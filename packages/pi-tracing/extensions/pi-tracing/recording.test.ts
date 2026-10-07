// SPDX-License-Identifier: Apache-2.0
import {afterEach, expect, test} from 'bun:test';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Recorder} from './tracer.ts';
import {defaultConfig} from './config.ts';
import {mergePiTraces} from './merge.ts';
import {childPromptFlowId} from './workflow.ts';
import {decodeFields, tracePackets} from './test-proto.ts';

const dirs: string[] = [];
afterEach(async () => {for (const dir of dirs.splice(0)) await rm(dir, {recursive: true, force: true});});
async function directory() {const dir = await mkdtemp(join(tmpdir(), 'pi-recording-')); dirs.push(dir); return dir;}
const processor = process.env.PERFETTO_TRACE_PROCESSOR;
function query(path: string, sql: string, expected: string) {
  if (!processor) return;
  const result = spawnSync(processor, [path, '-Q', sql], {encoding: 'utf8'});
  expect(result.status, result.stderr).toBe(0);
  if (result.stdout.trim() !== expected) {
    const diagnostic = spawnSync(processor, [path, '-Q', "SELECT name, value FROM stats WHERE severity='error' AND value>0"], {encoding: 'utf8'});
    expect(result.stdout.trim(), diagnostic.stdout + diagnostic.stderr).toBe(expected);
  }
}
function recorder(dir: string, pid: number, recordingDirectory?: string) {
  const config = defaultConfig(); config.sampleHz = 0; config.finalizeDeadlineMs = 2000;
  return new Recorder({config, outDir: dir, sessionTag: `session-${pid}`, collectChildren: true,
    recordingDirectory, machineId: 42,
    identity: {pid, processName: 'pi', labels: [`session:00000000-0000-4000-8000-${String(pid).padStart(12, '0')}`]}});
}

test('one recording includes completed siblings, a nested child, and a running child at stop', async () => {
  const dir = await directory();
  const root = recorder(dir, 1); await root.start();
  const group = root.getRecordingDirectory()!;
  const a = recorder(dir, 2, group), b = recorder(dir, 3, group);
  await Promise.all([a.start(), b.start()]);
  const c = recorder(dir, 4, a.getRecordingDirectory()); await c.start();
  const flow = childPromptFlowId('00000000-0000-4000-8000-000000000002')!;
  const tool = root.beginToolSlice('child', 'subagent', undefined, undefined, {deferBegin: true});
  a.emitInstant({cat: 'session', name: 'prompt-input', trackUuid: a.trackSet()!.sessionUuid, flowIds: [flow]});
  a.recordTokenUsage({usage: {input: 17, output: 3}});
  await c.stop('done'); await a.stop('done');
  root.emitEnd(tool!, undefined, undefined, [flow]);
  b.beginToolSlice('pending', 'running-tool', undefined, undefined, {deferBegin: true});
  const result = await root.stop('stop');
  expect(result!.error).toBeUndefined();
  expect(result!.incompleteProcesses).toBe(false);
  expect(result!.path).toBe(root.getRecordingPath()!);
  expect((await readdir(dir)).filter(n => n.endsWith('.pftrace'))).toHaveLength(1);
  const groups = await readdir(join(dir, '.recordings'));
  expect(groups, JSON.stringify(await Promise.all(groups.map(g => readdir(join(dir, '.recordings', g)))))).toHaveLength(0);
  expect(b.isRecording()).toBe(false);
  query(result!.path, `SELECT CASE WHEN
    (SELECT COUNT(*) FROM slice WHERE name = 'profile (1)') = 4 AND
    (SELECT COUNT(*) FROM process WHERE name = 'pi') = 4 AND
    (SELECT COUNT(*) FROM flow f JOIN slice src ON src.id=f.slice_out JOIN slice dst ON dst.id=f.slice_in
      WHERE src.name='subagent' AND dst.name='prompt-input') = 1 AND
    (SELECT COUNT(*) FROM slice WHERE name='running-tool' AND dur>0
      AND EXTRACT_ARG(arg_set_id, 'debug.incomplete')=1) = 1 AND
    (SELECT MAX(c.value) FROM counter c JOIN counter_track t ON t.id=c.track_id WHERE t.name='Input tokens')=17 AND
    NOT EXISTS (SELECT 1 FROM stats WHERE severity='error' AND value>0)
    THEN 'OK' ELSE 'FAILED' END AS result`, '"result"\n"OK"');
  const late = recorder(dir, 5, group);
  expect((await late.start()).started).toBe(false);
  // A new capture gets a new group, without replaying earlier children.
  await root.start();
  expect(root.getRecordingDirectory()).not.toBe(group);
  const second = await root.stop('stop');
  query(second!.path, "SELECT COUNT(*) AS captures FROM slice WHERE name='profile (2)'", '"captures"\n1');
});

