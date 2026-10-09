// SPDX-License-Identifier: Apache-2.0
// packages/claude-tracing/direct-journal.ts
import { mkdirSync, writeFileSync, readFileSync as readFileSync3, readdirSync, renameSync, existsSync, linkSync, unlinkSync, statSync } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

// packages/pi-tracing/extensions/pi-tracing/tracer.ts
import { constants as fsConstants, readFileSync as readFileSync2 } from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname, uptime } from "node:os";

// packages/pi-tracing/extensions/pi-tracing/encoder.ts
var WIRE_VARINT = 0;
var WIRE_FIXED64 = 1;
var WIRE_LD = 2;
var TRACK_EVENT_BEGIN = 1;
var TRACK_EVENT_END = 2;
var TRACK_EVENT_INSTANT = 3;
var TRACK_EVENT_COUNTER = 4;
var SIBLING_MERGE_BY_TRACK_NAME = 1;
var SIBLING_MERGE_NONE = 2;
var CLOCK_REALTIME = 1;
var CLOCK_BOOTTIME = 6;
var COUNTER_UNIT_UNSPECIFIED = 0;
var COUNTER_UNIT_COUNT = 2;
var COUNTER_UNIT_BYTES = 3;
var textEncoder = new TextEncoder;
function encodeVarint(value) {
  let x = typeof value === "number" ? BigInt(value) : value;
  if (x < 0n)
    throw new Error("pi-tracing encoder: negative varint unsupported");
  const out = [];
  while (x > 0x7fn) {
    out.push(Number(x & 0x7fn | 0x80n));
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
}
function encodeFixed64(value) {
  let x = typeof value === "number" ? BigInt(value) : value;
  if (x < 0n)
    throw new Error("pi-tracing encoder: negative fixed64 unsupported");
  const out = [];
  for (let i = 0;i < 8; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}
function encodeTag(fieldNo, wire) {
  return encodeVarint(fieldNo << 3 | wire);
}
function encodeUint32Field(fieldNo, value) {
  if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
    throw new Error(`pi-tracing encoder: uint32 out of range (field ${fieldNo})`);
  }
  return [...encodeTag(fieldNo, WIRE_VARINT), ...encodeVarint(value)];
}
function encodeUint64Field(fieldNo, value) {
  return [...encodeTag(fieldNo, WIRE_VARINT), ...encodeVarint(value)];
}
function encodeStringField(fieldNo, value) {
  const bytes = textEncoder.encode(value);
  return [
    ...encodeTag(fieldNo, WIRE_LD),
    ...encodeVarint(bytes.length),
    ...bytes
  ];
}
function encodeBytesField(fieldNo, bytes) {
  const len = bytes.length;
  return [...encodeTag(fieldNo, WIRE_LD), ...encodeVarint(len), ...bytes];
}
function encodeFixed64Field(fieldNo, value) {
  return [...encodeTag(fieldNo, WIRE_FIXED64), ...encodeFixed64(value)];
}
function concat(...parts) {
  const out = [];
  for (const part of parts) {
    for (const byte of part)
      out.push(byte);
  }
  return out;
}
function toU8(bytes) {
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
}
function encodeDoubleField(fieldNo, value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...encodeTag(fieldNo, WIRE_FIXED64), ...bytes];
}
function buildDebugAnnotation(name, value) {
  const parts = name === undefined ? [] : [encodeStringField(10, name)];
  if (typeof value === "boolean") {
    parts.push(encodeUint32Field(2, value ? 1 : 0));
  } else if (typeof value === "number") {
    if (Number.isSafeInteger(value)) {
      parts.push(encodeUint64Field(value >= 0 ? 3 : 4, BigInt.asUintN(64, BigInt(value))));
    } else {
      parts.push(encodeDoubleField(5, value));
    }
  } else if (typeof value === "string") {
    parts.push(encodeStringField(6, value));
  } else if (Array.isArray(value)) {
    for (const item of value)
      parts.push(encodeBytesField(12, buildDebugAnnotation(undefined, item)));
  } else {
    for (const [key, item] of Object.entries(value))
      parts.push(encodeBytesField(11, buildDebugAnnotation(key, item)));
  }
  return concat(...parts);
}
function buildTrackEvent(args) {
  if (args.trackUuid === 0n)
    throw new Error("pi-tracing encoder: track_uuid 0 is the implicit global track; pass an explicit track");
  if (args.type === TRACK_EVENT_COUNTER && args.counterValue === undefined) {
    throw new Error("pi-tracing encoder: TYPE_COUNTER requires counterValue");
  }
  const parts = [
    encodeUint32Field(9, args.type),
    encodeUint64Field(11, args.trackUuid)
  ];
  for (const category of args.categories) {
    parts.push(encodeStringField(22, category));
  }
  if (args.name !== undefined)
    parts.push(encodeStringField(23, args.name));
  if (args.counterValue !== undefined) {
    parts.push([...encodeTag(30, WIRE_VARINT), ...encodeVarint(args.counterValue)]);
  }
  if (args.flowIds !== undefined) {
    for (const flowId of args.flowIds) {
      if (flowId === 0n)
        throw new Error("pi-tracing encoder: flow id 0 is reserved");
      parts.push(encodeFixed64Field(47, flowId));
    }
  }
  if (args.debugAnnotations !== undefined) {
    for (const [name, value] of Object.entries(args.debugAnnotations)) {
      parts.push(encodeBytesField(4, buildDebugAnnotation(name, value)));
    }
  }
  return toU8(concat(...parts));
}
function buildProcessDescriptor(info) {
  const parts = [encodeUint32Field(1, info.pid)];
  parts.push(encodeStringField(6, info.processName));
  for (const label of info.labels)
    parts.push(encodeStringField(8, label));
  return concat(...parts);
}
function buildCounterDescriptor(info) {
  if (!info.unitName)
    throw new Error("pi-tracing encoder: counter unit_name is required");
  const parts = [encodeUint32Field(3, info.unit), encodeStringField(6, info.unitName)];
  if (info.yAxisShareKey !== undefined)
    parts.push(encodeStringField(7, info.yAxisShareKey));
  return concat(...parts);
}
function buildTrackDescriptor(args) {
  if (args.uuid === 0n)
    throw new Error("pi-tracing encoder: TrackDescriptor uuid 0 is reserved for the implicit track");
  const parts = [encodeUint64Field(1, args.uuid)];
  if (args.name !== undefined)
    parts.push(encodeStringField(2, args.name));
  if (args.process !== undefined)
    parts.push(encodeBytesField(3, buildProcessDescriptor(args.process)));
  if (args.thread !== undefined)
    parts.push(encodeBytesField(4, concat(encodeUint32Field(1, args.thread.pid), encodeUint64Field(2, args.thread.tid), ...args.thread.threadName === undefined ? [] : [encodeStringField(5, args.thread.threadName)])));
  if (args.parentUuid !== undefined)
    parts.push(encodeUint64Field(5, args.parentUuid));
  if (args.counter !== undefined)
    parts.push(encodeBytesField(8, buildCounterDescriptor(args.counter)));
  if (args.description !== undefined)
    parts.push(encodeStringField(14, args.description));
  if (args.siblingMergeBehavior !== undefined)
    parts.push(encodeUint32Field(15, args.siblingMergeBehavior));
  return toU8(concat(...parts));
}
function buildClockSnapshot(clocks, primaryTraceClock) {
  const parts = [];
  for (const clock of clocks) {
    const clockBytes = concat(encodeUint32Field(1, clock.clockId), encodeUint64Field(2, clock.timestampNs));
    parts.push(encodeBytesField(1, clockBytes));
  }
  parts.push(encodeUint32Field(2, primaryTraceClock));
  return toU8(concat(...parts));
}
function buildTracePacket(args) {
  if (args.seqId === 0)
    throw new Error("pi-tracing encoder: trusted_packet_sequence_id must be nonzero");
  const set = [args.trackEvent, args.trackDescriptor, args.clockSnapshot].filter((part) => part !== undefined);
  if (set.length !== 1)
    throw new Error("pi-tracing encoder: TracePacket needs exactly one data field");
  if (args.timestampNs === undefined !== (args.clockId === undefined)) {
    throw new Error("pi-tracing encoder: timestamp and clock id must be provided together");
  }
  if (args.trackEvent !== undefined && args.timestampNs === undefined) {
    throw new Error("pi-tracing encoder: TrackEvent packets require a timestamp and clock id");
  }
  const parts = [encodeUint32Field(10, args.seqId)];
  if (args.machineId !== undefined && args.machineId !== 0) {
    parts.push(encodeUint32Field(98, args.machineId));
  }
  if (args.timestampNs !== undefined && args.clockId !== undefined) {
    parts.unshift(encodeUint32Field(58, args.clockId));
    parts.unshift(encodeUint64Field(8, args.timestampNs));
  }
  if (args.trackEvent !== undefined)
    parts.push(encodeBytesField(11, args.trackEvent));
  if (args.trackDescriptor !== undefined)
    parts.push(encodeBytesField(60, args.trackDescriptor));
  if (args.clockSnapshot !== undefined)
    parts.push(encodeBytesField(6, args.clockSnapshot));
  return toU8(concat(...parts));
}
function framePacket(packet) {
  return toU8(encodeBytesField(1, packet));
}

