// SPDX-License-Identifier: Apache-2.0
// Zero-dependency protobuf writer for the minimal Perfetto surface pi-tracing
// emits. Field numbers pinned against v58.2 protos:
//
//   Trace.packet = 1 (repeated TracePacket, length-delimited)
//   TracePacket: timestamp = 8 (u64), trusted_packet_sequence_id = 10 (u32),
//     track_event = 11 (LD), clock_snapshot = 6 (LD), track_descriptor = 60 (LD),
//     timestamp_clock_id = 58 (u32), machine_id = 98 (u32)
//   TrackEvent: type = 9, track_uuid = 11 (u64), categories = 22 (rep string),
//     name = 23 (string), counter_value = 30 (int64, non-negative only here),
//     flow_ids = 47 (rep fixed64), debug_annotations = 4
//   TrackEvent.Type: SLICE_BEGIN = 1, SLICE_END = 2, INSTANT = 3, COUNTER = 4
//   TrackDescriptor: uuid = 1 (u64), name = 2, process = 3 (LD),
//     parent_uuid = 5 (u64), counter = 8 (LD), description = 14, sibling_merge_behavior = 15
//   ProcessDescriptor: pid = 1, process_name = 6, process_labels = 8 (rep)
//   CounterDescriptor: unit = 3 (UNIT_COUNT = 2, UNIT_SIZE_BYTES = 3)
//   ClockSnapshot: clocks = 1 (rep LD Clock{clock_id = 1, timestamp = 2}),
//     primary_trace_clock = 2
//   DebugAnnotation: bool_value = 2, uint_value = 3, int_value = 4,
//     double_value = 5, string_value = 6, name = 10, dict_entries = 11,
//     array_values = 12; TrackEvent.debug_annotations = 4

export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_LD = 2;

export const TRACK_EVENT_BEGIN = 1;
export const TRACK_EVENT_END = 2;
export const TRACK_EVENT_INSTANT = 3;
export const TRACK_EVENT_COUNTER = 4;

export const SIBLING_MERGE_BY_TRACK_NAME = 1;
export const SIBLING_MERGE_NONE = 2;

export const CLOCK_REALTIME = 1;
export const CLOCK_MONOTONIC = 3;
export const CLOCK_BOOTTIME = 6;
export const CLOCK_TRACE_FILE = 11;
/** Sequence-scoped custom clock used unless the runtime probe proves Bun's
 *  hrtime shares the built-in MONOTONIC epoch. Always valid with a snapshot. */
export const CLOCK_PI_CUSTOM = 64;

export const COUNTER_UNIT_UNSPECIFIED = 0;
export const COUNTER_UNIT_COUNT = 2;
export const COUNTER_UNIT_BYTES = 3;

const textEncoder = new TextEncoder();

export function encodeVarint(value: number | bigint): number[] {
  let x = typeof value === "number" ? BigInt(value) : value;
  if (x < 0n) throw new Error("pi-tracing encoder: negative varint unsupported");
  const out: number[] = [];
  while (x > 0x7fn) {
    out.push(Number((x & 0x7fn) | 0x80n));
    x >>= 7n;
  }
  out.push(Number(x));
  return out;
}

export function encodeFixed64(value: number | bigint): number[] {
  let x = typeof value === "number" ? BigInt(value) : value;
  if (x < 0n) throw new Error("pi-tracing encoder: negative fixed64 unsupported");
  const out: number[] = [];
  for (let i = 0; i < 8; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}

export function encodeTag(fieldNo: number, wire: number): number[] {
  return encodeVarint((fieldNo << 3) | wire);
}

export function encodeUint32Field(fieldNo: number, value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`pi-tracing encoder: uint32 out of range (field ${fieldNo})`);
  }
  return [...encodeTag(fieldNo, WIRE_VARINT), ...encodeVarint(value)];
}

export function encodeUint64Field(fieldNo: number, value: number | bigint): number[] {
  return [...encodeTag(fieldNo, WIRE_VARINT), ...encodeVarint(value)];
}

export function encodeStringField(fieldNo: number, value: string): number[] {
  const bytes = textEncoder.encode(value);
  return [
    ...encodeTag(fieldNo, WIRE_LD),
    ...encodeVarint(bytes.length),
    ...bytes,
  ];
}

