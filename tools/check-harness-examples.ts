// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {INCLUDE_CORE_MODULES_SQL, STDLIB_PACKAGE_ARG} from './stdlib-sql.ts';

const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const temporary = await mkdtemp(resolve(tmpdir(), 'agentprof-harness-examples-'));
try {
  const query = resolve(temporary, 'check.sql');
  await writeFile(query, `${INCLUDE_CORE_MODULES_SQL}
    SELECT JSON_OBJECT(
      'sessions', (SELECT COUNT(*) FROM dev_agentprof_capture_runs),
      'recording', (SELECT JSON_OBJECT(
        'sessionId',session,'harness',harness,'provider',provider,'model',model,'effort',effort,
        'inputTokens',input_tokens,'outputTokens',output_tokens,'responses',responses,'turns',turns,'tools',tools,
        'contextWindowTokens',context_window_tokens,'peakContext',peak_context,'incomplete',incomplete,
        'startNs',CAST(start_ts AS TEXT),'endNs',CAST(end_ts AS TEXT),
        'scripts',(SELECT COUNT(*) FROM dev_agentprof_tool_calls WHERE kind='script'),
        'nestedTools',(SELECT COUNT(*) FROM dev_agentprof_script_children),'flows',(SELECT COUNT(*) FROM flow)
      ) FROM dev_agentprof_capture_runs),
      'prompt',(SELECT EXTRACT_ARG(arg_set_id,'debug.text') FROM dev_agentprof_slices WHERE kind='prompt' LIMIT 1),
      'errors',(SELECT COUNT(*) FROM stats WHERE severity='error' AND value>0),
      'local_paths',(SELECT COUNT(*) FROM args WHERE string_value GLOB '*/home/*'),
      'counter_tracks',(SELECT COUNT(*) FROM counter_track WHERE unit='tokens'
        AND name IN ('Input tokens','Output tokens','Context size','Context window')),
      'nonzero_ends',(SELECT COUNT(*) FROM (
        SELECT value, ROW_NUMBER() OVER(PARTITION BY track_id ORDER BY ts DESC) AS n FROM counter
      ) WHERE n=1 AND value!=0),
      'missing_arguments',(SELECT COUNT(*) FROM dev_agentprof_tool_call_details WHERE arguments IS NULL),
      'categories',(SELECT JSON_GROUP_ARRAY(category) FROM (SELECT DISTINCT category FROM dev_agentprof_slices))
    ) AS result;`);

  for (const name of ['claude', 'codex']) {
    const source = resolve(`examples/${name}-coding`);
    const manifest = JSON.parse(await readFile(resolve(source, 'recording.json'), 'utf8'));
    const bytes = await readFile(resolve(source, manifest.bundledFile));
    const bundled = resolve(`artifacts/examples/agentprof-${name}-example.pftrace`);
    const prompt = await readFile(resolve(source, 'prompt.txt'), 'utf8');
    assert.equal(sha256(bytes), manifest.sha256);
    assert.deepEqual(await readFile(bundled), bytes);
    assert.equal(sha256(prompt), manifest.promptSha256);
    for (const [file, hash] of Object.entries(manifest.resultSha256))
      assert.equal(sha256(await readFile(resolve(source, 'result', file))), hash);
    assert.deepEqual(await readFile(resolve(source, 'result/intervals.test.mjs')),
      await readFile('examples/pi-opus-5/task/intervals.test.mjs'), 'Original tests were not edited');
    const tests = spawnSync('node', ['--test', '--test-reporter=tap'], {cwd: resolve(source, 'result'), encoding: 'utf8'});
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.match(tests.stdout, new RegExp(`# tests ${manifest.validation.testCount}\\b`));

    const result = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor'),
      ['--add-sql-package', STDLIB_PACKAGE_ARG, bundled, '-q', query], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout.trim().split('\n').at(-1)!.slice(1, -1));
    assert.equal(data.sessions, 1);
    assert.deepEqual(data.recording, manifest.recording);
    assert.equal(data.recording.incomplete, 0);
    assert.equal(data.prompt.trim(), prompt.trim());
    assert.equal(data.errors, 0);
    assert.equal(data.local_paths, 0);
    assert.equal(data.counter_tracks, 4);
    assert.equal(data.nonzero_ends, 0);
    assert.equal(data.missing_arguments, 0);
    assert.ok(data.categories.every((category: string) => category.startsWith(`${name}.`)));
  }
  console.log('PASS harness examples: reviewed traces, usage, context, scripts, clocks, import health and completed coding tasks');
} finally {await rm(temporary, {recursive: true, force: true});}