// packages/pi-tracing/extensions/pi-tracing/annotations.ts
function toolArgumentAnnotations(input, mode) {
  if (mode === false || mode === "disabled")
    return {};
  const attrs = {};
  let json;
  try {
    json = JSON.stringify(input);
  } catch {}
  if (json === undefined) {
    attrs["serializable"] = false;
    return attrs;
  }
  attrs["bytes"] = new TextEncoder().encode(json).length;
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const keys = Object.keys(input);
    attrs["keys"] = keys.slice(0, 12).map((key) => key.slice(0, 200));
    if (keys.length > 12 || keys.some((key) => key.length > 200))
      attrs["keys_truncated"] = true;
  }
  if (mode === "metadata")
    return attrs;
  let remainingNodes = 128;
  let remainingText = 65536;
  let truncated = false;
  const copy = (value, depth) => {
    if (--remainingNodes < 0 || depth > 8) {
      truncated = true;
      return;
    }
    if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))
      return value;
    if (typeof value === "string") {
      let size = Math.min(value.length, remainingText);
      if (size < value.length && size > 0 && /[\uD800-\uDBFF]/.test(value[size - 1]))
        size--;
      remainingText -= size;
      if (size < value.length)
        truncated = true;
      return value.slice(0, size);
    }
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) {
        const child = copy(item, depth + 1);
        if (child === undefined)
          break;
        result.push(child);
      }
      return result;
    }
    if (value !== null && typeof value === "object") {
      const result = Object.create(null);
      for (const [key, item] of Object.entries(value)) {
        if (remainingNodes <= 0 || remainingText < key.length) {
          truncated = true;
          break;
        }
        remainingText -= key.length;
        const child = copy(item, depth + 1);
        if (child !== undefined)
          result[key] = child;
      }
      return result;
    }
    truncated = true;
    return;
  };
  const value = copy(JSON.parse(json), 0);
  if (value !== undefined)
    attrs["args"] = value;
  if (truncated)
    attrs["truncated"] = true;
  return attrs;
}
function promptAnnotations(prompt, captureText) {
  if (typeof prompt !== "string")
    return {};
  const attrs = { length: prompt.length };
  if (captureText) {
    let limit = 65536;
    if (prompt.length > limit && /[\uD800-\uDBFF]/.test(prompt[limit - 1]))
      limit--;
    attrs["text"] = prompt.slice(0, limit);
    if (prompt.length > limit)
      attrs["truncated"] = true;
  }
  return attrs;
}

// packages/pi-tracing/extensions/pi-tracing/machine.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
var FNV1A_64_OFFSET_BASIS = 0xcbf29ce484222325n;
var FNV1A_64_PRIME = 0x100000001b3n;
var UINT64_MASK = 0xffffffffffffffffn;
var UINT32_MASK = 0xffffffffn;
var utf8 = new TextEncoder;
var defaultDependencies = {
  readTextFile(path) {
    return readFileSync(path, "utf8");
  },
  readSysctl(name) {
    return execFileSync("/usr/sbin/sysctl", ["-n", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000
    });
  }
};
function fnv1a64(value) {
  let digest = FNV1A_64_OFFSET_BASIS;
  for (const byte of utf8.encode(value)) {
    digest ^= BigInt(byte);
    digest = digest * FNV1A_64_PRIME & UINT64_MASK;
  }
  return digest;
}
function machineIdFromDigest(digest) {
  const id = Number(digest & UINT32_MASK);
  return id === 0 ? 1 : id;
}
function machineIdFromBootId(rawBootId) {
  const bootId = rawBootId.trim();
  return bootId === "" ? 0 : machineIdFromDigest(fnv1a64(bootId));
}
function resolveMachineIdentity(platform = process.platform, dependencies = defaultDependencies) {
  try {
    if (platform === "linux") {
      const id = machineIdFromBootId(dependencies.readTextFile("/proc/sys/kernel/random/boot_id"));
      return id === 0 ? { id: 0, source: "unavailable" } : { id, source: "linux-boot-id" };
    }
    if (platform === "darwin") {
      const id = machineIdFromBootId(dependencies.readSysctl("kern.bootsessionuuid"));
      return id === 0 ? { id: 0, source: "unavailable" } : { id, source: "darwin-boot-session" };
    }
  } catch {}
  return { id: 0, source: "unavailable" };
}
var cachedMachineIdentity;
function currentMachineIdentity() {
  cachedMachineIdentity ??= resolveMachineIdentity();
  return cachedMachineIdentity;
}

