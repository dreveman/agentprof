// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";

import { defaultConfig } from "./config.ts";
import {
  CLOCK_PI_CUSTOM,
  TRACK_EVENT_BEGIN,
  TRACK_EVENT_END,
  buildTracePacket,
  buildTrackEvent,
  framePacket,
} from "./encoder.ts";
import { Recorder } from "./tracer.ts";
import {
  buildDescriptorPreamble,
  buildSnapshotPacket,
  createTrackSet,
} from "./tracks.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveTraceProcessor(): string | undefined {
  const explicit = process.env.PERFETTO_TRACE_PROCESSOR;
  if (explicit && executable(explicit)) return explicit;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const name of ["trace_processor", "trace_processor_shell"]) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && executable(candidate)) return candidate;
    }
  }
  return undefined;
}

function query(binary: string, trace: string, sql: string): { status: number | null; output: string } {
  const modern = spawnSync(binary, ["query", trace, sql], { encoding: "utf8" });
  if (modern.status === 0) return { status: modern.status, output: `${modern.stdout}${modern.stderr}` };
  const legacy = spawnSync(binary, [trace, "-Q", sql], { encoding: "utf8" });
  return { status: legacy.status, output: `${legacy.stdout}${legacy.stderr}` };
}

const binary = resolveTraceProcessor();

test("CI provides trace_processor for golden import validation", () => {
  if (process.env.CI) expect(binary, "set PERFETTO_TRACE_PROCESSOR in CI").toBeDefined();
});

const goldenTest = binary === undefined ? test.skip : test;

goldenTest('sampled counters close at zero without losing totals, diagnostics, or unknowns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-counter-close-'));
  dirs.push(dir);
  const config = defaultConfig();
  config.sampleHz = 0;
  config.laneCap = 1;
  const r = new Recorder({config, outDir: dir, sessionTag: 'counter-close',
    identity: {pid: 123, processName: 'pi-test', labels: []}});
  expect((await r.start()).started).toBe(true);
  r.recordTokenUsage({usage: {input: 100, output: 10}});
  r.emitCounter('runtime.rss', 1024);
  r.beginToolSlice('one', 'read');
  expect(r.beginToolSlice('two', 'read')).toBeNull();
  config.categories.llm = false;
  config.categories.runtime = false;
  r.setConfig(config);
  const trace = await r.stop('test');
  const result = query(binary!, trace!.path, `
    WITH samples AS (
      SELECT c.*, t.name, ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY ts DESC, c.id DESC) AS latest
      FROM counter c JOIN counter_track t ON t.id = c.track_id
    ) SELECT CASE WHEN
      NOT EXISTS (SELECT 1 FROM samples WHERE latest = 1 AND
        (value != 0 OR ts != (SELECT ts + dur FROM slice WHERE name = 'profile (1)')))
      AND (SELECT COUNT(*) FROM samples WHERE latest = 1) = 6
      AND (SELECT MAX(value) FROM samples WHERE name = 'Input tokens') = 100
      AND (SELECT MAX(value) FROM samples WHERE name = 'Output tokens') = 10
      AND (SELECT MAX(value) FROM samples WHERE name = 'Resident memory') = 1024
      AND (SELECT unit FROM counter_track WHERE name = 'Resident memory') = 'bytes'
      AND (SELECT unit FROM counter_track WHERE name = 'Lane overflows') = 'count'
      AND (SELECT unit FROM counter_track WHERE name = 'Input tokens') = 'tokens'
      AND EXISTS (SELECT 1 FROM counter_track t JOIN track p ON p.id=t.parent_id
        JOIN track capture ON capture.id=p.parent_id
        WHERE t.name='Resident memory' AND p.name='Runtime' AND capture.name='agentprof.capture')
      AND EXISTS (SELECT 1 FROM counter_track t JOIN track p ON p.id=t.parent_id
        JOIN track capture ON capture.id=p.parent_id
        WHERE t.name='Lane overflows' AND p.name='Tracing' AND capture.name='agentprof.capture')
      AND EXISTS (SELECT 1 FROM counter_track t JOIN track p ON p.id=t.parent_id
        WHERE t.name='Input tokens' AND p.name='agentprof.capture')
      AND (SELECT MAX(value) FROM samples WHERE name = 'Lane overflows') = 1
      AND NOT EXISTS (SELECT 1 FROM samples WHERE name = 'Context size')
      THEN 'COUNTER_CLOSE_OK' ELSE 'FAILED' END`);
  expect(result.status).toBe(0);
  expect(result.output).toContain('COUNTER_CLOSE_OK');
});

