#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// packages/muse-tracing/main.ts
import { spawnSync } from "node:child_process";
import { readFileSync as readFileSync3 } from "node:fs";
import { mkdir as mkdir2 } from "node:fs/promises";
import { dirname as dirname2, resolve as resolve2, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface as createInterface2 } from "node:readline";

// packages/muse-tracing/record.ts
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, link, readlink, realpath, stat, open } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// packages/pi-tracing/extensions/pi-tracing/tracer.ts
import { constants as fsConstants, readFileSync as readFileSync2 } from "node:fs";
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
function toolArgumentAnnotations(input, captureContents) {
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
  if (!captureContents)
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
var estimateContextTokens = (chars) => Math.ceil(chars / 4);
var count = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
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
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

// packages/muse-tracing/native.ts
var object = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
var string = (v) => typeof v === "string" ? v : "";
var integer = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
var validSession = (id) => /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(id);
var fields = {
  metadata: ["model_id", "provider_id", "build"],
  run_model: ["model_id", "provider_id", "profile_id"],
  session_end: ["exit_reason"],
  started: ["prompt", "task_id"],
  terminal: ["terminal", "reason", "duration_ms"],
  model_input_trace_recorded: ["schema_version", "model_step", "scope"],
  assistant_message_committed: ["message_id"],
  model_completed: ["duration_ms", "model", "usage", "finish_reason"],
  model_response_created: ["response_id"],
  assistant_tool_calls_committed: ["tool_calls"],
  tool_result_batch_committed: ["results"],
  tool_batch_effect: ["call_id", "task_id", "tool_name", "kind", "outcome"],
  proposed: ["task_kind"],
  side_effect_intent: ["operation", "idempotency_key", "parent_task_id"],
  failed: ["reason", "error"],
  cancelled: ["reason"],
  completed: [],
  task_stream_linked: ["task_id", "display"]
};
function readExport(raw, id) {
  const doc = object(raw);
  if (doc.export_schema_version !== 1 || !Array.isArray(doc.events))
    throw new Error("Unsupported Muse session export. Expected export_schema_version 1.");
  if (!doc.sessions?.some((s) => s.session_id === id && !s.is_copied_context))
    throw new Error(`Export does not contain session ${id}`);
  const records = [], seen = new Set;
  const diagnostics = {
    gaps: 0,
    omitted_live_only: 0,
    unparseable_lines: integer(doc.diagnostics?.unparseable_lines) ?? 0,
    unknown_payload_kinds: integer(doc.diagnostics?.unknown_payload_kinds) ?? 0
  };
  const consume = (envelope) => {
    if (envelope.stream?.id !== id || seen.has(envelope.id))
      return;
    seen.add(envelope.id);
    const us = integer(envelope.recorded_at);
    if (us === undefined)
      return;
    const p = object(envelope.payload), family = string(p.kind) || string(envelope.payload_type);
    const inner = object(p.event ?? p.record ?? p), kind = family === "tool_batch_effect" ? family : string(inner.kind) || family;
    const keys = fields[kind];
    const child = validSession(string(inner.child_session_id)) ? string(inner.child_session_id) : "";
    if (!keys && !child)
      return;
    const data = Object.fromEntries((keys ?? []).filter((k) => inner[k] !== undefined).map((k) => [k, inner[k]]));
    if (kind === "assistant_message_committed") {
      const chars = string(inner.text).length;
      data.context_chars = chars;
      data.context_tokens = estimateContextTokens(chars);
    }
    if (kind === "model_input_trace_recorded" && inner.schema_version === 2 && inner.scope === "full_request") {
      const b = object(inner.bounded);
      data.aggregates = (Array.isArray(b.aggregates) ? b.aggregates : []).map((raw) => {
        const a = object(raw);
        return {
          bytes: integer(a.byte_count),
          lane: string(a.logical_lane?.value),
          destination: string(a.provider_wire_destination?.value),
          source: string(a.source?.value)
        };
      });
      data.omitted_bytes = integer(b.omitted_aggregate_lane_bytes) ?? 0;
      data.omitted_groups = integer(b.omitted_aggregate_group_count) ?? 0;
    }
    if (kind === "tool_result_batch_committed")
      data.results = (inner.results ?? []).map((result) => {
        let outcome = {};
        try {
          outcome = object(JSON.parse(result.text));
        } catch {}
        const value = object(outcome);
        const chars = string(result.text).length;
        return {
          call_id: string(result.tool_call_id),
          context_chars: chars,
          context_tokens: estimateContextTokens(chars),
          ...Number.isSafeInteger(value.exit_code) && typeof value.terminal_status === "string" ? { exit_code: value.exit_code, terminal_status: value.terminal_status } : {}
        };
      });
    if (child)
      Object.assign(data, {
        child_session_id: child,
        child_session_log_path: string(inner.child_session_log_path),
        role: string(inner.reminder_agent_id) || string(inner.agent_type) || "subagent"
      });
    records.push({
      id: string(envelope.id),
      at: (BigInt(us) * 1000n).toString(),
      family,
      run: string(p.run_id),
      task: string(p.task_id ?? inner.task_id),
      kind,
      data
    });
  };
  for (const e of doc.events) {
    if (e.kind === "record")
      consume(e.envelope);
    else if (e.kind === "retained_frame") {
      for (const child of e.envelope?.children ?? []) {
        try {
          consume(JSON.parse(child.record_json));
        } catch {
          diagnostics.unparseable_lines++;
        }
      }
    } else if (e.kind === "gap" && (!e.stream?.id || e.stream.id === id)) {
      diagnostics[e.marker === "omitted_live_only" ? "omitted_live_only" : "gaps"]++;
    }
  }
  records.sort((a, b) => BigInt(a.at) < BigInt(b.at) ? -1 : BigInt(a.at) > BigInt(b.at) ? 1 : 0);
  return { id, records, diagnostics, missingChildren: [] };
}

// packages/muse-tracing/convert.ts
var min = (a, b) => a < b ? a : b;
var max = (a, b) => a > b ? a : b;
var controlPrompt = (text) => /^(?:\/)?tracing (?:start(?:[ \t]+[^\r\n]+)?|stop|status)$/.test(text.trim());
var controlTool = (text) => /(?:^|[._:/-])tracing_(start|stop|status)$/.test(text);
function convert(capture, native) {
  const first = BigInt(capture.start), last = BigInt(capture.end);
  if (last < first)
    throw new Error("Recording end precedes start");
  const sessions = [], slices = [], counters = [];
  const inputs = new Map, delegates = [];
  const add = (session, id, track, name, start, end, attrs) => {
    if (start > last || (end ?? start) < first)
      return;
    const partial = start < first || end !== undefined && end > last;
    const s = {
      session,
      id: `${session}:${id}`,
      track,
      name,
      start: max(first, start),
      ...end !== undefined ? { end: min(last, max(start, end)) } : {},
      attrs: { ...attrs, ...partial ? { incomplete: true } : {} },
      flows: []
    };
    slices.push(s);
    return s;
  };
  const edge = (a, b) => {
    if (!a || !b || b.start < a.start)
      return;
    const flow = fnv1a64(`${capture.id}:${a.id}:${b.id}`) || 1n;
    a.flows.push(flow);
    b.flows.push(flow);
  };
  for (const source of native) {
    const { records, id } = source;
    if (!records.some((r) => BigInt(r.at) >= first && BigInt(r.at) <= last) && id !== capture.session)
      continue;
    const metadata = records.find((r) => r.kind === "metadata")?.data ?? {};
    const start = id === capture.session ? first : max(first, BigInt(records[0]?.at ?? capture.start));
    const end = id === capture.session ? last : min(last, BigInt(records.at(-1)?.at ?? capture.end));
    const session = { id, start, end: max(start, end), attrs: {
      harness: "muse",
      recorder_version: "muse-plugin-1",
      timing: "native-export",
      model: string(metadata.model_id),
      provider: string(metadata.provider_id),
      harness_version: string(metadata.build?.semver),
      ...source.parent ? { parent_session: source.parent, child_role: source.role ?? "subagent" } : {},
      ...capture.incomplete || source.diagnostics.gaps || source.diagnostics.unparseable_lines ? { incomplete: true } : {},
      export_gaps: source.diagnostics.gaps ?? 0,
      omitted_live_only: source.diagnostics.omitted_live_only ?? 0,
      unavailable_child_sessions: source.missingChildren.length
    } };
    sessions.push(session);
    const prompts = new Map, calls = new Map, tools = new Map;
    const tasks = new Map;
    const emittedTasks = new Set;
    const results = new Map;
    const configuration = (at, model) => {
      const hook = capture.hooks.findLast((h) => h.session === id && h.event === "PreLLMCall" && BigInt(h.at) <= at);
      const run = records.findLast((r) => r.kind === "run_model" && BigInt(r.at) <= at);
      const name = model || hook?.model || string(run?.data.model_id) || string(session.attrs.model);
      const provider = hook?.provider || string(run?.data.provider_id) || string(session.attrs.provider);
      const limit = capture.catalog.find((m) => m.model === name && m.provider === provider)?.context;
      return { model: name, provider, ...hook?.effort ? { effort: hook.effort } : {}, ...limit ? { context_window_tokens: limit } : {} };
    };
    Object.assign(session.attrs, configuration(start));
    const contextTracker = new ContextTracker;
    let contextItems = [];
    const compactEnds = capture.hooks.filter((h) => h.session === id && h.event === "PostCompact").map((h) => BigInt(h.at)).sort(compareTime);
    let compactIndex = 0;
    let requestContext;
    for (const r of records) {
      const d = r.data, at = BigInt(r.at);
      if (r.family === "run" && r.kind === "started" && !controlPrompt(string(d.prompt))) {
        const terminal = records.find((n) => n.run === r.run && n.family === "run" && n.kind === "terminal" && BigInt(n.at) >= at);
        const p = add(id, r.id, "Session", "prompt", at, terminal ? BigInt(terminal.at) : last, {
          kind: "prompt",
          turn_id: r.run,
          ...promptAnnotations(d.prompt, true),
          ...!terminal ? { incomplete: true } : {},
          ...terminal?.data.terminal && terminal.data.terminal !== "completed" ? { outcome: string(terminal.data.terminal) } : {}
        });
        if (p) {
          prompts.set(r.run, p);
          const input = add(id, `${r.id}:input`, "Inputs", "prompt-input", at, undefined, { source: source.parent ? "agent" : "user" });
          edge(input, p);
          if (input && !inputs.has(id))
            inputs.set(id, input);
        }
      }
      if (r.kind === "assistant_tool_calls_committed")
        for (const call of d.tool_calls ?? [])
          calls.set(string(call.call_id), { ...call, at, run: r.run });
      if (r.kind === "tool_result_batch_committed")
        for (const result of d.results ?? [])
          results.set(result.call_id, result);
      if (r.family === "task") {
        const task = tasks.get(r.task) ?? { start: at, kind: "", run: r.run };
        tasks.set(r.task, task);
        if (r.kind === "proposed")
          task.kind = string(d.task_kind);
        if (r.kind === "side_effect_intent") {
          task.operation = string(d.operation);
          if (string(d.idempotency_key).startsWith("tool:"))
            task.call = string(d.idempotency_key).slice(5);
        }
        if (r.kind === "started")
          task.start = at;
        if (["completed", "failed", "cancelled"].includes(r.kind)) {
          task.end = at;
          task.error = r.kind !== "completed";
        }
      }
    }
    const responses = [];
    for (const r of records) {
      const d = r.data, at = BigInt(r.at);
      while (compactIndex < compactEnds.length && compactEnds[compactIndex] <= at) {
        contextItems = [];
        requestContext = undefined;
        contextTracker.reset();
        compactIndex++;
      }
      if (r.kind === "assistant_message_committed" && integer(d.context_tokens) !== undefined)
        contextItems.push({
          id: string(d.message_id) || r.id,
          category: "assistant",
          tokens: d.context_tokens,
          chars: d.context_chars,
          label: "Assistant history",
          source_kind: "response"
        });
      if (r.kind === "model_input_trace_recorded" && Array.isArray(d.aggregates)) {
        const categories = {};
        for (const a of d.aggregates) {
          const bytes = integer(a.bytes);
          if (bytes === undefined || !bytes)
            continue;
          const key = a.lane === "system_base" ? "system" : a.lane === "tool_result" ? "results" : a.lane === "tool_specs" ? "tools" : a.source === "current_user" ? "prompts" : a.lane === "history" && a.destination === "message.role:assistant" ? "assistant" : a.lane === "history" ? "messages" : "unattributed";
          categories[key] = (categories[key] ?? 0) + Math.ceil(bytes / 4);
        }
        if (integer(d.omitted_bytes))
          categories.unattributed = (categories.unattributed ?? 0) + Math.ceil(d.omitted_bytes / 4);
        requestContext = { at, items: [...contextItems], categories };
      }
      if (r.family === "run" && r.kind === "started" && !controlPrompt(string(d.prompt))) {
        const chars = string(d.prompt).length;
        contextItems.push({ id: r.id, category: "prompts", chars, tokens: estimateContextTokens(chars), source_kind: "prompt", label: "User prompt" });
      }
      if (r.kind === "tool_result_batch_committed")
        for (const result of d.results ?? []) {
          const n = integer(result.context_tokens);
          if (n !== undefined)
            contextItems.push({
              id: `result:${result.call_id}`,
              category: "results",
              tokens: n,
              chars: integer(result.context_chars),
              source_id: string(result.call_id),
              source_kind: "tool",
              label: "Tool result"
            });
        }
      if (r.kind === "assistant_tool_calls_committed")
        for (const call of d.tool_calls ?? []) {
          const chars = typeof call.args === "string" ? call.args.length : JSON.stringify(call.args ?? {}).length;
          contextItems.push({ id: `call:${call.call_id}`, category: "assistant", chars, tokens: estimateContextTokens(chars), source_kind: "tool", source_id: string(call.call_id), label: "Tool arguments" });
        }
      if (r.kind === "model_completed") {
        const duration = integer(d.duration_ms), begin = duration !== undefined ? at - BigInt(duration) * 1000000n : at;
        const compaction = capture.hooks.some((h) => h.session === id && h.event === "PreCompact" && BigInt(h.at) <= begin && at <= BigInt(capture.hooks.find((n) => n.session === id && n.event === "PostCompact" && BigInt(n.at) >= BigInt(h.at))?.at ?? capture.end));
        const attrs = {
          kind: compaction ? "compaction-response" : "assistant-message",
          ...configuration(at, string(d.model)),
          timing: duration === undefined ? "unmeasured" : "native-duration",
          stop_reason: string(d.finish_reason)
        };
        const usage = object(d.usage);
        if (begin >= first && at <= last) {
          for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"]) {
            const value = integer(usage[key]);
            if (value !== undefined)
              attrs[key] = value;
          }
          if (attrs.cache_read_tokens === undefined && integer(usage.cached_tokens) !== undefined)
            attrs.cache_read_tokens = usage.cached_tokens;
          if (attrs.input_tokens !== undefined) {
            attrs.context_tokens = attrs.input_tokens;
            attrs.context_source = "reported-input";
          }
        }
        if (duration === undefined)
          attrs.incomplete = true;
        const response = add(id, r.id, compaction ? "Compaction responses" : "Responses", "response", begin, at, attrs);
        if (response) {
          responses.push(response);
          edge(prompts.get(r.run), response);
          if (!compaction && (requestContext || contextItems.length)) {
            const snapshot = contextTracker.snapshot(requestContext?.items ?? contextItems, {
              stage: requestContext ? "request-input" : "transcript-observed",
              basis: requestContext ? "native-bytes/4" : "chars/4",
              ...requestContext ? { categories: requestContext.categories, item_stage: "transcript-observed", reported_tokens: integer(attrs.context_tokens) } : {},
              coverage: "partial",
              model: string(attrs.model),
              window_tokens: integer(attrs.context_window_tokens)
            });
            attachContext(response, snapshot, counters, requestContext ? max(response.start, requestContext.at) : at);
          }
          if (!compaction)
            add(id, `${r.id}:turn`, "Turns", "turn", begin, at, { kind: "turn" });
        }
        requestContext = undefined;
      }
      if (r.kind === "tool_batch_effect" && d.kind === "started") {
        emittedTasks.add(string(d.task_id));
        const call = calls.get(string(d.call_id)), name = string(d.tool_name) || string(call?.name) || "tool";
        if (controlTool(name))
          continue;
        const terminal = records.find((n) => n.kind === "tool_batch_effect" && n.data.kind === "terminal" && n.data.call_id === d.call_id);
        const outcome = object(terminal?.data.outcome), task = tasks.get(string(d.task_id));
        const result = ["bash", "bash_input"].includes(name) ? results.get(string(d.call_id)) : undefined;
        const incomplete = !terminal, failed = task?.error || terminal && outcome.kind !== "completed" || result?.exit_code !== undefined && result.exit_code !== 0;
        let args = call?.args;
        try {
          if (typeof args === "string")
            args = JSON.parse(args);
        } catch {}
        const tool = add(id, r.id, "Tools", name, task?.start ?? at, terminal ? BigInt(terminal.at) : last, {
          kind: "tool-execution",
          name,
          call_id: string(d.call_id),
          ...toolArgumentAnnotations(args, true),
          ...typeof object(args).description === "string" ? { intent: string(object(args).description).slice(0, 1024) } : {},
          ...result?.exit_code !== undefined ? { exit_code: result.exit_code, outcome: result.terminal_status } : {},
          ...incomplete ? { incomplete: true } : { is_error: Boolean(failed) },
          ...!result && outcome.kind ? { outcome: string(outcome.kind) } : {}
        });
        if (tool) {
          tools.set(string(d.call_id), tool);
          edge(responses.findLast((s) => s.end <= tool.start), tool);
        }
      }
      if (d.child_session_id && at <= last) {
        const task = tasks.get(r.task);
        const s = add(id, r.id, "Delegates", "delegate", task?.start ?? at, task?.end ?? last, { kind: "child-operation", child_session: string(d.child_session_id), role: string(d.role), ...!task?.end ? { incomplete: true } : {} });
        if (s) {
          delegates.push({ slice: s, child: string(d.child_session_id) });
          edge(prompts.get(r.run), s);
        }
      }
    }
    for (const [key, task] of tasks)
      if (task.kind.startsWith("tool.") && !emittedTasks.has(key)) {
        const name = task.kind.slice(5);
        if (controlTool(name))
          continue;
        const candidates = [...calls.values()].filter((c) => c.name === name && c.run === task.run && c.at <= task.start && !tools.has(c.call_id));
        const call = task.call ? calls.get(task.call) : candidates.length === 1 ? candidates[0] : undefined;
        let args = call?.args;
        try {
          if (typeof args === "string")
            args = JSON.parse(args);
        } catch {}
        const tool = add(id, key, "Tools", name, task.start, task.end ?? last, {
          kind: "tool-execution",
          name,
          ...call ? { call_id: string(call.call_id), ...toolArgumentAnnotations(args, true) } : {},
          ...task.end ? { is_error: Boolean(task.error) } : { incomplete: true }
        });
        if (tool) {
          if (call)
            tools.set(call.call_id, tool);
          edge(responses.findLast((s) => s.end <= tool.start), tool);
        }
      }
    for (const [key, task] of tasks)
      if (task.kind.startsWith("model.") && !responses.some((r) => r.start >= task.start && r.start <= (task.end ?? last))) {
        add(id, key, "Requests", "request", task.start, task.end ?? last, { kind: "provider-request", incomplete: true, ...task.error ? { is_error: true } : {} });
      }
    for (const h of capture.hooks.filter((h) => h.session === id && h.event === "PreCompact")) {
      const end = capture.hooks.find((n) => n.session === id && n.event === "PostCompact" && BigInt(n.at) >= BigInt(h.at));
      add(id, `compact:${h.at}`, "Compaction", "compaction", BigInt(h.at), BigInt(end?.at ?? capture.end), { kind: "compaction", trigger: h.trigger ?? "unknown", ...!end ? { incomplete: true } : {} });
    }
    responses.sort((a, b) => compareTime(a.end, b.end));
    for (const [name, key, cumulative] of [
      ["Input tokens", "input_tokens", true],
      ["Output tokens", "output_tokens", true],
      ["Context size", "context_tokens", false],
      ["Context window", "context_window_tokens", false]
    ]) {
      let total = 0;
      const samples = responses.flatMap((s) => {
        const value = integer(s.attrs[key]);
        if (value === undefined)
          return [];
        total = cumulative ? total + value : value;
        return [{ at: s.end, value: total }];
      });
      counters.push({ session: id, name, unit: "tokens", ...!cumulative ? { axis: "llm.context.tokens" } : {}, samples });
    }
    const peak = Math.max(0, ...responses.map((r) => Number(r.attrs.context_tokens ?? 0)));
    if (responses.some((r) => r.attrs.context_tokens !== undefined))
      session.attrs.peak_context_tokens = peak;
    let previous = "";
    for (const r of responses) {
      const attrs = {
        kind: "configuration",
        harness: "muse",
        model: r.attrs.model,
        provider: r.attrs.provider,
        ...r.attrs.effort ? { effort: r.attrs.effort } : {},
        ...r.attrs.context_window_tokens ? { context_window_tokens: r.attrs.context_window_tokens } : {}
      };
      const text = JSON.stringify(attrs);
      if (text === previous)
        continue;
      previous = text;
      add(id, `${r.id}:configuration`, "Configuration", "run-configuration", r.start, r.start, attrs);
    }
  }
  for (const { slice, child } of delegates)
    edge(slice, inputs.get(child));
  const trace = writeTrace({
    capture: capture.id,
    pid: capture.pid,
    machineId: capture.machineId,
    processName: "muse",
    processLabel: "Muse Code",
    category: "muse",
    sessions,
    slices,
    counters,
    clocks: capture.clocks.map((c) => ({ realtimeNs: BigInt(c.realtimeNs), boottimeNs: BigInt(c.boottimeNs) }))
  });
  const messages = slices.filter((s) => s.attrs.kind === "assistant-message");
  return { trace, summary: {
    sessions: sessions.length,
    responses: messages.length,
    tools: slices.filter((s) => s.attrs.kind === "tool-execution").length,
    inputTokens: messages.reduce((n, s) => n + Number(s.attrs.input_tokens ?? 0), 0),
    outputTokens: messages.reduce((n, s) => n + Number(s.attrs.output_tokens ?? 0), 0),
    unavailableChildren: native.reduce((n, s) => n + s.missingChildren.length, 0)
  } };
}