test('partial process spools get closed spans and counter zeros; normal streams retain their clocks', async () => {
  const dir = await directory();
  const config = defaultConfig(); config.sampleHz = 0;
  const r = new Recorder({config, outDir: dir, sessionTag: 'partial', machineId: 42,
    identity: {pid: 10, processName: 'pi', labels: []}});
  await r.start();
  r.beginToolSlice('open', 'work'); r.recordTokenUsage({usage: {input: 100}});
  const result = await r.stop('done');
  const original = await readFile(result!.path);
  const packets = tracePackets(original);
  const cut = packets.findIndex(packet => {
    const event = decodeFields(packet).find(f => f.number === 11)?.bytes;
    return event && decodeFields(event).some(f => f.number === 9 && f.value === 2n);
  });
  const {framePacket} = await import('./encoder.ts');
  const partial = Buffer.concat([...packets.slice(0, cut).map(framePacket), Buffer.from([10, 200, 1, 8])]);
  const merged = mergePiTraces([{bytes: partial, incomplete: true}]);
  expect(merged.incomplete).toBe(true);
  const path = join(dir, 'snapshot.pftrace');
  const {writeFile} = await import('node:fs/promises'); await writeFile(path, merged.bytes);
  query(path, `SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM slice WHERE dur < 0)
    AND EXISTS (SELECT 1 FROM slice WHERE name='work' AND EXTRACT_ARG(arg_set_id, 'debug.incomplete')=1)
    AND (SELECT MAX(value) FROM counter c JOIN counter_track t ON t.id=c.track_id WHERE t.name='Input tokens')=100
    AND NOT EXISTS (SELECT 1 FROM (SELECT value, ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY ts DESC) AS n FROM counter) WHERE n=1 AND value != 0)
    THEN 'OK' ELSE 'FAILED' END AS result`, '"result"\n"OK"');
  expect(() => mergePiTraces([{bytes: original}], {maxBytes: 1})).toThrow('maxFileMB');
  expect(() => mergePiTraces([{bytes: original}], {deadlineAt: 0})).toThrow('deadline');
  expect(() => mergePiTraces([{bytes: partial}])).toThrow();
  // Even identical packet sequence IDs in separate spools get separate namespaces.
  const twice = mergePiTraces([{bytes: original}, {bytes: original}]);
  const sequences = new Set(tracePackets(twice.bytes).map(p => decodeFields(p).find(f => f.number === 10)?.value));
  expect(sequences.size).toBe(2);
});

test('merged child counters remain valid when the child starts before the owner', async () => {
  const dir = await directory();
  const child = recorder(dir, 21); await child.start();
  child.recordTokenUsage({usage: {input: 17, output: 3}});
  const childResult = await child.stop('done');
  await new Promise(resolve => setTimeout(resolve, 20));
  const owner = recorder(dir, 22); await owner.start();
  owner.recordTokenUsage({usage: {input: 29, output: 5}});
  const ownerResult = await owner.stop('done');
  const merged = mergePiTraces([{bytes: await readFile(ownerResult!.path)}, {bytes: await readFile(childResult!.path)}]);
  const firstPacketBySequence = new Map<bigint, Uint8Array>();
  for (const packet of tracePackets(merged.bytes)) {
    const fields = decodeFields(packet);
    const sequence = fields.find(f => f.number === 10)?.value;
    if (sequence !== undefined && !firstPacketBySequence.has(sequence)) firstPacketBySequence.set(sequence, packet);
  }
  expect(firstPacketBySequence.size).toBe(2);
  for (const packet of firstPacketBySequence.values()) {
    expect(decodeFields(packet).some(f => f.number === 6)).toBe(true);
  }
  const path = join(dir, 'merged.pftrace');
  await writeFile(path, merged.bytes);
  query(path, `SELECT CASE WHEN
    (SELECT COUNT(DISTINCT track_id) FROM counter c JOIN counter_track t ON t.id=c.track_id
      WHERE t.name='Input tokens') = 2 AND
    (SELECT MAX(value) FROM counter c JOIN counter_track t ON t.id=c.track_id
      WHERE t.name='Input tokens') = 29 AND
    NOT EXISTS (SELECT 1 FROM stats WHERE severity='error' AND value>0)
    THEN 'OK' ELSE 'FAILED' END AS result`, '"result"\n"OK"');
});

test('custom output publishes an owner and child without replacing an existing trace', async () => {
  const dir = await directory();
  const path = join(dir, 'results', 'workflow.pftrace');
  const owner = recorder(dir, 31);
  expect((await owner.start('workflow', path)).started).toBe(true);
  const child = recorder(dir, 32, owner.getRecordingDirectory());
  expect((await child.start()).started).toBe(true);
  child.recordTokenUsage({usage: {input: 17}});
  await child.stop('done');
  const result = await owner.stop('done');
  expect(result!.path).toBe(path);
  query(path, `SELECT CASE WHEN
    (SELECT COUNT(*) FROM process WHERE name='pi') = 2 AND
    (SELECT MAX(value) FROM counter c JOIN counter_track t ON t.id=c.track_id
      WHERE t.name='Input tokens') = 17 AND
    NOT EXISTS (SELECT 1 FROM stats WHERE severity='error' AND value>0)
    THEN 'OK' ELSE 'FAILED' END AS result`, '"result"\n"OK"');
  const original = await readFile(path);
  expect((await owner.start('again', path)).started).toBe(false);
  expect(await readFile(path)).toEqual(original);
  expect((await child.start('separate', join(dir, 'child.pftrace'))).started).toBe(false);

  const racedPath = join(dir, 'results', 'raced.pftrace');
  expect((await owner.start('raced', racedPath)).started).toBe(true);
  await writeFile(racedPath, 'existing trace');
  const raced = await owner.stop('done');
  expect(raced!.error).toContain('recording assembly');
  expect(await readFile(racedPath, 'utf8')).toBe('existing trace');
});
