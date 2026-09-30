// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {SETUP_SQL} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL, OVERVIEW_QUERIES} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';

import {childPromptFlowId} from '../packages/pi-tracing/extensions/pi-tracing/workflow.ts';
import {decodeFields, tracePackets} from '../packages/pi-tracing/extensions/pi-tracing/test-proto.ts';

const source = resolve('examples/pi-opus-5');
const manifest = JSON.parse(await readFile(resolve(source, 'recording.json'), 'utf8'));
// Inspect packets because separate TAR members have independent flow trackers.
for (const child of manifest.workflow.children) {
  const endpoints: {file: string; name: string; type: bigint | undefined}[] = [];
  for (const file of manifest.bundledFiles) {
    for (const packet of tracePackets(await readFile(resolve('examples/pi-opus-5', file)))) {
      const event = decodeFields(packet).find(f => f.number === 11)?.bytes;
      if (!event) continue;
      const fields = decodeFields(event);
      if (fields.some(f => f.number === 47 && f.value === childPromptFlowId(child.sessionId))) {
        endpoints.push({file, name: new TextDecoder().decode(fields.find(f => f.number === 23)?.bytes),
          type: fields.find(f => f.number === 9)?.value});
      }
    }
  }
  assert.equal(endpoints.length, 2, `delegation endpoints for ${child.sessionId}`);
  assert.ok(endpoints.some(e => e.file === 'workflow-parent.pftrace' && e.name === 'subagent' && e.type === 1n));
  const childFile = manifest.recordings.find((r: {sessionId: string}) => r.sessionId === child.sessionId).file;
  assert.ok(endpoints.some(e => e.file === childFile && e.name === 'prompt-input' && e.type === 3n));
}

