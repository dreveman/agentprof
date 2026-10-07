// SPDX-License-Identifier: Apache-2.0
// Merge this recorder's local-process streams into one Perfetto trace. This is
// deliberately not an importer for arbitrary Perfetto traces or remote clocks.
import {buildTracePacket, buildTrackEvent, encodeVarint, framePacket} from './encoder.ts';

interface Field {number: number; wire: number; value?: bigint; bytes?: Uint8Array; raw: Uint8Array}
function varint(data: Uint8Array, offset: number): [bigint, number] {
  let value = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    const byte = data[offset++];
    if (byte === undefined) throw new Error('incomplete protobuf field');
    value |= BigInt(byte & 127) << shift;
    if (byte < 128) return [value, offset];
  }
  throw new Error('invalid protobuf varint');
}
function* fields(data: Uint8Array): Generator<Field> {
  let offset = 0;
  while (offset < data.length) {
    const start = offset;
    let tag: bigint;
    [tag, offset] = varint(data, offset);
    const number = Number(tag >> 3n), wire = Number(tag & 7n);
    let value: bigint | undefined, bytes: Uint8Array | undefined;
    if (wire === 0) [value, offset] = varint(data, offset);
    else if (wire === 2) {
      let length: bigint;
      [length, offset] = varint(data, offset);
      if (length > BigInt(data.length - offset)) throw new Error('incomplete protobuf field');
      bytes = data.subarray(offset, offset + Number(length));
      offset += Number(length);
    } else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else throw new Error('unsupported protobuf wire type');
    if (offset > data.length) throw new Error('incomplete protobuf field');
    yield {number, wire, value, bytes, raw: data.subarray(start, offset)};
  }
}
const integer = (number: number, value: bigint | number) =>
  Uint8Array.from([...encodeVarint(number << 3), ...encodeVarint(value)]);
const blob = (number: number, bytes: Uint8Array) => Buffer.concat([
  Uint8Array.from([...encodeVarint((number << 3) | 2), ...encodeVarint(bytes.length)]), bytes]);
const scalar = (data: Field[], number: number) => data.find(f => f.number === number)?.value;
const message = (data: Field[], number: number) => data.find(f => f.number === number)?.bytes;
interface Packet {bytes: Uint8Array; ts: bigint; priority: number; seq: number; clock: number; event?: Uint8Array; partial: boolean}
export interface MergeInput {bytes: Uint8Array; incomplete?: boolean}

