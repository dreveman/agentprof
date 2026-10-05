// SPDX-License-Identifier: Apache-2.0
import type {Observation} from './convert.ts';
export const rootSession = '10000000-0000-4000-8000-000000000001';
export const childSession = '10000000-0000-4000-8000-000000000002';
export const epoch = 1_790_000_000_000_000_000n;
export const at = (value: number) => String(epoch + BigInt(Math.round(value * 1e6)));
export const attrs = (values: Record<string, string | number | boolean>) => Object.entries(values).map(([key, value]) => ({key,
  value: typeof value === 'boolean' ? {boolValue: value} : typeof value === 'number' ? {intValue: String(value)} : {stringValue: value}}));
const span = (trace: string, id: string, parent: string, name: string, start: number, end: number, values = {}) =>
  ({traceId: trace, spanId: id, parentSpanId: parent, name, startTimeUnixNano: at(start), endTimeUnixNano: at(end), attributes: attrs(values)});
export const log = (time: number, session: string, name: string, values = {}, trace = '') => ({timeUnixNano: '0',
  traceId: trace, spanId: '', attributes: attrs({'event.timestamp': new Date(Number(BigInt(at(time)) / 1_000_000n)).toISOString(),
    'conversation.id': session, 'event.name': name, ...values})});
export function fixture(): Observation[] {
  const spans = [
    span('warm', 'warm', '', 'startup_prewarm', 0, 8, {'conversation.id': rootSession}),
    span('warm', 'warm-stream', 'warm', 'responses_websocket.stream_request', 1, 5),
    span('root', 'prompt', '', 'session_task.turn', 9, 900, {'thread.id': rootSession, 'turn.id': 'turn-main'}),
    span('root', 'response', 'prompt', 'responses_websocket.stream_request', 20, 200),
    span('root', 'script', 'prompt', 'code_mode.handler.execute', 205, 360,
      {'conversation.id': rootSession, 'cell.id': '7', call_id: 'script-call', outcome: 'completed'}),
    span('nested', 'broker', '', 'code_mode.broker.invoke_tool', 210, 310, {'conversation.id': rootSession, 'cell.id': '7'}),
    span('root', 'response2', 'prompt', 'responses_websocket.stream_request', 400, 600),
    span('child', 'prompt', '', 'session_task.turn', 260, 500, {'thread.id': childSession, 'turn.id': 'turn-child'}),
    span('child', 'response', 'prompt', 'responses_websocket.stream_request', 300, 450),
  ];
  const logs = [
    log(0, rootSession, 'codex.conversation_starts', {provider_name: 'OpenAI', model: 'fixture-model', reasoning_effort: 'high'}, 'root'),
    log(5, rootSession, 'codex.sse_event', {'event.kind': 'response.completed', input_token_count: '999', output_token_count: '0', model: 'fixture-model'}),
    log(10, rootSession, 'codex.user_prompt', {prompt: 'Check the recorded fixture.'}, 'root'),
    log(200, rootSession, 'codex.sse_event', {'event.kind': 'response.completed', input_token_count: '100', output_token_count: '10', cached_token_count: '70', cache_write_token_count: '20', model: 'fixture-model', ttft_ms: '50'}),
    log(250, rootSession, 'codex.tool_result', {tool_name: 'spawn_agent', call_id: 'spawn', duration_ms: '30', success: 'true',
      arguments: '{"message":"Check the sum"}', output: `{"agent_id":"${childSession}"}`}, 'root'),
    log(250, childSession, 'codex.conversation_starts', {provider_name: 'OpenAI', model: 'fixture-model', reasoning_effort: 'low'}, 'child'),
    log(260, childSession, 'codex.user_prompt', {prompt: 'Check the sum'}, 'child'),
    log(300, rootSession, 'codex.tool_result', {tool_name: 'exec_command', call_id: 'nested', duration_ms: '80', success: 'true',
      arguments: '{"cmd":"exit 7","max_output_tokens":128}', output: 'Process exited with code 7\n'}, 'nested'),
    log(360, rootSession, 'codex.tool_result', {tool_name: 'exec', call_id: 'script-call', duration_ms: '155', success: 'true',
      arguments: 'text(await tools.exec_command({cmd:"exit 7"}));\n', output: 'Script completed\n{"exit_code":7}'}, 'root'),
    log(450, childSession, 'codex.sse_event', {'event.kind': 'response.completed', input_token_count: '40', output_token_count: '4', model: 'fixture-model'}),
    log(600, rootSession, 'codex.sse_event', {'event.kind': 'response.completed', input_token_count: '120', output_token_count: '0', model: 'fixture-model'}),
  ];
  const metadata = (session: string, time: number, input: number, output: number): Observation => ({source: 'session_metadata', timestamp: at(999),
    data: {session_id: session, record: {type: 'event_msg', timestamp: new Date(Number(BigInt(at(time)) / 1_000_000n)).toISOString(),
      payload: {type: 'token_count', info: {model_context_window: 1000, last_token_usage: {input_tokens: input, output_tokens: output}}}}}});
  return [
    {source: 'process_start', timestamp: at(0), data: {pid: 12346, machineId: 101, captureId: 'codex-fixture'}},
    {source: 'clock_snapshot', timestamp: at(0), data: {realtimeNs: at(0), boottimeNs: '10000000000'}},
    {source: 'cli', timestamp: at(0), data: {type: 'thread.started', thread_id: rootSession}},
    {source: '/v1/traces', timestamp: at(950), data: {resourceSpans: [{scopeSpans: [{spans: [...spans].reverse()}]}]}},
    {source: '/v1/logs', timestamp: at(960), data: {resourceLogs: [{scopeLogs: [{logRecords: [...logs].reverse()}]}]}},
    {source: '/v1/logs', timestamp: at(970), data: {resourceLogs: [{scopeLogs: [{logRecords: logs}]}]}},
    metadata(rootSession, 201, 100, 10), metadata(rootSession, 601, 120, 0), metadata(childSession, 451, 40, 4),
    {source: 'session_metadata', timestamp: at(999), data: {session_id: childSession, record: {type: 'session_meta',
      payload: {id: childSession, source: {subagent: {thread_spawn: {parent_thread_id: rootSession, agent_role: 'auditor'}}}}}}},
    {source: 'process_end', timestamp: at(1000), data: {code: 0, dropped: 0}},
  ];
}
