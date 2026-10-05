// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {convertObservations, type Observation} from './convert.ts';
import {initializeDirectCapture, readDirectCapture, finishDirectCapture} from './direct-journal.ts';
import {SETUP_SQL} from '../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL} from '../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';

const epoch = 1_790_000_000_000_000_000n;
const at = (ms: number) => String(epoch + BigInt(ms) * 1_000_000n);
const row = (ms: number, event: string, phase: string, id: string, data = {}): Observation =>
  ({source: 'claude.mod', timestamp: at(ms), data: {event, phase, id, session_id: 'session', ...data}});
const usage = (input: number, output: number) =>
  ({model: 'fixture-model', input_tokens: input, output_tokens: output, cache_read_input_tokens: 50, cache_creation_input_tokens: 2});
function fixture(): Observation[] {
  return [
    {source: 'process_start', timestamp: at(0), data: {pid: 12345, machineId: 101, captureId: 'direct-fixture'}},
    {source: 'clock_snapshot', timestamp: at(0), data: {realtimeNs: at(0), boottimeNs: '10000000000'}},
    row(0, 'session', 'begin', 'session', {model: 'fixture-model', provider: 'vertex', context: {window: 200000}}),
    row(10, 'prompt', 'begin', 'prompt', {prompt: 'Check these numbers', prompt_length: 19}),
    row(20, 'response', 'begin', 'prompt:0', {turn_id: 'prompt', model: 'fixture-model'}),
    row(100, 'response', 'end', 'prompt:0', {usage: usage(5, 10), first_content_ms: 5, first_text_ms: 10}),
    row(101, 'context', 'sample', 'prompt:0', {model: 'fixture-model', context: {tokens: 57, window: 200000}}),
    row(110, 'tool', 'begin', 'bash', {tool: 'Bash', arguments: {command: 'exit 7', timeout: 1000}}),
    row(330, 'execution', 'end', 'bash', {duration_ms: 20, is_error: true}),
    row(350, 'tool', 'end', 'bash', {is_error: true}),
    row(110, 'tool', 'begin', 'launch', {tool: 'Agent', arguments: {prompt: 'Verify', description: 'Independent check'}}),
    row(150, 'agent', 'begin', 'worker', {agent_id: 'worker', call_id: 'launch', model: 'fixture-model', role: 'auditor', prompt: 'Verify'}),
    row(160, 'response', 'begin', 'child:0', {agent_id: 'worker', turn_id: 'child', model: 'fixture-model'}),
    row(350, 'response', 'end', 'child:0', {agent_id: 'worker', usage: usage(4, 7)}),
    // Deliberately reuse a call ID in another scope to test attribution.
    row(360, 'tool', 'begin', 'bash', {agent_id: 'worker', tool: 'Read', arguments: {file_path: 'numbers.txt'}}),
    row(385, 'execution', 'end', 'bash', {agent_id: 'worker', duration_ms: 20, is_error: false}),
    row(390, 'tool', 'end', 'bash', {agent_id: 'worker', is_error: false}),
    row(400, 'prompt', 'end', 'child', {agent_id: 'worker'}),
    row(690, 'execution', 'end', 'launch', {duration_ms: 550, is_error: false}),
    row(700, 'tool', 'end', 'launch', {is_error: false}),
    row(720, 'response', 'begin', 'prompt:1', {turn_id: 'prompt', model: 'fixture-model'}),
    row(800, 'response', 'end', 'prompt:1', {usage: usage(2, 3)}),
    row(805, 'compaction', 'begin', 'compact', {trigger: 'manual'}),
    row(850, 'compaction', 'end', 'compact', {success: true, pre_tokens: 80, post_tokens: 20, usage: usage(6, 4)}),
    row(900, 'prompt', 'end', 'prompt'),
    row(1000, 'session', 'end', 'session', {reason: 'prompt_input_exit', dropped: 0}),
  ];
}
function query(rows: Observation[], sql: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'claude-direct-test-'));
  try {
    writeFileSync(join(directory, 'trace.pftrace'), convertObservations(rows).trace);
    writeFileSync(join(directory, 'check.sql'), `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}\n${sql}`);
    const result = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor'),
      [join(directory, 'trace.pftrace'), '-q', join(directory, 'check.sql')], {encoding: 'utf8'});
    if (result.status !== 0) throw new Error(result.stderr || String(result.error));
    return result.stdout.trim().split('\n').at(-1)!;
  } finally {rmSync(directory, {recursive: true, force: true});}
}

