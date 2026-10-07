// SPDX-License-Identifier: Apache-2.0
import {attachContext} from '../agent-tracing/context.ts';
import {ContextTracker, estimateContextTokens, type ContextItem} from '../pi-tracing/extensions/pi-tracing/context.ts';
import {writeTrace, compareTime, type Attrs, type Slice, type Session, type Counter} from '../agent-tracing/trace.ts';
import {fnv1a64} from '../pi-tracing/extensions/pi-tracing/machine.ts';
import {promptAnnotations, toolArgumentAnnotations} from '../pi-tracing/extensions/pi-tracing/annotations.ts';
import {integer, object, string, type NativeSession} from './native.ts';

export interface Capture {
  id: string; session: string; pid: number; machineId: number; start: string; end: string;
  clocks: {realtimeNs: string; boottimeNs: string}[];
  catalog: {model: string; provider: string; context: number}[];
  hooks: {at: string; session: string; event: string; model?: string; provider?: string; effort?: string; trigger?: string}[];
  incomplete?: boolean;
  capture_contents?: boolean;
}
const min = (a: bigint, b: bigint) => a < b ? a : b;
const max = (a: bigint, b: bigint) => a > b ? a : b;
export const controlPrompt = (text: string) => /^(?:\/)?tracing (?:start(?:[ \t]+[^\r\n]+)?|stop|status)$/.test(text.trim());
export const controlTool = (text: string) => /(?:^|[._:/-])tracing_(start|stop|status)$/.test(text);

