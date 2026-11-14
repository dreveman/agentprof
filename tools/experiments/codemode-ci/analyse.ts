// SPDX-License-Identifier: Apache-2.0
// Merge each pair and check its traces using the same queries as the UI.
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {mergePiTraces} from '../../../packages/pi-tracing/extensions/pi-tracing/merge.ts';
import {OVERVIEW_SELECTS as Q} from '../../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';
import {INCLUDE_CORE_MODULES_SQL, STDLIB_PACKAGE_ARG} from '../../stdlib-sql.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const batch = resolve(process.argv[2] ?? '');
const manifest = JSON.parse(readFileSync(resolve(batch, 'recording.json'), 'utf8'));
for (const round of new Set<number>(manifest.recordings.map((run: any) => run.round))) {
  const runs = manifest.recordings.filter((run: any) => run.round === round);
  assert.equal(runs.length, 2);
  const target = resolve(batch, `round-${round}/comparison.pftrace`);
  writeFileSync(target, mergePiTraces(runs.map((run: any) => {
    assert.equal(run.correct, true);
    assert.equal(run.error, null);
    const bytes = readFileSync(resolve(batch, `round-${round}/${run.mode}/trace.pftrace`));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), run.traceSha256);
    return {bytes};
  })).bytes);
  const checks = runs.map((run: any) => {
    assert.match(run.sessionId, /^[\da-f-]+$/);
    return `EXISTS (SELECT 1 FROM runs WHERE session = '${run.sessionId}'
      AND tools = ${run.toolCalls} AND turns = ${run.responses}
      AND output_tokens = ${run.outputTokens} AND incomplete = 0)
      AND (SELECT COUNT(*) FROM agentprof_tool_calls WHERE session = '${run.sessionId}'
        AND parent_call_id IS NOT NULL) = ${run.nestedCalls}
      AND (SELECT COUNT(*) FROM flow f JOIN agentprof_tool_calls a ON a.id = f.slice_out
        JOIN agentprof_slices b ON b.id = f.slice_in
        WHERE a.session = '${run.sessionId}' AND a.kind = 'script' AND b.name = 'tool-preflight') = ${run.nestedCalls}
      AND (SELECT COUNT(*) FROM flow f JOIN agentprof_slices a ON a.id = f.slice_out
        JOIN agentprof_tool_calls b ON b.id = f.slice_in
        WHERE b.session = '${run.sessionId}' AND a.name = 'tool-preflight'
        AND b.parent_call_id IS NOT NULL) = ${run.nestedCalls}`;
  });
  const rawSql = `${INCLUDE_CORE_MODULES_SQL}
    CREATE PERFETTO TABLE runs AS ${Q.runs};
    SELECT CASE WHEN ${checks.join(' AND ')}
      AND (SELECT COUNT(*) FROM runs) = 2
      AND (SELECT COUNT(DISTINCT prompt_text) FROM runs) = 1
      AND NOT EXISTS (SELECT 1 FROM stats WHERE severity = 'error' AND value > 0)
      AND (SELECT MAX(value) FROM (${Q.health}) WHERE metric = 'Lane overflows') = 0
      AND (SELECT MAX(value) FROM (${Q.health}) WHERE metric = 'Dropped events') = 0
      THEN 'TRACE_OK' ELSE 'TRACE_FAILED' END AS status,
      session, duration_ms, peak_context, tools, turns, output_tokens, model_busy_ms FROM runs`;
  const sql = rawSql.replace(/(?<!debug\.|dev_)\bagentprof_/g, 'dev_agentprof_');
  const result = spawnSync(resolve(root, 'third_party/src/perfetto/tools/trace_processor'),
    ['--add-sql-package', STDLIB_PACKAGE_ARG, target, '-Q', sql], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('TRACE_OK') && !result.stdout.includes('TRACE_FAILED'), result.stdout);
  writeFileSync(resolve(batch, `round-${round}/trace-metrics.csv`), result.stdout.trim() + '\n');
  console.log(target + '\n' + result.stdout.trim());
}
