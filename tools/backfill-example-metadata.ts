// SPDX-License-Identifier: Apache-2.0
// Migrate metadata and attach original tool inputs to the reviewed comparison.
// Timings, usage, and other protobuf fields are preserved. Safe to rerun.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {buildTrackEvent, encodeBytesField, encodeStringField, type DebugAnnotationValue} from '../packages/pi-tracing/extensions/pi-tracing/encoder.ts';
import {decodeFields} from '../packages/pi-tracing/extensions/pi-tracing/test-proto.ts';
import {scriptAnnotations, toolArgumentAnnotations} from '../packages/pi-tracing/extensions/pi-tracing/annotations.ts';

function varint(bytes: Uint8Array, offset: number): [bigint, number] {
  let value = 0n;
  for (let shift = 0n; shift < 70n; shift += 7n) {
    const byte = bytes[offset++];
    if (byte === undefined) throw new Error('Truncated protobuf field');
    value |= BigInt(byte & 127) << shift;
    if (byte < 128) return [value, offset];
  }
  throw new Error('Invalid protobuf varint');
}

function rewrite(bytes: Uint8Array, visit: (number: number, payload: Uint8Array) => Uint8Array | undefined): Uint8Array {
  const result: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    let tag: bigint;
    [tag, offset] = varint(bytes, offset);
    const number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (wire === 2) {
      let length: bigint;
      [length, offset] = varint(bytes, offset);
      if (length > BigInt(bytes.length - offset)) throw new Error('Truncated protobuf message');
      const payload = bytes.subarray(offset, offset + Number(length));
      offset += Number(length);
      const updated = visit(number, payload);
      if (updated !== undefined) result.push(updated === payload ? bytes.subarray(start, offset)
        : Uint8Array.from(encodeBytesField(number, updated)));
      continue;
    }
    if (wire === 0) [, offset] = varint(bytes, offset);
    else if (wire === 1 || wire === 5) offset += wire === 1 ? 8 : 4;
    else throw new Error(`Unsupported wire type: ${wire}`);
    if (offset > bytes.length) throw new Error('Truncated protobuf field');
    result.push(bytes.subarray(start, offset));
  }
  return Buffer.concat(result);
}

const source = resolve('examples/pi-codemode');
const manifestPath = resolve(source, 'recording.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const toolInputs = await readFile(resolve(source, 'tool-arguments.json'), 'utf8');
const inputRuns: {sessionId: string; eventsSha256: string;
  calls: {toolCallId: string; toolName: string; args: unknown}[]}[] = JSON.parse(toolInputs);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
for (const recording of manifest.recordings) {
  const path = resolve(source, recording.file);
  const original = await readFile(path);
  assert.equal(hash(original), recording.sha256);
  const inputRun = inputRuns.find(run => run.sessionId === recording.sessionId)!;
  assert.ok(inputRun);
  const calls = new Map(inputRun.calls.map(call => [call.toolCallId, call]));
  assert.equal(calls.size, recording.toolCalls + recording.scripts);
  const matched = new Set<string>();
  let changed = 0;
  const bytes = rewrite(original, (field, packet) => field !== 1 ? packet :
    rewrite(packet, (field, event) => {
      if (field !== 11) return event;
      const migrated = rewrite(event, (field, annotation) => {
        if (field !== 4) return annotation;
        const fields = decodeFields(annotation);
        if (new TextDecoder().decode(fields.find(f => f.number === 10)?.bytes) !== 'codemode_enabled') return annotation;
        changed++;
        if (fields.find(f => f.number === 2)?.value !== 1n) return undefined;
        return Uint8Array.from([
          ...encodeStringField(10, 'session_labels'),
          ...encodeBytesField(12, encodeStringField(6, 'codemode')),
        ]);
      });
      const fields = decodeFields(migrated);
      if (fields.find(f => f.number === 9)?.value !== 1n) return migrated;
      const annotations = new Map(fields.filter(f => f.number === 4).map(f => {
        const parts = decodeFields(f.bytes!);
        return [text(parts.find(p => p.number === 10)?.bytes), parts];
      }));
      const callId = text(annotations.get('call_id')?.find(f => f.number === 6)?.bytes);
      const call = calls.get(callId);
      if (!call) return migrated;
      assert.equal(text(fields.find(f => f.number === 23)?.bytes), call.toolName);
      assert.ok(!matched.has(callId));
      matched.add(callId);
      const extraAnnotations: Record<string, DebugAnnotationValue> = {};
      if (!annotations.has('args')) {
        const data = toolArgumentAnnotations(call.args, true);
        extraAnnotations.args = data.args!;
        if (data.truncated) extraAnnotations.args_truncated = true;
      }
      if (call.toolName === 'codemode') {
        const metadata = scriptAnnotations('JavaScript', (call.args as {code?: unknown}).code);
        for (const [key, value] of Object.entries(metadata)) {
          if (!annotations.has(key)) extraAnnotations[key] = value;
        }
      }
      if (Object.keys(extraAnnotations).length === 0) return migrated;
      const encoded = buildTrackEvent({trackUuid: fields.find(f => f.number === 11)!.value!, type: 1, categories: [],
        debugAnnotations: extraAnnotations});
      const extra = decodeFields(encoded).filter(f => f.number === 4)
        .flatMap(f => encodeBytesField(4, f.bytes!));
      changed++;
      return Buffer.concat([migrated, Uint8Array.from(extra)]);
    }));
  assert.equal(matched.size, calls.size);
  if (changed === 0) continue;
  recording.originalSha256 ??= recording.sha256;
  recording.sha256 = hash(bytes);
  recording.toolArgumentsSha256 = hash(new TextEncoder().encode(toolInputs));
  recording.toolEventsSha256 = inputRun.eventsSha256;
  await writeFile(path, bytes);
  console.log(`Updated ${changed} metadata entries in ${recording.file}`);
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
