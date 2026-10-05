// SPDX-License-Identifier: Apache-2.0
import {writeTrace, compareTime, type Observation, type Session, type Slice, type Counter, type Attrs} from '../agent-tracing/trace.ts';
import {fnv1a64} from '../pi-tracing/extensions/pi-tracing/machine.ts';
import {promptAnnotations, toolArgumentAnnotations} from '../pi-tracing/extensions/pi-tracing/annotations.ts';

type Data = Record<string, unknown>;
const object = (v: unknown): Data => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
const text = (v: unknown) => typeof v === 'string' ? v : '';
const value = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
const tokens = (v: unknown) => Number.isSafeInteger(value(v)) ? value(v) : undefined;
const ms = (v: number) => BigInt(Math.round(v * 1e6));
const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;

export function convertDirectObservations(rows: Observation[]): {trace: Uint8Array; summary: Data} {
  // A resumed conversation may visit the same native id again in one recording.
  // Keep each capture window distinct so open operations cannot cross /resume.
  const firstSegment = new Map<string, number>();
  for (const r of rows) if (r.source === 'claude.mod' && !firstSegment.has(text(r.data.session_id)))
    firstSegment.set(text(r.data.session_id), Number(r.data.segment ?? 0));
  rows = rows.map(r => {
    if (r.source !== 'claude.mod' || Number(r.data.segment ?? 0) === firstSegment.get(text(r.data.session_id))) return r;
    const id = `${r.data.session_id}:${r.data.segment}`;
    return {...r, data: {...r.data, native_session_id: r.data.session_id, session_id: id,
      ...(r.data.event === 'session' ? {id} : {})}};
  });
  const identity = rows.find(r => r.source === 'process_start');
  if (!identity || !tokens(identity.data.pid) || !text(identity.data.captureId)) throw new Error('Missing Claude process identity');
  const capture = text(identity.data.captureId);
  const events = rows.filter(r => r.source === 'claude.mod').sort((a, b) => compareTime(BigInt(a.timestamp), BigInt(b.timestamp)));
  if (!events.length) throw new Error('No direct Claude events captured');
  const last = BigInt(events.at(-1)!.timestamp);
  const agents = new Map<string, Data>();
  for (const r of events.filter(r => r.data.event === 'agent')) agents.set(`${r.data.session_id}/${r.data.agent_id}`, r.data);
  const scope = (d: Data) => `${text(d.session_id)}${d.agent_id ? '/' + text(d.agent_id) : ''}`;
  const key = (d: Data) => `${scope(d)}:${d.event}:${d.id}`;
  const ends = new Map(events.filter(r => r.data.phase === 'end').map(r => [key(r.data), r]));
  const sessions = new Map<string, Session>();
  const getSession = (r: Observation) => {
    const id = scope(r.data), at = BigInt(r.timestamp);
    let session = sessions.get(id);
    if (!session) {
      const native = agents.get(id);
      session = {id, start: at, end: at, attrs: {harness: 'claude-code',
        ...(r.data.native_session_id ? {native_session_id: text(r.data.native_session_id)} : {}),
        provider: sessions.get(text(r.data.session_id))?.attrs.provider ?? 'anthropic', timing: 'mod-hooks',
        ...(r.data.agent_id ? {parent_session: `${r.data.session_id}${native?.parent_agent_id ? '/' + native.parent_agent_id : ''}`,
          agent_id: text(r.data.agent_id), child_role: text(native?.role) || 'internal', ...(native?.model ? {model: text(native.model)} : {})} : {})}};
      sessions.set(id, session);
    }
    session.start = min(session.start, at); session.end = max(session.end, at);
    return session;
  };
  for (const r of events) {
    if (!text(r.data.session_id)) continue;
    const session = getSession(r);
    if (r.data.event === 'session' && r.data.phase === 'begin') {
      if (r.data.model) session.attrs.model = text(r.data.model);
      if (r.data.version) session.attrs.harness_version = text(r.data.version);
      if (r.data.provider) session.attrs.provider = text(r.data.provider);
    }
  }
  const captureEnd = (d: Data) => {
    const closed = ends.get(`${text(d.session_id)}:session:${text(d.session_id)}`);
    return closed ? BigInt(closed.timestamp) : last;
  };
  // A manual stop can cut through child work. Extend its capture to that
  // boundary so unfinished spans and counter resets stay inside the capture.
  for (const r of events.filter(r => r.data.phase === 'begin')) {
    const d = r.data;
    const open = ['prompt', 'response', 'tool', 'compaction'].includes(text(d.event)) && !ends.has(key(d));
    const childOpen = d.event === 'agent' && !events.some(v => scope(v.data) === scope(d) && v.data.event === 'prompt' && v.data.phase === 'end');
    if (open || childOpen) getSession(r).end = max(getSession(r).end, captureEnd(d));
  }
  for (const session of sessions.values()) {
    if (!session.attrs.parent_session) {
      const closed = events.findLast(r => scope(r.data) === session.id && r.data.event === 'session' && r.data.phase === 'end');
      if (!closed || closed.data.dropped || rows.some(r => r.source === 'recovery')) session.attrs.incomplete = true;
      if (closed) session.attrs.stop_reason = text(closed.data.reason);
      if (closed?.data.dropped) session.attrs.dropped_events = tokens(closed.data.dropped)!;
    } else if (!events.some(r => scope(r.data) === session.id && r.data.event === 'prompt' && r.data.phase === 'end')) {
      session.attrs.incomplete = true;
    }
  }
  const slices: Slice[] = [], counters: Counter[] = [];
  const add = (r: Observation, track: string, name: string, start: bigint, end: bigint | undefined, attrs: Attrs, suffix = '') => {
    const slice: Slice = {id: key(r.data) + suffix, session: scope(r.data), track, name, start, end, attrs, flows: []};
    slices.push(slice); return slice;
  };
  const edge = (from?: Slice, to?: Slice) => {
    if (!from || !to || to.start < from.start) return;
    const id = fnv1a64(`${capture}:${from.id}:${to.id}`) || 1n; from.flows.push(id); to.flows.push(id);
  };
  const prompts = new Map<string, Slice>(), inputs = new Map<string, Slice>(), responses: Slice[] = [];
  const tools = new Map<string, Slice>(), dispatches = new Map<string, Slice>();
  const executions = new Map(events.filter(r => r.data.event === 'execution').map(r => [`${scope(r.data)}:${r.data.id}`, r]));
  const contextRows = events.filter(r => r.data.event === 'context' || (r.data.event === 'session' && r.data.phase === 'begin'));
  const usageAttrs = (raw: unknown): Attrs => {
    const u = object(raw), attrs: Attrs = {};
    for (const [source, target] of [['input_tokens', 'input_tokens'], ['output_tokens', 'output_tokens'],
      ['cache_read_input_tokens', 'cache_read_tokens'], ['cache_creation_input_tokens', 'cache_write_tokens']] as const) {
      const n = tokens(u[source]); if (n !== undefined) attrs[target] = n;
    }
    return attrs;
  };
  for (const r of events.filter(r => r.data.phase === 'begin' && ['prompt', 'agent'].includes(text(r.data.event)))) {
    const d = r.data, session = getSession(r), close = ends.get(key(d));
    const promptEnd = close ? BigInt(close.timestamp) : d.event === 'agent' ? session.end : captureEnd(d);
    const input = add(r, 'Inputs', 'prompt-input', BigInt(r.timestamp), undefined, {source: d.agent_id ? 'agent' : 'user'}, ':input');
    const prompt = add(r, 'Session', 'prompt', BigInt(r.timestamp), promptEnd,
      {kind: 'prompt', ...promptAnnotations(d.prompt, true), ...(tokens(d.prompt_length) !== undefined ? {length: tokens(d.prompt_length)!} : {}),
        ...(d.content_omitted ? {content_omitted: true} : {}),
        ...(d.started_before_capture ? {started_before_capture: true, incomplete: true} : {}),
        ...(!close && (d.event !== 'agent' || session.attrs.incomplete) ? {incomplete: true} : {}), ...(close?.data.aborted ? {aborted: true} : {})});
    prompts.set(`${session.id}:${d.id}`, prompt); inputs.set(session.id, input); edge(input, prompt);
  }
  for (const r of events.filter(r => r.data.event === 'response' && r.data.phase === 'begin')) {
    const d = r.data, close = ends.get(key(d)), result = close?.data ?? {}, u = object(result.usage);
    const start = BigInt(r.timestamp), end = close ? BigInt(close.timestamp) : captureEnd(d);
    const model = text(u.model) || text(d.model), session = getSession(r);
    const attrs: Attrs = {kind: 'assistant-message', model, provider: session.attrs.provider!, timing: 'mod-request-including-retries',
      ...usageAttrs(u), ...(d.effort !== undefined ? {effort: d.effort as string | number} : {}),
      ...(!close || result.incomplete || result.stop_reason === null ? {incomplete: true} : {})};
    for (const [source, target] of [['first_content_ms', 'first_content_ns'], ['first_text_ms', 'first_text_ns']] as const) {
      const n = value(result[source]); if (n !== undefined) attrs[target] = Math.round(n * 1e6);
    }
    const context = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].map(tokens);
    if (context.every(v => v !== undefined)) attrs.context_tokens = context.reduce<number>((n, v) => n + v!, 0);
    // Context APIs describe only the main conversation, not an arbitrary child.
    if (!d.agent_id) {
      const reading = contextRows.find(v => scope(v.data) === session.id && v.data.id === d.id && BigInt(v.timestamp) >= end) ??
        contextRows.findLast(v => scope(v.data) === session.id && BigInt(v.timestamp) <= start);
      const window = reading?.data.model === model ? tokens(object(reading.data.context).window) : undefined;
      if (window) attrs.context_window_tokens = window;
    }
    const response = add(r, 'Responses', 'response', start, end, attrs); responses.push(response);
    add(r, 'Turns', 'turn', start, end, {kind: 'turn', ...(attrs.incomplete ? {incomplete: true} : {})}, ':turn');
    edge(prompts.get(`${session.id}:${d.turn_id}`) ?? slices.find(s => s.session === session.id && s.attrs.kind === 'prompt' && s.start <= start && s.end! >= start), response);
  }
  for (const r of events.filter(r => r.data.event === 'tool' && r.data.phase === 'begin')) {
    const d = r.data, close = ends.get(key(d));
    const execution = executions.get(`${scope(d)}:${d.id}`);
    const duration = value(execution?.data.duration_ms), dispatchStart = BigInt(r.timestamp);
    const dispatchEnd = close ? BigInt(close.timestamp) : captureEnd(d);
    // Host duration has millisecond precision; allow rounding, not arbitrary
    // intervals outside the observed dispatch. Placement ends at PostToolUse.
    const measured = duration !== undefined && execution !== undefined && ms(duration) <= dispatchEnd - dispatchStart + ms(1);
    const end = measured ? BigInt(execution.timestamp) : dispatchEnd;
    const start = measured ? end - ms(duration) : dispatchStart;
    const attrs: Attrs = {kind: 'tool-execution', call_id: text(d.id), ...toolArgumentAnnotations(d.arguments, true),
      timing: measured ? 'reported-execution-duration' : 'dispatch-only',
      ...(d.content_omitted ? {content_omitted: true} : {}),
      ...(!measured || !close || close.data.incomplete ? {incomplete: true} : {}),
      ...(close ? {is_error: Boolean(close.data.is_error)} : execution ? {is_error: Boolean(execution.data.is_error)} : {})};
    const intent = object(d.arguments).description;
    if (typeof intent === 'string') attrs.intent = intent;
    const tool = add(r, 'Tools', text(d.tool) || 'tool', start, end, attrs); tools.set(`${scope(d)}:${d.id}`, tool);
    const dispatch = add(r, 'Tool dispatch', text(d.tool) || 'tool', dispatchStart, dispatchEnd,
      {kind: 'tool-dispatch', call_id: text(d.id), timing: 'including-permissions-and-hooks',
        ...(!close || close.data.incomplete ? {incomplete: true} : {})}, ':dispatch');
    dispatches.set(`${scope(d)}:${d.id}`, dispatch);
    edge(dispatch, tool);
    edge(responses.filter(s => s.session === tool.session && s.start <= dispatchStart).at(-1), tool);
  }
  for (const r of events.filter(r => r.data.event === 'agent')) {
    const parent = `${r.data.session_id}${r.data.parent_agent_id ? '/' + r.data.parent_agent_id : ''}`;
    const key = `${parent}:${r.data.call_id}`, tool = tools.get(key), input = inputs.get(scope(r.data));
    if (tool) {
      tool.attrs.delegation = true; tool.attrs.child_session = scope(r.data);
      // Reported execution duration does not provide an exact start timestamp.
      // Fall back to the observed dispatch when its estimated start is too late.
      edge(input && tool.start <= input.start ? tool : dispatches.get(key), input);
    }
  }
  for (const r of events.filter(r => r.data.event === 'compaction' && r.data.phase === 'begin')) {
    const close = ends.get(key(r.data)), result = close?.data ?? {};
    const attrs: Attrs = {kind: 'compaction', trigger: text(r.data.trigger), timing: 'mod-compaction',
      ...usageAttrs(result.usage), ...(!close || result.incomplete ? {incomplete: true} : {success: result.success === true}),
      ...(result.skipped ? {skipped: true} : {})};
    for (const k of ['pre_tokens', 'post_tokens']) {const n = tokens(result[k]); if (n !== undefined) attrs[k] = n;}
    add(r, 'Compaction', r.data.trigger === 'precompute' ? 'precompute' : 'compact', BigInt(r.timestamp), close ? BigInt(close.timestamp) : captureEnd(r.data), attrs);
  }
  for (const session of sessions.values()) {
    const work = responses.filter(s => s.session === session.id);
    const usageWork = slices.filter(s => s.session === session.id && ['assistant-message', 'compaction'].includes(text(s.attrs.kind)))
      .sort((a, b) => compareTime(a.end!, b.end!));
    let config: Slice | undefined, previous = '';
    for (const response of work) {
      const attrs: Attrs = {harness: 'claude-code'};
      for (const k of ['model', 'provider', 'effort', 'context_window_tokens']) if (response.attrs[k] !== undefined) attrs[k] = response.attrs[k]!;
      const current = JSON.stringify(attrs); if (current === previous) continue;
      if (config) config.end = response.start;
      config = {...response, id: `config:${response.id}`, track: 'Configuration', name: 'run-configuration', end: session.end, attrs, flows: []};
      slices.push(config); previous = current;
    }
    for (const [name, field] of [['Input tokens', 'input_tokens'], ['Output tokens', 'output_tokens'], ['Context size', 'context_tokens'], ['Context window', 'context_window_tokens']] as const) {
      const cumulative = field === 'input_tokens' || field === 'output_tokens';
      const samples: Counter['samples'] = []; let total = 0;
      for (const response of cumulative ? usageWork : work) {
        const n = tokens(response.attrs[field]); if (n === undefined) continue;
        total += n; samples.push({at: cumulative ? response.end! : response.start, value: cumulative ? total : n});
      }
      if (field === 'context_tokens' || field === 'context_window_tokens') {
        for (const r of contextRows.filter(v => scope(v.data) === session.id)) {
          const n = tokens(object(r.data.context)[field === 'context_tokens' ? 'tokens' : 'window']);
          if (n !== undefined) samples.push({at: BigInt(r.timestamp), value: n});
        }
        if (field === 'context_tokens') for (const compact of slices.filter(s => s.session === session.id && s.attrs.kind === 'compaction' && s.name !== 'precompute')) {
          const before = tokens(compact.attrs.pre_tokens), after = tokens(compact.attrs.post_tokens);
          if (before !== undefined) samples.push({at: compact.start, value: before});
          if (after !== undefined) samples.push({at: compact.end!, value: after});
        }
      }
      counters.push({session: session.id, name, unit: 'tokens', ...(!cumulative ? {axis: 'llm.context.tokens'} : {}), samples});
    }
  }
  const trace = writeTrace({capture, pid: tokens(identity.data.pid)!, machineId: tokens(identity.data.machineId) ?? 0,
    processName: 'claude', processLabel: 'Claude Code', category: 'claude', sessions: [...sessions.values()], slices, counters,
    clocks: rows.filter(r => r.source === 'clock_snapshot').map(r => ({realtimeNs: BigInt(text(r.data.realtimeNs)), boottimeNs: BigInt(text(r.data.boottimeNs))}))});
  return {trace, summary: {source: 'claude-mod', sessions: sessions.size, responses: responses.length, tools: tools.size,
    measuredResponses: responses.filter(s => !s.attrs.incomplete).length,
    incompleteOperations: slices.filter(s => s.attrs.incomplete && ['prompt', 'assistant-message', 'tool-execution', 'compaction'].includes(text(s.attrs.kind))).length,
    measuredTools: [...tools.values()].filter(t => !t.attrs.incomplete).length,
    compactions: slices.filter(s => s.attrs.kind === 'compaction').length,
    inputTokens: slices.reduce((n, s) => n + (tokens(s.attrs.input_tokens) ?? 0), 0),
    outputTokens: slices.reduce((n, s) => n + (tokens(s.attrs.output_tokens) ?? 0), 0)}};
}