async function writeSyntheticTrace(args: {
  dir: string;
  fileName: string;
  machineId: number;
  seqId: number;
  pid: number;
  sliceName: string;
  sourceNs: bigint;
  boottimeNs: bigint;
  realtimeNs: bigint;
}): Promise<string> {
  const tracks = createTrackSet(1);
  const records = [
    buildSnapshotPacket({
      seqId: args.seqId,
      machineId: args.machineId,
      sourceClockId: CLOCK_PI_CUSTOM,
      sourceNs: args.sourceNs,
      boottimeNs: args.boottimeNs,
      realtimeNs: args.realtimeNs,
    }),
    ...buildDescriptorPreamble({
      tracks,
      identity: {
        pid: args.pid,
        processName: "pi-test",
        labels: [args.fileName],
      },
      seqId: args.seqId,
      machineId: args.machineId,
      clockId: CLOCK_PI_CUSTOM,
      nowNs: args.sourceNs,
      counterSpecs: [],
    }),
  ];
  const eventPacket = (type: number, timestampNs: bigint, name?: string): Uint8Array =>
    framePacket(
      buildTracePacket({
        timestampNs,
        clockId: CLOCK_PI_CUSTOM,
        seqId: args.seqId,
        machineId: args.machineId,
        trackEvent: buildTrackEvent({
          trackUuid: tracks.sessionUuid,
          categories: type === TRACK_EVENT_BEGIN ? ["pi.agent"] : [],
          name,
          type,
        }),
      }),
    );
  records.push(
    eventPacket(TRACK_EVENT_BEGIN, args.sourceNs + 10_000_000n, args.sliceName),
    eventPacket(TRACK_EVENT_END, args.sourceNs + 20_000_000n),
  );
  const path = join(args.dir, `${args.fileName}.pftrace`);
  await writeFile(path, Buffer.concat(records.map((record) => Buffer.from(record))));
  return path;
}

goldenTest("generated trace imports with tracks, closed slices, and no clock packet loss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tracing-golden-"));
  dirs.push(dir);
  const config = defaultConfig();
  config.sampleHz = 0;
  const recorder = new Recorder({
    config,
    outDir: dir,
    sessionTag: "golden",
    identity: { pid: process.pid, processName: "pi-test", labels: ["golden"] },
    machineId: 101,
  });
  expect((await recorder.start()).started).toBe(true);
  const track = recorder.trackSet()?.sessionUuid;
  expect(track).toBeDefined();
  const span = recorder.beginSlice({ cat: "agent", trackUuid: track!, name: "golden-slice" });
  expect(span).not.toBeNull();
  recorder.emitEnd(span!);
  const manifest = await recorder.stop("golden");
  expect(manifest?.shutdownTruncated).toBe(false);
  expect(manifest?.path.endsWith(".pftrace")).toBe(true);

  const sql = `
    SELECT CASE WHEN
      (SELECT COUNT(*) FROM track) > 0 AND
      (SELECT COUNT(*) FROM slice WHERE name = 'golden-slice' AND dur >= 0) = 1 AND
      (SELECT COUNT(*) FROM machine WHERE raw_id = 101) = 1 AND
      EXISTS (
        SELECT 1
        FROM slice s
        JOIN track t ON t.id = s.track_id
        JOIN machine m ON m.id = t.machine_id
        WHERE s.name = 'golden-slice' AND m.raw_id = 101
      ) AND
      (SELECT int_value FROM metadata WHERE name = 'trace_time_clock_id') = 1 AND
      EXISTS (
        SELECT 1
        FROM clock_snapshot
        GROUP BY machine_id, snapshot_id
        HAVING SUM(clock_id = 1) > 0 AND SUM(clock_id = 6) > 0 AND SUM(clock_id = 64) > 0
      ) AND
      COALESCE((SELECT SUM(value) FROM stats WHERE name = 'clock_sync_failure_no_path'), 0) = 0 AND
      COALESCE((SELECT SUM(value) FROM stats WHERE name = 'clock_sync_failure_undeferrable_packet_loss'), 0) = 0
    THEN 'PI_TRACING_GOLDEN_OK' ELSE 'PI_TRACING_GOLDEN_BAD' END AS result;
  `;
  const result = query(binary!, manifest!.path, sql);
  expect(result.status, `${basename(binary!)} output:\n${result.output}`).toBe(0);
  expect(result.output).toContain("PI_TRACING_GOLDEN_OK");
});

