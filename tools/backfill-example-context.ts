// SPDX-License-Identifier: Apache-2.0
// Add the Pi 0.87.1 catalogued model limit to the archived real recordings.
// The original activity packets and timestamps are preserved.
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {
  TRACK_EVENT_COUNTER, buildTracePacket, buildTrackDescriptor, buildTrackEvent,
  encodeBytesField, encodeStringField, encodeUint64Field, framePacket,
} from '../packages/pi-tracing/extensions/pi-tracing/encoder.ts';
import {decodeFields, tracePackets} from '../packages/pi-tracing/extensions/pi-tracing/test-proto.ts';

const source = resolve('examples/pi-opus-5');
const manifestPath = resolve(source, 'recording.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const model = 'claude-opus-5';
const windowTokens = 1_000_000;
const text = (bytes?: Uint8Array) => new TextDecoder().decode(bytes);
const field = (bytes: Uint8Array, number: number) => decodeFields(bytes).find(f => f.number === number);
const value = (bytes: Uint8Array, number: number) => field(bytes, number)?.value;

function varint(bytes: Uint8Array, offset: number): [bigint, number] {
  let result = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    const byte = bytes[offset++];
    if (byte === undefined) throw new Error('truncated protobuf varint');
    result |= BigInt(byte & 127) << shift;
    if (byte < 128) return [result, offset];
  }
  throw new Error('invalid protobuf varint');
}

// Retain every unmodified field byte-for-byte, including fields unknown here.
function replaceFields(bytes: Uint8Array, replacements: Map<number, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  let offset = 0;
  const replaced = new Set<number>();
  while (offset < bytes.length) {
    const start = offset;
    let tag: bigint;
    [tag, offset] = varint(bytes, offset);
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) [, offset] = varint(bytes, offset);
    else if (wire === 1) offset += 8;
    else if (wire === 2) {
      let length: bigint;
      [length, offset] = varint(bytes, offset);
      offset += Number(length);
    } else if (wire === 5) offset += 4;
    else throw new Error(`unsupported protobuf wire type ${wire}`);
    if (offset > bytes.length) throw new Error('truncated protobuf field');
    const replacement = replacements.get(number);
    if (replacement === undefined) parts.push(bytes.subarray(start, offset));
    else {
      if (replaced.has(number)) throw new Error(`duplicate field ${number}`);
      parts.push(replacement);
      replaced.add(number);
    }
  }
  if (replaced.size !== replacements.size) throw new Error('required protobuf field absent');
  return Buffer.concat(parts);
}

function matchingPacket(reference: Uint8Array, payload: {trackDescriptor?: Uint8Array; trackEvent?: Uint8Array}) {
  const timestampNs = value(reference, 8);
  const clockId = value(reference, 58);
  const seqId = value(reference, 10);
  if (timestampNs === undefined || clockId === undefined || seqId === undefined) {
    throw new Error('recorded packet lacks timestamp, clock, or sequence');
  }
  return buildTracePacket({timestampNs, clockId: Number(clockId), seqId: Number(seqId),
    machineId: Number(value(reference, 98) ?? 0n), ...payload});
}

