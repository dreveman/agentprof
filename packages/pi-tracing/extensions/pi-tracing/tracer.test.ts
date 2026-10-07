// SPDX-License-Identifier: Apache-2.0
import {spawnSync} from "node:child_process";
import {decodeFields, tracePackets} from "./test-proto.ts";
import {childPromptFlowId} from "./workflow.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toolArgumentAnnotations } from "./annotations.ts";
import { defaultConfig } from "./config.ts";
import { CLOCK_BOOTTIME, CLOCK_PI_CUSTOM, CLOCK_REALTIME, buildTracePacket, buildTrackDescriptor, framePacket } from "./encoder.ts";
import { Recorder, linuxUptimeReading, boottimeNsForPlatform, sanitizeArgv0 } from "./tracer.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function recorder(
  tag: string,
  machineId?: number,
): Promise<{ recorder: Recorder; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-tracing-test-"));
  dirs.push(dir);
  const config = defaultConfig();
  config.sampleHz = 0;
  const instance = new Recorder({
    config,
    outDir: dir,
    sessionTag: tag,
    identity: { pid: process.pid, processName: "pi-test", labels: ["test"] },
    machineId,
  });
  return { recorder: instance, dir };
}

describe("pi-tracing recorder safety", () => {
  test("Linux boot snapshots preserve fractional uptime and expose fallback precision", () => {
    expect(linuxUptimeReading(() => "123.45 987.65\n", () => 123)).toEqual({seconds: 123.45, resolutionNs: 10_000_000n});
    expect(linuxUptimeReading(() => {throw new Error("no procfs");}, () => 123)).toEqual({seconds: 123, resolutionNs: 1_000_000_000n});
    expect(linuxUptimeReading(() => "invalid", () => 123)).toEqual({seconds: 123, resolutionNs: 1_000_000_000n});
  });
  test("BOOTTIME matches Perfetto's platform clock convention", () => {
    expect(boottimeNsForPlatform("linux", 99n, 1.25)).toBe(1_250_000_000n);
    expect(boottimeNsForPlatform("darwin", 99n, 1.25)).toBe(99n);
    expect(() => boottimeNsForPlatform("linux", 99n, Number.NaN)).toThrow();
  });

  test("metadata-only executable parsing never returns environment values", () => {
    expect(sanitizeArgv0("AWS_SECRET_ACCESS_KEY=secret aws s3 ls")).toBe("aws");
    expect(sanitizeArgv0("env TOKEN=secret curl https://example.com")).toBe("curl");
    expect(sanitizeArgv0("'TOKEN=secret value' command")).toBe("<redacted>");
    expect(sanitizeArgv0("$(secret-command) arg")).toBe("<redacted>");
  });

  test("recovery leaves a live recorder part untouched", async () => {
    const first = await recorder("live");
    const started = await first.recorder.start();
    expect(started.started).toBe(true);
    const partName = started.message.replace(/^recording to /, "");
    const second = new Recorder({
      config: defaultConfig(),
      outDir: first.dir,
      sessionTag: "observer",
      identity: { pid: process.pid, processName: "pi-test", labels: ["test"] },
    });
    const notes = await second.recoverParts();
    expect(notes.some((note) => note.includes("left live capture untouched"))).toBe(true);
    expect(existsSync(join(first.dir, partName))).toBe(true);
    await first.recorder.stop("test");
  });

  test("every packet carries one machine id and snapshots use REALTIME", async () => {
    const machineId = 0x10203040;
    const item = await recorder("machine", machineId);
    expect((await item.recorder.start()).started).toBe(true);
    const track = item.recorder.trackSet()?.sessionUuid;
    expect(track).toBeDefined();
    item.recorder.emitInstant({ cat: "agent", trackUuid: track!, name: "machine-event" });
    const manifest = await item.recorder.stop("test");
    expect(manifest?.machineId).toBe(machineId);

    const packets = tracePackets(new Uint8Array(await readFile(manifest!.path)));
    expect(packets.length).toBeGreaterThan(1);
    for (const packet of packets) {
      const ids = decodeFields(packet)
        .filter((field) => field.number === 98)
        .map((field) => Number(field.value));
      expect(ids).toEqual([machineId]);
    }

    const snapshots = packets.flatMap((packet) =>
      decodeFields(packet)
        .filter((field) => field.number === 6 && field.bytes !== undefined)
        .map((field) => field.bytes!),
    );
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      const fields = decodeFields(snapshot);
      expect(
        fields
          .filter((field) => field.number === 2)
          .map((field) => Number(field.value)),
      ).toEqual([CLOCK_REALTIME]);
      const clockIds = fields
        .filter((field) => field.number === 1 && field.bytes !== undefined)
        .map((field) =>
          Number(
            decodeFields(field.bytes!).find((clockField) => clockField.number === 1)
              ?.value,
          ),
        );
      expect(clockIds).toContain(CLOCK_PI_CUSTOM);
      expect(clockIds).toContain(CLOCK_BOOTTIME);
      expect(clockIds).toContain(CLOCK_REALTIME);
    }
  });

  test("span ids do not alias across recording generations", async () => {
    const item = await recorder("generation");
    expect((await item.recorder.start("one")).started).toBe(true);
    const firstTrack = item.recorder.trackSet()?.sessionUuid;
    expect(firstTrack).toBeDefined();
    const firstSpan = item.recorder.beginSlice({ cat: "agent", trackUuid: firstTrack!, name: "one" });
    expect(firstSpan).not.toBeNull();
    await item.recorder.stop("one");

    expect((await item.recorder.start("two")).started).toBe(true);
    const secondTrack = item.recorder.trackSet()?.sessionUuid;
    expect(secondTrack).toBeDefined();
    const secondSpan = item.recorder.beginSlice({ cat: "agent", trackUuid: secondTrack!, name: "two" });
    expect(secondSpan).not.toBeNull();
    expect(secondSpan).not.toBe(firstSpan);
    // A stale end from generation one must not close generation two.
    expect(item.recorder.emitEnd(firstSpan!)).toBeNull();
    expect(item.recorder.getStats().openSpans).toBe(1);
    item.recorder.emitEnd(secondSpan!);
    await item.recorder.stop("two");
  });
});