goldenTest("TAR aligns same-machine and remote traces through real-time snapshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-tracing-merge-"));
  dirs.push(dir);
  const realtime = 1_700_000_000_000_000_000n;
  const parent = await writeSyntheticTrace({
    dir,
    fileName: "parent",
    machineId: 101,
    seqId: 11,
    pid: 1001,
    sliceName: "parent-slice",
    sourceNs: 10_000_000_000n,
    boottimeNs: 100_000_000_000n,
    realtimeNs: realtime,
  });
  const child = await writeSyntheticTrace({
    dir,
    fileName: "child",
    machineId: 101,
    seqId: 12,
    pid: 1002,
    sliceName: "child-slice",
    sourceNs: 20_000_000_000n,
    boottimeNs: 101_000_000_000n,
    realtimeNs: realtime + 1_000_000_000n,
  });
  // Deliberately unrelated BOOTTIME: remote alignment must use REALTIME.
  const remote = await writeSyntheticTrace({
    dir,
    fileName: "remote",
    machineId: 202,
    seqId: 13,
    pid: 2001,
    sliceName: "remote-slice",
    sourceNs: 30_000_000_000n,
    boottimeNs: 9_000_000_000_000n,
    realtimeNs: realtime + 2_000_000_000n,
  });
  const archive = join(dir, "merged.tar");

  const merge = spawnSync(
    "tar",
    ["-cf", archive, "-C", dir, basename(parent), basename(child), basename(remote)],
    { encoding: "utf8" },
  );
  expect(merge.error).toBeUndefined();
  expect(
    merge.status,
    `merge output:\n${merge.stdout}${merge.stderr}`,
  ).toBe(0);

  const sql = `
    SELECT CASE WHEN
      (SELECT COUNT(*) FROM __intrinsic_trace_file WHERE trace_type = 'proto') = 3 AND
      (SELECT COUNT(*) FROM machine WHERE raw_id IN (101, 202)) = 2 AND
      EXISTS (
        SELECT 1 FROM slice s
        JOIN track t ON t.id = s.track_id
        JOIN machine m ON m.id = t.machine_id
        WHERE s.name = 'parent-slice' AND m.raw_id = 101
      ) AND
      EXISTS (
        SELECT 1 FROM slice s
        JOIN track t ON t.id = s.track_id
        JOIN machine m ON m.id = t.machine_id
        WHERE s.name = 'child-slice' AND m.raw_id = 101
      ) AND
      EXISTS (
        SELECT 1 FROM slice s
        JOIN track t ON t.id = s.track_id
        JOIN machine m ON m.id = t.machine_id
        WHERE s.name = 'remote-slice' AND m.raw_id = 202
      ) AND
      ABS(
        (SELECT ts FROM slice WHERE name = 'child-slice') -
        (SELECT ts FROM slice WHERE name = 'parent-slice') - 1000000000
      ) < 1000000 AND
      ABS(
        (SELECT ts FROM slice WHERE name = 'remote-slice') -
        (SELECT ts FROM slice WHERE name = 'parent-slice') - 2000000000
      ) < 1000000 AND
      COALESCE((
        SELECT SUM(value) FROM stats WHERE name IN (
          'clock_sync_unrelatable_clock_domains',
          'clock_sync_failure_no_path',
          'clock_sync_failure_undeferrable_packet_loss',
          'trace_sorter_negative_timestamp_dropped'
        )
      ), 0) = 0
    THEN 'PI_TRACING_MERGE_OK' ELSE 'PI_TRACING_MERGE_BAD' END AS result;
  `;
  const result = query(binary!, archive, sql);
  expect(result.status, `${basename(binary!)} output:\n${result.output}`).toBe(0);
  const diagnostics = result.output.includes("PI_TRACING_MERGE_OK") ? "" : query(binary!, archive, `
    SELECT
      (SELECT GROUP_CONCAT(s.name || ':' || s.ts || ':' || m.raw_id)
       FROM slice s JOIN track t ON t.id = s.track_id
       LEFT JOIN machine m ON m.id = t.machine_id) AS slices,
      (SELECT GROUP_CONCAT(trace_type) FROM __intrinsic_trace_file) AS trace_types,
      (SELECT GROUP_CONCAT(name || ':' || value) FROM stats
       WHERE value != 0 AND name GLOB '*clock*') AS clock_errors;
  `).output;
  expect(result.output, diagnostics).toContain("PI_TRACING_MERGE_OK");
});