// packages/muse-tracing/record.ts
var execute = promisify(execFile);
var now = () => (BigInt(Date.now()) * 1000000n).toString();
var dataDirectory = () => process.env.MUSE_PLUGIN_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "muse/plugins/data/agentprof");
var clock = () => {
  const c = captureClockReadings();
  return { realtimeNs: c.realtimeNs.toString(), boottimeNs: c.boottimeNs.toString() };
};
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 384, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT")
      return;
    throw e;
  }
}
function statePath(data, id) {
  if (!validSession(id))
    throw new Error("Muse did not supply a valid session identity");
  return join(data, "sessions", `${id}.json`);
}
async function locked(data, id, fn) {
  const path = statePath(data, id), lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 448 });
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      await mkdir(lock, { mode: 448 });
      break;
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 120000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (error) {
        if (error.code === "ENOENT")
          continue;
        throw error;
      }
      if (Date.now() >= deadline)
        throw new Error("Recording is busy. Retry shortly.");
      await delay(50);
    }
  }
  try {
    return await fn(path);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
function nativeEnv(data) {
  return { ...process.env, MUSE_NO_AUTO_UPDATE: "1", XDG_DATA_HOME: resolve(data, "../../../..") };
}
async function catalog(binary = "muse", data = dataDirectory()) {
  const host = spawn(binary, ["serve"], { env: nativeEnv(data), stdio: ["pipe", "pipe", "pipe"] });
  host.stderr.resume();
  let serial = 0;
  const pending = new Map;
  const fail = (e) => {
    for (const p of pending.values())
      p.reject(e);
    pending.clear();
  };
  host.once("error", fail);
  host.once("exit", () => fail(new Error("Muse catalog host exited")));
  const lines = createInterface({ input: host.stdout });
  lines.on("line", (line) => {
    try {
      const m = JSON.parse(line), p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    } catch {}
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    host.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + `
`);
  });
  const timer = setTimeout(() => {
    fail(new Error("Timed out reading Muse model catalog"));
    host.kill();
  }, 1e4);
  try {
    await send("initialize", { clientInfo: { name: "agentprof", version: "0.2.0" } });
    host.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + `
`);
    const result = await send("model/list");
    return (result.models ?? []).filter((m) => integer(m.contextLimit)).map((m) => ({ model: string(m.modelId), provider: string(m.providerId), context: m.contextLimit }));
  } finally {
    clearTimeout(timer);
    lines.close();
    host.stdin.end();
    host.kill();
  }
}
async function exportSessions(recording, data) {
  const result = [], seen = new Set, deadline = Date.now() + 45000;
  const temporary = await mkdtemp(join(tmpdir(), "agentprof-muse-export-"));
  const visit = async (id, parent, role, path) => {
    if (seen.has(id))
      return;
    if (seen.size >= 128 || Date.now() >= deadline) {
      if (parent)
        parent.missingChildren.push(id);
      return;
    }
    seen.add(id);
    try {
      const exported = join(temporary, `${id}.json`);
      await execute(recording.binary, ["export", "--session", path || id, "--out", exported], {
        env: nativeEnv(data),
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: Math.max(1, Math.min(15000, deadline - Date.now()))
      });
      if ((await stat(exported)).size > 256 * 1024 * 1024)
        throw new Error("Muse session export exceeds 256 MiB");
      const session = readExport(JSON.parse(await readFile(exported, "utf8")), id);
      await rm(exported);
      const configuration = (await readJson(statePath(data, id)))?.configuration ?? [];
      for (const h of configuration)
        if (!recording.capture.hooks.some((n) => n.session === h.session && n.at === h.at))
          recording.capture.hooks.push(h);
      recording.capture.hooks.sort((a, b) => BigInt(a.at) < BigInt(b.at) ? -1 : BigInt(a.at) > BigInt(b.at) ? 1 : 0);
      if (parent) {
        session.parent = parent.id;
        session.role = role;
      }
      result.push(session);
      for (const r of session.records)
        if (r.data.child_session_id && BigInt(r.at) <= BigInt(recording.capture.end)) {
          const candidate = string(r.data.child_session_log_path), root = resolve(data, "../../../sessions");
          let parentLog = path;
          if (!parentLog && id[14] === "7") {
            const date = new Date(Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16)).toISOString().slice(0, 10).replaceAll("-", "/");
            parentLog = join(root, date, id, "session.jsonl");
          }
          let childPath;
          if (candidate && (isAbsolute(candidate) || parentLog)) {
            try {
              const resolved = await realpath(resolve(parentLog ? dirname(parentLog) : root, candidate));
              if (resolved.startsWith(await realpath(root) + sep))
                childPath = resolved;
            } catch {}
          }
          await visit(r.data.child_session_id, session, r.data.role, childPath);
        }
    } catch (e) {
      if (!parent)
        throw e;
      parent.missingChildren.push(id);
    }
  };
  try {
    await visit(recording.session);
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
async function control(data, id, action, output) {
  return locked(data, id, async (path) => {
    const record = await readJson(path);
    if (!record)
      throw new Error("No session hook received. Install and approve the Agent Profiler plugin, then start a new Muse session.");
    if (action === "start" && !record.capture) {
      const config = await readJson(join(data, "config.json"));
      const target = resolve(record.cwd, output ?? config?.output_directory ?? join(record.cwd, "agentprof-traces"), ...output ? [] : [`muse-${new Date().toISOString().replace(/[:.]/g, "-")}-${id.slice(0, 8)}-${randomUUID().slice(0, 8)}.pftrace`]);
      if (!target.endsWith(".pftrace"))
        throw new Error("Output path must end in .pftrace");
      await mkdir(dirname(target), { recursive: true, mode: 448 });
      try {
        await stat(target);
        throw new Error(`Output already exists: ${target}`);
      } catch (e) {
        if (e.code !== "ENOENT")
          throw e;
      }
      let models = [];
      const cached = await readJson(join(data, "catalog.json"));
      if (cached && Date.now() - cached.at < 86400000)
        models = cached.models;
      else
        try {
          models = await catalog(record.binary, data);
          await atomicJson(join(data, "catalog.json"), { at: Date.now(), models });
        } catch {}
      record.capture = {
        id: randomUUID(),
        session: id,
        pid: record.pid,
        machineId: currentMachineIdentity().id,
        start: now(),
        end: now(),
        clocks: [clock()],
        catalog: models,
        hooks: []
      };
      if (record.model)
        record.capture.hooks.push({
          at: record.capture.start,
          session: id,
          event: "PreLLMCall",
          model: record.model,
          provider: record.provider,
          effort: record.effort
        });
      record.output = target;
      record.saved = undefined;
      record.summary = undefined;
      record.stopping = false;
      record.watcher = undefined;
      await atomicJson(path, record);
    } else if (["stop", "recover", "finish"].includes(action) && record.capture) {
      if (!record.stopping) {
        record.capture.end = now();
        record.capture.clocks.push(clock());
        record.stopping = true;
      }
      if (action === "recover")
        record.capture.incomplete = true;
      await atomicJson(path, record);
      const sessions = await exportSessions(record, data);
      if (action === "finish" && record.stopping) {
        const end = sessions[0]?.records.findLast((r) => r.kind === "session_end");
        if (end && BigInt(end.at) >= BigInt(record.capture.start) && BigInt(end.at) <= BigInt(record.capture.end))
          record.capture.end = end.at;
        if (!end && !alive(record.pid) || end?.data.exit_reason && end.data.exit_reason !== "clean")
          record.capture.incomplete = true;
      }
      const converted = convert(record.capture, sessions);
      const temporary = join(dirname(record.output), `.agentprof-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, converted.trace, { flag: "wx", mode: 384 });
        await link(temporary, record.output);
      } finally {
        await rm(temporary, { force: true });
      }
      record.saved = record.output;
      record.summary = converted.summary;
      record.capture = undefined;
      record.stopping = false;
      await atomicJson(path, record);
    } else if (!["start", "stop", "recover", "status", "finish"].includes(action))
      throw new Error("Unknown recording action");
    return {
      state: record.capture ? record.stopping ? "pending" : "recording" : record.saved ? "saved" : "idle",
      session_id: id,
      output_path: record.output ?? record.saved,
      ...record.summary ? { summary: record.summary } : {}
    };
  });
}
async function hook(data, payload, pid = process.ppid) {
  const id = string(payload.session_id), event = string(payload.hook_event_name), at = now();
  const command = string(payload.prompt).trim();
  await locked(data, id, async (path) => {
    let record = await readJson(path);
    if (!record) {
      let binary = "muse";
      if (process.platform === "linux")
        try {
          const executable = await readlink(`/proc/${pid}/exe`);
          if (/(?:^|\/)muse(?:-bin[^/]*)?$/.test(executable))
            binary = executable;
        } catch {}
      record = { session: id, pid, cwd: string(payload.cwd) || process.cwd(), binary, lastSeen: at };
    }
    if (event === "SessionStart" && record.pid !== pid) {
      if (record.capture)
        throw new Error(`Previous capture needs recovery: agentprof-muse recover --session ${id}`);
      record.pid = pid;
      record.cwd = string(payload.cwd) || record.cwd;
    }
    record.lastSeen = at;
    if (payload.model)
      record.model = string(payload.model);
    if (payload.model_provider)
      record.provider = string(payload.model_provider);
    if (event === "PreLLMCall") {
      const options = object(payload.options);
      const effort = options["meta.reasoning.effort"] ?? options["reasoning.effort"] ?? options.reasoning_effort;
      record.effort = string(effort) || undefined;
      const h = { at, session: id, event, model: record.model, provider: record.provider, effort: record.effort };
      const previous = record.configuration?.at(-1);
      if (!previous || previous.model !== h.model || previous.provider !== h.provider || previous.effort !== h.effort) {
        record.configuration ??= [];
        record.configuration.push(h);
        if (record.configuration.length > 4096)
          record.configuration.shift();
      }
    }
    if (record.capture && !record.stopping && ["PreLLMCall", "PreCompact", "PostCompact"].includes(event)) {
      record.capture.hooks.push({
        at,
        session: id,
        event,
        model: record.model,
        provider: record.provider,
        effort: record.effort,
        trigger: string(payload.trigger) || undefined
      });
      if (BigInt(at) - BigInt(record.capture.clocks.at(-1).realtimeNs) > 60000000000n)
        record.capture.clocks.push(clock());
    }
    await atomicJson(path, record);
  });
  if (event === "SubagentStart" && validSession(string(payload.child_session_id))) {
    const child = string(payload.child_session_id), parent = await readJson(statePath(data, id));
    if (child !== id)
      await locked(data, child, async (path) => {
        const record = await readJson(path) ?? { session: child, pid, cwd: parent.cwd, binary: parent.binary, lastSeen: at };
        record.parentSession = id;
        await atomicJson(path, record);
      });
  }
  if (event === "UserPromptSubmit" && controlPrompt(command)) {
    const [, action, output] = /^(?:\/)?tracing (start|stop|status)(?:\s+(.+))?$/.exec(command);
    const result = await control(data, id, action, output);
    const message = `Agent Profiler: ${result.state}${result.output_path ? ` — ${result.output_path}` : ""}`;
    return { decision: "block", reason: message, systemMessage: message };
  }
  if (event === "SessionStart" && payload.source !== "fork" && !(await readJson(statePath(data, id)))?.parentSession && (await readJson(join(data, "config.json")))?.auto_start) {
    const result = await control(data, id, "start");
    return { systemMessage: `Agent Profiler recording: ${result.output_path}` };
  }
  if (event === "SessionEnd") {
    const result = await control(data, id, "finish");
    if (result.state === "saved")
      return { systemMessage: `Agent Profiler trace saved: ${result.output_path}` };
  }
  return {};
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
async function ensureWatcher(data, id, script) {
  await locked(data, id, async (path) => {
    const record = await readJson(path);
    if (!record?.capture || record.watcher && alive(record.watcher))
      return;
    const log = await open(join(data, "watcher.log"), "a", 384);
    try {
      const child = spawn(process.execPath, [script, "watch", "--session", id], {
        env: { ...process.env, MUSE_PLUGIN_DATA_DIR: data },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log.fd, log.fd]
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      child.unref();
      record.watcher = child.pid;
      await atomicJson(path, record);
    } finally {
      await log.close();
    }
  });
}
async function watch(data, id) {
  const initial = await readJson(statePath(data, id));
  if (!initial?.capture)
    return;
  const captureId = initial.capture.id;
  while (true) {
    const record = await readJson(statePath(data, id));
    if (record?.capture?.id !== captureId)
      return;
    if (!alive(record.pid)) {
      const result = await control(data, id, "finish");
      console.log(`Agent Profiler trace saved: ${result.output_path}`);
      return;
    }
    await delay(1000);
  }
}

// packages/muse-tracing/main.ts
var tools = ["start", "stop", "status"].map((action) => ({
  name: `tracing_${action}`,
  description: action === "start" ? "Start recording this Muse Code session and its recorded subagents. Returns the local Perfetto trace output path." : action === "stop" ? "Stop recording and save this session’s Perfetto trace. Returns the saved file path." : "Get this session’s recording state and output path.",
  inputSchema: { type: "object", properties: action === "start" ? { output_path: { type: "string", description: "New .pftrace path, relative to the session working directory." } } : {}, additionalProperties: false },
  annotations: { readOnlyHint: action === "status", destructiveHint: false, openWorldHint: false }
}));
var script = fileURLToPath(import.meta.url);
async function mcp(data) {
  const session = process.env.MUSE_SESSION_ID ?? "";
  const lines = createInterface2({ input: process.stdin, crlfDelay: Infinity });
  const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
  for await (const line of lines) {
    if (line.length > 1024 * 1024)
      continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id === undefined)
      continue;
    if (m.method === "initialize") {
      reply(m.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agentprof", version: "0.2.0" } });
      continue;
    }
    if (m.method === "tools/list") {
      reply(m.id, { tools });
      continue;
    }
    if (m.method === "ping") {
      reply(m.id, {});
      continue;
    }
    if (m.method !== "tools/call") {
      console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } }));
      continue;
    }
    try {
      const params = object(m.params), name = string(params.name), args = object(params.arguments);
      if (!tools.some((t) => t.name === name))
        throw new Error("Unknown tracing tool");
      if (Object.keys(args).some((k) => name !== "tracing_start" || k !== "output_path") || args.output_path !== undefined && typeof args.output_path !== "string")
        throw new Error("Invalid tracing arguments");
      const result = await control(data, session, name.slice(8), args.output_path);
      if (result.state === "recording")
        await ensureWatcher(data, session, script);
      reply(m.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
    } catch (e) {
      reply(m.id, { isError: true, content: [{ type: "text", text: String(e) }] });
    }
  }
}
var args = process.argv.slice(2);
var action = args.shift();
var data = dataDirectory();
try {
  if (action === "hook") {
    const payload = object(JSON.parse(readFileSync3(0, "utf8")));
    try {
      const result = await hook(data, payload);
      await ensureWatcher(data, string(payload.session_id), script);
      console.log(JSON.stringify(result));
    } catch (error) {
      const message = `Agent Profiler: ${String(error)}`;
      console.log(JSON.stringify(payload.hook_event_name === "UserPromptSubmit" && controlPrompt(string(payload.prompt)) ? { decision: "block", reason: message, systemMessage: message } : { systemMessage: message }));
    }
  } else if (action === "mcp")
    await mcp(data);
  else if (action === "watch")
    await watch(data, args[args.indexOf("--session") + 1] ?? "");
  else if (action === "install") {
    const plugin = resolve2(dirname2(fileURLToPath(import.meta.url)), "..");
    const install = spawnSync("muse", ["plugins", "install", plugin, "--scope", args.includes("--project") ? "project" : "user"], { stdio: "inherit", env: { ...process.env, MUSE_NO_AUTO_UPDATE: "1" } });
    if (install.status !== 0)
      throw new Error(`Muse plugin installation failed: ${install.error ?? install.status}`);
    await mkdir2(data, { recursive: true, mode: 448 });
    try {
      await atomicJson(join2(data, "catalog.json"), { at: Date.now(), models: await catalog("muse", data) });
    } catch {}
    console.log(`Installed Agent Profiler. Review and enable its hooks and tools with:
  muse plugins approve agentprof
Then start Muse normally and type: tracing start
Type tracing stop to save, or exit Muse to finish recording.`);
  } else if (action === "configure") {
    if (args.length !== 1 || !["--auto-start", "--manual"].includes(args[0]))
      throw new Error("Use configure --auto-start or configure --manual");
    await mkdir2(data, { recursive: true, mode: 448 });
    await atomicJson(join2(data, "config.json"), { auto_start: args[0] === "--auto-start" });
    console.log(`Muse tracing: ${args[0] === "--auto-start" ? "start automatically in new sessions" : "start manually"}`);
  } else if (["start", "stop", "status", "recover"].includes(action ?? "")) {
    const index = args.indexOf("--session"), id = index >= 0 ? args.splice(index, 2)[1] : process.env.MUSE_SESSION_ID;
    if (!id)
      throw new Error("Provide --session SESSION_ID, or use the recording controls inside Muse.");
    const result = await control(data, id, action, args[0]);
    if (result.state === "recording")
      await ensureWatcher(data, id, script);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Usage: agentprof-muse install [--project] | configure --auto-start|--manual | start [OUTPUT.pftrace] --session ID | stop|status|recover --session ID");
    if (action && action !== "--help")
      process.exitCode = 2;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