export function encodeBytesField(fieldNo: number, bytes: Uint8Array | number[]): number[] {
  const len = bytes.length;
  return [...encodeTag(fieldNo, WIRE_LD), ...encodeVarint(len), ...bytes];
}

export function encodeFixed64Field(fieldNo: number, value: number | bigint): number[] {
  return [...encodeTag(fieldNo, WIRE_FIXED64), ...encodeFixed64(value)];
}

export function concat(...parts: Array<Uint8Array | number[]>): number[] {
  const out: number[] = [];
  for (const part of parts) {
    for (const byte of part) out.push(byte as number);
  }
  return out;
}

export function toU8(bytes: number[] | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
}

export type DebugAnnotationValue = string | number | boolean | DebugAnnotationValue[] | {[key: string]: DebugAnnotationValue};

export interface TrackEventArgs {
  trackUuid: bigint;
  categories: string[];
  name?: string;
  type: number;
  counterValue?: bigint;
  debugAnnotations?: Record<string, DebugAnnotationValue>;
  /** Causal-link arrows in the Perfetto UI. Direction is inferred from
   * timestamps (earliest = source). Zero-cost beyond ~10 bytes per packet. */
  flowIds?: bigint[];
}

function encodeDoubleField(fieldNo: number, value: number): number[] {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...encodeTag(fieldNo, WIRE_FIXED64), ...bytes];
}

function buildDebugAnnotation(name: string | undefined, value: DebugAnnotationValue): number[] {
  const parts: number[][] = name === undefined ? [] : [encodeStringField(10, name)];
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
    for (const item of value) parts.push(encodeBytesField(12, buildDebugAnnotation(undefined, item)));
  } else {
    for (const [key, item] of Object.entries(value)) parts.push(encodeBytesField(11, buildDebugAnnotation(key, item)));
  }
  return concat(...parts);
}