// packages/pi-tracing/extensions/pi-tracing/context.ts
var CONTEXT_CATEGORIES = {
  system: "System instructions",
  rules: "Rules and memory",
  skills: "Skills",
  tools: "Tool definitions",
  environment: "Environment",
  prompts: "User prompts",
  assistant: "Assistant history",
  results: "Tool results",
  summaries: "Compaction summaries",
  overhead: "Harness overhead",
  messages: "Conversation",
  unattributed: "Unattributed"
};
var count = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
function instructionCategory(name) {
  if (/rule|memory|claude.?md|agents.?md|instruction.?file/i.test(name))
    return "rules";
  if (/skill/i.test(name))
    return "skills";
  if (/environment|date|workspace|session.?info|project|email/i.test(name))
    return "environment";
  if (/reminder|wrapper/i.test(name))
    return "overhead";
  if (/tool|agent|command/i.test(name))
    return "tools";
  return "system";
}
class ContextTracker {
  previous;
  model;
  reset() {
    this.previous = undefined;
    this.model = undefined;
  }
  snapshot(items, options) {
    const baseline = this.previous === undefined || options.model !== this.model;
    const previous = baseline ? new Map : this.previous;
    const current = new Map(items.filter((i) => count(i.tokens) !== undefined).map((i) => {
      const item = Object.fromEntries(Object.entries(i).filter(([, value]) => value !== undefined));
      return [item.id, item];
    }));
    const categories = {};
    for (const item of current.values())
      categories[item.category] = (categories[item.category] ?? 0) + item.tokens;
    const changes = [];
    for (const item of current.values()) {
      const old = previous.get(item.id);
      if (!old || old.tokens !== item.tokens || old.category !== item.category)
        changes.push({
          ...item,
          change: !old ? baseline ? "baseline" : "added" : "replaced",
          delta_tokens: item.tokens - (old?.tokens ?? 0)
        });
    }
    for (const item of previous.values())
      if (!current.has(item.id))
        changes.push({ ...item, change: "removed", delta_tokens: -item.tokens });
    changes.sort((a, b) => Math.abs(b.delta_tokens) - Math.abs(a.delta_tokens));
    this.previous = current;
    this.model = options.model;
    const measured = options.categories ?? categories;
    return {
      version: 1,
      stage: options.stage,
      basis: options.basis ?? "chars/4",
      coverage: options.coverage ?? "partial",
      baseline,
      ...options.item_stage ? { item_stage: options.item_stage } : {},
      categories: measured,
      ...Object.keys(measured).length ? { estimated_tokens: Object.values(measured).reduce((a, b) => a + b, 0) } : {},
      ...count(options.reported_tokens) !== undefined ? { reported_tokens: options.reported_tokens } : {},
      ...count(options.window_tokens) !== undefined ? { window_tokens: options.window_tokens } : {},
      ...count(options.compact_threshold_tokens) !== undefined ? { compact_threshold_tokens: options.compact_threshold_tokens } : {},
      ...count(options.effective_window_tokens) !== undefined ? { effective_window_tokens: options.effective_window_tokens } : {},
      ...options.model ? { model: options.model } : {},
      changes: changes.slice(0, 64),
      omitted_changes: Math.max(0, changes.length - 64)
    };
  }
}