test('direct capture imports with measured work, compaction usage, child flows and known context limits', () => {
  expect(convertObservations(fixture()).summary).toMatchObject({sessions: 2, responses: 3, tools: 3, measuredTools: 3,
    compactions: 1, inputTokens: 17, outputTokens: 24});
  expect(query(fixture(), `SELECT
    (SELECT COUNT(*) FROM process WHERE pid = 12345 AND name = 'claude') = 1,
    (SELECT COUNT(*) FROM agentprof_capture_hierarchy WHERE is_subagent) = 1,
    (SELECT COUNT(*) FROM agentprof_messages) = 3,
    (SELECT first_ns FROM agentprof_messages WHERE first_ns IS NOT NULL) = 5000000,
    (SELECT input_tokens FROM agentprof_capture_runs WHERE session = 'session') = 13,
    (SELECT output_tokens FROM agentprof_capture_runs WHERE session = 'session/worker') = 7,
    (SELECT provider FROM agentprof_capture_runs WHERE session = 'session/worker') = 'vertex',
    (SELECT peak_context FROM agentprof_capture_runs WHERE session = 'session') = 80,
    (SELECT context_window_tokens FROM agentprof_capture_runs WHERE session = 'session') = 200000,
    (SELECT context_window_tokens FROM agentprof_capture_runs WHERE session = 'session/worker') IS NULL,
    (SELECT SUM(dur) FROM slice WHERE name = 'Bash' AND EXTRACT_ARG(arg_set_id, 'debug.kind') = 'tool-execution') = 20000000,
    (SELECT COUNT(*) FROM agentprof_tool_calls WHERE is_error) = 1,
    (SELECT COUNT(*) FROM flow JOIN slice a ON a.id=flow.slice_out JOIN slice b ON b.id=flow.slice_in WHERE a.name='Agent' AND b.name='prompt-input') = 1,
    (SELECT COUNT(*) FROM agentprof_slices WHERE incomplete) = 0,
    (SELECT COUNT(*) FROM stats WHERE severity='error' AND value>0) = 0;`)).toBe(Array(15).fill('1').join(','));
}, 30000);

test('partial capture does not invent usage, execution time or a child completion', () => {
  const rows = fixture().filter(r => !(r.data.phase === 'end' && ['response', 'execution', 'prompt', 'session'].includes(String(r.data.event))));
  expect(query(rows, `SELECT
    (SELECT SUM(input_tokens) FROM agentprof_capture_runs) = 6,
    (SELECT COUNT(*) FROM agentprof_tool_calls WHERE NOT incomplete) = 0,
    (SELECT COUNT(*) FROM agentprof_slices WHERE kind = 'capture' AND incomplete) = 2;`)).toBe('1,1,1');
  // The completed compaction is still reported, even if other records were lost.
  expect(convertObservations(rows).summary.inputTokens).toBe(6);
}, 30000);

test('context limits are sampled for the response, never borrowed from a later model setting', () => {
  const rows = fixture().filter(r => r.data.event !== 'context');
  rows.push(row(710, 'context', 'sample', 'config', {model: 'different-model', context: {window: 1000000}}));
  expect(query(rows, `SELECT
    EXTRACT_ARG(arg_set_id, 'debug.context_window_tokens') IS NULL FROM agentprof_slices
    WHERE kind = 'assistant-message' AND ts = (SELECT MAX(ts) FROM agentprof_slices WHERE kind = 'assistant-message');`)).toBe('1');
}, 30000);

