// SPDX-License-Identifier: Apache-2.0
import {test, expect, spyOn} from 'bun:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {convertObservations} from './convert.ts';
import {fixture, log, at, rootSession} from './fixture.ts';
import {tagControlScripts} from './plugin-observations.ts';
import {omitContent} from '../agent-tracing/content.ts';
import {DETECT_SQL, SETUP_SQL} from '../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL} from '../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';

function query(rows: ReturnType<typeof fixture>, sql: string): string {
  const path = mkdtempSync(join(tmpdir(), 'codex-import-'));
  try {
    writeFileSync(join(path, 'recording.pftrace'), convertObservations(rows).trace);
    writeFileSync(join(path, 'query.sql'), `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}\n${sql}`);
    const result = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor'),
      [join(path, 'recording.pftrace'), '-q', join(path, 'query.sql')], {encoding: 'utf8'});
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout;
  } finally {rmSync(path, {recursive: true, force: true});}
}
test('disabled content never parses unsanitized native argument strings', () => {
  const rows = fixture(), secret = '{"private":"disabled-input"}';
  rows[0]!.data.capture_contents = false;
  for (const row of rows.filter(r => r.source === '/v1/logs')) for (const resource of (row.data as any).resourceLogs)
    for (const scope of resource.scopeLogs) for (const log of scope.logRecords)
      for (const attr of log.attributes) if (attr.key === 'arguments') attr.value.stringValue = secret;
  let inspected = 0;
  const parse = JSON.parse, spy = spyOn(JSON, 'parse').mockImplementation((input: string, reviver?: (this: any, key: string, value: any) => any) => {
    if (input === secret) {inspected++; throw new Error('disabled argument was parsed');}
    return parse(input, reviver);
  });
  try {
    const trace = Buffer.from(convertObservations(rows).trace);
    expect(inspected).toBe(0);
    expect(trace.includes('disabled-input')).toBe(false);
    expect(trace.includes('fixture-model')).toBe(true);
  } finally {spy.mockRestore();}
});

test('content-off code-mode controls remain excluded without retaining or parsing their source', () => {
  const rows = fixture(); rows[0]!.data.capture_contents = false;
  for (const row of rows.filter(r => r.source === '/v1/logs')) {
    for (const resource of (row.data as any).resourceLogs) for (const scope of resource.scopeLogs)
      for (const log of scope.logRecords) {
        const call = log.attributes.find((a: any) => a.key === 'call_id')?.value.stringValue;
        if (call === 'script-call') log.attributes.find((a: any) => a.key === 'arguments').value.stringValue = 'tools.tracing_status()';
      }
    tagControlScripts(row.data);
    row.data = omitContent(row.data) as Record<string, unknown>;
  }
  expect(JSON.stringify(rows)).not.toContain('tracing_status()');
  const result = convertObservations(rows);
  expect(result.summary.scripts).toBe(0);
  expect(Buffer.from(result.trace).includes('tracing_status()')).toBe(false);
});

