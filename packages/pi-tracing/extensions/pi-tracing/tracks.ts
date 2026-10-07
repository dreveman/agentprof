// SPDX-License-Identifier: Apache-2.0
import {CONTEXT_CATEGORIES} from './context.ts';
// Track model: root process descriptor + named generic child tracks +
// free-lane tool allocator + one counter track per metric. Categories are
// filters and never become threads; see tracks.ts consumers in tracer.ts.

import {
  CLOCK_BOOTTIME,
  CLOCK_MONOTONIC,
  CLOCK_PI_CUSTOM,
  CLOCK_REALTIME,
  COUNTER_UNIT_BYTES,
  COUNTER_UNIT_COUNT,
  COUNTER_UNIT_UNSPECIFIED,
  SIBLING_MERGE_BY_TRACK_NAME,
  SIBLING_MERGE_NONE,
  buildClockSnapshot,
  buildTracePacket,
  buildTrackDescriptor,
  framePacket,
} from "./encoder.ts";

export interface ProcessIdentity {
  /** Actual OS process ID. Logical agents must never receive synthetic PIDs. */
  pid: number;
  processName: string;
  labels: string[];
  /** Supply only a verified OS thread ID, never a JavaScript worker ID. */
  mainThread?: {tid: number; name?: string};
}

export interface CounterSpec {
  key: string;
  trackName: string;
  unit: number;
  unitName: string;
  yAxisShareKey?: string;
  category?: "llm" | "runtime";
  group?: "Runtime" | "Tracing" | "Context";
  description?: string;
}

