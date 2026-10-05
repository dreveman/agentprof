// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {readExport} from './native.ts';
import {convert, type Capture} from './convert.ts';
import {DETECT_SQL, SETUP_SQL} from '../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL} from '../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';

export const root = '11111111-1111-4111-8111-111111111111', child = '22222222-2222-4222-8222-222222222222';
const base = 1791128200000000000n;
export const at = (ms: number) => (base + BigInt(ms) * 1000000n).toString();
function native(id: string, rows: [number, string, string, Record<string, unknown>, string?][]) {
  return {export_schema_version: 1, sessions: [{session_id: id, is_copied_context: false}], diagnostics: {},
    events: rows.map(([ms, family, kind, data, task], index) => ({kind: 'record', envelope: {id: `${id}-${index}`,
      stream: {id}, recorded_at: Number(BigInt(at(ms)) / 1000n), payload_type: 'runtime.session',
      payload: {kind: family, run_id: 'run', task_id: task, [family === 'run' || family === 'task' ? 'event' : 'record']: {kind, ...data}}}}))};
}
export function fixture() {
  const capture: Capture = {id: 'fixture', session: root, pid: 12345, machineId: 12, start: at(0), end: at(1000),
    clocks: [{realtimeNs: at(0), boottimeNs: '123456789'}], catalog: [{model: 'fixture-model', provider: 'meta', context: 1000}],
    hooks: [{at: at(1), session: root, event: 'PreLLMCall', model: 'fixture-model', provider: 'meta', effort: 'low'}]};
  const raw = native(root, [
    [0, 'metadata', 'metadata', {model_id: 'fixture-model', provider_id: 'meta', build: {semver: '1.4.1'}}],
    [10, 'run', 'started', {prompt: 'Read the fixture and fix the bug.'}],
    [20, 'task', 'proposed', {task_kind: 'model.meta.response'}, 'request'],
    [25, 'task', 'started', {}, 'request'],
    [130, 'run', 'model_completed', {model: 'fixture-model', duration_ms: 100, usage: {input_tokens: 100, output_tokens: 10, cache_read_tokens: 80}}],
    [131, 'task', 'completed', {}, 'request'],
    [135, 'run', 'assistant_tool_calls_committed', {tool_calls: [{call_id: 'call1', name: 'bash', args: '{"command":"exit 2","yield_time_ms":1000}'}]}],
    [140, 'task', 'proposed', {task_kind: 'tool.bash'}, 'tool1'],
    [145, 'task', 'started', {}, 'tool1'],
    [150, 'tool_batch_effect', 'started', {call_id: 'call1', task_id: 'tool1', tool_name: 'bash'}],
    [160, 'run', 'subagent_session_linked', {child_session_id: child, role: 'subagent'}],
    [210, 'task', 'failed', {reason: 'command failed'}, 'tool1'],
    [215, 'tool_batch_effect', 'terminal', {call_id: 'call1', outcome: {kind: 'failed'}}],
    [250, 'run', 'model_completed', {model: 'fixture-model', duration_ms: 25, usage: {input_tokens: 120, output_tokens: 5}}],
    [500, 'run', 'terminal', {terminal: 'completed'}],
    [1000, 'session_end', 'session_end', {exit_reason: 'clean'}],
  ]);
  const nested = native(child, [
    [165, 'metadata', 'metadata', {model_id: 'fixture-model', provider_id: 'meta'}],
    [170, 'run', 'started', {prompt: 'Inspect the tests.'}],
    [200, 'run', 'model_completed', {model: 'fixture-model', duration_ms: 20, usage: {input_tokens: 30, output_tokens: 3}}],
    [205, 'run', 'terminal', {terminal: 'completed'}],
  ]);
  const session = readExport(raw, root), sub = readExport(nested, child); sub.parent = root;
  return {capture, sessions: [session, sub], raw};
}
function query(f: ReturnType<typeof fixture>, sql: string) {
  const directory = mkdtempSync(join(tmpdir(), 'muse-trace-'));
  try {
    writeFileSync(join(directory, 'trace.pftrace'), convert(f.capture, f.sessions).trace);
    writeFileSync(join(directory, 'query.sql'), `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}\n${sql}`);
    const result = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor'),
      [join(directory, 'trace.pftrace'), '-q', join(directory, 'query.sql')], {encoding: 'utf8'});
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.trim().split('\n').at(-1);
  } finally {rmSync(directory, {recursive: true, force: true});}
}
test('Muse measurements import with scoped sessions, usage, context, flows and real process identity', () => {
  const f = fixture();
  expect(convert(f.capture, f.sessions).summary).toMatchObject({sessions: 2, responses: 3, tools: 1, inputTokens: 250, outputTokens: 18});
  expect(query(f, `SELECT (${DETECT_SQL}) = 2,
    (SELECT COUNT(*) FROM stats WHERE severity='error' AND value>0)=0,
    (SELECT SUM(dur) FROM agentprof_messages)=145000000,
    (SELECT SUM(input_tokens) FROM agentprof_capture_runs)=250,
    (SELECT COUNT(*) FROM agentprof_capture_runs WHERE harness='muse' AND context_window_tokens=1000)=2,
    (SELECT COUNT(*) FROM counter_track WHERE unit='tokens')=8,
    (SELECT COUNT(*) FROM counter_track WHERE EXTRACT_ARG(source_arg_set_id,'y_axis_share_key')='llm.context.tokens')=4,
    (SELECT COUNT(*) FROM (SELECT value, ROW_NUMBER() OVER(PARTITION BY track_id ORDER BY ts DESC) n FROM counter) WHERE n=1 AND value!=0)=0,
    (SELECT COUNT(*) FROM agentprof_tool_calls WHERE is_error=1)=1,
    (SELECT COUNT(*) FROM flow)>=5,
    (SELECT COUNT(*) FROM process WHERE pid=12345 AND name='muse')=1,
    (SELECT COUNT(*) FROM thread WHERE tid NOT IN (0,12345))=0;`)).toBe('1,1,1,1,1,1,1,1,1,1,1,1');
});
test('export deduplicates records, excludes inherited history and never retains reasoning', () => {
  const f = fixture();
  f.raw.events.push(f.raw.events[2]!);
  const copy = structuredClone(f.raw.events[2]!); copy.envelope.stream.id = child; copy.envelope.id = 'inherited'; f.raw.events.push(copy);
  const reasoning = structuredClone(f.raw.events[2]!); reasoning.envelope.id = 'secret';
  (reasoning.envelope.payload as any).event = {kind: 'reasoning_committed', encrypted_content: 'do not retain'}; f.raw.events.push(reasoning);
  const result = readExport(f.raw, root);
  expect(result.records.length).toBe(f.sessions[0]!.records.length);
  expect(JSON.stringify(result)).not.toContain('do not retain');
  expect(() => readExport({...f.raw, export_schema_version: 2}, root)).toThrow('Unsupported');
  expect(() => readExport(f.raw, child)).toThrow('does not contain');
});
test('intentional omitted tool deltas are distinguished from missing journal records', () => {
  const f = fixture();
  (f.raw.events as any[]).push({kind: 'gap', marker: 'omitted_live_only', stream: {id: root}}, {kind: 'gap', marker: 'missing', stream: {id: root}});
  expect(readExport(f.raw, root).diagnostics).toMatchObject({gaps: 1, omitted_live_only: 1});
});
test('partial captures exclude partial-response tokens, preserve incomplete operations and record compaction', () => {
  const f = fixture(); f.capture.start = at(50); f.capture.end = at(195);
  f.capture.hooks.push({at: at(180), session: root, event: 'PreCompact', trigger: 'auto'});
  expect(convert(f.capture, f.sessions).summary.inputTokens).toBe(0);
  expect(query(f, `SELECT (SELECT COUNT(*) FROM agentprof_messages WHERE incomplete=1)>0,
    (SELECT COUNT(*) FROM agentprof_tool_calls WHERE incomplete=1)=1,
    (SELECT COUNT(*) FROM agentprof_slices WHERE kind='compaction' AND incomplete=1)=1;`)).toBe('1,1,1');
});
test('missing duration and usage remain unavailable; controls do not become profiling work', () => {
  const f = fixture();
  const r = f.sessions[0]!.records.find(r => r.kind === 'model_completed')!;
  delete r.data.duration_ms; delete r.data.usage;
  const prompt = f.sessions[0]!.records.find(r => r.kind === 'started' && r.family === 'run')!;
  prompt.data.prompt = 'tracing stop';
  f.sessions[0]!.records.find(r => r.kind === 'tool_batch_effect')!.data.tool_name = 'plugin:agentprof:tracing:tracing_stop';
  expect(query(f, `SELECT (SELECT COUNT(*) FROM agentprof_messages WHERE incomplete=1 AND output_tokens IS NULL)=1,
    (SELECT COUNT(*) FROM agentprof_tool_calls)=0,
    (SELECT COUNT(*) FROM agentprof_slices WHERE kind='prompt')=1;`)).toBe('1,1,1');
});
test('compaction model work contributes tokens without becoming an assistant turn', () => {
  const f = fixture();
  f.capture.hooks.push({at: at(220), session: root, event: 'PreCompact', trigger: 'auto'},
    {at: at(255), session: root, event: 'PostCompact', trigger: 'auto'});
  expect(query(f, `SELECT (SELECT COUNT(*) FROM agentprof_messages)=2,
    (SELECT SUM(turns) FROM agentprof_capture_runs)=2,
    (SELECT SUM(input_tokens) FROM agentprof_capture_runs)=250,
    (SELECT COUNT(*) FROM agentprof_slices WHERE kind='compaction-response')=1;`)).toBe('1,1,1,1');
});
test('typed shell exit codes distinguish failed commands from successful tool dispatch', () => {
  const f = fixture();
  const shell = f.sessions[0]!.records.find(r => r.kind === 'tool_batch_effect' && r.data.kind === 'terminal')!;
  shell.data.outcome.kind = 'completed';
  f.sessions[0]!.records.find(r => r.kind === 'failed')!.kind = 'completed';
  f.sessions[0]!.records.push({id: 'result', at: at(216), family: 'run', kind: 'tool_result_batch_committed', run: 'run', task: '', data: {
    results: [{call_id: 'call1', exit_code: 7, terminal_status: 'failed'}],
  }});
  expect(query(f, `SELECT COUNT(*) FROM agentprof_tool_calls WHERE is_error=1 AND EXTRACT_ARG(arg_set_id,'debug.exit_code')=7;`)).toBe('1');
});