// Read emitted counter values directly, including tracks with no samples.
async function recordedCounters(path: string): Promise<Record<string, bigint[]>> {
  const packets = tracePackets(new Uint8Array(await readFile(path))).map(decodeFields);
  const names = new Map<bigint, string>();
  const values: Record<string, bigint[]> = {};
  for (const packet of packets) {
    const descriptor = packet.find(f => f.number === 60)?.bytes;
    if (!descriptor) continue;
    const fields = decodeFields(descriptor);
    if (!fields.some(f => f.number === 8)) continue;
    const uuid = fields.find(f => f.number === 1)?.value;
    const name = fields.find(f => f.number === 2)?.bytes;
    if (uuid !== undefined && name) {
      const text = new TextDecoder().decode(name);
      names.set(uuid, text);
      values[text] = [];
    }
  }
  for (const packet of packets) {
    const event = packet.find(f => f.number === 11)?.bytes;
    if (!event) continue;
    const fields = decodeFields(event);
    const uuid = fields.find(f => f.number === 11)?.value;
    const value = fields.find(f => f.number === 30)?.value;
    const name = uuid === undefined ? undefined : names.get(uuid);
    if (name !== undefined && value !== undefined) values[name]!.push(value);
  }
  return values;
}

test('token counters accumulate reported usage, skip unknowns, and reset per capture', async () => {
  const {recorder: r} = await recorder('tokens');
  r.setRunConfiguration({model: 'first', contextWindowTokens: 200000});
  const config = r.getConfig();
  config.categories.runtime = false;
  r.setConfig(config);
  expect((await r.start()).started).toBe(true);
  r.recordTokenUsage({usage: {input: 100, output: 20, cacheRead: 900}});
  r.recordTokenUsage({usage: {output: 5}});
  r.recordTokenUsage({usage: {input: NaN, output: -1}});
  r.recordTokenUsage({usage: {input: 1.5, output: Number.MAX_SAFE_INTEGER + 1}});
  r.recordTokenUsage({});
  r.recordTokenUsage({usage: {input: 50, output: 0}});
  r.recordContextTokens(1000);
  r.recordContextTokens(null);
  r.recordContextTokens(undefined);
  r.recordContextTokens(-1);
  r.recordContextTokens(Infinity);
  r.recordContextTokens(250);
  r.recordContextTokens(0);
  r.setRunConfiguration({model: 'second', contextWindowTokens: 300000});
  r.setRunConfiguration({model: 'third'});
  r.setRunConfiguration({model: 'fourth', contextWindowTokens: 100000});
  const first = await r.stop('test');
  const counters = await recordedCounters(first!.path);
  expect(counters['Input tokens']).toEqual([0n, 100n, 150n, 0n]);
  expect(counters['Output tokens']).toEqual([0n, 20n, 25n, 25n, 0n]);
  expect(counters['Context size']).toEqual([1000n, 250n, 0n, 0n]);
  expect(counters['Context window']).toEqual([200000n, 300000n, 0n, 100000n, 0n]);
  r.recordTokenUsage({usage: {input: 999, output: 999}});
  expect((await r.start()).started).toBe(true);
  r.recordTokenUsage({usage: {input: 2, output: 3}});
  const second = await recordedCounters((await r.stop('test'))!.path);
  expect(second['Input tokens']).toEqual([0n, 2n, 0n]);
  expect(second['Output tokens']).toEqual([0n, 3n, 0n]);
  expect(second['Context size']).toEqual([]);
  expect(second['Context window']).toEqual([100000n, 0n]);
});