function backfill(bytes: Uint8Array, sessionId: string): Uint8Array {
  const packets = tracePackets(bytes);
  const descriptors = new Set<bigint>();
  let contextIndex = -1, beginIndex = -1, endIndex = -1;
  let contextDescriptor: Uint8Array | undefined;
  let profileTrack: bigint | undefined;
  let alreadyHasWindow = false;
  for (const [index, packet] of packets.entries()) {
    const descriptor = field(packet, 60)?.bytes;
    if (descriptor) {
      const uuid = value(descriptor, 1);
      if (uuid !== undefined) descriptors.add(uuid);
      const name = text(field(descriptor, 2)?.bytes);
      if (name === 'Context size (est.)') {
        if (contextIndex !== -1) throw new Error('duplicate context descriptor');
        contextIndex = index;
        contextDescriptor = descriptor;
      }
      if (name === 'Context window') alreadyHasWindow = true;
    }
    const event = field(packet, 11)?.bytes;
    if (!event) continue;
    const type = value(event, 9);
    const name = text(field(event, 23)?.bytes);
    if (type === 1n && name === 'profile (1)') {
      if (beginIndex !== -1) throw new Error('multiple capture beginnings');
      beginIndex = index;
      profileTrack = value(event, 11);
    }
    if (type === 2n && value(event, 11) === profileTrack &&
      decodeFields(event).some(f => f.number === 4 &&
        text(field(f.bytes!, 10)?.bytes) === 'peak_context_tokens')) {
      endIndex = index;
    }
  }
  if (alreadyHasWindow) {
    if (contextIndex !== -1) throw new Error('partially backfilled trace');
    return bytes;
  }
  if (contextIndex < 0 || beginIndex < 0 || endIndex < 0 || !contextDescriptor || !profileTrack) {
    throw new Error('recording lacks context track or capture boundaries');
  }
  const rootUuid = value(contextDescriptor, 5);
  const counter = field(contextDescriptor, 8)?.bytes;
  if (!rootUuid || !counter || text(field(counter, 6)?.bytes) !== 'tokens') {
    throw new Error('context counter has unexpected parent or unit');
  }
  const windowUuid = createHash('sha256').update(`agentprof.context-window/${sessionId}`)
    .digest().readBigUInt64LE(0);
  if (windowUuid === 0n || descriptors.has(windowUuid)) throw new Error('counter UUID collision');
  const shareKey = 'llm.context.tokens';
  const renamed = replaceFields(contextDescriptor, new Map([
    [2, Uint8Array.from(encodeStringField(2, 'Context size'))],
    [8, Uint8Array.from(encodeBytesField(8, Buffer.concat([
      counter, Uint8Array.from(encodeStringField(7, shareKey))])))],
  ]));
  const ceiling = buildTrackDescriptor({uuid: windowUuid, parentUuid: rootUuid,
    name: 'Context window', counter: {unit: 0, unitName: 'tokens', yAxisShareKey: shareKey}});
  const annotation = Uint8Array.from(encodeBytesField(4, Buffer.concat([
    Uint8Array.from(encodeStringField(10, 'context_window_tokens')),
    Uint8Array.from(encodeUint64Field(3, windowTokens)),
  ])));
  const result: Uint8Array[] = [];
  for (const [index, packet] of packets.entries()) {
    if (index === contextIndex) {
      result.push(framePacket(replaceFields(packet, new Map([
        [60, Uint8Array.from(encodeBytesField(60, renamed))],
      ]))));
      result.push(framePacket(matchingPacket(packet, {trackDescriptor: ceiling})));
    } else if (index === beginIndex) {
      const event = field(packet, 11)!.bytes!;
      result.push(framePacket(replaceFields(packet, new Map([
        [11, Uint8Array.from(encodeBytesField(11, Buffer.concat([event, annotation])))],
      ]))));
      result.push(framePacket(matchingPacket(packet, {trackEvent: buildTrackEvent({
        trackUuid: windowUuid, categories: [], type: TRACK_EVENT_COUNTER,
        counterValue: BigInt(windowTokens),
      })})));
    } else {
      result.push(framePacket(packet));
    }
    if (index === endIndex) result.push(framePacket(matchingPacket(packet, {
      trackEvent: buildTrackEvent({trackUuid: windowUuid, categories: [],
        type: TRACK_EVENT_COUNTER, counterValue: 0n}),
    })));
  }
  return Buffer.concat(result);
}

if (manifest.piVersion !== '0.87.1') throw new Error('verify model limit against this Pi version');
for (const recording of manifest.recordings) {
  if (recording.provider !== 'anthropic' || recording.model !== model) {
    throw new Error(`unexpected model in ${recording.file}`);
  }
  const path = resolve(source, recording.file);
  const original = await readFile(path);
  const digest = createHash('sha256').update(original).digest('hex');
  if (digest !== recording.sha256) throw new Error(`${recording.file}: checksum mismatch`);
  const updated = backfill(original, recording.sessionId);
  if (updated !== original) {
    recording.originalSha256 = recording.originalSha256 ?? recording.sha256;
    recording.sha256 = createHash('sha256').update(updated).digest('hex');
    await writeFile(path, updated);
    console.log(`Updated ${recording.file}`);
  }
}
manifest.contextWindowBackfill = {model, tokens: windowTokens,
  source: 'Pi 0.87.1 model catalog', originalRecordingDate: manifest.recordedAt};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
