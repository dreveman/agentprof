// SPDX-License-Identifier: Apache-2.0
// Serialization for offline harness adapters. All times are source REALTIME ns.
import {buildClockSnapshot, buildTracePacket, buildTrackDescriptor, buildTrackEvent, framePacket,
  CLOCK_REALTIME, CLOCK_BOOTTIME, TRACK_EVENT_BEGIN, TRACK_EVENT_END, TRACK_EVENT_INSTANT, TRACK_EVENT_COUNTER,
  SIBLING_MERGE_BY_TRACK_NAME, SIBLING_MERGE_NONE, type DebugAnnotationValue} from '../pi-tracing/extensions/pi-tracing/encoder.ts';
import {fnv1a64} from '../pi-tracing/extensions/pi-tracing/machine.ts';

export type Attrs = Record<string, DebugAnnotationValue>;
export interface Observation {source: string; timestamp: string; data: Record<string, unknown>}
export interface Slice {id: string; session: string; track: string; name: string; start: bigint; end?: bigint; attrs: Attrs; flows: bigint[]}
export interface Session {id: string; start: bigint; end: bigint; attrs: Attrs}
export interface Counter {session: string; name: string; unit: string; axis?: string; samples: {at: bigint; value: number}[]}
export const compareTime = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;

export function writeTrace(options: {
  capture: string; pid: number; machineId: number; processName: string; processLabel: string; category: string;
  clocks: {realtimeNs: bigint; boottimeNs: bigint}[]; sessions: Session[]; slices: Slice[]; counters: Counter[];
}): Uint8Array {
  if (!options.capture || !Number.isInteger(options.pid) || options.pid <= 0) throw new Error('Missing process/capture identity');
  if (!options.clocks.length) throw new Error('Missing boot/realtime clock snapshot');
  const uuid = (key: string) => fnv1a64(`${options.capture}:${key}`) || 1n;
  const seqId = Number(uuid('sequence') & 0xffffffffn) || 1;
  const packets: Uint8Array[] = [];
  const packet = (data: {trackDescriptor?: Uint8Array; trackEvent?: Uint8Array; clockSnapshot?: Uint8Array}, at?: bigint) =>
    packets.push(framePacket(buildTracePacket({seqId, machineId: options.machineId,
      ...(at === undefined ? {} : {timestampNs: at, clockId: CLOCK_REALTIME}), ...data})));
  for (const clock of options.clocks) packet({clockSnapshot: buildClockSnapshot([
    {clockId: CLOCK_REALTIME, timestampNs: clock.realtimeNs}, {clockId: CLOCK_BOOTTIME, timestampNs: clock.boottimeNs},
  ], CLOCK_REALTIME)});
  const process = uuid('process');
  packet({trackDescriptor: buildTrackDescriptor({uuid: process, process: {pid: options.pid,
    processName: options.processName, labels: [options.processLabel]}})});
  const events: {at: bigint; rank: number; data: Uint8Array}[] = [];
  const event = (at: bigint, rank: number, trackUuid: bigint, type: number, name?: string,
                 attrs?: Attrs, flows?: bigint[], counterValue?: bigint) => {
    events.push({at, rank, data: buildTrackEvent({trackUuid, type, name,
      categories: type === TRACK_EVENT_END ? [] : [`${options.category}.${name?.startsWith('profile (') || name === 'run-configuration' ? 'metadata' : 'activity'}`],
      debugAnnotations: attrs, flowIds: flows, counterValue})});
  };
  for (const session of options.sessions) {
    const root = uuid(`capture:${session.id}`), profile = uuid(`profile:${session.id}`);
    packet({trackDescriptor: buildTrackDescriptor({uuid: root, parentUuid: process, name: 'agentprof.capture', siblingMergeBehavior: SIBLING_MERGE_NONE})});
    packet({trackDescriptor: buildTrackDescriptor({uuid: profile, parentUuid: root, name: 'Session'})});
    event(session.start, -4, profile, TRACK_EVENT_BEGIN, 'profile (1)',
      {...session.attrs, kind: 'capture', schema_version: 1, session_id: session.id, capture_id: root.toString(16)});
    event(session.end, 4, profile, TRACK_EVENT_END);
    const groups = new Map<string, Slice[]>();
    for (const slice of options.slices.filter(s => s.session === session.id)) {
      const group = groups.get(slice.track) ?? []; group.push(slice); groups.set(slice.track, group);
    }
    for (const [name, slices] of groups) {
      const lanes: {uuid: bigint; end: bigint}[] = [];
      for (const slice of slices.sort((a, b) => compareTime(a.start, b.start))) {
        let lane = lanes.find(l => l.end <= slice.start);
        if (!lane) {
          lane = {uuid: uuid(`${session.id}:${name}:${lanes.length}`), end: slice.start}; lanes.push(lane);
          packet({trackDescriptor: buildTrackDescriptor({uuid: lane.uuid, parentUuid: root, name, siblingMergeBehavior: SIBLING_MERGE_BY_TRACK_NAME})});
        }
        lane.end = slice.end === slice.start ? slice.start + 1n : slice.end ?? slice.start;
        event(slice.start, slice.end === undefined ? -1 : 0, lane.uuid,
          slice.end === undefined ? TRACK_EVENT_INSTANT : TRACK_EVENT_BEGIN, slice.name, slice.attrs, [...new Set(slice.flows)]);
        if (slice.end !== undefined) event(slice.end, slice.end === slice.start ? 1 : -2, lane.uuid, TRACK_EVENT_END);
      }
    }
    for (const counter of options.counters.filter(c => c.session === session.id && c.samples.length)) {
      const id = uuid(`${session.id}:counter:${counter.name}`);
      packet({trackDescriptor: buildTrackDescriptor({uuid: id, parentUuid: root, name: counter.name,
        counter: {unit: 0, unitName: counter.unit, ...(counter.axis ? {yAxisShareKey: counter.axis} : {})}})});
      event(session.start, -3, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, 0n);
      for (const sample of counter.samples.sort((a, b) => compareTime(a.at, b.at)))
        event(sample.at, 2, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, BigInt(sample.value));
      event(session.end, 3, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, 0n);
    }
  }
  events.sort((a, b) => compareTime(a.at, b.at) || a.rank - b.rank);
  for (const e of events) packet({trackEvent: e.data}, e.at);
  return Buffer.concat(packets);
}