export function mergePiTraces(inputs: MergeInput[], options: {maxBytes?: number; deadlineAt?: number} = {}) {
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  const checkDeadline = () => {
    if (Date.now() >= (options.deadlineAt ?? Infinity)) throw new Error('recording merge deadline exceeded');
  };
  if (inputs.reduce((n, input) => n + input.bytes.length, 0) > maxBytes) throw new Error('combined recording exceeds maxFileMB');
  const packets: Packet[] = [];
  let nextSequence = 1, machine: bigint | undefined, incomplete = false;
  const snapshots: {bytes: Uint8Array; ts: bigint}[] = [];
  for (const [inputIndex, input] of inputs.entries()) {
    const sequences = new Map<bigint, number>();
    // A live writer may have written only part of its final packet. Keep only
    // complete outer frames; malformed complete packets still fail validation.
    const frames = fields(input.bytes);
    while (true) {
      let frame: IteratorResult<Field>;
      try {frame = frames.next();} catch (error) {
        if (!input.incomplete) throw error;
        incomplete = true;
        break;
      }
      if (frame.done) break;
      if (packets.length % 1024 === 0) checkDeadline();
      if (frame.value.number !== 1 || !frame.value.bytes) throw new Error('expected Trace.packet');
      const p = [...fields(frame.value.bytes)];
      const rawMachine = scalar(p, 98) ?? 0n;
      machine ??= rawMachine;
      if (rawMachine !== machine) throw new Error('cannot merge Pi streams from different machines');
      const oldSequence = scalar(p, 10);
      if (!oldSequence) throw new Error('Pi packet missing sequence ID');
      let seq = sequences.get(oldSequence);
      if (seq === undefined) {seq = nextSequence++; sequences.set(oldSequence, seq);}
      const snapshot = message(p, 6), event = message(p, 11), descriptor = message(p, 60);
      if (!snapshot && !event && !descriptor) throw new Error('unsupported Pi packet payload');
      let ts = scalar(p, 8);
      let clock = Number(scalar(p, 58) ?? 0n);
      if (snapshot) {
        const clocks = [...fields(snapshot)].filter(f => f.number === 1).map(f => [...fields(f.bytes!)]);
        // Node hrtime is shared by local processes. The recorder labels it
        // MONOTONIC after its probe, or uses sequence-local clock 64 otherwise.
        const source = clocks.find(c => scalar(c, 1) === 3n) ?? clocks.find(c => scalar(c, 1) === 64n);
        if (!source) throw new Error('Pi snapshot missing source clock');
        ts = scalar(source, 2);
        clock = Number(scalar(source, 1));
      }
      if (ts === undefined || (clock !== 3 && clock !== 64)) throw new Error('unsupported Pi source clock');
      if (snapshot) {
        // All participants use Node's host-wide hrtime clock. Use only the
        // owner's calibration so independently quantized wall-clock samples
        // cannot reverse short flows. Replicate it for each packet sequence.
        if (inputIndex === 0) {
          const rewritten = Buffer.concat([...fields(snapshot)].map(f => {
            if (f.number !== 1 || !f.bytes) return f.raw;
            const c = [...fields(f.bytes)];
            if (scalar(c, 1) !== 3n && scalar(c, 1) !== 64n) return f.raw;
            return blob(1, Buffer.concat(c.map(cf => cf.number === 1 ? integer(1, 64) : cf.raw)));
          }));
          snapshots.push({bytes: rewritten, ts});
        }
        continue;
      }
      const bytes = Buffer.concat(p.map(f => f.number === 10 ? integer(10, seq)
        : f.number === 58 ? integer(58, 64) : f.raw));
      packets.push({bytes, ts, priority: descriptor ? 1 : 2, seq, clock: 64, event, partial: input.incomplete === true});
    }
    incomplete ||= input.incomplete === true;
  }
  if (snapshots.length === 0) throw new Error('recording owner has no clock snapshot');
  if (packets.length === 0) throw new Error('recording has no packets');
  const earliestPacketTs = packets.reduce((earliest, packet) => packet.ts < earliest ? packet.ts : earliest, packets[0]!.ts);
  for (const [index, snapshot] of snapshots.entries()) for (let seq = 1; seq < nextSequence; seq++) {
    // A child may have emitted descriptors before the owner's first clock
    // snapshot. Put the initial calibration before every sequence's packets
    // so Perfetto can import those descriptors. Snapshot packets have no outer
    // timestamp, so this changes only their position, not their clock values.
    packets.push({bytes: buildTracePacket({seqId: seq, machineId: Number(machine), clockSnapshot: snapshot.bytes}),
      ts: index === 0 && earliestPacketTs < snapshot.ts ? earliestPacketTs : snapshot.ts,
      priority: 0, seq, clock: 64, partial: false});
  }
  // Global clock snapshots must advance in order. Sorting also restores saved
  // BEGIN timestamps and preserves order within a track for equal timestamps.
  packets.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.priority - b.priority);
  checkDeadline();
  const startNs = packets[0]!.ts;
  let endNs = packets.at(-1)!.ts;
  if (incomplete) {
    const open = new Map<bigint, Packet[]>(), counters = new Map<bigint, Packet>();
    for (const packet of packets) {
      if (!packet.partial || !packet.event) continue;
      const e = [...fields(packet.event)], track = scalar(e, 11), type = scalar(e, 9);
      if (track === undefined) continue;
      if (type === 1n) {const stack = open.get(track) ?? []; stack.push(packet); open.set(track, stack);}
      else if (type === 2n) open.get(track)?.pop();
      else if (type === 4n) counters.set(track, packet);
    }
    const cutoff = ++endNs;
    const append = (track: bigint, packet: Packet, type: number) => {
      const event = buildTrackEvent({trackUuid: track, categories: [], type,
        ...(type === 4 ? {counterValue: 0n} : {debugAnnotations: {incomplete: true, cutoff_reason: 'recording-stop'}})});
      packets.push({...packet, ts: cutoff, event, bytes: buildTracePacket({timestampNs: cutoff,
        clockId: packet.clock, seqId: packet.seq, machineId: Number(machine), trackEvent: event})});
    };
    for (const [track, stack] of open) for (const packet of stack.reverse()) append(track, packet, 2);
    for (const [track, packet] of counters) append(track, packet, 4);
  }
  const bytes = Buffer.concat(packets.map(p => framePacket(p.bytes)));
  if (bytes.length > maxBytes) throw new Error('combined recording exceeds maxFileMB');
  checkDeadline();
  return {bytes, packets: packets.length, startNs, endNs, incomplete};
}