goldenTest('run configuration survives disabled categories and records changes without duplicates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-configuration-'));
  dirs.push(dir);
  const config = defaultConfig();
  config.sampleHz = 0;
  for (const category of Object.keys(config.categories) as (keyof typeof config.categories)[]) {
    config.categories[category] = false;
  }
  const r = new Recorder({config, outDir: dir, sessionTag: 'configuration',
    identity: {pid: 123, processName: 'pi-test', labels: ['session:configuration']}});
  r.setRunConfiguration({model: 'model-a', provider: 'test', effort: 'high', contextWindowTokens: 100000});
  expect((await r.start()).started).toBe(true);
  r.setRunConfiguration({model: 'model-a', provider: 'test', effort: 'high', contextWindowTokens: 100000});
  r.setRunConfiguration({model: 'model-b', provider: 'test', effort: 'low', contextWindowTokens: 200000});
  r.setRunConfiguration({model: 'model-b', provider: 'test', effort: 'low', contextWindowTokens: 200000});
  const trace = await r.stop('test');
  const result = query(binary!, trace!.path, `SELECT CASE WHEN
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.model') FROM slice WHERE name = 'profile (1)') = 'model-a' AND
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.context_window_tokens') FROM slice WHERE name = 'profile (1)') = 100000 AND
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.effort') FROM slice WHERE name = 'profile (1)') = 'high' AND
    (SELECT dur FROM slice WHERE name = 'profile (1)') = ${trace!.tEndNs - trace!.tStartNs} AND
    (SELECT dur > 0 FROM slice WHERE name = 'run-configuration') AND
    (SELECT COUNT(*) FROM slice s JOIN track t ON t.id = s.track_id
      WHERE s.name = 'run-configuration' AND t.name = 'Tracing' AND s.dur > 0) = 1 AND
    NOT EXISTS (SELECT 1 FROM slice WHERE name = 'tracing-start' OR dur < 0) AND
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.stop_reason') FROM slice WHERE name = 'profile (1)') = 'test' AND
    (SELECT COUNT(*) FROM slice WHERE name = 'run-configuration') = 1 AND
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.model') FROM slice WHERE name = 'run-configuration') = 'model-b' AND
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.context_window_tokens') FROM slice WHERE name = 'run-configuration') = 200000 AND
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.effort') FROM slice WHERE name = 'run-configuration') = 'low'
    THEN 'CONFIG_OK' ELSE 'CONFIG_FAILED' END`);
  expect(result.status).toBe(0);
  expect(result.output).toContain('CONFIG_OK');
});

