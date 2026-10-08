// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {convertObservations, type Observation} from './convert.ts';
import {decodeFields, tracePackets} from '../pi-tracing/extensions/pi-tracing/test-proto.ts';
import {DETECT_SQL, SETUP_SQL} from '../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL} from '../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';

const epoch = 1_790_000_000_000_000_000n;
const at = (ms: number) => String(epoch + BigInt(ms) * 1_000_000n);
const attributes = (values: Record<string, string | number | boolean>) => Object.entries(values).map(([key, value]) => ({key, value:
  typeof value === 'string' ? {stringValue: value} : typeof value === 'boolean' ? {boolValue: value} : {intValue: String(value)}}));
const span = (id: string, parent: string, name: string, start: number, end: number, attrs: Record<string, string | number | boolean> = {}) =>
  ({traceId: 'trace', spanId: id, parentSpanId: parent, name: `claude_code.${name}`, startTimeUnixNano: at(start), endTimeUnixNano: at(end),
    attributes: attributes({'session.id': 'session', ...attrs})});
const hook = (ms: number, event: Record<string, unknown>): Observation => ({source: '/hook', timestamp: at(ms),
  data: {timestamp: at(ms), event: {session_id: 'session', ...event}}});
function fixture(): Observation[] {
  const spans = [
    span('prompt', '', 'interaction', 1, 900, {user_prompt: 'A measured fixture'}),
    span('model', 'prompt', 'llm_request', 2, 100, {model: 'fixture-model', input_tokens: 10, output_tokens: 5, cache_read_tokens: 20, cache_creation_tokens: 3, success: true, ttft_ms: 10}),
    span('agent', 'prompt', 'tool', 110, 750, {tool_name: 'Agent', tool_use_id: 'agent-call'}),
    span('agent-exec', 'agent', 'tool.execution', 115, 740, {tool_use_id: 'agent-call', success: true}),
    span('bash', 'prompt', 'tool', 120, 300, {tool_name: 'Bash', tool_use_id: 'bash-call'}),
    span('bash-exec', 'bash', 'tool.execution', 125, 295, {tool_use_id: 'bash-call', success: false}),
    span('child-model', 'agent', 'llm_request', 150, 700, {agent_id: 'worker', model: 'fixture-model', input_tokens: 4, output_tokens: 7,
      cache_read_tokens: 2, cache_creation_tokens: 0, success: true}),
    span('model-2', 'prompt', 'llm_request', 760, 800, {model: 'fixture-model', input_tokens: 2, output_tokens: 1,
      cache_read_tokens: 5, cache_creation_tokens: 0, success: true}),
    span('compact-model', 'prompt', 'llm_request', 815, 845, {model: 'fixture-model', input_tokens: 3, output_tokens: 2,
      cache_read_tokens: 5, cache_creation_tokens: 0, success: true}),
  ];
  return [
    {source: 'process_start', timestamp: at(0), data: {pid: 12345, machineId: 101, captureId: 'fixture'}},
    {source: 'clock_snapshot', timestamp: at(0), data: {realtimeNs: at(0), boottimeNs: '10000000000'}},
    hook(0, {hook_event_name: 'SessionStart'}),
    hook(109, {hook_event_name: 'PreToolUse', tool_use_id: 'agent-call', tool_name: 'Agent', tool_input: {prompt: 'Check the sum', description: 'Independent check'}}),
    hook(119, {hook_event_name: 'PreToolUse', tool_use_id: 'bash-call', tool_name: 'Bash', tool_input: {command: 'exit 7'}}),
    hook(140, {hook_event_name: 'SubagentStart', agent_id: 'worker', agent_type: 'auditor'}),
    hook(710, {hook_event_name: 'SubagentStop', agent_id: 'worker'}),
    hook(846, {hook_event_name: 'SubagentStop', agent_id: 'internal-compaction-worker', agent_type: ''}),
    {source: '/v1/traces', timestamp: at(950), data: {resourceSpans: [{scopeSpans: [{spans: [...spans].reverse()}]}]}},
    // Retried OTLP delivery must not count usage twice.
    {source: '/v1/traces', timestamp: at(960), data: {resourceSpans: [{scopeSpans: [{spans: [spans[1]]}]}]}},
    {source: '/v1/logs', timestamp: at(965), data: {resourceLogs: [{scopeLogs: [{logRecords: [{timeUnixNano: at(850),
      attributes: attributes({'session.id': 'session', 'event.name': 'compaction', duration_ms: '40', pre_tokens: '40', post_tokens: '6', success: 'true', trigger: 'manual'})}]}]}]}},
    {source: 'result', timestamp: at(990), data: {modelUsage: {'fixture-model': {contextWindow: 200000}}}},
    {source: 'process_end', timestamp: at(1000), data: {code: 0, dropped: 0}},
  ];
}
function query(rows: Observation[], sql: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-trace-test-'));
  try {
    const {trace} = convertObservations(rows);
    writeFileSync(join(directory, 'trace.pftrace'), trace);
    writeFileSync(join(directory, 'check.sql'), `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}\n${sql}`);
    const result = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor'),
      [join(directory, 'trace.pftrace'), '-q', join(directory, 'check.sql')], {encoding: 'utf8'});
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout;
  } finally {rmSync(directory, {recursive: true, force: true});}
}
test('native timestamps, deduplication, logical subagents, flows and counters survive Perfetto import', () => {
  const result = convertObservations(fixture());
  expect(result.summary).toMatchObject({sessions: 2, responses: 3, tools: 2, nativeSpans: 9, compactions: 1});
  const output = query(fixture(), `SELECT
    (${DETECT_SQL}) = 2 AS detected_captures,
    (SELECT COUNT(*) FROM process WHERE pid != 0) = 1 AND
      (SELECT COUNT(*) FROM process WHERE pid = 12345 AND name = 'claude') = 1 AS one_real_process,
    (SELECT COUNT(*) FROM agentprof_capture_runs) = 2 AS two_sessions,
    (SELECT COUNT(*) FROM agentprof_capture_hierarchy WHERE is_subagent) = 1 AS one_child,
    (SELECT COUNT(*) FROM agentprof_messages) = 3 AS responses,
    (SELECT COUNT(*) FROM agentprof_messages WHERE first_ns IS NOT NULL) = 0 AS no_invented_first_content,
    (SELECT input_tokens FROM agentprof_capture_runs WHERE session = 'session') = 15 AS primary_usage,
    (SELECT output_tokens FROM agentprof_capture_runs WHERE session = 'session/worker') = 7 AS child_usage,
    (SELECT peak_context FROM agentprof_capture_runs WHERE session = 'session') = 40 AS precompact_peak,
    (SELECT COUNT(*) FROM agentprof_tool_calls WHERE is_error) = 1 AS failed_tool,
    (SELECT COUNT(*) FROM flow f JOIN slice a ON a.id=f.slice_out JOIN slice b ON b.id=f.slice_in WHERE a.name='Agent' AND b.name='prompt-input') = 1 AS child_flow,
    (SELECT COUNT(*) FROM stats WHERE severity='error' AND value>0) = 0 AS clean_import,
    (SELECT COUNT(*) FROM agentprof_slices WHERE kind = 'provider-request' AND
      EXTRACT_ARG(arg_set_id, 'debug.phase') = 'compaction') = 1 AS compaction_request,
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.post_tokens') FROM agentprof_slices
      WHERE kind = 'compaction') = 6 AS typed_compaction_usage,
    (SELECT COUNT(*) FROM agentprof_slices WHERE incomplete) = 0 AS fully_closed;`);
  expect(output.trim().split('\n').at(-1)).toBe('1,1,1,1,1,1,1,1,1,1,1,1,1,1,1');
}, 30000);