test('native composition retains sparse changes without adding free space, item details or child windows', () => {
  const rows = fixture();
  const reading = (messages: number, delta: unknown[], extra = {}) => ({window: 200000,
    breakdown: {categories: [{name: 'Messages', kind: 'used', tokens: messages},
      {name: 'System prompt', kind: 'used', tokens: 20}, {name: 'Free space', kind: 'free', tokens: 199800},
      {name: 'MCP tools', kind: 'deferred', tokens: 50}], raw_max_tokens: 200000, auto_compact_threshold: 167000},
    item_changes: delta, removed_items: [], ...extra});
  const initial = rows.find(r => r.data.event === 'session' && r.data.phase === 'begin')!;
  initial.data.context = reading(10, [{id: 'prompt', category: 'prompts', tokens: 10}], {items_reset: true});
  rows.find(r => r.data.event === 'response' && r.data.id === 'prompt:0' && r.data.phase === 'begin')!.data.context = reading(10, []);
  rows.find(r => r.data.event === 'response' && r.data.id === 'prompt:1' && r.data.phase === 'begin')!.data.context = reading(100,
    [{id: 'result', category: 'results', tokens: 90, source_id: 'bash', source_kind: 'tool'}]);
  const compact = rows.find(r => r.data.event === 'compaction' && r.data.phase === 'end')!;
  compact.data.context = reading(5, [{id: 'summary', category: 'summaries', tokens: 5}], {removed_items: ['prompt', 'result']});
  compact.data.model = 'fixture-model';
  expect(query(rows, `SELECT
    (SELECT COUNT(*) FROM agentprof_context_snapshots)=4,
    (SELECT MAX(estimated_tokens) FROM agentprof_context_snapshots)=120,
    (SELECT COUNT(*) FROM agentprof_context_snapshots WHERE session='session/worker')=0,
    (SELECT COUNT(*) FROM agentprof_context_changes WHERE delta_tokens=90 AND tool='Bash' AND NOT baseline)=1,
    (SELECT COUNT(*) FROM agentprof_context_changes WHERE change='removed' AND NOT baseline)=2,
    (SELECT MAX(reported_tokens) FROM agentprof_context_snapshots)=57,
    (SELECT COUNT(*) FROM stats WHERE severity='error' AND value>0)=0;`)).toBe('1,1,1,1,1,1,1');
}, 30000);

test('child causal link survives estimated execution start after actual child start', () => {
  const rows = fixture();
  rows.find(r => r.data.event === 'execution' && r.data.id === 'launch')!.data.duration_ms = 500;
  expect(query(rows, `SELECT COUNT(*) = 1 FROM flow
    JOIN slice a ON a.id=flow.slice_out JOIN slice b ON b.id=flow.slice_in
    WHERE a.name='Agent' AND EXTRACT_ARG(a.arg_set_id, 'debug.kind')='tool-dispatch' AND b.name='prompt-input';`)).toBe('1');
}, 30000);