goldenTest('configuration intervals are adjacent and capture stop closes nested operations in order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-capture-spans-'));
  dirs.push(dir);
  const config = defaultConfig();
  config.sampleHz = 0;
  const r = new Recorder({config, outDir: dir, sessionTag: 'spans',
    identity: {pid: process.pid, processName: 'pi-test', labels: ['session:spans'],
      mainThread: {tid: process.pid, name: 'pi'}}});
  await r.start();
  const track = r.trackSet()!.sessionUuid;
  r.beginSlice({cat: 'agent', trackUuid: track, name: 'outer'});
  r.beginSlice({cat: 'agent', trackUuid: track, name: 'inner'});
  r.setRunConfiguration({model: 'a'});
  r.setRunConfiguration({model: 'b'});
  r.setRunConfiguration({model: 'b'});
  const trace = await r.shutdownFinalize('quit');
  const result = query(binary!, trace!.path, `SELECT CASE WHEN
    (SELECT COUNT(*) FROM slice s JOIN thread_track tt ON tt.id = s.track_id
      JOIN thread t ON t.utid = tt.utid WHERE s.name = 'profile (1)' AND t.tid = ${process.pid}) = 1 AND
    (SELECT COUNT(*) FROM slice WHERE name = 'run-configuration') = 2 AND
    (SELECT MAX(ts + dur) - MIN(ts) = SUM(dur) FROM slice WHERE name = 'run-configuration') AND
    (SELECT COUNT(*) FROM slice s JOIN track t ON t.id = s.track_id
      WHERE s.name = 'run-configuration' AND t.name = 'Tracing' AND s.dur > 0) = 2 AND
    (SELECT COUNT(*) FROM slice WHERE EXTRACT_ARG(arg_set_id, 'debug.incomplete') = 1) = 2 AND
    (SELECT c.name = 'inner' AND c.ts + c.dur = p.ts + p.dur
      FROM slice c JOIN slice p ON c.parent_id = p.id WHERE p.name = 'outer') AND
    (SELECT dur FROM slice WHERE name = 'profile (1)') = ${trace!.tEndNs - trace!.tStartNs} AND
    NOT EXISTS (SELECT 1 FROM slice WHERE dur < 0)
    THEN 'SPANS_OK' ELSE 'SPANS_FAILED' END`);
  expect(result.status).toBe(0);
  expect(result.output).toContain('SPANS_OK');
  expect(await r.stop('again')).toBeNull();
  await r.start();
  const second = await r.stop('second');
  const restarted = query(binary!, second!.path, `SELECT CASE WHEN
    (SELECT COUNT(*) FROM slice WHERE name = 'profile (2)' AND dur > 0) = 1 AND
    NOT EXISTS (SELECT 1 FROM slice WHERE name = 'run-configuration' OR dur < 0)
    THEN 'RESTART_OK' ELSE 'RESTART_FAILED' END`);
  expect(restarted.status).toBe(0);
  expect(restarted.output).toContain('RESTART_OK');
  const combined = join(dir, 'combined.pftrace');
  await writeFile(combined, Buffer.concat(await Promise.all([trace!.path, second!.path].map(path => readFile(path)))));
  const merged = query(binary!, combined, `SELECT CASE WHEN
    (SELECT COUNT(*) FROM thread WHERE tid = ${process.pid}) = 1 AND
    (SELECT COUNT(*) FROM process WHERE pid = ${process.pid}) = 1 AND
    (SELECT COUNT(*) FROM slice WHERE name GLOB 'profile ([0-9]*)' AND dur > 0) = 2
    AND (SELECT COUNT(*) FROM slice WHERE name = 'profile (2)' AND dur > 0) = 1 AND
    (SELECT COUNT(*) FROM track WHERE name = 'agentprof.capture') = 2
    THEN 'THREAD_MERGE_OK' ELSE 'THREAD_MERGE_FAILED' END`);
  expect(merged.status).toBe(0);
  expect(merged.output).toContain('THREAD_MERGE_OK');
});

