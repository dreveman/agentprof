// SPDX-License-Identifier: Apache-2.0
// Offline conversion preserves source timestamps when OTLP batches arrive late.
import {buildClockSnapshot, buildTracePacket, buildTrackDescriptor, buildTrackEvent, framePacket,
  CLOCK_REALTIME, CLOCK_BOOTTIME, TRACK_EVENT_BEGIN, TRACK_EVENT_END, TRACK_EVENT_INSTANT, TRACK_EVENT_COUNTER,
  SIBLING_MERGE_BY_TRACK_NAME, SIBLING_MERGE_NONE, type DebugAnnotationValue} from '../pi-tracing/extensions/pi-tracing/encoder.ts';
import {fnv1a64} from '../pi-tracing/extensions/pi-tracing/machine.ts';
import {promptAnnotations, toolArgumentAnnotations} from '../pi-tracing/extensions/pi-tracing/annotations.ts';
import {convertDirectObservations} from './direct.ts';

type ObjectValue = Record<string, unknown>;
type Attrs = Record<string, DebugAnnotationValue>;
export interface Observation {source: string; timestamp: string; data: ObjectValue}
interface Span {key: string; parent: string; name: string; start: bigint; end: bigint; attrs: Attrs; error: boolean}
interface Hook {at: bigint; event: ObjectValue}
interface Slice {id: string; scope: string; track: string; name: string; start: bigint; end?: bigint; attrs: Attrs; flows: bigint[]}
interface Scope {key: string; session: string; agent: string; parent?: string; start: bigint; end: bigint; root: bigint; attrs: Attrs}
const object = (v: unknown): ObjectValue => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as ObjectValue : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const integer = (v: unknown): number | undefined => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
function measurement(v: unknown): number | undefined {
  const value = typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : v;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function ns(v: unknown): bigint | undefined {
  if ((typeof v !== 'string' || !/^\d+$/.test(v)) && (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)) return;
  return BigInt(v);
}
function otelValue(raw: unknown): DebugAnnotationValue | undefined {
  const v = object(raw);
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (v.intValue !== undefined) return integer(Number(v.intValue));
  if (typeof v.doubleValue === 'number' && Number.isFinite(v.doubleValue)) return v.doubleValue;
  if (v.arrayValue) return array(object(v.arrayValue).values).map(otelValue).filter((x): x is DebugAnnotationValue => x !== undefined);
  return undefined;
}
function attributes(raw: unknown): Attrs {
  const result: Attrs = {};
  for (const item of array(raw)) {
    const a = object(item), value = otelValue(a.value);
    if (typeof a.key === 'string' && value !== undefined) result[a.key] = value;
  }
  return result;
}
const compareTime = (a: bigint, b: bigint) => a < b ? -1 : a > b ? 1 : 0;

export function convertObservations(rows: Observation[]): {trace: Uint8Array; summary: ObjectValue} {
  if (rows.some(row => row.source === 'claude.mod')) return convertDirectObservations(rows);
  const processStart = rows.find(r => r.source === 'process_start');
  if (!processStart || integer(processStart.data.pid) === undefined) throw new Error('Missing recorded Claude process identity');
  const first = BigInt(processStart.timestamp);
  const processEnd = rows.find(r => r.source === 'process_end');
  const last = BigInt(processEnd?.timestamp ?? rows.at(-1)?.timestamp ?? processStart.timestamp);
  const capture = string(processStart.data.captureId);
  const machineId = integer(processStart.data.machineId) ?? 0;
  const clockSnapshots = rows.filter(r => r.source === 'clock_snapshot');
  if (!clockSnapshots.length) throw new Error('Missing captured boot/realtime clock snapshot');
  const seqId = Number(fnv1a64(capture) & 0xffffffffn) || 1;
  const uuid = (key: string) => fnv1a64(`${capture}:${key}`) || 1n;
  const spans = new Map<string, Span>();
  const hooks: Hook[] = [];
  const logs: {at: bigint; attrs: Attrs}[] = [];
  const limits = new Map<string, number>();
  const seenLogs = new Set<string>();
  for (const row of rows) {
    if (row.source === '/hook') hooks.push({at: ns(row.data.timestamp) ?? BigInt(row.timestamp), event: object(row.data.event)});
    if (row.source === 'result') {
      for (const [model, value] of Object.entries(object(row.data.modelUsage))) {
        const limit = integer(object(value).contextWindow);
        if (limit) limits.set(model, limit);
      }
    }
    for (const resource of array(row.data.resourceSpans)) {
      for (const scope of array(object(resource).scopeSpans)) {
        for (const entry of array(object(scope).spans)) {
          const s = object(entry), start = ns(s.startTimeUnixNano), end = ns(s.endTimeUnixNano);
          if (start === undefined || end === undefined || end < start) continue;
          const traceId = string(s.traceId);
          const key = `${traceId}:${string(s.spanId)}`;
          spans.set(key, {key, parent: `${traceId}:${string(s.parentSpanId)}`, name: string(s.name), start, end,
            attrs: attributes(s.attributes), error: [2, 'STATUS_CODE_ERROR'].includes(object(s.status).code as string | number)});
        }
      }
    }
    for (const resource of array(row.data.resourceLogs)) {
      for (const scope of array(object(resource).scopeLogs)) {
        for (const entry of array(object(scope).logRecords)) {
          const log = object(entry);
          const attrs = attributes(log.attributes), at = ns(log.timeUnixNano) ?? BigInt(row.timestamp);
          const key = `${attrs['session.id']}:${attrs['event.sequence']}:${attrs['event.name']}:${at}`;
          if (!seenLogs.has(key)) {logs.push({at, attrs}); seenLogs.add(key);}
        }
      }
    }
  }
  const ordered = [...spans.values()].sort((a, b) => compareTime(a.start, b.start));
  hooks.sort((a, b) => compareTime(a.at, b.at));
  const defaultSession = string(hooks.find(h => h.event.session_id)?.event.session_id) ||
    string(ordered.find(s => s.attrs['session.id'])?.attrs['session.id']);
  if (!defaultSession) throw new Error('No Claude session identity was captured');
  const scopes = new Map<string, Scope>();
  function getScope(session = defaultSession, agent = ''): Scope {
    const key = agent ? `${session}/${agent}` : session;
    let value = scopes.get(key);
    if (!value) {
      value = {key, session, agent, start: agent ? last : first, end: agent ? first : last,
        root: uuid(`capture:${key}`), attrs: {harness: 'claude-code', schema_version: 1, recorder_version: 'claude-prototype-1',
          session_id: key, native_session_id: session, ...(agent ? {agent_id: agent, parent_session: session, child_role: 'subagent'} : {}),
          timing: 'native-otel', ...(processEnd && processEnd.data.dropped === 0 ? {} : {incomplete: true})}};
      scopes.set(key, value);
    }
    return value;
  }
  getScope();
  function spanScope(s: Span): Scope {
    let cursor: Span | undefined = s;
    const seen = new Set<string>();
    let agent = '';
    while (cursor && !seen.has(cursor.key)) {
      seen.add(cursor.key);
      agent = string(cursor.attrs.agent_id);
      if (agent) break;
      cursor = spans.get(cursor.parent);
    }
    const scope = getScope(string(s.attrs['session.id']) || defaultSession, agent);
    if (s.start < scope.start) scope.start = s.start;
    if (s.end > scope.end) scope.end = s.end;
    const parentAgent = string(s.attrs.parent_agent_id);
    if (parentAgent) scope.attrs.parent_session = getScope(scope.session, parentAgent).key;
    return scope;
  }
  const slices: Slice[] = [];
  const mapped = new Map<string, Slice>();
  const preflight = new Map<string, Hook>();
  for (const h of hooks) {
    if (h.event.hook_event_name === 'PreToolUse') preflight.set(`${h.event.session_id}:${h.event.tool_use_id}`, h);
    if (h.event.hook_event_name === 'SubagentStart') {
      const scope = getScope(string(h.event.session_id), string(h.event.agent_id));
      if (h.at < scope.start) scope.start = h.at;
      if (h.at > scope.end) scope.end = h.at;
      if (h.event.agent_type) scope.attrs.child_role = string(h.event.agent_type);
    }
  }
  const add = (id: string, scope: Scope, track: string, name: string, start: bigint, end: bigint | undefined, attrs: Attrs): Slice => {
    const slice = {id, scope: scope.key, track, name, start, end, attrs, flows: []};
    slices.push(slice);
    return slice;
  };
  const edge = (from: Slice, to: Slice) => {
    if (to.start < from.start) return;
    const id = uuid(`flow:${from.id}:${to.id}`);
    from.flows.push(id); to.flows.push(id);
  };
  let responses = 0, tools = 0;
  for (const s of ordered) {
    const scope = spanScope(s);
    if (s.name === 'claude_code.interaction') {
      const prompt = add(s.key, scope, 'Session', 'prompt', s.start, s.end,
        {kind: 'prompt', ...promptAnnotations(s.attrs.user_prompt, true)});
      mapped.set(s.key, prompt);
      const input = add(`${s.key}:input`, scope, 'Inputs', 'prompt-input', s.start, undefined, {source: 'user', timing: 'interaction-start'});
      edge(input, prompt);
    } else if (s.name === 'claude_code.llm_request') {
      const attrs: Attrs = {kind: s.attrs.success === false || s.error ? 'provider-request' : 'assistant-message',
        provider: string(s.attrs['gen_ai.system']) || 'anthropic', timing: 'request-including-retries', is_error: s.error || s.attrs.success === false};
      for (const key of ['model', 'effort', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'stop_reason', 'attempt', 'error', 'status_code', 'query_source']) {
        if (s.attrs[key] !== undefined) attrs[key] = s.attrs[key]!;
      }
      if (s.attrs.cache_creation_tokens !== undefined) attrs.cache_write_tokens = s.attrs.cache_creation_tokens;
      if (typeof s.attrs.ttft_ms === 'number') attrs.ttft_ns = Math.round(s.attrs.ttft_ms * 1e6);
      // Older clients' ttft_ms has a different boundary from first content.
      if (typeof s.attrs.first_content_ms === 'number') attrs.first_content_ns = Math.round(s.attrs.first_content_ms * 1e6);
      const response = add(s.key, scope, attrs.kind === 'assistant-message' ? 'Responses' : 'Requests',
        attrs.kind === 'assistant-message' ? 'response' : 'request', s.start, s.end, attrs);
      mapped.set(s.key, response);
      if (attrs.kind === 'assistant-message') {
        responses++;
        add(`${s.key}:turn`, scope, 'Turns', 'turn', s.start, s.end, {kind: 'turn'});
      }
      if (attrs.model && !scope.attrs.model) scope.attrs.model = attrs.model;
      if (attrs.provider) scope.attrs.provider = attrs.provider;
      if (attrs.effort) scope.attrs.effort = attrs.effort;
    } else if (s.name === 'claude_code.tool.execution') {
      const parent = spans.get(s.parent);
      const callId = string(s.attrs.tool_use_id ?? parent?.attrs.tool_use_id);
      const hook = preflight.get(`${scope.session}:${callId}`);
      const name = string(parent?.attrs.tool_name) || string(hook?.event.tool_name) || 'tool';
      const args = toolArgumentAnnotations(hook?.event.tool_input, true);
      if (args.truncated !== undefined) {args.args_truncated = args.truncated; delete args.truncated;}
      const description = object(hook?.event.tool_input).description;
      const tool = add(s.key, scope, 'Tools', name, s.start, s.end,
        {kind: 'tool-execution', call_id: callId, is_error: s.error || s.attrs.success === false, ...args,
          ...(typeof description === 'string' ? {intent: description} : {})});
      mapped.set(s.key, tool);
      if (parent) mapped.set(parent.key, tool);
      tools++;
    } else if (s.name === 'claude_code.tool.blocked_on_user') {
      add(s.key, scope, 'Permissions', 'permission', s.start, s.end,
        {kind: 'permission', ...(s.attrs.decision ? {decision: s.attrs.decision} : {})});
    }
  }
  // Compaction can emit a stop hook for an internal worker with no recorded
  // start or native spans. A stop alone does not establish an agent session.
  for (const h of hooks.filter(h => h.event.hook_event_name === 'SubagentStop')) {
    const scope = scopes.get(`${h.event.session_id}/${h.event.agent_id}`);
    if (!scope) continue;
    if (h.at > scope.end) scope.end = h.at;
    if (h.event.agent_type) scope.attrs.child_role = string(h.event.agent_type);
  }
  // Preserve tools observed at shutdown even when their native end span was lost.
  let missingToolSpans = 0;
  for (const h of preflight.values()) {
    const scope = getScope(string(h.event.session_id), string(h.event.agent_id));
    const callId = string(h.event.tool_use_id);
    if (slices.some(s => s.attrs.kind === 'tool-execution' && s.attrs.call_id === callId && scopes.get(s.scope)?.session === scope.session)) continue;
    missingToolSpans++;
    const terminal = hooks.find(end => end.event.session_id === scope.session && end.event.tool_use_id === callId &&
      ['PostToolUse', 'PostToolUseFailure'].includes(string(end.event.hook_event_name)));
    const observedEnd = terminal?.at ?? last;
    add(`unmeasured:${scope.key}:${callId}`, scope, 'Tools', string(h.event.tool_name) || 'tool', h.at, observedEnd,
      {kind: 'tool-execution', call_id: callId, incomplete: true, timing: 'hook-observation',
        reason: 'native_execution_span_not_received', ...toolArgumentAnnotations(h.event.tool_input, true)});
    if (h.at < scope.start) scope.start = h.at;
    if (observedEnd > scope.end) scope.end = observedEnd;
  }
  // Native parent span IDs establish causality without guessing from overlap.
  for (const s of ordered) {
    const child = mapped.get(s.key);
    if (!child) continue;
    let ancestor = spans.get(s.parent);
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.key)) {
      seen.add(ancestor.key);
      const parent = mapped.get(ancestor.key);
      if (parent && parent !== child) {edge(parent, child); break;}
      ancestor = spans.get(ancestor.parent);
    }
  }
  // Each logical agent gets its own capture beneath the real Claude process.
  for (const scope of scopes.values()) {
    if (!scope.agent || scope.end < scope.start) continue;
    const childWork = slices.filter(s => s.scope === scope.key && s.end !== undefined).sort((a, b) => compareTime(a.start, b.start));
    const input = add(`input:${scope.key}`, scope, 'Inputs', 'prompt-input', scope.start, undefined, {source: 'agent'});
    const prompt = add(`prompt:${scope.key}`, scope, 'Session', 'prompt', scope.start, scope.end, {kind: 'prompt'});
    edge(input, prompt);
    const firstChild = childWork[0];
    if (firstChild) edge(prompt, firstChild);
    const firstNative = ordered.find(native => mapped.get(native.key)?.scope === scope.key);
    let ancestor = firstNative ? spans.get(firstNative.parent) : undefined;
    let launch: Slice | undefined;
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.key)) {
      seen.add(ancestor.key);
      const candidate = mapped.get(ancestor.key);
      if (candidate?.scope !== scope.key && candidate?.attrs.kind === 'tool-execution') {launch = candidate; break;}
      ancestor = spans.get(ancestor.parent);
    }
    if (launch) {
      launch.attrs.delegation = true; launch.attrs.child_session = scope.key;
      scope.attrs.parent_session = launch.scope;
      const h = preflight.get(`${scopes.get(launch.scope)!.session}:${launch.attrs.call_id}`);
      Object.assign(prompt.attrs, promptAnnotations(object(h?.event.tool_input).prompt, true));
      edge(launch, input);
    }
  }
  for (const log of logs) {
    const duration = measurement(log.attrs.duration_ms);
    if (log.attrs['event.name'] !== 'compaction' || duration === undefined) continue;
    const scope = getScope(string(log.attrs['session.id']) || defaultSession, string(log.attrs.agent_id));
    const attrs: Attrs = {kind: 'compaction', timing: 'native-duration'};
    for (const key of ['trigger', 'success', 'error']) if (log.attrs[key] !== undefined) attrs[key] = log.attrs[key]!;
    for (const key of ['pre_tokens', 'post_tokens']) {
      const count = integer(measurement(log.attrs[key]));
      if (count !== undefined) attrs[key] = count;
    }
    if (attrs.success === 'true' || attrs.success === 'false') attrs.success = attrs.success === 'true';
    attrs.is_error = log.attrs.success === false || log.attrs.success === 'false';
    add(`compact:${scope.key}:${log.at}`, scope, 'Compaction', 'compact', log.at - BigInt(Math.round(duration * 1e6)), log.at, attrs);
  }
  for (const response of slices.filter(s => s.attrs.kind === 'assistant-message')) {
    const compaction = slices.find(s => s.scope === response.scope && s.attrs.kind === 'compaction' &&
      s.start <= response.start && s.end! >= response.end!);
    if (!compaction && response.attrs.query_source !== 'compact') continue;
    response.attrs.kind = 'provider-request';
    response.attrs.phase = 'compaction';
    response.name = 'request'; response.track = 'Requests'; responses--;
    const turn = slices.find(s => s.id === `${response.id}:turn`);
    if (turn) {turn.attrs.kind = 'compaction-step'; turn.name = 'summarize';}
  }

  const packets: Uint8Array[] = [];
  const packet = (data: {trackDescriptor?: Uint8Array; trackEvent?: Uint8Array; clockSnapshot?: Uint8Array}, at = first) =>
    packets.push(framePacket(buildTracePacket({seqId, machineId, timestampNs: at, clockId: CLOCK_REALTIME, ...data})));
  for (const snapshot of clockSnapshots) {
    const realtime = ns(snapshot.data.realtimeNs), boot = ns(snapshot.data.boottimeNs);
    if (realtime === undefined || boot === undefined) throw new Error('Invalid captured clock snapshot');
    packets.push(framePacket(buildTracePacket({seqId, machineId, clockSnapshot: buildClockSnapshot([
      {clockId: CLOCK_REALTIME, timestampNs: realtime}, {clockId: CLOCK_BOOTTIME, timestampNs: boot},
    ], CLOCK_REALTIME)})));
  }
  const processUuid = uuid('process');
  packet({trackDescriptor: buildTrackDescriptor({uuid: processUuid, process: {pid: processStart.data.pid as number,
    processName: 'claude', labels: ['Claude Code']}})});
  const events: {at: bigint; rank: number; event: Uint8Array}[] = [];
  const event = (at: bigint, rank: number, trackUuid: bigint, type: number, name?: string, attrs?: Attrs, flows?: bigint[], counterValue?: bigint) => {
    events.push({at, rank, event: buildTrackEvent({trackUuid, type, name, categories: type === TRACK_EVENT_END ? [] :
      [name?.startsWith('profile (') || name === 'run-configuration' ? 'claude.metadata' : 'claude.activity'],
      debugAnnotations: attrs, flowIds: flows, counterValue})});
  };
  for (const scope of scopes.values()) {
    if (scope.end < scope.start) continue;
    packet({trackDescriptor: buildTrackDescriptor({uuid: scope.root, parentUuid: processUuid, name: 'agentprof.capture', siblingMergeBehavior: SIBLING_MERGE_NONE})});
    const sessionTrack = uuid(`${scope.key}:profile`);
    packet({trackDescriptor: buildTrackDescriptor({uuid: sessionTrack, parentUuid: scope.root, name: 'Session'})});
    const model = string(scope.attrs.model), limit = limits.get(model);
    if (limit) scope.attrs.context_window_tokens = limit;
    event(scope.start, -3, sessionTrack, TRACK_EVENT_BEGIN, 'profile (1)', {...scope.attrs, kind: 'capture', capture_id: scope.root.toString(16)});
    event(scope.end, 3, sessionTrack, TRACK_EVENT_END, undefined, {...(processEnd ? {stop_reason: 'process-exit'} : {incomplete: true})});
    const grouped = new Map<string, Slice[]>();
    const configurations = slices.filter(s => s.scope === scope.key && ['assistant-message', 'provider-request'].includes(string(s.attrs.kind)))
      .sort((a, b) => compareTime(a.start, b.start));
    let previousConfig = '';
    let openConfig: Slice | undefined;
    for (const request of configurations) {
      const attrs: Attrs = {harness: 'claude-code'};
      for (const key of ['provider', 'model', 'effort']) if (request.attrs[key] !== undefined) attrs[key] = request.attrs[key]!;
      const requestLimit = limits.get(string(attrs.model));
      if (requestLimit) attrs.context_window_tokens = requestLimit;
      const config = JSON.stringify(attrs);
      if (config === previousConfig) continue;
      if (openConfig) openConfig.end = request.start;
      openConfig = add(`config:${request.id}`, scope, 'Configuration', 'run-configuration', request.start, scope.end, attrs);
      previousConfig = config;
    }
    for (const s of slices.filter(s => s.scope === scope.key)) {
      const group = grouped.get(s.track) ?? []; group.push(s); grouped.set(s.track, group);
    }
    for (const [name, group] of grouped) {
      const lanes: bigint[] = [], ends: bigint[] = [];
      for (const s of group.sort((a, b) => compareTime(a.start, b.start))) {
        let lane = ends.findIndex(end => end <= s.start);
        if (lane < 0) {
          lane = lanes.length;
          const id = uuid(`${scope.key}:${name}:${lane}`); lanes.push(id);
          packet({trackDescriptor: buildTrackDescriptor({uuid: id, parentUuid: scope.root, name, siblingMergeBehavior: SIBLING_MERGE_BY_TRACK_NAME})});
        }
        ends[lane] = s.end === s.start ? s.start + 1n : s.end ?? s.start;
        event(s.start, s.end === undefined ? -1 : 0, lanes[lane]!, s.end === undefined ? TRACK_EVENT_INSTANT : TRACK_EVENT_BEGIN, s.name, s.attrs, [...new Set(s.flows)]);
        if (s.end !== undefined) event(s.end, s.end === s.start ? 1 : -2, lanes[lane]!, TRACK_EVENT_END);
      }
    }
    const responsesForScope = slices.filter(s => s.scope === scope.key && s.attrs.timing === 'request-including-retries').sort((a, b) => compareTime(a.end!, b.end!));
    for (const [name, field] of [['Input tokens', 'input_tokens'], ['Output tokens', 'output_tokens'], ['Context size', 'context'], ['Context window', 'limit']] as const) {
      const samples: {at: bigint; value: number}[] = [];
      let total = 0;
      if (field === 'limit' && limit) samples.push({at: scope.start, value: limit});
      for (const response of responsesForScope) {
        if (field === 'limit') {
          const responseLimit = limits.get(string(response.attrs.model));
          if (responseLimit !== undefined || samples.length) samples.push({at: response.start, value: responseLimit ?? 0});
          continue;
        }
        if (field === 'context') {
          const parts = ['input_tokens', 'cache_read_tokens', 'cache_write_tokens'].map(k => integer(response.attrs[k]));
          if (parts.every(v => v !== undefined)) samples.push({at: response.start, value: parts.reduce<number>((sum, v) => sum + v!, 0)});
        } else {
          const value = integer(response.attrs[field]);
          if (value !== undefined) {total += value; samples.push({at: response.end!, value: total});}
        }
      }
      if (field === 'context') {
        for (const compact of slices.filter(s => s.scope === scope.key && s.attrs.kind === 'compaction')) {
          const before = integer(compact.attrs.pre_tokens), after = integer(compact.attrs.post_tokens);
          if (before !== undefined) samples.push({at: compact.start, value: before});
          if (after !== undefined) samples.push({at: compact.end!, value: after});
          else if (compact.attrs.success === true) samples.push({at: compact.end!, value: 0});
        }
      }
      if (!samples.length) continue;
      const id = uuid(`${scope.key}:counter:${name}`);
      packet({trackDescriptor: buildTrackDescriptor({uuid: id, parentUuid: scope.root, name,
        counter: {unit: 0, unitName: 'tokens', ...(['context', 'limit'].includes(field) ? {yAxisShareKey: 'llm.context.tokens'} : {})}})});
      event(scope.start, -2, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, 0n);
      for (const sample of samples.sort((a, b) => compareTime(a.at, b.at))) event(sample.at, 1, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, BigInt(sample.value));
      event(scope.end, 2, id, TRACK_EVENT_COUNTER, undefined, undefined, undefined, 0n);
    }
  }
  events.sort((a, b) => compareTime(a.at, b.at) || a.rank - b.rank);
  for (const e of events) packet({trackEvent: e.event}, e.at);
  return {trace: Buffer.concat(packets), summary: {sessions: scopes.size, responses, tools, nativeSpans: spans.size, hooks: hooks.length,
    dropped: processEnd?.data.dropped ?? null, processExitCode: processEnd?.data.code ?? null, missingToolSpans,
    compactions: slices.filter(s => s.attrs.kind === 'compaction').length,
    limitations: ['Native request timing includes retries.', 'Context size is measured request input, not a live estimate.',
      'Runtime CPU and heap sampling are not included.']}};
}