// packages/pi-tracing/extensions/pi-tracing/tracks.ts
var DEFAULT_COUNTERS = [
  ...Object.entries(CONTEXT_CATEGORIES).map(([key, name]) => ({
    key: `context.${key}`,
    trackName: name,
    unit: COUNTER_UNIT_UNSPECIFIED,
    unitName: "tokens",
    yAxisShareKey: "llm.context.tokens",
    category: "llm",
    group: "Context"
  })),
  { key: "llm.tokens.input", trackName: "Input tokens", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", category: "llm" },
  { key: "llm.tokens.output", trackName: "Output tokens", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", category: "llm" },
  { key: "llm.context.estimated_tokens", trackName: "Context size", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", yAxisShareKey: "llm.context.tokens", category: "llm" },
  { key: "llm.context.window_tokens", trackName: "Context window", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", yAxisShareKey: "llm.context.tokens", category: "llm" },
  { key: "runtime.rss", trackName: "Resident memory", group: "Runtime", unit: COUNTER_UNIT_BYTES, unitName: "bytes" },
  { key: "runtime.heap", trackName: "JS heap", group: "Runtime", unit: COUNTER_UNIT_BYTES, unitName: "bytes" },
  { key: "runtime.cpu", trackName: "CPU time (interval)", description: "Process CPU time consumed since the previous sample, in microseconds; not utilization.", group: "Runtime", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "us" },
  { key: "tracing.droppedEvents", trackName: "Dropped events", group: "Tracing", unit: COUNTER_UNIT_COUNT, unitName: "count" },
  { key: "tracing.queueDepth", trackName: "Queue depth", group: "Tracing", unit: COUNTER_UNIT_COUNT, unitName: "count" },
  { key: "tracing.laneOverflows", trackName: "Lane overflows", group: "Tracing", unit: COUNTER_UNIT_COUNT, unitName: "count" }
];

// packages/pi-tracing/extensions/pi-tracing/tracer.ts
var FLUSH_BATCH_BYTES = 64 * 1024;
var FINALIZE_RESERVE_BYTES = 64 * 1024;
var MAX_TIMESTAMP_NS = (1n << 64n) - 1n;
var OWNER_GRACE_MS = 5 * 60 * 1000;
var utf82 = new TextEncoder;
var runtimeIdentity = randomToken();
function nowSourceNs() {
  return process.hrtime.bigint();
}
function realtimeNowNs() {
  return BigInt(Date.now()) * 1000000n;
}
function boottimeNsForPlatform(platform, realtimeNs, uptimeSeconds) {
  if (platform !== "linux")
    return realtimeNs;
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    throw new Error("system uptime clock unavailable");
  }
  return BigInt(Math.round(uptimeSeconds * 1e9));
}
function linuxUptimeReading(readText = () => readFileSync2("/proc/uptime", "utf8"), fallback = uptime) {
  try {
    const seconds = Number(readText().trim().split(/\s+/)[0]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { seconds, resolutionNs: 10000000n };
    }
  } catch {}
  return { seconds: fallback(), resolutionNs: 1000000000n };
}
function captureClockReadings() {
  const sourceBefore = nowSourceNs();
  const realtimeBefore = realtimeNowNs();
  const boot = process.platform === "linux" ? linuxUptimeReading() : { seconds: 0, resolutionNs: 0n };
  const realtimeAfter = realtimeNowNs();
  const sourceAfter = nowSourceNs();
  const realtimeNs = realtimeBefore + (realtimeAfter - realtimeBefore) / 2n;
  const samplingUncertainty = (sourceAfter - sourceBefore) / 2n;
  const realtimeDelta = realtimeAfter >= realtimeBefore ? realtimeAfter - realtimeBefore : realtimeBefore - realtimeAfter;
  const realtimeUncertainty = realtimeDelta / 2n;
  const quantizationUncertainty = boot.resolutionNs + 1000000n;
  const uncertaintyNs = quantizationUncertainty + samplingUncertainty + realtimeUncertainty;
  return {
    sourceNs: sourceBefore + (sourceAfter - sourceBefore) / 2n,
    boottimeNs: boottimeNsForPlatform(process.platform, realtimeNs, boot.seconds),
    realtimeNs,
    uncertaintyNs
  };
}
function randomToken() {
  return randomBytes(8).toString("hex");
}

// packages/agent-tracing/find-last.ts
function findLast(values, predicate) {
  if (!values)
    return;
  for (let index = values.length - 1;index >= 0; index--) {
    const value = values[index];
    if (predicate(value))
      return value;
  }
}

// packages/agent-tracing/context.ts
function attachContext(slice, snapshot, counters, at = slice.start) {
  slice.attrs.context = { ...snapshot, sample_offset_ns: Number(at - slice.start) };
  for (const [key, value] of Object.entries(snapshot.categories)) {
    const name = CONTEXT_CATEGORIES[key] ?? key;
    let counter = counters.find((c) => c.session === slice.session && c.name === `Context: ${name}`);
    if (!counter) {
      counter = { session: slice.session, name: `Context: ${name}`, group: "Context", unit: "tokens", axis: "llm.context.tokens", samples: [] };
      counters.push(counter);
    }
    counter.samples.push({ at, value });
  }
  for (const c of counters.filter((c) => c.session === slice.session && c.group === "Context"))
    if (!Object.keys(snapshot.categories).some((key) => c.name === `Context: ${CONTEXT_CATEGORIES[key] ?? key}`))
      c.samples.push({ at, value: 0 });
}

// packages/agent-tracing/trace.ts
var compareTime = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function writeTrace(options) {
  if (!options.capture || !Number.isInteger(options.pid) || options.pid <= 0)
    throw new Error("Missing process/capture identity");
  if (!options.clocks.length)
    throw new Error("Missing boot/realtime clock snapshot");
  const uuid = (key) => fnv1a64(`${options.capture}:${key}`) || 1n;
  const seqId = Number(uuid("sequence") & 0xffffffffn) || 1;
  const packets = [];
  const packet = (data, at) => packets.push(framePacket(buildTracePacket({
    seqId,
    machineId: options.machineId,
    ...at === undefined ? {} : { timestampNs: at, clockId: CLOCK_REALTIME },
    ...data
  })));
  for (const clock of options.clocks)
    packet({ clockSnapshot: buildClockSnapshot([
      { clockId: CLOCK_REALTIME, timestampNs: clock.realtimeNs },
      { clockId: CLOCK_BOOTTIME, timestampNs: clock.boottimeNs }
    ], CLOCK_REALTIME) });
  const process2 = uuid("process");
  packet({ trackDescriptor: buildTrackDescriptor({ uuid: process2, process: {
    pid: options.pid,
    processName: options.processName,
    labels: [options.processLabel]
  } }) });
  const events = [];
  const event = (at, rank, trackUuid, type, name, attrs, flows, counterValue) => {
    events.push({ at, rank, data: buildTrackEvent({
      trackUuid,
      type,
      name,
      categories: type === TRACK_EVENT_END ? [] : [`${options.category}.${name?.startsWith("profile (") || name === "run-configuration" ? "metadata" : "activity"}`],
      debugAnnotations: attrs,
      flowIds: flows,
      counterValue
    }) });
  };
  for (const session of options.sessions) {
    const root = uuid(`capture:${session.id}`), profile = uuid(`profile:${session.id}`);
    packet({ trackDescriptor: buildTrackDescriptor({ uuid: root, parentUuid: process2, name: "agentprof.capture", siblingMergeBehavior: SIBLING_MERGE_NONE }) });
    packet({ trackDescriptor: buildTrackDescriptor({ uuid: profile, parentUuid: root, name: "Session" }) });
    event(session.start, -4, profile, TRACK_EVENT_BEGIN, "profile (1)", { ...session.attrs, kind: "capture", schema_version: 1, session_id: session.id, capture_id: root.toString(16) });
    event(session.end, 4, profile, TRACK_EVENT_END);
    const groups = new Map;
    for (const slice of options.slices.filter((s) => s.session === session.id)) {
      const group = groups.get(slice.track) ?? [];
      group.push(slice);
      groups.set(slice.track, group);
    }
    for (const [name, slices] of groups) {
      const lanes = [];
      for (const slice of slices.sort((a, b) => compareTime(a.start, b.start))) {
        let lane = lanes.find((l) => l.end <= slice.start);
        if (!lane) {
          lane = { uuid: uuid(`${session.id}:${name}:${lanes.length}`), end: slice.start };
          lanes.push(lane);
          packet({ trackDescriptor: buildTrackDescriptor({ uuid: lane.uuid, parentUuid: root, name, siblingMergeBehavior: SIBLING_MERGE_BY_TRACK_NAME }) });
        }
        lane.end = slice.end === slice.start ? slice.start + 1n : slice.end ?? slice.start;
        event(slice.start, slice.end === undefined ? -1 : 0, lane.uuid, slice.end === undefined ? TRACK_EVENT_INSTANT : TRACK_EVENT_BEGIN, slice.name, slice.attrs, [...new Set(slice.flows)]);
        if (slice.end !== undefined)
          event(slice.end, slice.end === slice.start ? 1 : -2, lane.uuid, TRACK_EVENT_END);
      }
    }
    const describedGroups = new Set;
    for (const counter of options.counters.filter((c) => c.session === session.id && c.samples.length)) {
      const id = uuid(`${session.id}:counter:${counter.name}`);
      const parent = counter.group ? uuid(`${session.id}:group:${counter.group}`) : root;
      if (counter.group && !describedGroups.has(counter.group)) {
        packet({ trackDescriptor: buildTrackDescriptor({ uuid: parent, parentUuid: root, name: counter.group }) });
        describedGroups.add(counter.group);
      }
      packet({ trackDescriptor: buildTrackDescriptor({
        uuid: id,
        parentUuid: parent,
        name: counter.name,
        counter: { unit: 0, unitName: counter.unit, ...counter.axis ? { yAxisShareKey: counter.axis } : {} }
      }) });
      if (!counter.group)
        event(session.start, -3, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, 0n);
      for (const sample of counter.samples.sort((a, b) => compareTime(a.at, b.at)))
        event(sample.at, 2, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, BigInt(sample.value));
      event(session.end, 3, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, 0n);
    }
  }
  events.sort((a, b) => compareTime(a.at, b.at) || a.rank - b.rank);
  for (const e of events)
    packet({ trackEvent: e.data }, e.at);
  return Buffer.concat(packets);
}

// packages/claude-tracing/direct.ts
var object = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
var text = (v) => typeof v === "string" ? v : "";
var value = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
var tokens = (v) => Number.isSafeInteger(value(v)) ? value(v) : undefined;
var ms = (v) => BigInt(Math.round(v * 1e6));
var min = (a, b) => a < b ? a : b;
var max = (a, b) => a > b ? a : b;
function convertDirectObservations(rows) {
  const firstSegment = new Map;
  for (const r of rows)
    if (r.source === "claude.mod" && !firstSegment.has(text(r.data.session_id)))
      firstSegment.set(text(r.data.session_id), Number(r.data.segment ?? 0));
  rows = rows.map((r) => {
    if (r.source !== "claude.mod" || Number(r.data.segment ?? 0) === firstSegment.get(text(r.data.session_id)))
      return r;
    const id = `${r.data.session_id}:${r.data.segment}`;
    return { ...r, data: {
      ...r.data,
      native_session_id: r.data.session_id,
      session_id: id,
      ...r.data.event === "session" ? { id } : {}
    } };
  });
  const identity = rows.find((r) => r.source === "process_start");
  if (!identity || !tokens(identity.data.pid) || !text(identity.data.captureId))
    throw new Error("Missing Claude process identity");
  const capture = text(identity.data.captureId);
  const events = rows.filter((r) => r.source === "claude.mod").sort((a, b) => compareTime(BigInt(a.timestamp), BigInt(b.timestamp)));
  const captureContents = !events.some((r) => r.data.event === "session" && r.data.capture_contents === false);
  if (!events.length)
    throw new Error("No direct Claude events captured");
  const last = BigInt(events.at(-1).timestamp);
  const agents = new Map;
  for (const r of events.filter((r) => r.data.event === "agent"))
    agents.set(`${r.data.session_id}/${r.data.agent_id}`, r.data);
  const scope = (d) => `${text(d.session_id)}${d.agent_id ? "/" + text(d.agent_id) : ""}`;
  const key = (d) => `${scope(d)}:${d.event}:${d.id}`;
  const ends = new Map(events.filter((r) => r.data.phase === "end").map((r) => [key(r.data), r]));
  const sessions = new Map;
  const getSession = (r) => {
    const id = scope(r.data), at = BigInt(r.timestamp);
    let session = sessions.get(id);
    if (!session) {
      const native = agents.get(id);
      session = { id, start: at, end: at, attrs: {
        harness: "claude-code",
        ...r.data.native_session_id ? { native_session_id: text(r.data.native_session_id) } : {},
        provider: sessions.get(text(r.data.session_id))?.attrs.provider ?? "anthropic",
        timing: "mod-hooks",
        ...r.data.agent_id ? {
          parent_session: `${r.data.session_id}${native?.parent_agent_id ? "/" + native.parent_agent_id : ""}`,
          agent_id: text(r.data.agent_id),
          child_role: text(native?.role) || "internal",
          ...native?.model ? { model: text(native.model) } : {}
        } : {}
      } };
      sessions.set(id, session);
    }
    session.start = min(session.start, at);
    session.end = max(session.end, at);
    return session;
  };
  for (const r of events) {
    if (!text(r.data.session_id))
      continue;
    const session = getSession(r);
    if (r.data.event === "session" && r.data.phase === "begin") {
      if (r.data.model)
        session.attrs.model = text(r.data.model);
      if (r.data.version)
        session.attrs.harness_version = text(r.data.version);
      if (r.data.provider)
        session.attrs.provider = text(r.data.provider);
    }
  }
  const captureEnd = (d) => {
    const closed = ends.get(`${text(d.session_id)}:session:${text(d.session_id)}`);
    return closed ? BigInt(closed.timestamp) : last;
  };
  for (const r of events.filter((r) => r.data.phase === "begin")) {
    const d = r.data;
    const open = ["prompt", "response", "tool", "compaction"].includes(text(d.event)) && !ends.has(key(d));
    const childOpen = d.event === "agent" && !events.some((v) => scope(v.data) === scope(d) && v.data.event === "prompt" && v.data.phase === "end");
    if (open || childOpen)
      getSession(r).end = max(getSession(r).end, captureEnd(d));
  }
  for (const session of sessions.values()) {
    if (!session.attrs.parent_session) {
      const closed = findLast(events, (r) => scope(r.data) === session.id && r.data.event === "session" && r.data.phase === "end");
      if (!closed || closed.data.dropped || rows.some((r) => r.source === "recovery"))
        session.attrs.incomplete = true;
      if (closed)
        session.attrs.stop_reason = text(closed.data.reason);
      if (closed?.data.dropped)
        session.attrs.dropped_events = tokens(closed.data.dropped);
    } else if (!events.some((r) => scope(r.data) === session.id && r.data.event === "prompt" && r.data.phase === "end")) {
      session.attrs.incomplete = true;
    }
  }
  const slices = [], counters = [];
  const add = (r, track, name, start, end, attrs, suffix = "") => {
    const slice = { id: key(r.data) + suffix, session: scope(r.data), track, name, start, end, attrs, flows: [] };
    slices.push(slice);
    return slice;
  };
  const edge = (from, to) => {
    if (!from || !to || to.start < from.start)
      return;
    const id = fnv1a64(`${capture}:${from.id}:${to.id}`) || 1n;
    from.flows.push(id);
    to.flows.push(id);
  };
  const contextTrackers = new Map;
  const contextSamples = [];
  const prompts = new Map, inputs = new Map, responses = [];
  const tools = new Map, dispatches = new Map;
  const executions = new Map(events.filter((r) => r.data.event === "execution").map((r) => [`${scope(r.data)}:${r.data.id}`, r]));
  const contextRows = events.filter((r) => r.data.event === "context" || r.data.event === "session" && r.data.phase === "begin");
  const usageAttrs = (raw) => {
    const u = object(raw), attrs = {};
    for (const [source, target] of [
      ["input_tokens", "input_tokens"],
      ["output_tokens", "output_tokens"],
      ["cache_read_input_tokens", "cache_read_tokens"],
      ["cache_creation_input_tokens", "cache_write_tokens"]
    ]) {
      const n = tokens(u[source]);
      if (n !== undefined)
        attrs[target] = n;
    }
    return attrs;
  };
  for (const r of events.filter((r) => r.data.phase === "begin" && ["prompt", "agent"].includes(text(r.data.event)))) {
    const d = r.data, session = getSession(r), close = ends.get(key(d));
    const promptEnd = close ? BigInt(close.timestamp) : d.event === "agent" ? session.end : captureEnd(d);
    const input = add(r, "Inputs", "prompt-input", BigInt(r.timestamp), undefined, { source: d.agent_id ? "agent" : "user" }, ":input");
    const prompt = add(r, "Session", "prompt", BigInt(r.timestamp), promptEnd, {
      kind: "prompt",
      ...promptAnnotations(d.prompt, captureContents),
      ...tokens(d.prompt_length) !== undefined ? { length: tokens(d.prompt_length) } : {},
      ...d.content_omitted ? { content_omitted: true } : {},
      ...d.started_before_capture ? { started_before_capture: true, incomplete: true } : {},
      ...!close && (d.event !== "agent" || session.attrs.incomplete) ? { incomplete: true } : {},
      ...close?.data.aborted ? { aborted: true } : {}
    });
    prompts.set(`${session.id}:${d.id}`, prompt);
    inputs.set(session.id, input);
    edge(input, prompt);
  }
  for (const r of events.filter((r) => r.data.event === "response" && r.data.phase === "begin")) {
    const d = r.data, close = ends.get(key(d)), result = close?.data ?? {}, u = object(result.usage);
    const start = BigInt(r.timestamp), end = close ? BigInt(close.timestamp) : captureEnd(d);
    const model = text(u.model) || text(d.model), session = getSession(r);
    const attrs = {
      kind: "assistant-message",
      model,
      provider: session.attrs.provider,
      timing: "mod-request-including-retries",
      ...usageAttrs(u),
      ...d.effort !== undefined ? { effort: d.effort } : {},
      ...!close || result.incomplete || result.stop_reason === null ? { incomplete: true } : {}
    };
    for (const [source, target] of [["first_content_ms", "first_content_ns"], ["first_text_ms", "first_text_ns"]]) {
      const n = value(result[source]);
      if (n !== undefined)
        attrs[target] = Math.round(n * 1e6);
    }
    const context = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].map(tokens);
    if (context.every((v) => v !== undefined))
      attrs.context_tokens = context.reduce((n, v) => n + v, 0);
    if (!d.agent_id) {
      const reading = contextRows.find((v) => scope(v.data) === session.id && v.data.id === d.id && BigInt(v.timestamp) >= end) ?? findLast(contextRows, (v) => scope(v.data) === session.id && BigInt(v.timestamp) <= start);
      const window = tokens(object(d.context).window) ?? (reading?.data.model === model ? tokens(object(reading.data.context).window) : undefined);
      if (window)
        attrs.context_window_tokens = window;
    }
    const response = add(r, "Responses", "response", start, end, attrs);
    responses.push(response);
    if (d.context && !d.agent_id)
      contextSamples.push({
        slice: response,
        input: object(d.context),
        model,
        stage: "request-input",
        at: start,
        reported: tokens(attrs.context_tokens)
      });
    add(r, "Turns", "turn", start, end, { kind: "turn", ...attrs.incomplete ? { incomplete: true } : {} }, ":turn");
    edge(prompts.get(`${session.id}:${d.turn_id}`) ?? slices.find((s) => s.session === session.id && s.attrs.kind === "prompt" && s.start <= start && s.end >= start), response);
  }
  for (const r of events.filter((r) => r.data.event === "tool" && r.data.phase === "begin")) {
    const d = r.data, close = ends.get(key(d));
    const execution = executions.get(`${scope(d)}:${d.id}`);
    const duration = value(execution?.data.duration_ms), dispatchStart = BigInt(r.timestamp);
    const dispatchEnd = close ? BigInt(close.timestamp) : captureEnd(d);
    const measured = duration !== undefined && execution !== undefined && ms(duration) <= dispatchEnd - dispatchStart + ms(1);
    const end = measured ? BigInt(execution.timestamp) : dispatchEnd;
    const start = measured ? end - ms(duration) : dispatchStart;
    const attrs = {
      kind: "tool-execution",
      call_id: text(d.id),
      ...toolArgumentAnnotations(d.arguments, captureContents),
      timing: measured ? "reported-execution-duration" : "dispatch-only",
      ...d.content_omitted ? { content_omitted: true } : {},
      ...!measured || !close || close.data.incomplete ? { incomplete: true } : {},
      ...close ? { is_error: Boolean(close.data.is_error) } : execution ? { is_error: Boolean(execution.data.is_error) } : {}
    };
    const intent = captureContents ? object(d.arguments).description : undefined;
    if (captureContents && typeof intent === "string")
      attrs.intent = intent;
    const tool = add(r, "Tools", text(d.tool) || "tool", start, end, attrs);
    tools.set(`${scope(d)}:${d.id}`, tool);
    const dispatch = add(r, "Tool dispatch", text(d.tool) || "tool", dispatchStart, dispatchEnd, {
      kind: "tool-dispatch",
      call_id: text(d.id),
      timing: "including-permissions-and-hooks",
      ...!close || close.data.incomplete ? { incomplete: true } : {}
    }, ":dispatch");
    dispatches.set(`${scope(d)}:${d.id}`, dispatch);
    edge(dispatch, tool);
    edge(responses.filter((s) => s.session === tool.session && s.start <= dispatchStart).at(-1), tool);
  }
  for (const r of events.filter((r) => r.data.event === "agent")) {
    const parent = `${r.data.session_id}${r.data.parent_agent_id ? "/" + r.data.parent_agent_id : ""}`;
    const key = `${parent}:${r.data.call_id}`, tool = tools.get(key), input = inputs.get(scope(r.data));
    if (tool) {
      tool.attrs.delegation = true;
      tool.attrs.child_session = scope(r.data);
      edge(input && tool.start <= input.start ? tool : dispatches.get(key), input);
    }
  }
  for (const r of events.filter((r) => r.data.event === "compaction" && r.data.phase === "begin")) {
    const close = ends.get(key(r.data)), result = close?.data ?? {};
    const attrs = {
      kind: "compaction",
      trigger: text(r.data.trigger),
      timing: "mod-compaction",
      ...usageAttrs(result.usage),
      ...!close || result.incomplete ? { incomplete: true } : { success: result.success === true },
      ...result.skipped ? { skipped: true } : {}
    };
    for (const k of ["pre_tokens", "post_tokens"]) {
      const n = tokens(result[k]);
      if (n !== undefined)
        attrs[k] = n;
    }
    const compact = add(r, "Compaction", r.data.trigger === "precompute" ? "precompute" : "compact", BigInt(r.timestamp), close ? BigInt(close.timestamp) : captureEnd(r.data), attrs);
    if (result.context && !r.data.agent_id)
      contextSamples.push({
        slice: compact,
        input: object(result.context),
        stage: "post-compaction",
        at: compact.end,
        model: text(result.model)
      });
  }
  const turnContexts = new Map;
  for (const r of events.filter((r) => r.data.event === "context")) {
    const id = `${scope(r.data)}:${text(r.data.id)}`, pair = turnContexts.get(id) ?? {};
    if (r.data.phase === "summary")
      pair.summary = r;
    else
      pair.delta = r;
    turnContexts.set(id, pair);
  }
  for (const [id, { delta, summary }] of turnContexts) {
    const prompt = prompts.get(id), input = { ...object(summary?.data.context), ...object(delta?.data.context) };
    if (!prompt || !input.breakdown && !(Array.isArray(input.item_changes) && input.item_changes.length))
      continue;
    contextSamples.push({
      slice: prompt,
      input,
      stage: "transcript-observed",
      at: BigInt(delta?.timestamp ?? summary.timestamp),
      model: text(summary?.data.model) || text(sessions.get(prompt.session)?.attrs.model)
    });
  }
  for (const r of events.filter((r) => r.data.event === "session" && r.data.phase === "begin" && object(r.data.context).breakdown)) {
    const session = sessions.get(scope(r.data));
    const profile = {
      id: `profile:${session.id}`,
      session: session.id,
      track: "Session",
      name: "profile (1)",
      start: session.start,
      end: session.end,
      attrs: session.attrs,
      flows: []
    };
    contextSamples.push({ slice: profile, input: object(r.data.context), model: text(r.data.model), stage: "capture-start", at: profile.start });
  }
  const retainedItems = new Map;
  for (const sample of contextSamples.sort((a, b) => compareTime(a.at, b.at))) {
    const { slice, input, model, stage, at, reported } = sample, breakdown = object(input.breakdown);
    const tracker = contextTrackers.get(slice.session) ?? new ContextTracker;
    contextTrackers.set(slice.session, tracker);
    const categories = {};
    for (const raw of Array.isArray(breakdown.categories) ? breakdown.categories : []) {
      const c = object(raw), n = tokens(c.tokens);
      if (c.kind !== "used" || n === undefined)
        continue;
      const name = text(c.name);
      const key = /message|conversation/i.test(name) ? "messages" : /system|tool|memory|rule|skill|agent|command|environment|reminder/i.test(name) ? instructionCategory(name) : "unattributed";
      categories[key] = (categories[key] ?? 0) + n;
    }
    let items = Array.isArray(input.items) ? input.items : [];
    if (Array.isArray(input.item_changes)) {
      const retained = input.items_reset ? new Map : retainedItems.get(slice.session) ?? new Map;
      for (const item of input.item_changes)
        retained.set(item.id, item);
      for (const id of Array.isArray(input.removed_items) ? input.removed_items : [])
        retained.delete(String(id));
      retainedItems.set(slice.session, retained);
      items = [...retained.values()];
      if (input.items_reset)
        tracker.reset();
    }
    attachContext(slice, tracker.snapshot(items, {
      stage,
      basis: Object.keys(categories).length ? "native-summary" : "chars/4",
      coverage: "partial",
      model,
      ...Object.keys(categories).length ? { categories } : {},
      window_tokens: tokens(input.window),
      reported_tokens: reported,
      effective_window_tokens: tokens(breakdown.raw_max_tokens),
      compact_threshold_tokens: tokens(breakdown.auto_compact_threshold)
    }), counters, at);
  }
  for (const session of sessions.values()) {
    const work = responses.filter((s) => s.session === session.id);
    const firstModel = text(work[0]?.attrs.model), requested = text(session.attrs.model);
    if (requested && firstModel && requested !== firstModel && requested.replace(/-\d{8}$/, "") === firstModel.replace(/-\d{8}$/, "")) {
      session.attrs.requested_model = requested;
      session.attrs.model = firstModel;
    }
    const usageWork = slices.filter((s) => s.session === session.id && ["assistant-message", "compaction"].includes(text(s.attrs.kind))).sort((a, b) => compareTime(a.end, b.end));
    let config, previous = "";
    for (const response of work) {
      const attrs = { harness: "claude-code" };
      for (const k of ["model", "provider", "effort", "context_window_tokens"])
        if (response.attrs[k] !== undefined)
          attrs[k] = response.attrs[k];
      const current = JSON.stringify(attrs);
      if (current === previous)
        continue;
      if (config)
        config.end = response.start;
      config = { ...response, id: `config:${response.id}`, track: "Configuration", name: "run-configuration", end: session.end, attrs, flows: [] };
      slices.push(config);
      previous = current;
    }
    for (const [name, field] of [["Input tokens", "input_tokens"], ["Output tokens", "output_tokens"], ["Context size", "context_tokens"], ["Context window", "context_window_tokens"]]) {
      const cumulative = field === "input_tokens" || field === "output_tokens";
      const samples = [];
      let total = 0;
      for (const response of cumulative ? usageWork : work) {
        const n = tokens(response.attrs[field]);
        if (n === undefined)
          continue;
        total += n;
        samples.push({ at: cumulative ? response.end : response.start, value: cumulative ? total : n });
      }
      if (field === "context_tokens" || field === "context_window_tokens") {
        for (const r of contextRows.filter((v) => scope(v.data) === session.id)) {
          const n = tokens(object(r.data.context)[field === "context_tokens" ? "tokens" : "window"]);
          if (n !== undefined)
            samples.push({ at: BigInt(r.timestamp), value: n });
        }
        if (field === "context_tokens")
          for (const compact of slices.filter((s) => s.session === session.id && s.attrs.kind === "compaction" && s.name !== "precompute")) {
            const before = tokens(compact.attrs.pre_tokens), after = tokens(compact.attrs.post_tokens);
            if (before !== undefined)
              samples.push({ at: compact.start, value: before });
            if (after !== undefined)
              samples.push({ at: compact.end, value: after });
          }
      }
      counters.push({ session: session.id, name, unit: "tokens", ...!cumulative ? { axis: "llm.context.tokens" } : {}, samples });
    }
  }
  const trace = writeTrace({
    capture,
    pid: tokens(identity.data.pid),
    machineId: tokens(identity.data.machineId) ?? 0,
    processName: "claude",
    processLabel: "Claude Code",
    category: "claude",
    sessions: [...sessions.values()],
    slices,
    counters,
    clocks: rows.filter((r) => r.source === "clock_snapshot").map((r) => ({ realtimeNs: BigInt(text(r.data.realtimeNs)), boottimeNs: BigInt(text(r.data.boottimeNs)) }))
  });
  return { trace, summary: {
    source: "claude-mod",
    sessions: sessions.size,
    responses: responses.length,
    tools: tools.size,
    measuredResponses: responses.filter((s) => !s.attrs.incomplete).length,
    incompleteOperations: slices.filter((s) => s.attrs.incomplete && ["prompt", "assistant-message", "tool-execution", "compaction"].includes(text(s.attrs.kind))).length,
    measuredTools: [...tools.values()].filter((t) => !t.attrs.incomplete).length,
    compactions: slices.filter((s) => s.attrs.kind === "compaction").length,
    inputTokens: slices.reduce((n, s) => n + (tokens(s.attrs.input_tokens) ?? 0), 0),
    outputTokens: slices.reduce((n, s) => n + (tokens(s.attrs.output_tokens) ?? 0), 0)
  } };
}

// packages/agent-tracing/journal.ts
function parseObservationJournal(text) {
  const lines = text.split(`
`), tail = lines.pop();
  const rows = [];
  let corruptRecords = tail ? 1 : 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row === null || typeof row !== "object" || Array.isArray(row))
        throw new Error("invalid observation");
      const value = row;
      if (typeof value.source !== "string" || !value.source || typeof value.timestamp !== "string" || !/^\d{1,20}$/.test(value.timestamp) || BigInt(value.timestamp) > (1n << 64n) - 1n || value.data === null || typeof value.data !== "object" || Array.isArray(value.data))
        throw new Error("invalid observation");
      rows.push(value);
    } catch {
      corruptRecords++;
    }
  }
  return { rows, corruptRecords };
}