goldenTest('main-thread agent spans retain their durations across configuration changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-main-thread-'));
  dirs.push(dir);
  const config = defaultConfig();
  config.sampleHz = 0;
  const r = new Recorder({config, outDir: dir, sessionTag: 'main-thread',
    identity: {pid: process.pid, processName: 'pi', labels: [],
      mainThread: {tid: process.pid, name: 'pi'}}});
  expect((await r.start()).started).toBe(true);
  const track = r.trackSet()!.sessionUuid;
  const start = r.captureTimestamp();
  const prompt = r.beginSlice({cat: 'agent', trackUuid: track, name: 'prompt', tNs: start})!;
  const attempt = r.beginSlice({cat: 'agent', trackUuid: track, name: 'attempt', tNs: start + 10n})!;
  r.setRunConfiguration({model: 'a'}, start + 20n);
  r.setRunConfiguration({model: 'b'}, start + 30n);
  const turn = r.beginSlice({cat: 'agent', trackUuid: track, name: 'turn', tNs: start + 40n})!;
  r.emitEnd(turn, undefined, start + 50n);
  r.emitEnd(attempt, undefined, start + 60n);
  r.emitEnd(prompt, undefined, start + 70n);
  const trace = await r.stop('test');
  const result = query(binary!, trace!.path, `SELECT CASE WHEN
    (SELECT dur FROM slice WHERE name = 'prompt') = 70 AND
    (SELECT dur FROM slice WHERE name = 'attempt') = 50 AND
    (SELECT dur FROM slice WHERE name = 'turn') = 10 AND
    (SELECT COUNT(*) FROM slice s JOIN thread_track tt ON tt.id = s.track_id
      WHERE s.name IN ('prompt', 'attempt', 'turn')) = 3 AND
    (SELECT COUNT(*) FROM slice s JOIN track t ON t.id = s.track_id
      WHERE s.name = 'run-configuration' AND t.name = 'Tracing') = 2 AND
    NOT EXISTS (SELECT 1 FROM track WHERE name = 'Agent') AND
    NOT EXISTS (SELECT 1 FROM stats WHERE severity = 'error' AND value > 0)
    THEN 'MAIN_THREAD_OK' ELSE 'MAIN_THREAD_FAILED' END`);
  expect(result.status).toBe(0);
  expect(result.output).toContain('MAIN_THREAD_OK');
});

goldenTest('tool siblings merge visually, preserve overlap and flows, and keep captures separate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-tool-merge-')); dirs.push(dir);
  const config = defaultConfig(); config.sampleHz = 0;
  const r = new Recorder({config, outDir: dir, sessionTag: 'tools',
    identity: {pid: 321, processName: 'pi', labels: []}});
  await r.start();
  const start = r.captureTimestamp();
  r.emitInstant({cat: 'tools', trackUuid: r.trackSet()!.sessionUuid,
    name: 'tool-preflight', tNs: start, flowIds: [99n]});
  const a = r.beginToolSlice('a', 'long', start + 10n, [99n]);
  const b = r.beginToolSlice('b', 'short', start + 20n);
  r.emitEnd(b!, undefined, start + 40n);
  const c = r.beginToolSlice('c', 'reused', start + 50n);
  r.emitEnd(a!, undefined, start + 70n);
  r.emitEnd(c!, undefined, start + 80n);
  const first = await r.stop('test');
  await r.start();
  const d = r.beginToolSlice('d', 'next-capture'); r.emitEnd(d!);
  const second = await r.stop('test');
  const {mergePiTraces} = await import('./merge.ts');
  const merged = mergePiTraces(await Promise.all([first!.path, second!.path].map(async path => ({bytes: await readFile(path)}))));
  const path = join(dir, 'merged.pftrace'); await writeFile(path, merged.bytes);
  const result = query(binary!, path, `INCLUDE PERFETTO MODULE viz.summary.track_event;
    SELECT CASE WHEN
    (SELECT COUNT(*) FROM _track_event_tracks_ordered_groups WHERE name='Tools' AND has_data)=2 AND
    (SELECT COUNT(*) FROM _track_event_tracks_ordered_groups WHERE name='Tools' AND track_ids GLOB '*,*')=1 AND
    NOT EXISTS (SELECT 1 FROM track WHERE name GLOB 'tools.lane.*') AND
    (SELECT COUNT(*) FROM slice WHERE name IN ('long','short','reused','next-capture') AND parent_id IS NULL)=4 AND
    (SELECT COUNT(*) FROM slice WHERE (name='long' AND dur=60) OR (name='short' AND dur=20) OR (name='reused' AND dur=30))=3 AND
    (SELECT COUNT(*) FROM flow f JOIN slice src ON src.id=f.slice_out JOIN slice dst ON dst.id=f.slice_in
      WHERE src.name='tool-preflight' AND dst.name='long')=1 AND
    NOT EXISTS (SELECT 1 FROM stats WHERE severity='error' AND value>0)
    THEN 'MERGED_TOOLS_OK' ELSE 'FAILED' END`);
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain('MERGED_TOOLS_OK');
});