test('LLM counters respect category disablement even with runtime enabled', async () => {
  const {recorder: r} = await recorder('no-tokens');
  r.setRunConfiguration({model: 'first', contextWindowTokens: 200000});
  const config = r.getConfig();
  config.categories.llm = false;
  r.setConfig(config);
  await r.start();
  r.recordTokenUsage({usage: {input: 50, output: 10}});
  r.recordContextTokens(500);
  const counters = await recordedCounters((await r.stop('test'))!.path);
  expect(counters['Input tokens']).toEqual([]);
  expect(counters['Output tokens']).toEqual([]);
  expect(counters['Context size']).toEqual([]);
  expect(counters['Context window']).toEqual([]);
});


test('deferred tool begins preserve timestamps, cross-process flows, lane reservations, and interrupted calls', async () => {
  const {recorder: r} = await recorder('deferred');
  await r.start();
  const start = r.captureTimestamp();
  const flow = childPromptFlowId('22222222-2222-4222-8222-222222222222')!;
  const a = r.beginToolSlice('a', 'subagent', start, [77n], {deferBegin: true});
  const b = r.beginToolSlice('b', 'interrupted', start + 1n, undefined, {deferBegin: true});
  const failed = r.beginToolSlice('failed', 'failed-launch', start + 2n, undefined, {deferBegin: true});
  expect([a, b, failed].every(id => id !== null)).toBe(true);
  r.emitInstant({cat: 'session', trackUuid: 123456789n,
    name: 'prompt-input', tNs: start + 3n, flowIds: [flow]});
  r.annotateSpan(a!, {middleware_is_error: false});
  r.accumulate(a!, 42);
  r.emitEnd(failed!, {is_error: true}, start + 4n);
  r.emitEnd(a!, undefined, start + 5n, [flow]);
  const result = await r.stop('test');
  // Describe the receiving track as a separate OS process in this single trace.
  const packets = tracePackets(await readFile(result!.path));
  const firstEvent = packets.findIndex(p => decodeFields(p).some(f => f.number === 11));
  const header = decodeFields(packets[firstEvent]!);
  const descriptor = buildTracePacket({timestampNs: start,
    clockId: Number(header.find(f => f.number === 58)!.value),
    seqId: Number(header.find(f => f.number === 10)!.value),
    machineId: Number(header.find(f => f.number === 98)!.value),
    trackDescriptor: buildTrackDescriptor({uuid: 123456789n, name: 'child process',
      process: {pid: 2000000000, processName: 'child', labels: []}})});
  packets.splice(firstEvent, 0, descriptor);
  await writeFile(result!.path, Buffer.concat(packets.map(p => framePacket(p))));
  const events = packets.flatMap(packet => {
    const fields = decodeFields(packet);
    const event = fields.find(f => f.number === 11)?.bytes;
    return event ? [{ts: fields.find(f => f.number === 8)!.value!, fields: decodeFields(event)}] : [];
  });
  const name = (e: typeof events[number]) => new TextDecoder().decode(e.fields.find(f => f.number === 23)?.bytes);
  const begins = events.filter(e => ['subagent', 'interrupted', 'failed-launch'].includes(name(e)));
  expect(begins).toHaveLength(3);
  expect(new Set(begins.map(e => e.fields.find(f => f.number === 11)!.value)).size).toBe(3);
  const begin = begins.find(e => name(e) === 'subagent')!;
  expect(begin.ts).toBe(start);
  expect(begin.fields.filter(f => f.number === 47).map(f => f.value)).toEqual([77n, flow]);
  expect(events.indexOf(begin)).toBeGreaterThan(events.findIndex(e => name(e) === 'prompt-input'));
  const processor = process.env.PERFETTO_TRACE_PROCESSOR;
  if (processor) {
    const imported = spawnSync(processor, [result!.path, '-Q', `SELECT CASE WHEN
      (SELECT COUNT(*) FROM flow f JOIN slice src ON src.id = f.slice_out JOIN slice dst ON dst.id = f.slice_in
        WHERE src.name = 'subagent' AND dst.name = 'prompt-input' AND src.dur = 5 AND dst.ts = src.ts + 3
        AND dst.track_id IN (SELECT pt.id FROM process_track pt JOIN process p USING (upid) WHERE p.pid = 2000000000)) = 1
      AND (SELECT COUNT(*) FROM slice WHERE name = 'interrupted' AND dur > 0
        AND EXTRACT_ARG(arg_set_id, 'debug.incomplete') = 1) = 1
      AND (SELECT COUNT(*) FROM slice WHERE name = 'failed-launch' AND dur = 2
        AND EXTRACT_ARG(arg_set_id, 'debug.is_error') = 1) = 1
      AND (SELECT COUNT(*) FROM slice WHERE name = 'subagent'
        AND EXTRACT_ARG(arg_set_id, 'debug.bytes') = 42
        AND EXTRACT_ARG(arg_set_id, 'debug.middleware_is_error') = 0) = 1
      THEN 'DEFERRED_OK' ELSE 'FAILED' END`], {encoding: 'utf8'});
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout).toContain('DEFERRED_OK');
  }
});