export const DEFAULT_COUNTERS: CounterSpec[] = [
  ...Object.entries(CONTEXT_CATEGORIES).map(([key, name]): CounterSpec => ({key: `context.${key}`, trackName: name,
    unit: COUNTER_UNIT_UNSPECIFIED, unitName: 'tokens', yAxisShareKey: 'llm.context.tokens', category: 'llm', group: 'Context'})),
  { key: "llm.tokens.input", trackName: "Input tokens", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", category: "llm" },
  { key: "llm.tokens.output", trackName: "Output tokens", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", category: "llm" },
  { key: "llm.context.estimated_tokens", trackName: "Context size", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", yAxisShareKey: "llm.context.tokens", category: "llm" },
  { key: "llm.context.window_tokens", trackName: "Context window", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "tokens", yAxisShareKey: "llm.context.tokens", category: "llm" },
  { key: "runtime.rss", trackName: "Resident memory", group: "Runtime", unit: COUNTER_UNIT_BYTES, unitName: "bytes" },
  { key: "runtime.heap", trackName: "JS heap", group: "Runtime", unit: COUNTER_UNIT_BYTES, unitName: "bytes" },
  // process.cpuUsage() reports microseconds. Perfetto has no microsecond enum;
  // leave the enum unspecified and use the free-form unit instead.
  { key: "runtime.cpu", trackName: "CPU time (interval)", description: "Process CPU time consumed since the previous sample, in microseconds; not utilization.", group: "Runtime", unit: COUNTER_UNIT_UNSPECIFIED, unitName: "us" },
  { key: "tracing.droppedEvents", trackName: "Dropped events", group: "Tracing", unit: COUNTER_UNIT_COUNT, unitName: "count" },
  { key: "tracing.queueDepth", trackName: "Queue depth", group: "Tracing", unit: COUNTER_UNIT_COUNT, unitName: "count" },
  { key: "tracing.laneOverflows", trackName: "Lane overflows", group: "Tracing", unit: COUNTER_UNIT_COUNT, unitName: "count" },
];

export function randomUuid64(used: Set<string>): bigint {
  const values = new BigUint64Array(1);
  for (let attempts = 0; attempts < 100; attempts++) {
    crypto.getRandomValues(values);
    const candidate = values[0] ?? 0n;
    if (candidate === 0n) continue;
    const key = candidate.toString(16);
    if (used.has(key)) continue;
    used.add(key);
    return candidate;
  }
  throw new Error("pi-tracing: uuid collision retry budget exhausted");
}

export function randomSeqId(): number {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  const candidate = values[0] ?? 0;
  return candidate === 0 ? 1 : candidate;
}

export interface ToolLane {
  uuid: bigint;
  lane: number;
  isNew: boolean;
}

/** Allocate only unoccupied lanes up to a cap. Never round-robin unrelated
 * active spans onto one track (that would create invalid nesting). */
export class ToolLaneAllocator {
  private readonly cap: number;
  private readonly lanes: bigint[] = [];
  private readonly described = new Set<number>();
  private readonly active = new Map<string, number>();
  private readonly used: Set<string>;
  overflows = 0;

  constructor(cap: number, used: Set<string>) {
    this.cap = Math.max(1, cap);
    this.used = used;
  }

  alloc(key: string): ToolLane | null {
    const existing = this.active.get(key);
    if (existing !== undefined) {
      const uuid = this.lanes[existing];
      if (uuid === undefined) return null;
      return { uuid, lane: existing, isNew: !this.described.has(existing) };
    }
    for (let lane = 0; lane < this.lanes.length; lane++) {
      let occupied = false;
      for (const held of this.active.values()) {
        if (held === lane) {
          occupied = true;
          break;
        }
      }
      if (!occupied) {
        const uuid = this.lanes[lane];
        if (uuid === undefined) continue;
        this.active.set(key, lane);
        return { uuid, lane, isNew: !this.described.has(lane) };
      }
    }
    if (this.lanes.length >= this.cap) {
      this.overflows++;
      return null;
    }
    const uuid = randomUuid64(this.used);
    const lane = this.lanes.length;
    this.lanes.push(uuid);
    this.active.set(key, lane);
    return { uuid, lane, isNew: true };
  }

  markDescribed(lane: number): void {
    this.described.add(lane);
  }

  free(key: string): void {
    this.active.delete(key);
  }

  activeCount(): number {
    return this.active.size;
  }
}

export interface TrackSet {
  used: Set<string>;
  processUuid: bigint;
  rootUuid: bigint;
  providerUuid: bigint;
  responseUuid: bigint;
  sessionUuid: bigint;
  compactionUuid: bigint;
  workflowUuid: bigint;
  runtimeUuid: bigint;
  tracingUuid: bigint;
  contextUuid: bigint;
  lanes: ToolLaneAllocator;
  workflowLanes: ToolLaneAllocator;
  counters: Map<string, bigint>;
}

export function createTrackSet(laneCap: number, osTracks?: {processUuid: bigint; threadUuid?: bigint}): TrackSet {
  const used = new Set<string>();
  const processUuid = osTracks?.processUuid ?? randomUuid64(used);
  used.add(processUuid.toString());
  if (osTracks?.threadUuid !== undefined) used.add(osTracks.threadUuid.toString());
  const rootUuid = randomUuid64(used);
  const providerUuid = randomUuid64(used);
  const responseUuid = randomUuid64(used);
  const sessionUuid = osTracks?.threadUuid ?? randomUuid64(used);
  const workflowUuid = randomUuid64(used);
  return {
    used,
    processUuid,
    rootUuid,
    providerUuid,
    responseUuid,
    sessionUuid,
    compactionUuid: randomUuid64(used),
    workflowUuid,
    runtimeUuid: randomUuid64(used),
    tracingUuid: randomUuid64(used),
    contextUuid: randomUuid64(used),
    lanes: new ToolLaneAllocator(laneCap, used),
    workflowLanes: new ToolLaneAllocator(laneCap, used),
    counters: new Map(),
  };
}

export function counterTrackUuid(tracks: TrackSet, spec: CounterSpec): bigint {
  const existing = tracks.counters.get(spec.key);
  if (existing !== undefined) return existing;
  const uuid = randomUuid64(tracks.used);
  tracks.counters.set(spec.key, uuid);
  return uuid;
}

function descriptorPacket(args: {
  descriptor: Uint8Array;
  seqId: number;
  machineId: number;
  clockId: number;
  nowNs: bigint;
}): Uint8Array {
  return framePacket(
    buildTracePacket({
      timestampNs: args.nowNs,
      clockId: args.clockId,
      seqId: args.seqId,
      machineId: args.machineId,
      trackDescriptor: args.descriptor,
    }),
  );
}

/** Idempotent descriptor preamble for one writer generation. Must follow the
 * clock snapshot and precede every event referencing these tracks. */
export function buildDescriptorPreamble(args: {
  tracks: TrackSet;
  identity: ProcessIdentity;
  seqId: number;
  machineId: number;
  clockId: number;
  nowNs: bigint;
  counterSpecs: CounterSpec[];
}): Uint8Array[] {
  const { tracks, identity, seqId, machineId, clockId, nowNs, counterSpecs } = args;
  const descriptors = [
    buildTrackDescriptor({
      uuid: tracks.processUuid,
      name: "pi",
      process: { pid: identity.pid, processName: identity.processName, labels: identity.labels },
    }),
    // A generic parent survives import even when process descriptors with the
    // same PID are combined. Each capture keeps its own slices and counters.
    buildTrackDescriptor({ uuid: tracks.rootUuid, parentUuid: tracks.processUuid, name: "agentprof.capture",
      // SIBLING_MERGE_BEHAVIOR_NONE: captures sharing one process must not
      // combine by name, even when all packets are in the same input file.
      siblingMergeBehavior: SIBLING_MERGE_NONE }),
    buildTrackDescriptor({ uuid: tracks.providerUuid, parentUuid: tracks.rootUuid, name: "Requests",
      description: "Request start through response headers; excludes consuming the response stream." }),
    buildTrackDescriptor({ uuid: tracks.responseUuid, parentUuid: tracks.rootUuid, name: "Responses" }),
    identity.mainThread === undefined
      ? buildTrackDescriptor({ uuid: tracks.sessionUuid, parentUuid: tracks.rootUuid, name: "Session" })
      : buildTrackDescriptor({ uuid: tracks.sessionUuid,
        thread: {pid: identity.pid, tid: identity.mainThread.tid, threadName: identity.mainThread.name} }),
    buildTrackDescriptor({ uuid: tracks.compactionUuid, parentUuid: tracks.rootUuid, name: "Compaction" }),
    buildTrackDescriptor({ uuid: tracks.workflowUuid, parentUuid: tracks.rootUuid, name: "Workflow" }),
    buildTrackDescriptor({ uuid: tracks.runtimeUuid, parentUuid: tracks.rootUuid, name: "Runtime" }),
    buildTrackDescriptor({uuid: tracks.contextUuid, parentUuid: tracks.rootUuid, name: "Context"}),
    buildTrackDescriptor({ uuid: tracks.tracingUuid, parentUuid: tracks.rootUuid, name: "Tracing" }),
  ];
  for (const spec of counterSpecs) {
    descriptors.push(
      buildTrackDescriptor({
        uuid: counterTrackUuid(tracks, spec),
        parentUuid: spec.group === "Runtime" ? tracks.runtimeUuid : spec.group === "Tracing" ? tracks.tracingUuid : spec.group === "Context" ? tracks.contextUuid : tracks.rootUuid,
        name: spec.trackName,
        description: spec.description,
        counter: { unit: spec.unit, unitName: spec.unitName,
          yAxisShareKey: spec.yAxisShareKey },
      }),
    );
  }
  return descriptors.map((descriptor) =>
    descriptorPacket({ descriptor, seqId, machineId, clockId, nowNs }),
  );
}

/** Emit before the first event on a newly allocated tool lane. */
export function buildToolLaneDescriptorPacket(args: {
  tracks: TrackSet;
  lane: ToolLane;
  seqId: number;
  machineId: number;
  clockId: number;
  nowNs: bigint;
}): Uint8Array {
  return descriptorPacket({
    descriptor: buildTrackDescriptor({
      uuid: args.lane.uuid,
      parentUuid: args.tracks.rootUuid,
      name: "Tools",
      siblingMergeBehavior: SIBLING_MERGE_BY_TRACK_NAME,
    }),
    seqId: args.seqId,
    machineId: args.machineId,
    clockId: args.clockId,
    nowNs: args.nowNs,
  });
}

/** Emit before the first event on a newly allocated workflow child lane. */
export function buildWorkflowLaneDescriptorPacket(args: {
  tracks: TrackSet;
  lane: ToolLane;
  seqId: number;
  machineId: number;
  clockId: number;
  nowNs: bigint;
}): Uint8Array {
  return buildChildLaneDescriptorPacket({
    parentUuid: args.tracks.workflowUuid,
    name: "Child workflows",
    lane: args.lane,
    seqId: args.seqId,
    machineId: args.machineId,
    clockId: args.clockId,
    nowNs: args.nowNs,
  });
}

function buildChildLaneDescriptorPacket(args: {
  parentUuid: bigint;
  name: string;
  lane: ToolLane;
  seqId: number;
  machineId: number;
  clockId: number;
  nowNs: bigint;
}): Uint8Array {
  return descriptorPacket({
    descriptor: buildTrackDescriptor({
      uuid: args.lane.uuid,
      parentUuid: args.parentUuid,
      name: args.name,
      siblingMergeBehavior: SIBLING_MERGE_BY_TRACK_NAME,
    }),
    seqId: args.seqId,
    machineId: args.machineId,
    clockId: args.clockId,
    nowNs: args.nowNs,
  });
}

/** Nonzero 64-bit flow identifier, globally unique within a trace via the
 * shared per-generation uuid registry. */
export function randomFlowId(used: Set<string>): bigint {
  for (let attempts = 0; attempts < 100; attempts++) {
    const values = new BigUint64Array(1);
    crypto.getRandomValues(values);
    const candidate = values[0] ?? 0n;
    if (candidate === 0n) continue;
    const key = `flow:${candidate.toString(16)}`;
    if (used.has(key)) continue;
    used.add(key);
    return candidate;
  }
  throw new Error("pi-tracing: flow id retry budget exhausted");
}

/** ClockSnapshot is intentionally the first packet and has no outer timestamp.
 * Events retain a high-resolution monotonic/source clock. BOOTTIME is the
 * per-machine bridge. REALTIME is the primary trace clock so independently
 * recorded files share an epoch, including with older Trace Processor versions. */
export function buildSnapshotPacket(args: {
  seqId: number;
  machineId: number;
  sourceClockId: number;
  sourceNs: bigint;
  boottimeNs: bigint;
  realtimeNs: bigint;
}): Uint8Array {
  const clocks = [{ clockId: args.sourceClockId, timestampNs: args.sourceNs }];
  if (args.sourceClockId !== CLOCK_BOOTTIME) {
    clocks.push({ clockId: CLOCK_BOOTTIME, timestampNs: args.boottimeNs });
  }
  if (args.sourceClockId !== CLOCK_REALTIME) {
    clocks.push({ clockId: CLOCK_REALTIME, timestampNs: args.realtimeNs });
  }
  const snapshot = buildClockSnapshot(clocks, CLOCK_REALTIME);
  return framePacket(
    buildTracePacket({
      seqId: args.seqId,
      machineId: args.machineId,
      clockSnapshot: snapshot,
    }),
  );
}

export function clockIdForProbe(probePassedMonotonic: boolean): number {
  // The safe default remains the sequence-scoped custom clock. The runtime
  // probe may opt into built-in MONOTONIC when it verifies the epoch.
  return probePassedMonotonic ? CLOCK_MONOTONIC : CLOCK_PI_CUSTOM;
}
