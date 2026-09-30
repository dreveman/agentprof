import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Phase-0 runtime probe. Pure and testable: no Pi imports, no filesystem
// writes, bounded to ~200 ms. Every source reports pass/fail with observed
// values; failures must surface as "unavailable on this runtime", never as
// silent zeroes in the trace.

const requireOptional = (() => {
  try {
    return createRequire(import.meta.url);
  } catch {
    return null;
  }
})();

export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
}

function safeString(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

export function probeHrtime(): ProbeResult {
  try {
    const first = process.hrtime.bigint();
    let prev = first;
    let steps = 0;
    for (let i = 0; i < 1000; i++) {
      const now = process.hrtime.bigint();
      if (now < prev) {
        return { name: "hrtime.bigint", ok: false, detail: "went backwards; clock unusable" };
      }
      if (now !== prev) steps++;
      prev = now;
    }
    return { name: "hrtime.bigint", ok: true, detail: `monotonic over 1000 samples, ${steps} distinct steps` };
  } catch (error) {
    return { name: "hrtime.bigint", ok: false, detail: safeString(error) };
  }
}

export function probeClockEquivalence(): ProbeResult {
  try {
    const hrtime = process.hrtime.bigint();
    const bunNs = (globalThis as { Bun?: { nanoseconds?: () => number | bigint } }).Bun?.nanoseconds?.();
    const perfNow = typeof performance !== "undefined" ? performance.now() : undefined;
    let uptimeNs: bigint | undefined;
    try {
      const seconds = Number(readFileSync("/proc/uptime", "utf8").split(/\s+/, 1)[0]);
      if (Number.isFinite(seconds)) uptimeNs = BigInt(Math.round(seconds * 1e9));
    } catch {
      uptimeNs = undefined;
    }

    const startHr = process.hrtime.bigint();
    const startPerf = typeof performance !== "undefined" ? performance.now() : 0;
    const target = startHr + 5_000_000n;
    while (process.hrtime.bigint() < target) {
      // spin
    }
    const endHr = process.hrtime.bigint();
    const endPerf = typeof performance !== "undefined" ? performance.now() : startPerf;
    const deltaDriftMs = Math.abs(Number(endHr - startHr) / 1e6 - (endPerf - startPerf));
    // Matching rates is insufficient: CLOCK_MONOTONIC requires the boot epoch.
    // On Linux, /proc/uptime is the authoritative epoch check. Else fail closed.
    const epochDriftMs = uptimeNs === undefined ? Number.POSITIVE_INFINITY : Math.abs(Number(hrtime - uptimeNs) / 1e6);
    const ok = deltaDriftMs < 2 && epochDriftMs < 5_000;
    const details = [
      `hrtime=${hrtime}`,
      bunNs === undefined ? "Bun.nanoseconds=missing" : `Bun.nanoseconds=${String(bunNs)}`,
      perfNow === undefined ? "performance.now=missing" : `performance.now=${perfNow.toFixed(3)}ms`,
      uptimeNs === undefined ? "/proc/uptime=unavailable" : `/proc/uptime=${uptimeNs}`,
      `deltaDrift=${deltaDriftMs.toFixed(2)}ms`,
      `epochDrift=${Number.isFinite(epochDriftMs) ? `${epochDriftMs.toFixed(0)}ms` : "unknown"}`,
      ok ? "CLOCK_MONOTONIC proven" : "use custom clock 64",
    ];
    return { name: "clock-equivalence", ok, detail: details.join(" | ") };
  } catch (error) {
    return { name: "clock-equivalence", ok: false, detail: safeString(error) };
  }
}

export function probeMemoryCpu(): ProbeResult[] {
  const results: ProbeResult[] = [];
  try {
    const mem = process.memoryUsage();
    const sane = mem.rss > 0 && mem.heapUsed > 0;
    results.push({ name: "process.memoryUsage", ok: sane, detail: `rss=${mem.rss} heapUsed=${mem.heapUsed}` });
  } catch (error) {
    results.push({ name: "process.memoryUsage", ok: false, detail: safeString(error) });
  }
  try {
    const cpu = process.cpuUsage();
    results.push({ name: "process.cpuUsage", ok: true, detail: `user=${cpu.user} system=${cpu.system}` });
  } catch (error) {
    results.push({ name: "process.cpuUsage", ok: false, detail: safeString(error) });
  }
  try {
    const perfHooks = (globalThis as { performance?: { eventLoopUtilization?: unknown } }).performance;
    if (typeof perfHooks?.eventLoopUtilization === "function") {
      const elu = (perfHooks.eventLoopUtilization as () => unknown)();
      results.push({ name: "eventLoopUtilization", ok: true, detail: `present: ${JSON.stringify(elu)} (verify nonzero delta across turns)` });
    } else {
      results.push({ name: "eventLoopUtilization", ok: false, detail: "unavailable on this runtime" });
    }
  } catch (error) {
    results.push({ name: "eventLoopUtilization", ok: false, detail: safeString(error) });
  }
  return results;
}

export function probeOptionalModules(): ProbeResult[] {
  const results: ProbeResult[] = [];
  const attempts: Array<[string, string]> = [
    ["PerformanceObserver/gc", "perf_hooks"],
    ["async_hooks", "async_hooks"],
    ["diagnostics_channel", "diagnostics_channel"],
    ["node:trace_events", "node:trace_events"],
  ];
  for (const [name, specifier] of attempts) {
    if (requireOptional === null) {
      results.push({ name, ok: false, detail: "unavailable on this runtime: no require" });
      continue;
    }
    try {
      const mod = requireOptional(specifier) as Record<string, unknown>;
      const keys = Object.keys(mod).slice(0, 6).join(",");
      results.push({ name, ok: true, detail: `require ok; exports include: ${keys}` });
    } catch (error) {
      results.push({ name, ok: false, detail: `unavailable on this runtime: ${safeString(error)}` });
    }
  }
  return results;
}

export function probeCryptoRandom(): ProbeResult {
  try {
    const values = new BigUint64Array(2);
    crypto.getRandomValues(values);
    const first = values[0] ?? 0n;
    const second = values[1] ?? 0n;
    if (first === 0n && second === 0n) return { name: "crypto-random", ok: false, detail: "returned zeroes" };
    return { name: "crypto-random", ok: true, detail: "64-bit uuid source available" };
  } catch (error) {
    return { name: "crypto-random", ok: false, detail: safeString(error) };
  }
}

export function runProbe(): ProbeResult[] {
  return [
    probeHrtime(),
    probeClockEquivalence(),
    ...probeMemoryCpu(),
    ...probeOptionalModules(),
    probeCryptoRandom(),
  ];
}

export function formatProbe(results: ProbeResult[]): string {
  const lines = ["Pi-tracing Phase-0 probe (inside Pi runtime):"];
  for (const result of results) {
    lines.push(`- [${result.ok ? "PASS" : "FAIL"}] ${result.name}: ${result.detail}`);
  }
  lines.push("FAIL = mark the category unavailable on this runtime; never emit zeroes.");
  return lines.join("\n");
}