test('late/repeated telemetry preserves native durations, usage, nested scripts and logical children', () => {
  const rows = fixture(), result = convertObservations(rows);
  expect(result.summary).toMatchObject({sessions: 2, responses: 3, scripts: 1, tools: 2, nestedTools: 1,
    prewarms: 1, unmeasuredResponses: 0, inputTokens: 260, outputTokens: 14});
  const output = query(rows, `SELECT
    (${DETECT_SQL}) = 2 AS detected,
    (SELECT COUNT(*) FROM process WHERE pid = 12346 AND name = 'codex') = 1 AS real_process,
    (SELECT COUNT(*) FROM thread WHERE tid NOT IN (0,12346)) = 0 AS no_invented_threads,
    (SELECT COUNT(*) FROM agentprof_messages) = 3 AS responses,
    (SELECT SUM(dur) FROM agentprof_messages) = 530000000 AS model_duration,
    (SELECT COUNT(*) FROM agentprof_script_children) = 1 AS nested_tool,
    (SELECT COUNT(*) FROM agentprof_tool_calls WHERE name='exec_command' AND is_error=1) = 1 AS command_error,
    (SELECT SUM(input_tokens) FROM agentprof_capture_runs) = 260 AS input,
    (SELECT SUM(output_tokens) FROM agentprof_capture_runs) = 14 AS output,
    (SELECT MAX(peak_context) FROM agentprof_capture_runs) = 120 AS context_without_double_cache,
    (SELECT COUNT(*) FROM flow) >= 7 AS flows,
    (SELECT COUNT(*) FROM stats WHERE severity='error' AND value>0) = 0 AS import_ok,
    (SELECT COUNT(*) FROM agentprof_capture_runs WHERE harness='codex' AND model='fixture-model'
      AND context_window_tokens=1000 AND context_share>0) = 2 AS configuration,
    (SELECT COUNT(*) FROM agentprof_tool_calls WHERE kind='script' AND is_error=0) = 1 AS script_success;`);
  expect(output.trim().split('\n').at(-1)).toBe('1,1,1,1,1,1,1,1,1,1,1,1,1,1');
});
test('absent native timing stays unmeasured; unknown usage is not fabricated', () => {
  const rows = fixture();
  rows.push({source: '/v1/logs', timestamp: at(800), data: {resourceLogs: [{scopeLogs: [{logRecords: [
    log(800, rootSession, 'codex.sse_event', {'event.kind': 'response.completed', model: 'fixture-model'}),
  ]}]}]}});
  expect(convertObservations(rows).summary).toMatchObject({responses: 4, unmeasuredResponses: 1, inputTokens: 260, outputTokens: 14});
  expect(query(rows, `SELECT COUNT(*) FROM agentprof_messages WHERE incomplete=1 AND input_tokens IS NULL AND output_tokens IS NULL;`).trim().split('\n').at(-1)).toBe('1');
});
test('requires real identity and clock alignment', () => {
  expect(() => convertObservations(fixture().filter(r => r.source !== 'process_start'))).toThrow('process identity');
  expect(() => convertObservations(fixture().filter(r => r.source !== 'clock_snapshot'))).toThrow('clock snapshot');
  expect(query(fixture().filter(r => r.source !== 'process_end'), `SELECT COUNT(*) > 0 FROM agentprof_slices WHERE kind='capture' AND incomplete=1;`).trim().split('\n').at(-1)).toBe('1');
});
test('context limits, units, shared axes and capture-end zeros survive import', () => {
  const rows = fixture();
  const metadata = rows.filter(r => r.source === 'session_metadata' && r.data.session_id === rootSession);
  (metadata[1]!.data.record as any).payload.info.model_context_window = 2000;
  const output = query(rows, `SELECT
    (SELECT COUNT(DISTINCT EXTRACT_ARG(arg_set_id,'debug.context_window_tokens')) FROM agentprof_slices
      WHERE name='run-configuration' AND session='${rootSession}') = 2 AS changed_limit,
    (SELECT COUNT(*) FROM counter_track WHERE unit='tokens') = 8 AS units,
    (SELECT COUNT(*) FROM counter_track WHERE EXTRACT_ARG(source_arg_set_id, 'y_axis_share_key')='llm.context.tokens') = 4 AS axes,
    (SELECT COUNT(*) FROM (SELECT value,ROW_NUMBER() OVER(PARTITION BY track_id ORDER BY ts DESC) AS n FROM counter) WHERE n=1 AND value!=0) = 0 AS zeros;`);
  expect(output.trim().split('\n').at(-1)).toBe('1,1,1,1');
});

test('interactive reasoning effort changes apply only to subsequent responses', () => {
  const rows = fixture();
  rows[0]!.data.recorder = 'codex-plugin-1'; rows[0]!.data.sessionId = rootSession;
  for (const [time, effort] of [[10, 'low'], [390, 'high']] as const) {
    rows.push({source: 'session_metadata', timestamp: at(999), data: {session_id: rootSession, record: {
      type: 'turn_context', timestamp: new Date(Number(BigInt(at(time)) / 1_000_000n)).toISOString(),
      payload: {model: 'fixture-model', effort},
    }}});
  }
  expect(query(rows, `SELECT GROUP_CONCAT(effort, ',') FROM (
    SELECT EXTRACT_ARG(arg_set_id, 'debug.effort') AS effort FROM agentprof_slices
    WHERE kind='assistant-message' AND session='${rootSession}' ORDER BY ts);`).trim().split('\n').at(-1)).toBe('"low,high"');
});