test('multibyte deferred tool arguments remain publishable at the 1 MiB file limit', async () => {
  const {recorder: r, dir} = await recorder('bounded-deferred');
  const config = r.getConfig();
  config.maxFileMB = 1;
  config.finalizeDeadlineMs = 2000;
  r.setConfig(config);
  expect((await r.start()).started).toBe(true);
  const args = toolArgumentAnnotations({command: '🙂'.repeat(40000)}, true);
  // The captured value is 65,536 UTF-16 units but 131,072 UTF-8 bytes:
  // bigger than the old fixed 64 KiB finalization reserve.
  const first = r.beginToolSlice('first', 'large-tool-first', undefined, [77n],
    {deferBegin: true, annotations: args});
  const second = r.beginToolSlice('second', 'large-tool-second', undefined, undefined,
    {deferBegin: true, annotations: args});
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  r.addBeginFlow(first!, 88n);
  const track = r.trackSet()!.sessionUuid;
  const padding = 'x'.repeat(8192);
  let limitReached = false;
  for (let i = 0; i < 150; i++) {
    if (!r.emitInstant({cat: 'agent', trackUuid: track, name: 'padding', annotations: {padding}})) {
      limitReached = true;
      break;
    }
  }
  expect(limitReached).toBe(true);
  expect(r.getStats().fileLimitReached).toBe(true);
  expect(r.emitEnd(second!)).not.toBeNull();
  expect(r.emitEnd(first!, undefined, undefined, [99n])).not.toBeNull();
  const result = await r.stop('bounded');
  expect(result?.error).toBeUndefined();
  expect(result?.shutdownTruncated).toBe(false);
  expect(result!.path.endsWith('.pftrace')).toBe(true);
  expect(result!.bytes).toBeLessThanOrEqual(1024 * 1024);
  expect((await readdir(dir)).some(path => path.endsWith('.pftrace.part'))).toBe(false);
  const events = tracePackets(await readFile(result!.path)).flatMap(packet => {
    const event = decodeFields(packet).find(field => field.number === 11)?.bytes;
    return event ? [decodeFields(event)] : [];
  });
  for (const name of ['large-tool-first', 'large-tool-second']) {
    const begin = events.find(fields => fields.find(field => field.number === 9)?.value === 1n &&
      new TextDecoder().decode(fields.find(field => field.number === 23)?.bytes) === name)!;
    expect(begin).toBeDefined();
    const uuid = begin.find(field => field.number === 11)!.value;
    expect(events.filter(fields => fields.find(field => field.number === 9)?.value === 2n &&
      fields.find(field => field.number === 11)?.value === uuid)).toHaveLength(1);
    const argsAnnotation = begin.filter(field => field.number === 4).map(field => decodeFields(field.bytes!))
      .find(fields => new TextDecoder().decode(fields.find(field => field.number === 10)?.bytes) === 'args')!;
    const command = decodeFields(argsAnnotation.find(field => field.number === 11)!.bytes!);
    const captured = command.find(field => field.number === 6)!.bytes!;
    expect(captured.length).toBeGreaterThan(64 * 1024);
    expect(new TextDecoder().decode(captured)).toBe((args.args as {command: string}).command);
    if (name === 'large-tool-first') {
      expect(begin.filter(field => field.number === 47).map(field => field.value)).toEqual([77n, 88n, 99n]);
    }
  }
});

