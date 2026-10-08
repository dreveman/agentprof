// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {SETUP_SQL} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL, OVERVIEW_QUERIES} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';

const source = resolve('examples/muse-coding'), manifest = JSON.parse(await readFile(join(source, 'recording.json'), 'utf8'));
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const trace = await readFile(join(source, manifest.bundledFile));
assert.equal(sha(trace), manifest.sha256);
assert.deepEqual(trace, await readFile('artifacts/examples/agentprof-muse-example.pftrace'));
assert.equal(sha(await readFile(join(source, 'prompt.txt'))), manifest.promptSha256);
for (const [file, digest] of Object.entries(manifest.resultSha256)) assert.equal(sha(await readFile(join(source, 'result', file))), digest);
assert.deepEqual(await readFile(join(source, 'result/intervals.test.mjs')), await readFile('examples/pi-opus-5/task/intervals.test.mjs'));
const tests = spawnSync('node', ['--test'], {cwd: join(source, 'result'), encoding: 'utf8'});
assert.equal(tests.status, 0, tests.stderr + tests.stdout);
assert.match(tests.stdout, /# tests 12\b/);
const temporary = await mkdtemp(join(tmpdir(), 'muse-example-'));
try {
  const query = join(temporary, 'query.sql');
  await writeFile(query, `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}\nSELECT JSON_OBJECT(
    'recordings',(SELECT JSON_GROUP_ARRAY(JSON_OBJECT('id',session,'harness',harness,'provider',provider,'model',model,'effort',effort,
      'responses',responses,'tools',tools,'turns',turns,'inputTokens',input_tokens,'outputTokens',output_tokens,
      'contextWindowTokens',context_window_tokens,'peakContext',peak_context,'incomplete',incomplete,
      'startNs',CAST(start_ts AS TEXT),'endNs',CAST(end_ts AS TEXT))) FROM agentprof_capture_runs),
    'sessions',(SELECT COUNT(*) FROM (${OVERVIEW_QUERIES.runs})),
    'input',(SELECT input_tokens FROM (${OVERVIEW_QUERIES.runs})),
    'unavailableChildren',(SELECT unavailable_children FROM (${OVERVIEW_QUERIES.summary})),
    'errors',(SELECT COUNT(*) FROM stats WHERE severity='error' AND value>0),
    'flows',(SELECT COUNT(*) FROM flow),
    'missingArgs',(SELECT COUNT(*) FROM agentprof_tool_calls WHERE arguments IS NULL),
    'localPaths',(SELECT COUNT(*) FROM args WHERE string_value GLOB '*/home/*'),
    'units',(SELECT COUNT(*) FROM counter_track WHERE unit='tokens'
      AND name IN ('Input tokens','Output tokens','Context size','Context window')),
    'nonzeroEnds',(SELECT COUNT(*) FROM (SELECT value,ROW_NUMBER() OVER(PARTITION BY track_id ORDER BY ts DESC) n FROM counter) WHERE n=1 AND value!=0),
    'shellErrors',(SELECT COUNT(*) FROM agentprof_tool_calls WHERE name='bash' AND is_error=1),
    'categories',(SELECT JSON_GROUP_ARRAY(category) FROM (SELECT DISTINCT category FROM agentprof_slices))
  );`);
  const result = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor'),
    [join(source, manifest.bundledFile), '-q', query], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout.trim().split('\n').at(-1)!.slice(1, -1));
  const ordered = (rows: any[]) => rows.sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(ordered(data.recordings), ordered(manifest.recordings));
  assert.equal(data.sessions, 1);
  assert.equal(data.input, manifest.recordings.reduce((n: number, r: any) => n + r.inputTokens, 0));
  assert.equal(data.unavailableChildren, manifest.unavailableChildren);
  assert.equal(data.errors, 0); assert.equal(data.flows, manifest.flows);
  assert.equal(data.missingArgs, 0); assert.equal(data.localPaths, 0);
  assert.equal(data.units, manifest.recordings.length * 4); assert.equal(data.nonzeroEnds, 0);
  assert.equal(data.shellErrors, 1);
  assert.ok(data.categories.every((c: string) => c.startsWith('muse.')));
  console.log('PASS Muse example: measured work, child rollup, missing-child warning, typed shell outcomes, clocks and token counters');
} finally {await rm(temporary, {recursive: true, force: true});}