test('journal recovery retains complete records, protects existing output, and publishes privately', () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-direct-journal-'));
  try {
    const output = join(directory, 'agent.pftrace');
    const capture = initializeDirectCapture(output, 12345);
    const events = fixture().filter(r => r.source === 'claude.mod');
    writeFileSync(join(capture.directory, 'events-000000.jsonl'), events.map(r => JSON.stringify(r) + '\n').join('') + '{"partial":');
    expect(readDirectCapture(capture.directory).at(-1)!.source).toBe('recovery');
    writeFileSync(output, 'Keep this file');
    expect(() => finishDirectCapture(capture.directory)).toThrow('Output already exists');
    expect(readFileSync(output, 'utf8')).toBe('Keep this file');
    rmSync(output);
    expect(finishDirectCapture(capture.directory).sessions).toBe(2);
    if (process.platform !== 'win32') expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(finishDirectCapture(capture.directory).sessions).toBe(2);
    rmSync(output);
    writeFileSync(output, 'Replacement');
    expect(() => finishDirectCapture(capture.directory)).toThrow('Output already exists');
    expect(readFileSync(output, 'utf8')).toBe('Replacement');
    expect(() => initializeDirectCapture(output)).toThrow('Output already exists');
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test('a manual stop clips unfinished child work to its own recording boundary', () => {
  const rows = fixture().filter(r => BigInt(r.timestamp) < BigInt(at(300)));
  rows.push(row(300, 'session', 'end', 'session', {reason: 'tool', dropped: 0}));
  // Another session later in the same recording must not extend the first one.
  rows.push(row(500, 'session', 'begin', 'second', {session_id: 'second'}));
  rows.push(row(600, 'session', 'end', 'second', {session_id: 'second'}));
  expect(convertObservations(rows).summary).toMatchObject({responses: 2, measuredResponses: 1, incompleteOperations: 5});
  expect(query(rows, `SELECT
    (SELECT ts + dur FROM agentprof_slices WHERE kind='capture' AND EXTRACT_ARG(arg_set_id,'debug.session_id')='session/worker') =
      (SELECT ts + dur FROM agentprof_slices WHERE kind='capture' AND EXTRACT_ARG(arg_set_id,'debug.session_id')='session'),
    (SELECT MAX(ts + dur) FROM agentprof_slices WHERE kind='assistant-message') =
      (SELECT ts + dur FROM agentprof_slices WHERE kind='capture' AND EXTRACT_ARG(arg_set_id,'debug.session_id')='session'),
    (SELECT COUNT(*) FROM agentprof_tool_calls WHERE NOT incomplete) = 0,
    (SELECT output_tokens FROM agentprof_capture_runs WHERE session='session/worker') IS NULL,
    (SELECT COUNT(*) FROM stats WHERE severity='error' AND value>0)=0;`)).toBe('1,1,1,1,1');
}, 30000);

test('same-id resume isolates unfinished operations and keeps native identity', () => {
  const rows = fixture().filter(r => BigInt(r.timestamp) < BigInt(at(100)));
  rows.push(row(100, 'session', 'end', 'session', {reason: 'resume'}));
  rows.push(row(200, 'session', 'begin', 'session', {segment: 1, model: 'fixture-model'}));
  rows.push(row(210, 'prompt', 'begin', 'second-prompt', {segment: 1, prompt: 'After resume'}));
  rows.push(row(220, 'prompt', 'end', 'second-prompt', {segment: 1}));
  rows.push(row(250, 'session', 'end', 'session', {segment: 1, reason: 'manual'}));
  expect(query(rows, `SELECT
    (SELECT COUNT(*) FROM agentprof_capture_runs)=2,
    (SELECT MAX(dur) FROM agentprof_slices WHERE kind='assistant-message')=80000000,
    (SELECT COUNT(*) FROM agentprof_slices WHERE kind='capture' AND EXTRACT_ARG(arg_set_id,'debug.native_session_id')='session')=1,
    (SELECT COUNT(*) FROM stats WHERE severity='error' AND value>0)=0;`)).toBe('1,1,1,1');
});

test('packaged Node writer finalizes after its launcher exits, and records publication failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-direct-worker-'));
  try {
    const output = join(directory, 'agent.pftrace');
    const capture = initializeDirectCapture(output, 12345);
    writeFileSync(join(capture.directory, 'events-000000.jsonl'), fixture().filter(r => r.source === 'claude.mod').map(r => JSON.stringify(r) + '\n').join(''));
    const writer = resolve(import.meta.dir, 'runtime/direct-writer.mjs');
    const child = spawnSync('node', [writer, 'finalize', capture.directory], {encoding: 'utf8'});
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout).saving).toBe(true);
    for (let i = 0; i < 100 && !existsSync(join(capture.directory, 'summary.json')); i++) await Bun.sleep(25);
    expect(existsSync(output)).toBe(true);
    expect(JSON.parse(readFileSync(join(capture.directory, 'summary.json'), 'utf8')).sessions).toBe(2);
    rmSync(output); writeFileSync(output, 'Keep this replacement');
    const failed = spawnSync('node', [writer, 'finish', capture.directory], {encoding: 'utf8'});
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('Output already exists');
    expect(readFileSync(join(capture.directory, 'error.txt'), 'utf8')).toContain('Output already exists');
    expect(readFileSync(output, 'utf8')).toBe('Keep this replacement');
  } finally {rmSync(directory, {recursive: true, force: true});}
}, 10000);