test('late oversized END annotations degrade the operation, not publication', async () => {
  const {recorder: r, dir} = await recorder('bounded-result');
  const config = r.getConfig();
  config.maxFileMB = 1;
  config.finalizeDeadlineMs = 2000;
  r.setConfig(config);
  expect((await r.start()).started).toBe(true);
  const span = r.beginToolSlice('result', 'result-tool', undefined, undefined,
    {deferBegin: true, annotations: {args: 'begin survives'}})!;
  expect(span).not.toBeNull();
  const track = r.trackSet()!.sessionUuid;
  const padding = 'x'.repeat(8192);
  let limitReached = false;
  for (let i = 0; i < 150; i++) {
    if (!r.emitInstant({cat: 'agent', trackUuid: track, name: 'padding', annotations: {padding}})) {
      limitReached = true;
      break;
    }
  }
  expect(limitReached).toBe(true);
  expect(r.emitEnd(span, {result: '🙂'.repeat(45000)})).not.toBeNull();
  const result = await r.stop('bounded');
  expect(result?.error).toBeUndefined();
  expect(result?.shutdownTruncated).toBe(false);
  expect(result!.droppedEvents).toBeGreaterThan(0);
  expect((await readdir(dir)).some(path => path.endsWith('.pftrace.part'))).toBe(false);
  const events = tracePackets(await readFile(result!.path)).flatMap(packet => {
    const event = decodeFields(packet).find(field => field.number === 11)?.bytes;
    return event ? [decodeFields(event)] : [];
  });
  const begin = events.find(fields => new TextDecoder().decode(fields.find(field => field.number === 23)?.bytes) === 'result-tool')!;
  expect(begin).toBeDefined();
  expect(events.filter(fields => fields.find(field => field.number === 9)?.value === 2n &&
    fields.find(field => field.number === 11)?.value === begin.find(field => field.number === 11)?.value)).toHaveLength(1);
});

test('open deferred spans leave queue headroom for capture closure at stop', async () => {
  const {recorder: r} = await recorder('saturated-queue');
  const config = r.getConfig();
  config.queueDepth = 256;
  config.finalizeDeadlineMs = 2000;
  r.setConfig(config);
  expect((await r.start()).started).toBe(true);
  const captureTrack = r.trackSet()!.sessionUuid;
  for (let i = 0; i < 16; i++) {
    expect(r.beginToolSlice(`pending-${i}`, `tool-${i}`, undefined, undefined,
      {deferBegin: true})).not.toBeNull();
  }
  let saturated = false;
  for (let i = 0; i < 300; i++) {
    if (!r.emitInstant({cat: 'agent', trackUuid: captureTrack, name: 'padding'})) {
      saturated = true;
      break;
    }
  }
  expect(saturated).toBe(true);
  const result = await r.stop('pending');
  expect(result?.error).toBeUndefined();
  expect(result?.shutdownTruncated).toBe(false);
  const counters = await recordedCounters(result!.path);
  expect(counters['Dropped events']).toEqual([BigInt(result!.droppedEvents), 0n]);
  const events = tracePackets(await readFile(result!.path)).flatMap(packet => {
    const event = decodeFields(packet).find(field => field.number === 11)?.bytes;
    return event ? [decodeFields(event)] : [];
  });
  expect(events.some(fields => fields.find(field => field.number === 9)?.value === 2n &&
    fields.find(field => field.number === 11)?.value === captureTrack)).toBe(true);
  for (let i = 0; i < 16; i++) {
    const begin = events.find(fields => new TextDecoder().decode(fields.find(field => field.number === 23)?.bytes) === `tool-${i}`)!;
    expect(begin).toBeDefined();
    expect(events.filter(fields => fields.find(field => field.number === 9)?.value === 2n &&
      fields.find(field => field.number === 11)?.value === begin.find(field => field.number === 11)?.value)).toHaveLength(1);
  }
});

test('a deferred BEGIN larger than the queue budget is dropped without poisoning the writer', async () => {
  const {recorder: r} = await recorder('oversized-deferred');
  const config = r.getConfig();
  config.maxFileMB = 1;
  config.queueBytes = 64 * 1024;
  r.setConfig(config);
  expect((await r.start()).started).toBe(true);
  const args = toolArgumentAnnotations({command: '🙂'.repeat(40000)}, true);
  expect(r.beginToolSlice('too-large', 'too-large', undefined, undefined,
    {deferBegin: true, annotations: args})).toBeNull();
  expect(r.getStats().openSpans).toBe(0);
  expect(r.getStats().writeError).toBeUndefined();
  const result = await r.stop('bounded');
  expect(result?.error).toBeUndefined();
  expect(result?.shutdownTruncated).toBe(false);
  expect(result!.droppedEvents).toBeGreaterThan(0);
});
