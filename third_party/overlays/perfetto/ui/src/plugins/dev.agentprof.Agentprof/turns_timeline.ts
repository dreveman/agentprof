// SPDX-License-Identifier: Apache-2.0

export function nanoseconds(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  return undefined;
}

export function intervalPosition(
  start: bigint,
  end: bigint,
  origin: bigint,
  limit: bigint,
) {
  if (limit <= origin) return {left: 0, width: 0, point: true};
  const clamp = (time: bigint) =>
    time < origin ? origin : time > limit ? limit : time;
  const left = clamp(start);
  const right = clamp(end < start ? start : end);
  const scale = (delta: bigint) =>
    Number((delta * 1_000_000n) / (limit - origin)) / 10_000;
  return {
    left: scale(left - origin),
    width: scale(right - left),
    point: end <= start,
  };
}

export function turnDuration(value: unknown): string {
  const ns = nanoseconds(value);
  if (ns === undefined || ns < 0n) return "Not recorded";
  if (ns === 0n) return "0 ms";
  if (ns < 1_000_000n) return "<1 ms";
  const ms = Number(ns / 1_000n) / 1000;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}
