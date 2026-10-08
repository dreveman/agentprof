// SPDX-License-Identifier: Apache-2.0
import {attachContext} from '../agent-tracing/context.ts';
import type {ContextSnapshot} from '../pi-tracing/extensions/pi-tracing/context.ts';
import {writeTrace, compareTime, type Attrs, type Observation, type Slice, type Session, type Counter} from '../agent-tracing/trace.ts';
import {fnv1a64} from '../pi-tracing/extensions/pi-tracing/machine.ts';
import {promptAnnotations, toolArgumentAnnotations, scriptAnnotations} from '../pi-tracing/extensions/pi-tracing/annotations.ts';
import {readOtel, object, string, integer, number, ns, isoTime, type Span, type Log} from './otel.ts';
import {addHooks, isControl, isControlScript} from './plugin-observations.ts';
export type {Observation} from '../agent-tracing/trace.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const ms = (value: number) => BigInt(Math.round(value * 1e6));
const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;

export function convertObservations(rows: Observation[]): {trace: Uint8Array; summary: Record<string, unknown>} {
  const processStart = rows.find(r => r.source === 'process_start');
  const pid = integer(processStart?.data.pid), capture = string(processStart?.data.captureId);
  if (!pid || !capture || !processStart) throw new Error('Missing recorded Codex process identity');
  const captureContents = processStart.data.capture_contents !== false;
  const first = BigInt(processStart.timestamp), processEnd = rows.findLast(r => r.source === 'process_end');
  const last = BigInt(processEnd?.timestamp ?? rows.at(-1)?.timestamp ?? processStart.timestamp);
  const {spans, logs} = readOtel(rows);
  const plugin = processStart.data.recorder === 'codex-plugin-1';
  const extra = plugin ? addHooks(rows, spans, logs, first, last, captureContents) : [];
  const ordered = [...spans.values()].sort((a, b) => compareTime(a.start, b.start));
  logs.sort((a, b) => compareTime(a.at, b.at));
  const cli = rows.filter(r => r.source === 'cli').map(r => r.data);
  const rootSession = string(processStart.data.sessionId) || string(cli.find(r => r.type === 'thread.started')?.thread_id) ||
    string(logs.find(l => l.attrs['event.name'] === 'codex.user_prompt')?.attrs['conversation.id']);
  if (!rootSession) throw new Error('No Codex session identity was captured.');
  const traceSessions = new Map<string, Set<string>>();
  const remember = (trace: string, id: string) => {
    if (!trace || !uuidPattern.test(id)) return;
    const ids = traceSessions.get(trace) ?? new Set<string>(); ids.add(id); traceSessions.set(trace, ids);
  };
  for (const log of logs) remember(log.trace, string(log.attrs['conversation.id']));
  for (const span of ordered) remember(span.trace, string(span.attrs['conversation.id']) || string(span.attrs['thread.id']));
  const ancestors = (s: Span): Span[] => {
    const result: Span[] = [], seen = new Set<string>();
    let current: Span | undefined = s;
    while (current && !seen.has(current.key)) {seen.add(current.key); result.push(current); current = spans.get(current.parent);}
    return result;
  };
  const spanSession = (s: Span): string => {
    for (const a of ancestors(s)) {
      const id = string(a.attrs['conversation.id']) || string(a.attrs['thread.id']);
      if (uuidPattern.test(id)) return id;
    }
    const ids = traceSessions.get(s.trace);
    return ids?.size === 1 ? [...ids][0]! : '';
  };
  const sessions = new Map<string, Session>();
  const getSession = (id: string): Session => {
    let s = sessions.get(id);
    if (!s) {
      s = {id, start: id === rootSession ? first : last, end: id === rootSession ? last : first,
        attrs: {harness: 'codex', recorder_version: plugin ? 'codex-plugin-1' : 'codex-prototype-1', timing: 'native-otel',
          ...(!processEnd || processEnd.data.dropped !== 0 || processEnd.data.incomplete || rows.some(r => r.source === 'recovery') ? {incomplete: true} : {})}};
      sessions.set(id, s);
    }
    return s;
  };
  getSession(rootSession);
  for (const row of rows.filter(r => r.source === 'codex.hook')) {
    const id = string(row.data.session_id);
    const s = getSession(id);
    if (row.data.parent_session) s.attrs.parent_session = string(row.data.parent_session);
    if (row.data.hook_event_name === 'SubagentStart') {
      const child = getSession(string(row.data.agent_id));
      child.attrs.parent_session = id; child.attrs.child_role = string(row.data.agent_type) || 'subagent';
    }
  }
  for (const log of logs) {
    const id = string(log.attrs['conversation.id']);
    if (!uuidPattern.test(id)) continue;
    const s = getSession(id); s.start = min(s.start, log.at); s.end = max(s.end, log.at);
    if (log.attrs['event.name'] === 'codex.conversation_starts') {
      for (const [key, field] of [['model', 'model'], ['provider_name', 'provider'], ['reasoning_effort', 'effort'], ['app.version', 'harness_version']] as const) {
        if (log.attrs[key]) s.attrs[field] = field === 'provider' ? string(log.attrs[key]).toLowerCase() : log.attrs[key]!;
      }
    }
  }
  for (const span of ordered) {
    const id = spanSession(span); if (!id) continue;
    const s = getSession(id); s.start = min(s.start, span.start); s.end = max(s.end, span.end);
  }
  const metadata = rows.filter(r => r.source === 'session_metadata').map(r => ({session: string(r.data.session_id), record: object(r.data.record)}));
  const tokenMetadata = new Map<string, {at: bigint; usage: Record<string, unknown>; limit?: number}[]>();
  const configurations = new Map<string, {at: bigint; model: string; effort: string}[]>();
  for (const {session, record} of metadata) {
    if (!sessions.has(session)) continue;
    const p = object(record.payload), s = getSession(session);
    if (record.type === 'session_meta') {
      const spawn = object(object(object(p.source).subagent).thread_spawn);
      if (uuidPattern.test(string(spawn.parent_thread_id))) {
        s.attrs.parent_session = string(spawn.parent_thread_id); s.attrs.child_role = string(spawn.agent_role) || 'subagent';
      }
      if (p.model_provider && !s.attrs.provider) s.attrs.provider = string(p.model_provider);
      if (p.cli_version) s.attrs.harness_version = string(p.cli_version);
    }
    if (record.type === 'turn_context' && plugin) {
      const at = isoTime(record.timestamp);
      if (at !== undefined && at <= last) {
        const values = configurations.get(session) ?? [];
        values.push({at, model: string(p.model), effort: string(p.effort)});
        configurations.set(session, values);
      }
    }
    if (record.type === 'event_msg' && p.type === 'token_count') {
      const info = object(p.info), at = isoTime(record.timestamp);
      if (at === undefined || at < first || at > last) continue;
      const values = tokenMetadata.get(session) ?? [];
      values.push({at, usage: object(info.last_token_usage), limit: integer(info.model_context_window)});
      tokenMetadata.set(session, values);
    }
  }
  for (const [id, values] of configurations) {
    values.sort((a, b) => compareTime(a.at, b.at));
    const initial = values.findLast(value => value.at <= first) ?? values[0]!;
    const session = getSession(id);
    if (initial.model) session.attrs.model = initial.model;
    if (initial.effort) session.attrs.effort = initial.effort;
  }
  const slices: Slice[] = [...extra], counters: Counter[] = [];
  const add = (session: string, id: string, track: string, name: string, start: bigint, end: bigint | undefined, attrs: Attrs): Slice => {
    const slice = {session, id, track, name, start, end, attrs, flows: []}; slices.push(slice); return slice;
  };
  const edge = (from: Slice | undefined, to: Slice | undefined) => {
    if (!from || !to || to.start < from.start) return;
    const flow = fnv1a64(`${capture}:flow:${from.id}:${to.id}`) || 1n; from.flows.push(flow); to.flows.push(flow);
  };
  const prompts: Slice[] = [];
  const inputs = new Map<string, Slice>();
  const usedPrompts = new Set<Log>();
  for (const turn of ordered.filter(s => s.name === 'session_task.turn')) {
    const id = spanSession(turn); if (!id) continue;
    const log = logs.find(l => !usedPrompts.has(l) && l.attrs['event.name'] === 'codex.user_prompt' &&
      l.attrs['conversation.id'] === id && l.at >= turn.start - ms(1000) && l.at <= turn.end);
    if (log) usedPrompts.add(log);
    const start = log?.at ?? turn.start;
    const input = add(id, `${turn.key}:input`, 'Inputs', 'prompt-input', start, undefined, {source: id === rootSession ? 'user' : 'agent'});
    const prompt = add(id, turn.key, 'Session', 'prompt', start, turn.end, {kind: 'prompt',
      turn_id: string(turn.attrs['turn.id']), ...(turn.attrs['capture.incomplete'] ? {incomplete: true} : {}),
      ...promptAnnotations(log?.attrs.prompt === '[REDACTED]' ? undefined : log?.attrs.prompt, captureContents),
      ...(integer(log?.attrs.prompt_length) !== undefined ? {length: integer(log?.attrs.prompt_length)!} : {})});
    edge(input, prompt); prompts.push(prompt); if (!inputs.has(id)) inputs.set(id, input);
  }
  for (const log of logs.filter(l => l.attrs['event.name'] === 'codex.user_prompt' && !usedPrompts.has(l))) {
    const id = string(log.attrs['conversation.id']); if (!sessions.has(id)) continue;
    const input = add(id, `${log.key}:input`, 'Inputs', 'prompt-input', log.at, undefined, {source: 'user'});
    const prompt = add(id, log.key, 'Session', 'prompt', log.at, getSession(id).end,
      {kind: 'prompt', incomplete: true, ...promptAnnotations(log.attrs.prompt, captureContents),
        ...(integer(log.attrs.prompt_length) !== undefined ? {length: integer(log.attrs.prompt_length)!} : {})});
    edge(input, prompt); prompts.push(prompt); inputs.set(id, input);
  }
  const ownerPrompt = (slice: Slice) => prompts.find(p => p.session === slice.session && p.start <= slice.start && p.end! >= slice.start);
  const requests = ordered.filter(s => ['responses_websocket.stream_request', 'responses.stream_request'].includes(s.name));
  const prewarm = (s: Span) => ancestors(s).some(a => a.name === 'startup_prewarm' || a.attrs['websocket.warmup'] === true) ||
    ordered.some(a => a.trace === s.trace && a.name === 'startup_prewarm' && a.start <= s.start && a.end >= s.end);
  const usedRequests = new Set<Span>();
  const responses: Slice[] = [];
  const compactionResponses: Slice[] = [];
  let unmeasuredResponses = 0, prewarms = 0;
  for (const log of logs.filter(l => l.attrs['event.kind'] === 'response.completed')) {
    const id = string(log.attrs['conversation.id']); if (!sessions.has(id)) continue;
    // Completion logs lack span IDs in 0.160. Match only a unique stream in the
    // same session ending near the millisecond-resolution completion log.
    const matches = requests.filter(s => !usedRequests.has(s) && spanSession(s) === id &&
      s.start <= log.at + ms(1) && s.end >= log.at - ms(1) && s.end <= log.at + ms(5));
    const request = matches.length === 1 ? matches[0] : undefined;
    if (request) usedRequests.add(request);
    const start = request?.start ?? log.at, end = request?.end ?? log.at;
    const warm = request !== undefined && prewarm(request);
    const compaction = extra.some(slice => slice.session === id && slice.attrs.kind === 'compaction' &&
      slice.start <= start && slice.end! >= end);
    const configuration = configurations.get(id)?.findLast(value => value.at <= start);
    const attrs: Attrs = {kind: warm ? 'startup' : compaction ? 'compaction-response' : 'assistant-message', model: string(log.attrs.model) || configuration?.model || string(getSession(id).attrs.model),
      ...(getSession(id).attrs.provider ? {provider: getSession(id).attrs.provider!} : {}), timing: request ? 'native-stream' : 'unmeasured',
      ...(request ? {is_error: request.error, ...(request.attrs['capture.incomplete'] ? {incomplete: true} : {})} : {incomplete: true})};
    for (const [source, target] of [['input_token_count', 'input_tokens'], ['output_token_count', 'output_tokens'],
      ['cached_token_count', 'cache_read_tokens'], ['cache_write_token_count', 'cache_write_tokens'],
      ['reasoning_token_count', 'reasoning_tokens']] as const) {
      const value = integer(log.attrs[source]); if (value !== undefined) attrs[target] = value;
    }
    const effort = log.attrs.model_reasoning_effort ?? (configuration ? configuration.effort : getSession(id).attrs.effort);
    if (effort !== undefined && effort !== '') attrs.effort = effort;
    const ttft = number(log.attrs.ttft_ms); if (ttft !== undefined) attrs.ttft_ns = Math.round(ttft * 1e6);
    const slice = add(id, log.key, warm ? 'Tracing' : compaction ? 'Compaction responses' : 'Responses', warm ? 'prewarm' : 'response', start, end, attrs);
    if (warm) {prewarms++; continue;}
    if (!request) unmeasuredResponses++;
    const samples = tokenMetadata.get(id) ?? [];
    const sample = samples.find(v => v.at >= end - ms(5) && v.at <= end + ms(1000) &&
      v.usage.input_tokens === attrs.input_tokens && v.usage.output_tokens === attrs.output_tokens);
    const limit = sample?.limit;
    if (limit) attrs.context_window_tokens = limit;
    if (attrs.input_tokens !== undefined) attrs.context_tokens = attrs.input_tokens;
    if (compaction) {compactionResponses.push(slice); continue;}
    responses.push(slice);
    add(id, `${log.key}:turn`, 'Turns', 'turn', start, end, {kind: 'turn', ...(request ? {} : {incomplete: true})});
    edge(ownerPrompt(slice), slice);
  }
  for (const request of requests.filter(s => !usedRequests.has(s))) {
    const id = spanSession(request); if (!id) continue;
    const warm = prewarm(request);
    add(id, request.key, warm ? 'Tracing' : 'Requests', warm ? 'prewarm' : 'request', request.start, request.end,
      {kind: warm ? 'startup' : 'provider-request', timing: 'native-stream', ...(request.error ? {is_error: true} : {}),
        ...(!warm ? {incomplete: true, reason: 'completion_not_received'} : {})});
  }
  const scripts = new Map<string, Slice>();
  const toolSlices: {slice: Slice; log: Log}[] = [];
  for (const log of logs.filter(l => l.attrs['event.name'] === 'codex.tool_result')) {
    const id = string(log.attrs['conversation.id']), duration = number(log.attrs.duration_ms);
    if (!sessions.has(id) || duration === undefined) continue;
    const call = string(log.attrs.call_id), name = string(log.attrs.tool_name) || 'tool';
    if (isControl(name)) continue;
    const native = ordered.find(s => s.name === 'code_mode.handler.execute' && s.attrs.call_id === call && spanSession(s) === id);
    const start = native?.start ?? log.at - ms(duration), end = native?.end ?? log.at;
    const source = string(log.attrs.arguments);
    if (native && (log.attrs['agentprof.control_script'] === true ||
      (captureContents && isControlScript(source)))) continue;
    let args: unknown;
    if (captureContents && source) {
      try {args = JSON.parse(source);} catch {args = {code: source};}
    }
    const annotation = captureContents && source ? toolArgumentAnnotations(args, true) : {};
    if (annotation.truncated !== undefined) {annotation.args_truncated = annotation.truncated; delete annotation.truncated;}
    const output = captureContents ? string(log.attrs.output) : '';
    const exit = ['exec_command', 'write_stdin', 'shell', 'shell_command'].includes(name)
      ? output.match(/(?:Process exited with code |"exit_code"\s*:\s*)(-?\d+)/) : null;
    const denied = logs.some(l => l.attrs['event.name'] === 'codex.sandbox_outcome' &&
      l.attrs['conversation.id'] === id && l.attrs.call_id === call && l.attrs.outcome === 'denied');
    const failed = log.attrs.success === false || log.attrs.success === 'false' || native?.error || denied;
    const attrs: Attrs = {kind: native ? 'script' : 'tool-execution', call_id: call, ...annotation,
      timing: native ? 'native-span' : 'native-tool-duration',
      ...(failed ? {is_error: true} : native?.attrs.outcome === 'completed' ? {is_error: false} : exit ? {is_error: Number(exit[1]) !== 0} : {}),
      ...(exit ? {exit_code: Number(exit[1])} : {}),
      ...(native ? scriptAnnotations('JavaScript', captureContents ? source : undefined) : {})};
    if (native?.attrs['capture.incomplete']) attrs.incomplete = true;
    const intent = captureContents ? object(args).description ?? object(args).justification : undefined;
    if (captureContents && typeof intent === 'string' && intent) attrs.intent = intent;
    const slice = add(id, log.key, 'Tools', name, start, end, attrs);
    if (plugin && start < first) {slice.start = first; slice.attrs.incomplete = true;}
    if (native) {
      scripts.set(`${id}:${native.attrs['cell.id']}`, slice);
      getSession(id).attrs.session_labels = ['scripted tools'];
    }
    toolSlices.push({slice, log}); edge(ownerPrompt(slice), slice);
  }
  for (const {slice, log} of toolSlices) {
    if (slice.attrs.kind === 'script') continue;
    const brokers = ordered.filter(s => s.trace === log.trace && s.name === 'code_mode.broker.invoke_tool' && spanSession(s) === slice.session);
    // Each broker invocation has its own trace; do not guess parentage from overlap.
    if (brokers.length === 1) {
      const script = scripts.get(`${slice.session}:${brokers[0]!.attrs['cell.id']}`);
      if (script) {slice.attrs.parent_call_id = script.attrs.call_id!; edge(script, slice);}
    }
    const response = responses.filter(s => s.session === slice.session && s.start <= slice.start)
      .sort((a, b) => compareTime(b.start, a.start))[0];
    edge(response, slice);
  }
  // Transcript source metadata identifies logical children without claiming
  // that Rust task IDs or agent sessions are operating-system threads.
  for (const session of sessions.values()) {
    const parent = string(session.attrs.parent_session); if (!parent) continue;
    const launch = captureContents ? toolSlices.find(({slice, log}) => slice.session === parent &&
      slice.name.endsWith('spawn_agent') && string(log.attrs.output).includes(session.id))?.slice : undefined;
    if (launch) {launch.attrs.delegation = true; launch.attrs.child_session = session.id; edge(launch, inputs.get(session.id));}
  }
  for (const session of sessions.values()) {
    const work = responses.filter(s => s.session === session.id).sort((a, b) => compareTime(a.start, b.start));
    const limits = [...new Set(work.map(s => integer(s.attrs.context_window_tokens)).filter((v): v is number => v !== undefined))];
    if (limits.length === 1) session.attrs.context_window_tokens = limits[0]!;
    let config: Slice | undefined, previous = '';
    for (const response of work) {
      const attrs: Attrs = {harness: 'codex'};
      for (const key of ['provider', 'model', 'effort', 'context_window_tokens'])
        if (response.attrs[key] !== undefined) attrs[key] = response.attrs[key]!;
      if (session.attrs.session_labels) attrs.session_labels = session.attrs.session_labels;
      const value = JSON.stringify(attrs); if (value === previous) continue;
      if (config) config.end = response.start;
      config = add(session.id, `config:${response.id}`, 'Configuration', 'run-configuration', response.start, session.end, attrs);
      previous = value;
    }
    for (const [name, field] of [['Input tokens', 'input_tokens'], ['Output tokens', 'output_tokens'],
      ['Context size', 'context_tokens'], ['Context window', 'context_window_tokens']] as const) {
      let total = 0;
      const cumulative = field === 'input_tokens' || field === 'output_tokens';
      const samples: Counter['samples'] = [];
      const usage = [...work, ...compactionResponses.filter(slice => slice.session === session.id)];
      for (const response of usage.sort((a, b) => compareTime(cumulative ? a.end! : a.start, cumulative ? b.end! : b.start))) {
        const value = integer(response.attrs[field]);
        if (value === undefined) {
          if (field === 'context_window_tokens' && samples.length) samples.push({at: response.start, value: 0});
          continue;
        }
        total += value; samples.push({at: cumulative ? response.end! : response.start, value: cumulative ? total : value});
      }
      counters.push({session: session.id, name, unit: 'tokens', ...(!cumulative ? {axis: 'llm.context.tokens'} : {}), samples});
    }
  }
  if (!plugin && !responses.length && !toolSlices.length) throw new Error('No Codex model/tool telemetry captured; check the installed CLI telemetry support.');
  if (plugin) for (const session of sessions.values()) {
    session.start = max(first, session.start); session.end = min(last, session.end);
  }
  for (const {session, record} of metadata) if (record.type === 'context_snapshot') {
    const at = isoTime(record.timestamp); if (at === undefined || at < first || at > last) continue;
    const operation = slices.filter(s => s.session === session && s.attrs.kind === 'assistant-message' && s.start <= at)
      .sort((a, b) => compareTime(b.start, a.start))[0];
    if (operation) attachContext(operation, record.payload as ContextSnapshot, counters, at);
  }
  const trace = writeTrace({capture, pid, machineId: integer(processStart.data.machineId) ?? 0,
    processName: 'codex', processLabel: 'Codex', category: 'codex', sessions: [...sessions.values()].filter(s => s.end >= s.start), slices, counters,
    clocks: rows.filter(r => r.source === 'clock_snapshot').map(r => {
      const realtimeNs = ns(r.data.realtimeNs), boottimeNs = ns(r.data.boottimeNs);
      if (realtimeNs === undefined || boottimeNs === undefined) throw new Error('Invalid clock snapshot');
      return {realtimeNs, boottimeNs};
    })});
  return {trace, summary: {sessions: sessions.size, responses: responses.length,
    scripts: scripts.size, tools: slices.filter(slice => slice.attrs.kind === 'tool-execution').length,
    nestedTools: toolSlices.filter(t => t.slice.attrs.parent_call_id).length, prewarms, unmeasuredResponses,
    compactions: extra.filter(slice => slice.attrs.kind === 'compaction').length,
    inputTokens: [...responses, ...compactionResponses].reduce((sum, s) => sum + (integer(s.attrs.input_tokens) ?? 0), 0),
    outputTokens: [...responses, ...compactionResponses].reduce((sum, s) => sum + (integer(s.attrs.output_tokens) ?? 0), 0),
    dropped: processEnd?.data.dropped ?? null, processExitCode: processEnd?.data.code ?? null,
    limitations: ['Context is sampled request input; reported input includes cached tokens.',
      'TTFT is retained separately from first-content timing.', 'CPU/heap sampling is not supported.']}};
}
