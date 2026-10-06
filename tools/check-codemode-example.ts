// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {SETUP_SQL} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL, OVERVIEW_QUERIES as Q} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';

const source = resolve('examples/pi-codemode');
const manifest = JSON.parse(await readFile(resolve(source, 'recording.json'), 'utf8'));
const prompt = await readFile(resolve(source, 'prompt.txt'), 'utf8');
const toolInputs = await readFile(resolve(source, 'tool-arguments.json'));
const inputRuns = JSON.parse(toolInputs.toString());
const snapshotBytes = await readFile(resolve(source, manifest.snapshotFile));
assert.equal(createHash('sha256').update(snapshotBytes).digest('hex'), manifest.snapshotSha256);
assert.equal(createHash('sha256').update(prompt).digest('hex'), manifest.promptSha256);
type Failure = {id: string; owner: string; duration_ms: number; history: {conclusion: string}[]};
const snapshot: {failures: Failure[]} = JSON.parse(snapshotBytes.toString());
assert.equal(snapshot.failures.length, manifest.cases);
const counts = new Map<string, {owner: string; new: number; persistent: number; intermittent: number}>();
const newFailures: Failure[] = [];
for (const failure of snapshot.failures) {
  assert.equal(failure.history.length, 4);
  assert.ok(failure.history.every(h => ['passed', 'failed'].includes(h.conclusion)));
  const category = failure.history.every(h => h.conclusion === 'passed') ? 'new'
    : failure.history.every(h => h.conclusion === 'failed') ? 'persistent' : 'intermittent';
  const owner = counts.get(failure.owner) ?? {owner: failure.owner, new: 0, persistent: 0, intermittent: 0};
  owner[category]++;
  counts.set(failure.owner, owner);
  if (category === 'new') newFailures.push(failure);
}
const expected = {
  total: snapshot.failures.length,
  owners: [...counts.values()].sort((a, b) => a.owner.localeCompare(b.owner)),
  slowest_new: newFailures.sort((a, b) => b.duration_ms - a.duration_ms || a.id.localeCompare(b.id))
    .slice(0, 5).map(({id, duration_ms}) => ({id, duration_ms})),
};
assert.deepEqual(JSON.parse(await readFile(resolve(source, 'expected.json'), 'utf8')), expected);
const answers = JSON.parse(await readFile(resolve(source, 'answers.json'), 'utf8'));
assert.equal(answers.length, manifest.recordings.length);
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
const checks: string[] = [];
let nestedCalls = 0;
let totalCalls = 0;
for (const run of manifest.recordings) {
  const bytes = await readFile(resolve(source, run.file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), run.sha256);
  assert.equal(run.preContextSha256, run.traceSha256, 'Preserve provenance of the original recording');
  assert.equal(createHash('sha256').update(toolInputs).digest('hex'), run.toolArgumentsSha256);
  assert.deepEqual(answers.find((answer: {sessionId: string}) => answer.sessionId === run.sessionId)?.answer, expected);
  const inputs = inputRuns.find((r: {sessionId: string}) => r.sessionId === run.sessionId);
  assert.equal(inputs.eventsSha256, run.toolEventsSha256);
  assert.equal(inputs.calls.length, run.toolCalls + run.scripts);
  const histories = inputs.calls.filter((call: {toolName: string}) => call.toolName === 'ci_get_failure_history');
  assert.equal(histories.length, snapshot.failures.length);
  assert.deepEqual(histories.map((call: {args: {failure_id: string}}) => call.args.failure_id).sort(),
    snapshot.failures.map(failure => failure.id).sort());
  assert.equal(inputs.calls.filter((call: {toolName: string}) => call.toolName.startsWith('ci_')).length, run.apiCalls);
  nestedCalls += run.nestedCalls;
  totalCalls += inputs.calls.length;
  checks.push(`EXISTS (SELECT 1 FROM runs WHERE session = ${quote(run.sessionId)}
    AND model = ${quote(run.model)} AND provider = ${quote(run.provider)} AND effort = ${quote(run.effort)}
    AND input_tokens = ${run.inputTokens} AND output_tokens = ${run.outputTokens}
    AND turns = ${run.responses} AND tools = ${run.toolCalls} AND incomplete = 0
    AND prompt_text = ${quote(prompt)} AND duration_ms > 0
    AND ${run.mode === 'codemode' ? `session_labels = '["codemode"]'` : 'session_labels IS NULL'})`);
  checks.push(`(SELECT COUNT(*) FROM agentprof_tool_calls WHERE kind = 'script'
    AND session = ${quote(run.sessionId)}) = ${run.scripts}`);
  checks.push(`(SELECT COUNT(*) FROM agentprof_tool_calls WHERE parent_call_id IS NOT NULL
    AND session = ${quote(run.sessionId)}) = ${run.nestedCalls}`);
  for (const call of inputs.calls) {
    for (const [key, value] of Object.entries(call.args)) {
      assert.ok(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
      const literal = typeof value === 'string' ? quote(value) : Number(value);
      checks.push(`EXISTS (SELECT 1 FROM agentprof_tool_calls WHERE session = ${quote(run.sessionId)}
        AND call_id = ${quote(call.toolCallId)} AND EXTRACT_ARG(arg_set_id, ${quote(`debug.args.${key}`)}) = ${literal})`);
    }
  }
}
const sql = `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}
  CREATE PERFETTO TABLE runs AS ${Q.runs};
  SELECT CASE WHEN ${checks.join('\n AND ')}
    AND (SELECT COUNT(*) FROM runs) = 2
    AND (SELECT COUNT(DISTINCT prompt_text) FROM runs) = 1
    AND (SELECT SUM(calls) FROM (${Q.scripts})) = ${nestedCalls}
    AND (SELECT COUNT(*) FROM (${Q.script_calls})) = ${nestedCalls}
    AND (SELECT COUNT(*) FROM flow f
      JOIN agentprof_tool_calls a ON a.id = f.slice_out
      JOIN agentprof_slices b ON b.id = f.slice_in
      WHERE a.kind = 'script' AND b.name = 'tool-preflight') = ${nestedCalls}
    AND (SELECT COUNT(*) FROM flow f JOIN agentprof_slices a ON a.id = f.slice_out
      JOIN agentprof_tool_calls b ON b.id = f.slice_in
      WHERE a.name = 'tool-preflight' AND b.parent_call_id IS NOT NULL) = ${nestedCalls}
    AND (SELECT MAX(value) FROM (${Q.health}) WHERE metric = 'Lane overflows') = 0
    AND (SELECT MAX(value) FROM (${Q.health}) WHERE metric = 'Dropped events') = 0
    AND NOT EXISTS (SELECT 1 FROM stats WHERE severity = 'error' AND value > 0)
    AND (SELECT COUNT(*) FROM agentprof_tool_calls WHERE arguments IS NOT NULL) = ${totalCalls}
    AND NOT EXISTS (SELECT 1 FROM args WHERE key = 'debug.codemode_enabled')
  THEN 'CODEMODE_EXAMPLE_OK' ELSE 'FAILED' END AS result`;
// Hundreds of original tool arguments can exceed the OS command-line limit.
const temporary = await mkdtemp(resolve(tmpdir(), 'agentprof-codemode-check-'));
try {
  const query = resolve(temporary, 'checks.sql');
  await writeFile(query, sql);
  const result = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor'),
    [resolve('artifacts/examples/agentprof-codemode-example.pftrace'), '-q', query], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('CODEMODE_EXAMPLE_OK'), result.stdout);
} finally {
  await rm(temporary, {recursive: true, force: true});
}
console.log('PASS real CI-audit comparison: answers, full coverage, identity, usage, arguments, nested calls, flows, capture health');