export function convert(capture: Capture, native: NativeSession[]) {
  const first = BigInt(capture.start), last = BigInt(capture.end);
  const captureContents = capture.capture_contents !== false;
  if (last < first) throw new Error('Recording end precedes start');
  const sessions: Session[] = [], slices: Slice[] = [], counters: Counter[] = [];
  const inputs = new Map<string, Slice>(), delegates: {slice: Slice; child: string}[] = [];
  const add = (session: string, id: string, track: string, name: string, start: bigint, end: bigint | undefined, attrs: Attrs): Slice | undefined => {
    if (start > last || (end ?? start) < first) return;
    const partial = start < first || (end !== undefined && end > last);
    const s: Slice = {session, id: `${session}:${id}`, track, name, start: max(first, start),
      ...(end !== undefined ? {end: min(last, max(start, end))} : {}), attrs: {...attrs, ...(partial ? {incomplete: true} : {})}, flows: []};
    slices.push(s); return s;
  };
  const edge = (a: Slice | undefined, b: Slice | undefined) => {
    if (!a || !b || b.start < a.start) return;
    const flow = fnv1a64(`${capture.id}:${a.id}:${b.id}`) || 1n;
    a.flows.push(flow); b.flows.push(flow);
  };
  for (const source of native) {
    const records = source.records, id = source.id;
    if (!records.some(r => BigInt(r.at) >= first && BigInt(r.at) <= last) && id !== capture.session) continue;
    const metadata = records.find(r => r.kind === 'metadata')?.data ?? {};
    const start = id === capture.session ? first : max(first, BigInt(records[0]?.at ?? capture.start));
    const end = id === capture.session ? last : min(last, BigInt(records.at(-1)?.at ?? capture.end));
    const session: Session = {id, start, end: max(start, end), attrs: {harness: 'muse', recorder_version: 'muse-plugin-1',
      timing: 'native-export', model: string(metadata.model_id), provider: string(metadata.provider_id),
      harness_version: string(metadata.build?.semver),
      ...(source.parent ? {parent_session: source.parent, child_role: source.role ?? 'subagent'} : {}),
      ...(capture.incomplete || source.diagnostics.gaps || source.diagnostics.unparseable_lines ? {incomplete: true} : {}),
      export_gaps: source.diagnostics.gaps ?? 0, omitted_live_only: source.diagnostics.omitted_live_only ?? 0,
      unavailable_child_sessions: source.missingChildren.length}};
    sessions.push(session);
    const prompts = new Map<string, Slice>(), calls = new Map<string, any>(), tools = new Map<string, Slice>();
    const tasks = new Map<string, {start: bigint; end?: bigint; kind: string; run: string; call?: string; operation?: string; error?: boolean}>();
    const emittedTasks = new Set<string>();
    const results = new Map<string, {exit_code?: number; terminal_status?: string}>();
    const configuration = (at: bigint, model?: string) => {
      const hook = capture.hooks.findLast(h => h.session === id && h.event === 'PreLLMCall' && BigInt(h.at) <= at);
      const run = records.findLast(r => r.kind === 'run_model' && BigInt(r.at) <= at);
      const name = model || hook?.model || string(run?.data.model_id) || string(session.attrs.model);
      const provider = hook?.provider || string(run?.data.provider_id) || string(session.attrs.provider);
      const limit = capture.catalog.find(m => m.model === name && m.provider === provider)?.context;
      return {model: name, provider, ...(hook?.effort ? {effort: hook.effort} : {}), ...(limit ? {context_window_tokens: limit} : {})};
    };
    Object.assign(session.attrs, configuration(start));
    const contextTracker = new ContextTracker();
    let contextItems: ContextItem[] = [];
    const compactEnds = capture.hooks.filter(h => h.session === id && h.event === 'PostCompact').map(h => BigInt(h.at)).sort(compareTime);
    let compactIndex = 0;
    let requestContext: {at: bigint; items: ContextItem[]; categories: Record<string, number>} | undefined;
    for (const r of records) {
      const d = r.data, at = BigInt(r.at);
      if (r.family === 'run' && r.kind === 'started' && !controlPrompt(string(d.prompt))) {
        const terminal = records.find(n => n.run === r.run && n.family === 'run' && n.kind === 'terminal' && BigInt(n.at) >= at);
        const p = add(id, r.id, 'Session', 'prompt', at, terminal ? BigInt(terminal.at) : last,
          {kind: 'prompt', turn_id: r.run, ...promptAnnotations(d.prompt, captureContents),
            ...(integer(d.prompt_length) !== undefined ? {length: d.prompt_length} : {}), ...(!terminal ? {incomplete: true} : {}),
            ...(terminal?.data.terminal && terminal.data.terminal !== 'completed' ? {outcome: string(terminal.data.terminal)} : {})});
        if (p) {
          prompts.set(r.run, p);
          const input = add(id, `${r.id}:input`, 'Inputs', 'prompt-input', at, undefined, {source: source.parent ? 'agent' : 'user'});
          edge(input, p); if (input && !inputs.has(id)) inputs.set(id, input);
        }
      }
      if (r.kind === 'assistant_tool_calls_committed') for (const call of d.tool_calls ?? []) calls.set(string(call.call_id), {...call, at, run: r.run});
      if (r.kind === 'tool_result_batch_committed') for (const result of d.results ?? []) results.set(result.call_id, result);
      if (r.family === 'task') {
        const task = tasks.get(r.task) ?? {start: at, kind: '', run: r.run}; tasks.set(r.task, task);
        if (r.kind === 'proposed') task.kind = string(d.task_kind);
        if (r.kind === 'side_effect_intent') {
          task.operation = string(d.operation);
          if (string(d.idempotency_key).startsWith('tool:')) task.call = string(d.idempotency_key).slice(5);
        }
        if (r.kind === 'started') task.start = at;
        if (['completed', 'failed', 'cancelled'].includes(r.kind)) {task.end = at; task.error = r.kind !== 'completed';}
      }
    }
    const responses: Slice[] = [];
    for (const r of records) {
      const d = r.data, at = BigInt(r.at);
      while (compactIndex < compactEnds.length && compactEnds[compactIndex]! <= at) {
        // The exported journal does not expose the replacement summary. Start a
        // partial baseline instead of asserting an empty post-compaction context.
        contextItems = []; requestContext = undefined; contextTracker.reset(); compactIndex++;
      }
      // Native journal contents are observable, but may differ from the final request.
      if (r.kind === 'assistant_message_committed' && integer(d.context_tokens) !== undefined) contextItems.push({
        id: string(d.message_id) || r.id, category: 'assistant', tokens: d.context_tokens, chars: d.context_chars,
        label: 'Assistant history', source_kind: 'response'});
      if (r.kind === 'model_input_trace_recorded' && Array.isArray(d.aggregates)) {
        const categories: Record<string, number> = {};
        for (const a of d.aggregates) {
          const bytes = integer(a.bytes); if (bytes === undefined || !bytes) continue;
          const key = a.lane === 'system_base' ? 'system' : a.lane === 'tool_result' ? 'results'
            : a.lane === 'tool_specs' ? 'tools' : a.source === 'current_user' ? 'prompts'
            : a.lane === 'history' && a.destination === 'message.role:assistant' ? 'assistant'
            : a.lane === 'history' ? 'messages' : 'unattributed';
          categories[key] = (categories[key] ?? 0) + Math.ceil(bytes / 4);
        }
        if (integer(d.omitted_bytes)) categories.unattributed = (categories.unattributed ?? 0) + Math.ceil(d.omitted_bytes / 4);
        requestContext = {at, items: [...contextItems], categories};
      }
      if (r.family === 'run' && r.kind === 'started' && !controlPrompt(string(d.prompt))) {
        const chars = integer(d.prompt_length) ?? string(d.prompt).length;
        contextItems.push({id: r.id, category: 'prompts', chars, tokens: estimateContextTokens(chars), source_kind: 'prompt', label: 'User prompt'});
      }
      if (r.kind === 'tool_result_batch_committed') for (const result of d.results ?? []) {
        const n = integer(result.context_tokens); if (n !== undefined) contextItems.push({id: `result:${result.call_id}`, category: 'results',
          tokens: n, chars: integer(result.context_chars), source_id: string(result.call_id), source_kind: 'tool', label: 'Tool result'});
      }
      if (r.kind === 'assistant_tool_calls_committed') for (const call of d.tool_calls ?? []) {
        const chars = !captureContents && integer(call.args_meta?.bytes) !== undefined ? call.args_meta.bytes :
          typeof call.args === 'string' ? call.args.length : JSON.stringify(call.args ?? {}).length;
        contextItems.push({id: `call:${call.call_id}`, category: 'assistant', chars, tokens: estimateContextTokens(chars), source_kind: 'tool', source_id: string(call.call_id), label: 'Tool arguments'});
      }

      if (r.kind === 'model_completed') {
        const duration = integer(d.duration_ms), begin = duration !== undefined ? at - BigInt(duration) * 1000000n : at;
        const compaction = capture.hooks.some(h => h.session === id && h.event === 'PreCompact' && BigInt(h.at) <= begin &&
          at <= BigInt(capture.hooks.find(n => n.session === id && n.event === 'PostCompact' && BigInt(n.at) >= BigInt(h.at))?.at ?? capture.end));
        const attrs: Attrs = {kind: compaction ? 'compaction-response' : 'assistant-message', ...configuration(at, string(d.model)),
          timing: duration === undefined ? 'unmeasured' : 'native-duration', stop_reason: string(d.finish_reason)};
        const usage = object(d.usage);
        if (begin >= first && at <= last) {
          for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens']) {
            const value = integer(usage[key]); if (value !== undefined) attrs[key] = value;
          }
          if (attrs.cache_read_tokens === undefined && integer(usage.cached_tokens) !== undefined) attrs.cache_read_tokens = usage.cached_tokens;
          if (attrs.input_tokens !== undefined) {attrs.context_tokens = attrs.input_tokens; attrs.context_source = 'reported-input';}
        }
        if (duration === undefined) attrs.incomplete = true;
        const response = add(id, r.id, compaction ? 'Compaction responses' : 'Responses', 'response', begin, at, attrs);
        if (response) {
          responses.push(response); edge(prompts.get(r.run), response);
          if (!compaction && (requestContext || contextItems.length)) {
            const snapshot = contextTracker.snapshot(requestContext?.items ?? contextItems,
              {stage: requestContext ? 'request-input' : 'transcript-observed', basis: requestContext ? 'native-bytes/4' : 'chars/4',
                ...(requestContext ? {categories: requestContext.categories, item_stage: 'transcript-observed', reported_tokens: integer(attrs.context_tokens)} : {}),
                coverage: 'partial', model: string(attrs.model), window_tokens: integer(attrs.context_window_tokens)});
            attachContext(response, snapshot, counters, requestContext ? max(response.start, requestContext.at) : at);
          }
          if (!compaction) add(id, `${r.id}:turn`, 'Turns', 'turn', begin, at, {kind: 'turn'});
        }
        requestContext = undefined;
      }
      if (r.kind === 'tool_batch_effect' && d.kind === 'started') {
        emittedTasks.add(string(d.task_id));
        const call = calls.get(string(d.call_id)), name = string(d.tool_name) || string(call?.name) || 'tool';
        if (controlTool(name)) continue;
        const terminal = records.find(n => n.kind === 'tool_batch_effect' && n.data.kind === 'terminal' && n.data.call_id === d.call_id);
        const outcome = object(terminal?.data.outcome), task = tasks.get(string(d.task_id));
        const result = ['bash', 'bash_input'].includes(name) ? results.get(string(d.call_id)) : undefined;
        const incomplete = !terminal, failed = task?.error || (terminal && outcome.kind !== 'completed') ||
          (result?.exit_code !== undefined && result.exit_code !== 0);
        let args: unknown = call?.args;
        try {if (typeof args === 'string') args = JSON.parse(args);} catch {}
        const tool = add(id, r.id, 'Tools', name, task?.start ?? at, terminal ? BigInt(terminal.at) : last,
          {kind: 'tool-execution', name, call_id: string(d.call_id),
            ...(call?.args_meta ?? toolArgumentAnnotations(args, captureContents)),
            ...(captureContents && typeof object(args).description === 'string' ? {intent: string(object(args).description).slice(0, 1024)} : {}),
            ...(result?.exit_code !== undefined ? {exit_code: result.exit_code, outcome: result.terminal_status!} : {}),
            ...(incomplete ? {incomplete: true} : {is_error: Boolean(failed)}),
            ...(!result && outcome.kind ? {outcome: string(outcome.kind)} : {})});
        if (tool) {tools.set(string(d.call_id), tool); edge(responses.findLast(s => s.end! <= tool.start), tool);}
      }
      if (d.child_session_id && at <= last) {
        const task = tasks.get(r.task);
        const s = add(id, r.id, 'Delegates', 'delegate', task?.start ?? at, task?.end ?? last,
          {kind: 'child-operation', child_session: string(d.child_session_id), role: string(d.role), ...(!task?.end ? {incomplete: true} : {})});
        if (s) {delegates.push({slice: s, child: string(d.child_session_id)}); edge(prompts.get(r.run), s);}
      }
    }
    // Internal decision tools can have task lifecycle records without a
    // tool-batch effect. Prefer the explicit call ID; a unique same-run call
    // supplies arguments when this Muse version omits that ID from the task.
    for (const [key, task] of tasks) if (task.kind.startsWith('tool.') && !emittedTasks.has(key)) {
      const name = task.kind.slice(5); if (controlTool(name)) continue;
      const candidates = [...calls.values()].filter(c => c.name === name && c.run === task.run && c.at <= task.start && !tools.has(c.call_id));
      const call = task.call ? calls.get(task.call) : candidates.length === 1 ? candidates[0] : undefined;
      let args = call?.args; try {if (typeof args === 'string') args = JSON.parse(args);} catch {}
      const tool = add(id, key, 'Tools', name, task.start, task.end ?? last,
        {kind: 'tool-execution', name, ...(call ? {call_id: string(call.call_id),
          ...(call.args_meta ?? toolArgumentAnnotations(args, captureContents))} : {}),
          ...(task.end ? {is_error: Boolean(task.error)} : {incomplete: true})});
      if (tool) {if (call) tools.set(call.call_id, tool); edge(responses.findLast(s => s.end! <= tool.start), tool);}
    }
    // A request with no completion is visible, but never receives invented usage.
    for (const [key, task] of tasks) if (task.kind.startsWith('model.') && !responses.some(r => r.start >= task.start && r.start <= (task.end ?? last))) {
      add(id, key, 'Requests', 'request', task.start, task.end ?? last,
        {kind: 'provider-request', incomplete: true, ...(task.error ? {is_error: true} : {})});
    }
    for (const h of capture.hooks.filter(h => h.session === id && h.event === 'PreCompact')) {
      const end = capture.hooks.find(n => n.session === id && n.event === 'PostCompact' && BigInt(n.at) >= BigInt(h.at));
      add(id, `compact:${h.at}`, 'Compaction', 'compaction', BigInt(h.at), BigInt(end?.at ?? capture.end),
        {kind: 'compaction', trigger: h.trigger ?? 'unknown', ...(!end ? {incomplete: true} : {})});
    }
    responses.sort((a, b) => compareTime(a.end!, b.end!));
    for (const [name, key, cumulative] of [['Input tokens', 'input_tokens', true], ['Output tokens', 'output_tokens', true],
      ['Context size', 'context_tokens', false], ['Context window', 'context_window_tokens', false]] as const) {
      let total = 0;
      const samples = responses.flatMap(s => {
        const value = integer(s.attrs[key]); if (value === undefined) return [];
        total = cumulative ? total + value : value; return [{at: s.end!, value: total}];
      });
      counters.push({session: id, name, unit: 'tokens', ...(!cumulative ? {axis: 'llm.context.tokens'} : {}), samples});
    }
    const peak = Math.max(0, ...responses.map(r => Number(r.attrs.context_tokens ?? 0)));
    if (responses.some(r => r.attrs.context_tokens !== undefined)) session.attrs.peak_context_tokens = peak;
    let previous = '';
    for (const r of responses) {
      const attrs = {kind: 'configuration', harness: 'muse', model: r.attrs.model!, provider: r.attrs.provider!,
        ...(r.attrs.effort ? {effort: r.attrs.effort} : {}),
        ...(r.attrs.context_window_tokens ? {context_window_tokens: r.attrs.context_window_tokens} : {})};
      const text = JSON.stringify(attrs); if (text === previous) continue; previous = text;
      add(id, `${r.id}:configuration`, 'Configuration', 'run-configuration', r.start, r.start, attrs);
    }
  }
  for (const {slice, child} of delegates) edge(slice, inputs.get(child));
  const trace = writeTrace({capture: capture.id, pid: capture.pid, machineId: capture.machineId,
    processName: 'muse', processLabel: 'Muse Code', category: 'muse', sessions, slices, counters,
    clocks: capture.clocks.map(c => ({realtimeNs: BigInt(c.realtimeNs), boottimeNs: BigInt(c.boottimeNs)}))});
  const messages = slices.filter(s => s.attrs.kind === 'assistant-message');
  return {trace, summary: {sessions: sessions.length, responses: messages.length,
    tools: slices.filter(s => s.attrs.kind === 'tool-execution').length,
    inputTokens: messages.reduce((n, s) => n + Number(s.attrs.input_tokens ?? 0), 0),
    outputTokens: messages.reduce((n, s) => n + Number(s.attrs.output_tokens ?? 0), 0),
    unavailableChildren: native.reduce((n, s) => n + s.missingChildren.length, 0)}};
}