const prompts = new Map<string, string>();
for (const recording of manifest.recordings) {
  prompts.set(recording.sessionId, await readFile(resolve(source, recording.promptFile), 'utf8'));
}
const binary = process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor');
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
type Recording = typeof manifest.recordings[number];
function validate(path: string, recordings: Recording[]) {
  const conditions = recordings.map(r => `EXISTS (
    SELECT 1 FROM recorded_runs WHERE session = ${quote(r.sessionId)}
      AND harness = 'pi' AND provider = ${quote(r.provider)} AND model = ${quote(r.model)}
      AND effort = ${quote(r.effort)} AND input_tokens = ${r.inputTokens}
      AND output_tokens = ${r.outputTokens} AND responses = ${r.responses}
      AND turns = ${r.turns} AND tools = ${r.toolCalls} AND incomplete = 0
      AND peak_context > 0 AND context_window_tokens = 1000000
      AND ABS(start_ts - ${r.startNs}) < 12000000
  ) AND (SELECT SUM(input_tokens) FROM agentprof_messages WHERE session = ${quote(r.sessionId)}) = ${r.inputTokens}
    AND (SELECT SUM(output_tokens) FROM agentprof_messages WHERE session = ${quote(r.sessionId)}) = ${r.outputTokens}
    AND (SELECT COUNT(*) FROM agentprof_slices WHERE session = ${quote(r.sessionId)} AND name = 'attempt') = 1
    AND (SELECT COUNT(*) FROM agentprof_messages WHERE session = ${quote(r.sessionId)}
      AND name = 'response' AND track_name = 'Responses' AND dur > 0 AND message_start_ts = ts
      AND ABS(dur - EXTRACT_ARG(arg_set_id, 'debug.duration_ns')) < 12000000) = ${r.responses}
    AND (SELECT COUNT(*) FROM agentprof_slices WHERE session = ${quote(r.sessionId)}
      AND name = 'request' AND track_name = 'Requests' AND dur > 0) = ${r.responses}
    AND (SELECT COUNT(*) FROM agentprof_slices WHERE session = ${quote(r.sessionId)}
      AND name = 'prompt' AND category = 'pi.agent,pi.prompt-data'
      AND EXTRACT_ARG(arg_set_id, 'debug.text') = ${quote(prompts.get(r.sessionId)!)}
      AND EXTRACT_ARG(arg_set_id, 'debug.length') = ${prompts.get(r.sessionId)!.length}) = 1
    AND (SELECT COUNT(*) FROM agentprof_slices WHERE session = ${quote(r.sessionId)}
      AND name = 'tool-preflight'
      AND EXTRACT_ARG(arg_set_id, 'debug.name') IS NOT NULL
      AND EXTRACT_ARG(arg_set_id, 'debug.bytes') > 0
      AND EXTRACT_ARG(arg_set_id, 'debug.keys[0]') IS NOT NULL) = ${r.toolCalls}`);
  const includedSessions = new Set(recordings.map(r => r.sessionId));
  for (const r of recordings) {
    const role = r.parentSessionId ? `Subagent · ${r.role}` : 'Primary';
    conditions.push(`EXISTS (SELECT 1 FROM (${OVERVIEW_QUERIES.sessions})
      WHERE session = ${quote(r.sessionId)} AND role = ${quote(role)})`);
    if (r.parentSessionId && includedSessions.has(r.parentSessionId)) continue;
    conditions.push(`EXISTS (SELECT 1 FROM overview_runs WHERE session = ${quote(r.sessionId)}
      AND prompt_text = ${quote(prompts.get(r.sessionId)!.slice(0, 2048))}
      AND tokens_per_s > 0 AND model_busy_ms > 0 AND model_busy_ms <= duration_ms
      AND peak_model_responses > 0
      AND prompt_id IN (SELECT id FROM agentprof_slices WHERE session = ${quote(r.sessionId)}
        AND name = 'prompt'))`);
  }
  const workflow = manifest.workflow;
  if (workflow && recordings.some(r => r.sessionId === workflow.parentSessionId)) {
    for (const child of workflow.children) {
      if (!recordings.some(r => r.sessionId === child.sessionId)) continue;
      conditions.push(`EXISTS (SELECT 1 FROM agentprof_slices
        WHERE session = ${quote(workflow.parentSessionId)} AND EXTRACT_ARG(arg_set_id, 'debug.delegation') = 1
          AND EXTRACT_ARG(arg_set_id, 'debug.child_session') = ${quote(child.sessionId)})
        AND EXISTS (SELECT 1 FROM agentprof_slices
        WHERE session = ${quote(child.sessionId)} AND name IN ('profile (1)', 'child-start subagent')
          AND EXTRACT_ARG(arg_set_id, 'debug.parent_session') = ${quote(workflow.parentSessionId)}
          AND EXTRACT_ARG(arg_set_id, 'debug.subagent_type') = ${quote(child.role)})`);
    }
    const worker = workflow.children.find((c: {role: string}) => c.role === 'implementation');
    const tests = workflow.children.find((c: {role: string}) => c.role === 'tests');
    const reviewer = workflow.children.find((c: {role: string}) => c.role === 'reviewer');
    if ([worker, tests, reviewer].every(c => recordings.some(r => r.sessionId === c.sessionId))) {
      const start = (id: string) => `(SELECT MIN(ts) FROM agentprof_slices WHERE session = ${quote(id)})`;
      const end = (id: string) => `(SELECT MAX(ts + MAX(dur, 0)) FROM agentprof_slices WHERE session = ${quote(id)})`;
      conditions.push(`MAX(${start(worker.sessionId)}, ${start(tests.sessionId)}) < MIN(${end(worker.sessionId)}, ${end(tests.sessionId)})`);
      conditions.push(`${start(reviewer.sessionId)} > MAX(${end(worker.sessionId)}, ${end(tests.sessionId)})`);
    }
  }
  const includedChildren = recordings.some(r => r.sessionId === workflow.parentSessionId)
    ? workflow.children.filter(c => recordings.some(r => r.sessionId === c.sessionId)) : [];
  conditions.push(`(SELECT COUNT(*) FROM overview_runs) = ${recordings.length - includedChildren.length}`);
  if (includedChildren.length) {
    const family = recordings.filter(r => r.sessionId === workflow.parentSessionId ||
      includedChildren.some(c => c.sessionId === r.sessionId));
    conditions.push(`EXISTS (SELECT 1 FROM overview_runs WHERE session = ${quote(workflow.parentSessionId)}
      AND input_tokens = ${family.reduce((n, r) => n + r.inputTokens, 0)}
      AND output_tokens = ${family.reduce((n, r) => n + r.outputTokens, 0)}
      AND turns = ${family.reduce((n, r) => n + r.turns, 0)}
      AND tools = ${family.reduce((n, r) => n + r.toolCalls, 0)}
      AND responses = ${family.reduce((n, r) => n + r.responses, 0)}
      AND subagents = ${includedChildren.length})`);
    if (includedChildren.length === 3) {
      conditions.push(`(SELECT peak_model_responses FROM overview_runs
        WHERE session = ${quote(workflow.parentSessionId)}) = 3`);
      conditions.push(`(SELECT peak_model_responses FROM (${OVERVIEW_QUERIES.headline})) = 3`);
    }
  }
  const sql = `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}
    INCLUDE PERFETTO MODULE viz.summary.track_event;
    CREATE PERFETTO TABLE recorded_runs AS SELECT * FROM agentprof_capture_runs;
    CREATE PERFETTO TABLE overview_runs AS ${OVERVIEW_QUERIES.runs};
    SELECT CASE WHEN ${conditions.join(' AND ')}
      AND (SELECT COUNT(*) FROM recorded_runs) = ${recordings.length}
      AND (SELECT COUNT(DISTINCT recorded_id) FROM recorded_runs) = ${recordings.length}
      AND (SELECT clock_errors FROM (${OVERVIEW_QUERIES.summary})) = 0
      AND (SELECT COUNT(*) FROM machine WHERE raw_id > 0) = 1
      AND (SELECT MAX(value) FROM (${OVERVIEW_QUERIES.health})) = 0
      AND NOT EXISTS (SELECT 1 FROM slice WHERE name = 'profile (1)'
        AND EXTRACT_ARG(arg_set_id, 'debug.tool_arguments') != 0)
      AND EXISTS (SELECT 1 FROM counter_track WHERE name = 'Resident memory')
      AND (SELECT COUNT(*) FROM counter_track WHERE name = 'Context size') = ${recordings.length}
      AND (SELECT COUNT(*) FROM counter_track WHERE name = 'Context window') = ${recordings.length}
      AND (SELECT COUNT(*) FROM counter c JOIN counter_track t ON t.id = c.track_id
        WHERE t.name = 'Context window' AND c.value = 1000000) = ${recordings.length}
      AND NOT EXISTS (SELECT 1 FROM counter_track WHERE name = 'Context size (est.)')
      AND (SELECT COUNT(*) FROM _track_event_tracks_ordered_groups
        WHERE is_counter = 1 AND name IN ('Context size', 'Context window')
          AND unit = 'tokens' AND y_axis_share_key = 'llm.context.tokens') = ${recordings.length * 2}
      AND (SELECT COUNT(*) FROM slice WHERE name = 'profile (1)'
        AND EXTRACT_ARG(arg_set_id, 'debug.context_window_tokens') = 1000000) = ${recordings.length}
      AND NOT EXISTS (SELECT 1 FROM args WHERE flat_key = 'chrome.process_label'
        AND string_value GLOB 'pi-tracing/*')
      AND NOT EXISTS (SELECT 1 FROM slice WHERE name = 'tracing-start')
      AND NOT EXISTS (SELECT 1 FROM slice WHERE name IN
        ('prompt-operation', 'agent-attempt', 'assistant-response', 'provider-request', 'provider-response'))
      AND NOT EXISTS (SELECT 1 FROM slice WHERE name GLOB 'input src=*')
      AND NOT EXISTS (SELECT 1 FROM slice WHERE name GLOB 'preflight *' OR name GLOB 'middleware *')
      AND NOT EXISTS (SELECT 1 FROM slice WHERE name = 'delegate')
      AND NOT EXISTS (SELECT 1 FROM slice s JOIN track t ON t.id = s.track_id WHERE t.name GLOB 'workflow.child.*')
      AND NOT EXISTS (SELECT 1 FROM args WHERE key GLOB 'debug.*[A-Z]*'
        AND key NOT GLOB 'debug.args.*')
      AND NOT EXISTS (SELECT 1 FROM args WHERE key GLOB 'debug.agentprof_*'
        OR key GLOB 'debug.pi_tracing_*')
      AND (SELECT COUNT(*) FROM flow f JOIN slice src ON src.id = f.slice_out
        JOIN slice dst ON dst.id = f.slice_in
        WHERE src.name = 'prompt-input' AND dst.name = 'prompt'
          AND EXTRACT_ARG(src.arg_set_id, 'debug.source') = 'interactive'
          AND EXTRACT_ARG(src.arg_set_id, 'debug.length') IS NULL) = ${recordings.length}
      AND NOT EXISTS (SELECT 1 FROM slice WHERE name GLOB 'assistant ttft=*'
        OR name GLOB 'provider-response*' OR name GLOB 'result *' OR name GLOB 'context messages=*'
        OR name GLOB 'prompt (*' OR name GLOB 'child-start *')
      AND (SELECT COUNT(*) FROM slice WHERE name = 'profile (1)' AND dur > 0
        AND EXTRACT_ARG(arg_set_id, 'debug.recorder_version') IS NOT NULL) = ${recordings.length}
      AND (SELECT COUNT(*) FROM slice WHERE name = 'profile (1)'
        AND EXTRACT_ARG(arg_set_id, 'debug.peak_context_tokens') > 0) = ${recordings.length}
      AND (SELECT COUNT(*) FROM slice s JOIN thread_track tt ON tt.id = s.track_id
        JOIN thread th ON th.utid = tt.utid JOIN process p ON p.upid = th.upid
        WHERE s.name = 'profile (1)' AND th.tid = p.pid AND th.name = 'pi') = ${recordings.length}
      AND NOT EXISTS (SELECT 1 FROM track WHERE name = 'Session')
      AND NOT EXISTS (SELECT 1 FROM track WHERE name = 'Agent')
      AND NOT EXISTS (SELECT 1 FROM slice s LEFT JOIN thread_track tt ON tt.id = s.track_id
        WHERE s.name IN ('prompt', 'attempt', 'turn') AND tt.id IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT c.*, ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY ts DESC, id DESC) AS latest
          FROM counter c
        ) c JOIN agentprof_track_process m ON m.track_id = c.track_id
        JOIN agentprof_slices s ON s.capture_id = m.capture_id AND s.name = 'profile (1)'
        WHERE c.latest = 1 AND (c.value != 0 OR c.ts != s.ts + s.dur)
      )
      AND NOT EXISTS (SELECT 1 FROM agentprof_slices s WHERE s.name = 'profile (1)'
        AND s.ts + s.dur != (SELECT MAX(c.ts) FROM counter c
          JOIN agentprof_track_process m ON m.track_id = c.track_id WHERE m.capture_id = s.capture_id))
      THEN 'RECORDED_EXAMPLE_OK' ELSE 'RECORDED_EXAMPLE_FAILED' END AS result`;
  const result = spawnSync(binary, [path, '-Q', sql], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('RECORDED_EXAMPLE_OK'), `${path}\n${result.stdout}\n${result.stderr}`);
}
for (const r of manifest.recordings) {
  const path = resolve(source, r.file);
  assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), r.sha256);
  validate(path, [r]);
}
validate(resolve('artifacts/examples/agentprof-example.pftrace'),
  manifest.recordings.filter((r: Recording) => manifest.bundledFiles.includes(r.file)));
const mergedFlow = spawnSync(binary, [resolve('artifacts/examples/agentprof-example.pftrace'), '-Q', `
  SELECT COUNT(*) AS connected_children FROM flow f
  JOIN slice src ON src.id = f.slice_out JOIN slice dst ON dst.id = f.slice_in
  WHERE src.name = 'subagent' AND dst.name = 'prompt-input'`], {encoding: 'utf8'});
assert.equal(mergedFlow.status, 0, mergedFlow.stderr);
assert.equal(mergedFlow.stdout.trim(), '"connected_children"\n3');
const tarPath = resolve('artifacts/examples/recorded-sessions.tar');
const tar = spawnSync('tar', ['-cf', tarPath, '-C', source, ...manifest.recordings.map((r: Recording) => r.file)], {encoding: 'utf8'});
assert.equal(tar.status, 0, tar.stderr);
validate(tarPath, manifest.recordings);
console.log('PASS real Pi recordings: checksums, reported usage, context, configuration, tools, capture health, merged session identity and clock offsets');