export function buildTrackEvent(args: TrackEventArgs): Uint8Array {
  if (args.trackUuid === 0n) throw new Error("pi-tracing encoder: track_uuid 0 is the implicit global track; pass an explicit track");
  if (args.type === TRACK_EVENT_COUNTER && args.counterValue === undefined) {
    throw new Error("pi-tracing encoder: TYPE_COUNTER requires counterValue");
  }
  const parts: number[][] = [
    encodeUint32Field(9, args.type),
    encodeUint64Field(11, args.trackUuid),
  ];
  for (const category of args.categories) {
    parts.push(encodeStringField(22, category));
  }
  if (args.name !== undefined) parts.push(encodeStringField(23, args.name));
  if (args.counterValue !== undefined) {
    parts.push([...encodeTag(30, WIRE_VARINT), ...encodeVarint(args.counterValue)]);
  }
  if (args.flowIds !== undefined) {
    for (const flowId of args.flowIds) {
      if (flowId === 0n) throw new Error("pi-tracing encoder: flow id 0 is reserved");
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

export interface ProcessInfo {
  pid: number;
  processName: string;
  labels: string[];
}

export interface CounterInfo {
  unit: number;
  unitName: string;
  yAxisShareKey?: string;
}

export interface ThreadInfo {
  pid: number;
  tid: number;
  threadName?: string;
}

export interface TrackDescriptorArgs {
  uuid: bigint;
  name?: string;
  parentUuid?: bigint;
  process?: ProcessInfo;
  thread?: ThreadInfo;
  counter?: CounterInfo;
  siblingMergeBehavior?: number;
  description?: string;
}

function buildProcessDescriptor(info: ProcessInfo): number[] {
  const parts: number[][] = [encodeUint32Field(1, info.pid)];
  parts.push(encodeStringField(6, info.processName));
  for (const label of info.labels) parts.push(encodeStringField(8, label));
  return concat(...parts);
}

function buildCounterDescriptor(info: CounterInfo): number[] {
  if (!info.unitName) throw new Error("pi-tracing encoder: counter unit_name is required");
  const parts: number[][] = [encodeUint32Field(3, info.unit), encodeStringField(6, info.unitName)];
  if (info.yAxisShareKey !== undefined) parts.push(encodeStringField(7, info.yAxisShareKey));
  return concat(...parts);
}

export function buildTrackDescriptor(args: TrackDescriptorArgs): Uint8Array {
  if (args.uuid === 0n) throw new Error("pi-tracing encoder: TrackDescriptor uuid 0 is reserved for the implicit track");
  const parts: number[][] = [encodeUint64Field(1, args.uuid)];
  if (args.name !== undefined) parts.push(encodeStringField(2, args.name));
  if (args.process !== undefined) parts.push(encodeBytesField(3, buildProcessDescriptor(args.process)));
  if (args.thread !== undefined) parts.push(encodeBytesField(4, concat(
    encodeUint32Field(1, args.thread.pid),
    encodeUint64Field(2, args.thread.tid),
    ...(args.thread.threadName === undefined ? [] : [encodeStringField(5, args.thread.threadName)]),
  )));
  if (args.parentUuid !== undefined) parts.push(encodeUint64Field(5, args.parentUuid));
  if (args.counter !== undefined) parts.push(encodeBytesField(8, buildCounterDescriptor(args.counter)));
  if (args.description !== undefined) parts.push(encodeStringField(14, args.description));
  if (args.siblingMergeBehavior !== undefined) parts.push(encodeUint32Field(15, args.siblingMergeBehavior));
  return toU8(concat(...parts));
}

export interface ClockReading {
  clockId: number;
  timestampNs: bigint;
}

export function buildClockSnapshot(clocks: ClockReading[], primaryTraceClock: number): Uint8Array {
  const parts: number[][] = [];
  for (const clock of clocks) {
    const clockBytes = concat(
      encodeUint32Field(1, clock.clockId),
      encodeUint64Field(2, clock.timestampNs),
    );
    parts.push(encodeBytesField(1, clockBytes));
  }
  parts.push(encodeUint32Field(2, primaryTraceClock));
  return toU8(concat(...parts));
}

export interface TracePacketArgs {
  timestampNs?: bigint;
  clockId?: number;
  seqId: number;
  /** Perfetto machine attribution. Zero/undefined is the implicit host and is
   * deliberately omitted from the wire format. */
  machineId?: number;
  trackEvent?: Uint8Array;
  trackDescriptor?: Uint8Array;
  clockSnapshot?: Uint8Array;
}

export function buildTracePacket(args: TracePacketArgs): Uint8Array {
  if (args.seqId === 0) throw new Error("pi-tracing encoder: trusted_packet_sequence_id must be nonzero");
  const set = [args.trackEvent, args.trackDescriptor, args.clockSnapshot].filter(
    (part) => part !== undefined,
  );
  if (set.length !== 1) throw new Error("pi-tracing encoder: TracePacket needs exactly one data field");
  if ((args.timestampNs === undefined) !== (args.clockId === undefined)) {
    throw new Error("pi-tracing encoder: timestamp and clock id must be provided together");
  }
  if (args.trackEvent !== undefined && args.timestampNs === undefined) {
    throw new Error("pi-tracing encoder: TrackEvent packets require a timestamp and clock id");
  }
  const parts: number[][] = [encodeUint32Field(10, args.seqId)];
  if (args.machineId !== undefined && args.machineId !== 0) {
    parts.push(encodeUint32Field(98, args.machineId));
  }
  if (args.timestampNs !== undefined && args.clockId !== undefined) {
    parts.unshift(encodeUint32Field(58, args.clockId));
    parts.unshift(encodeUint64Field(8, args.timestampNs));
  }
  if (args.trackEvent !== undefined) parts.push(encodeBytesField(11, args.trackEvent));
  if (args.trackDescriptor !== undefined) parts.push(encodeBytesField(60, args.trackDescriptor));
  if (args.clockSnapshot !== undefined) parts.push(encodeBytesField(6, args.clockSnapshot));
  return toU8(concat(...parts));
}

/** Frame one inner TracePacket as a top-level Trace.packet (field 1) record.
 *  The file is the concatenation of these records: safe to append, and a
 *  truncated tail after the last complete record stays parseable. */
export function framePacket(packet: Uint8Array): Uint8Array {
  return toU8(encodeBytesField(1, packet));
}
