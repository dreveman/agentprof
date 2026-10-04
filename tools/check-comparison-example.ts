// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {SETUP_SQL} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL, OVERVIEW_QUERIES as Q} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';

const source = resolve('examples/harness-comparison');
const manifest = JSON.parse(await readFile(resolve(source, 'recording.json'), 'utf8'));
const prompt = await readFile(resolve(source, 'prompt.txt'), 'utf8');
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const bytes = await readFile(resolve(source, manifest.bundledFile));
const bundled = resolve('artifacts/examples/agentprof-comparison-example.pftrace');
assert.equal(sha256(bytes), manifest.sha256);
assert.deepEqual(await readFile(bundled), bytes, 'Preserve the reviewed combined recording');
assert.equal(sha256(prompt), manifest.promptSha256);
assert.equal(manifest.recordings.length, 2);
assert.equal(new Set(manifest.recordings.map((r: any) => r.sessionId)).size, 2);
for (const variant of ['pi-codemode', 'claude-code']) {
  assert.deepEqual(manifest.recordings.filter((r: any) => r.variant === variant)
    .map((r: any) => r.round), [manifest.selection.selectedRound]);
}

const sql = `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}
  CREATE PERFETTO TABLE runs AS ${Q.runs};
  SELECT JSON_OBJECT(
    'runs', (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('session',session,'harness',harness,
      'model',model,'provider',provider,'responses',responses,'turns',turns,'tools',tools,
      'input_tokens',input_tokens,'output_tokens',output_tokens,'duration_ms',duration_ms,
      'incomplete',incomplete,'subagents',subagents,'prompt',prompt_text,'labels',session_labels)) FROM runs),
    'usage', (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('session',session,'cache_read_tokens',cache_read_tokens,
      'cache_write_tokens',cache_write_tokens)) FROM (SELECT session,SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(COALESCE(EXTRACT_ARG(arg_set_id,'debug.cache_write_tokens'),0)) AS cache_write_tokens
      FROM agentprof_messages GROUP BY session)),
    'tools', (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('session',session,'calls',calls,'scripts',scripts,'nested',nested))
      FROM (SELECT session,COUNT(*) AS calls,SUM(kind='script') AS scripts,
        SUM(parent_call_id IS NOT NULL) AS nested FROM agentprof_tool_calls GROUP BY session)),
    'script_children', (SELECT COUNT(*) FROM agentprof_script_children),
    'script_flows', (SELECT COUNT(*) FROM flow f JOIN agentprof_tool_calls a ON a.id=f.slice_out
      JOIN agentprof_slices b ON b.id=f.slice_in WHERE a.kind='script' AND b.name='tool-preflight'),
    'tool_flows', (SELECT COUNT(*) FROM flow f JOIN agentprof_slices a ON a.id=f.slice_out
      JOIN agentprof_tool_calls b ON b.id=f.slice_in WHERE a.name='tool-preflight' AND b.parent_call_id IS NOT NULL),
    'missing_arguments', (SELECT COUNT(*) FROM agentprof_tool_calls WHERE arguments IS NULL),
    'invalid_scripts', (SELECT COUNT(*) FROM agentprof_tool_calls WHERE kind='script'
      AND (language IS NOT 'JavaScript' OR line_count IS NULL OR line_count < 1)),
    'errors', (SELECT JSON_GROUP_ARRAY(name) FROM stats WHERE severity='error' AND value>0),
    'capture_loss', (SELECT COUNT(*) FROM counter c JOIN agentprof_counter_tracks t ON t.id=c.track_id
      WHERE t.name IN ('tracing.droppedEvents','tracing.laneOverflows') AND c.value>0)
  ) AS result;`;
const temporary = await mkdtemp(resolve(tmpdir(), 'agentprof-comparison-check-'));
try {
  const query = resolve(temporary, 'checks.sql');
  await writeFile(query, sql);
  const result = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor'),
    [bundled, '-q', query], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout.trim().split('\n').at(-1)!.slice(1, -1));
  assert.equal(data.runs.length, 2);
  let nested = 0;
  for (const expected of manifest.recordings) {
    assert.equal(expected.correct, true);
    assert.equal(expected.testCount, 12);
    assert.deepEqual(expected.protocolIssues, []);
    assert.equal(expected.promptSha256, manifest.promptSha256);
    const run = data.runs.find((r: any) => r.session === expected.sessionId);
    assert.ok(run, `Missing session ${expected.sessionId}`);
    assert.equal(run.harness, expected.harness);
    assert.equal(run.model, manifest.model);
    assert.equal(run.provider, 'anthropic');
    assert.equal(run.responses, expected.primaryResponses);
    assert.equal(run.turns, expected.primaryResponses);
    assert.equal(run.tools, expected.primaryExecutedCalls - expected.scriptCalls);
    assert.equal(run.input_tokens, expected.usage.input_tokens);
    assert.equal(run.output_tokens, expected.usage.output_tokens);
    assert.ok(Math.abs(run.duration_ms / 1000 - expected.wallSeconds) < 1e-6);
    assert.equal(run.incomplete, 0);
    assert.equal(run.subagents, 0);
    assert.equal(run.prompt, prompt);
    assert.deepEqual(JSON.parse(run.labels ?? '[]'), expected.variant === 'pi-codemode' ? ['codemode'] : []);
    const usage = data.usage.find((r: any) => r.session === expected.sessionId);
    assert.equal(usage.cache_read_tokens, expected.usage.cache_read_tokens);
    assert.equal(usage.cache_write_tokens, expected.usage.cache_write_tokens);
    assert.deepEqual(data.tools.find((r: any) => r.session === expected.sessionId), {
      session: expected.sessionId, calls: expected.primaryExecutedCalls,
      scripts: expected.scriptCalls, nested: expected.nestedToolCalls,
    });
    nested += expected.nestedToolCalls;
  }
  assert.equal(nested, 9);
  for (const key of ['script_children', 'script_flows', 'tool_flows']) assert.equal(data[key], nested, key);
  for (const key of ['missing_arguments', 'invalid_scripts', 'capture_loss']) assert.equal(data[key], 0, key);
  assert.deepEqual(data.errors, []);
} finally {
  await rm(temporary, {recursive: true, force: true});
}
console.log('PASS harness comparison: two sessions, prompts, identity, usage, scripts, nested tools, flows and capture health');