test('legacy conversion honors the persisted content policy even for unsanitized observations', () => {
  const rows = fixture();
  rows[0]!.data.capture_contents = false;
  let inspected = false;
  const hook = rows.find(r => r.source === '/hook' && (r.data.event as any).tool_use_id === 'bash-call')!;
  (hook.data.event as any).tool_input = {toJSON() {inspected = true; throw new Error('disabled input serialized');},
    get description() {inspected = true; throw new Error('disabled input inspected');}};
  const trace = Buffer.from(convertObservations(rows).trace);
  expect(inspected).toBe(false);
  for (const secret of ['A measured fixture', 'Check the sum', 'Independent check', 'exit 7'])
    expect(trace.includes(secret)).toBe(false);
  expect(trace.includes('fixture-model')).toBe(true);
});

test('Claude events and counters use harness-specific categories', () => {
  const {trace} = convertObservations(fixture());
  const events = tracePackets(trace).flatMap(packet => decodeFields(packet)
    .filter(field => field.number === 11).map(field => decodeFields(field.bytes!)));
  const categories = events.flatMap(event => event.filter(field => field.number === 22)
    .map(field => new TextDecoder().decode(field.bytes)));
  expect([...new Set(categories)].sort()).toEqual(['claude.activity', 'claude.metadata']);
  for (const event of events) {
    const type = event.find(field => field.number === 9)?.value;
    const count = event.filter(field => field.number === 22).length;
    expect(count).toBe(type === 2n ? 0 : 1);
  }
});

test('missing usage is absent and unfinished capture is marked incomplete', () => {
  const rows = fixture().filter(r => !['/v1/traces', '/v1/logs', 'process_end', 'result'].includes(r.source));
  const output = query(rows, `SELECT
    (SELECT SUM(input_tokens) FROM agentprof_capture_runs) IS NULL AS unknown_usage,
    (SELECT COUNT(*) FROM agentprof_slices WHERE incomplete) > 0 AS incomplete;`);
  expect(output.trim().split('\n').at(-1)).toBe('1,1');
}, 30000);

test('capture requires real process and session identity', () => {
  expect(() => convertObservations([])).toThrow('process identity');
  expect(() => convertObservations(fixture().slice(0, 1))).toThrow('clock snapshot');
  expect(() => convertObservations(fixture().slice(0, 2))).toThrow('session identity');
});