// packages/claude-tracing/direct-journal.ts
function initializeDirectCapture(path, pid = process.ppid) {
  const captureId = randomUUID();
  if (path !== undefined && (!path.trim() || !path.endsWith(".pftrace") || path.includes("\x00")))
    throw new Error("output_path must name a .pftrace file.");
  const output = resolve(path ?? join("agentprof-traces", `claude-${new Date().toISOString().replace(/[:.]/g, "-")}-${captureId.slice(0, 8)}.pftrace`));
  const directory = `${output}.capture`;
  if (existsSync(output))
    throw new Error(`Output already exists: ${output}`);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(directory, { mode: 448 });
  const clocks = captureClockReadings();
  const metadata = { output, directory, pid, captureId };
  const rows = [
    { source: "process_start", timestamp: String(clocks.realtimeNs), data: { ...metadata, machineId: currentMachineIdentity().id } },
    { source: "clock_snapshot", timestamp: String(clocks.realtimeNs), data: Object.fromEntries(Object.entries(clocks).map(([k, v]) => [k, String(v)])) }
  ];
  writeFileSync(join(directory, "metadata.json"), JSON.stringify(rows), { flag: "wx", mode: 384 });
  return metadata;
}
function readDirectCapture(directory) {
  const metadata = JSON.parse(readFileSync3(join(directory, "metadata.json"), "utf8"));
  if (!Array.isArray(metadata) || !metadata.every((row) => row && typeof row === "object" && typeof row.source === "string" && typeof row.timestamp === "string" && row.data && typeof row.data === "object" && !Array.isArray(row.data)))
    throw new Error("Invalid Claude capture metadata");
  const rows = metadata;
  for (const file of readdirSync(directory).filter((p) => /^events-\d+\.jsonl$/.test(p)).sort()) {
    const { rows: valid, corruptRecords } = parseObservationJournal(readFileSync3(join(directory, file), "utf8"));
    rows.push(...valid);
    if (corruptRecords)
      rows.push({
        source: "recovery",
        timestamp: rows.at(-1).timestamp,
        data: { incomplete_chunk: file, corrupt_records: corruptRecords }
      });
  }
  return rows;
}
function finishDirectCapture(directory) {
  const rows = readDirectCapture(directory), identity = rows.find((r) => r.source === "process_start");
  const expected = resolve(directory);
  if (!expected.endsWith(".pftrace.capture") || !identity || typeof identity.data.output !== "string" || !isAbsolute(identity.data.output) || resolve(identity.data.output) !== expected.slice(0, -".capture".length) || typeof identity.data.directory !== "string" || resolve(identity.data.directory) !== expected || typeof identity.data.captureId !== "string" || !identity.data.captureId)
    throw new Error("Invalid Claude capture identity or output path");
  const output = identity.data.output, captureId = identity.data.captureId;
  const result = convertDirectObservations(rows);
  const corruptRecords = rows.filter((r) => r.source === "recovery").reduce((sum, r) => sum + Number(r.data.corrupt_records ?? 0), 0);
  const ownership = join(directory, "published");
  const owned = existsSync(ownership) ? JSON.parse(readFileSync3(ownership, "utf8")) : undefined;
  const replace = existsSync(output);
  if (replace) {
    const current = statSync(output);
    if (![owned, owned?.previous].some((marker) => marker?.captureId === captureId && marker.ino === current.ino && marker.dev === current.dev && marker.mtimeMs === current.mtimeMs))
      throw new Error(`Output already exists: ${output}`);
  }
  const temp = join(directory, "recording.tmp");
  writeFileSync(temp, result.trace, { mode: 384 });
  const published = statSync(temp);
  const marker = { captureId, ino: published.ino, dev: published.dev, mtimeMs: published.mtimeMs };
  writeFileSync(`${ownership}.tmp`, JSON.stringify({ ...marker, previous: owned }), { mode: 384 });
  renameSync(`${ownership}.tmp`, ownership);
  if (replace)
    renameSync(temp, output);
  else {
    linkSync(temp, output);
    unlinkSync(temp);
  }
  writeFileSync(`${ownership}.tmp`, JSON.stringify(marker), { mode: 384 });
  renameSync(`${ownership}.tmp`, ownership);
  if (existsSync(join(directory, "error.txt")))
    unlinkSync(join(directory, "error.txt"));
  writeFileSync(join(directory, "summary.json"), JSON.stringify({ output, ...result.summary, corruptRecords }, null, 2) + `
`, { mode: 384 });
  return { output, ...result.summary, corruptRecords };
}

// packages/claude-tracing/direct-writer.ts
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync as readFileSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var [command, path] = process.argv.slice(2);
try {
  if (!["init", "finish", "finalize", "worker"].includes(command ?? "") || command !== "init" && !path)
    throw new Error("Usage: direct-writer.mjs init [OUTPUT] | finish CAPTURE_DIRECTORY");
  if (command === "finalize" || command === "finish") {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker", path], { detached: true, windowsHide: true, stdio: "ignore" });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (command === "finalize") {
      child.unref();
      console.log(JSON.stringify({ saving: true }));
    } else {
      const code = await new Promise((resolve) => child.once("exit", resolve));
      if (code !== 0)
        throw new Error(readFileSync4(join2(path, "error.txt"), "utf8").trim());
      console.log(readFileSync4(join2(path, "summary.json"), "utf8"));
    }
  } else
    console.log(JSON.stringify(command === "init" ? initializeDirectCapture(path) : finishDirectCapture(path)));
} catch (error) {
  if (command === "worker" && path) {
    try {
      writeFileSync2(join2(path, "error.txt"), String(error) + `
`, { mode: 384 });
    } catch {}
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
