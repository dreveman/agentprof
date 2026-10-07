// SPDX-License-Identifier: Apache-2.0
import {object, string, integer, type Span, type Log} from './otel.ts';
import type {Observation, Slice, Attrs} from '../agent-tracing/trace.ts';
import {toolArgumentAnnotations} from '../pi-tracing/extensions/pi-tracing/annotations.ts';

export const isControl = (name: string) => /(?:^|__)tracing_(?:start|stop|status)$/.test(name);
export const isControlScript = (source: string) => {
  const calls = [...source.matchAll(/\btools\.([\w]+)\s*\(/g)];
  return calls.length > 0 && calls.every(call => isControl(call[1]!));
};
export function addHooks(rows: Observation[], spans: Map<string, Span>, logs: Log[], first: bigint, last: bigint, captureContents = true): Slice[] {
  const extra: Slice[] = [], tools = new Map<string, Slice>(), compactions = new Map<string, Slice>();
  const hooks = rows.filter(row => row.source === 'codex.hook');
  for (const control of rows.filter(row => row.source === 'codex.control')) {
    for (const [key, span] of spans) {
      if (span.name === 'session_task.turn' && control.data.turn_id && span.attrs['turn.id'] === control.data.turn_id &&
          (span.attrs['conversation.id'] ?? span.attrs['thread.id']) === control.data.session_id) spans.delete(key);
    }
    // Native prompt logs have no turn ID and precede UserPromptSubmit. Remove
    // only the closest preceding prompt for this intercepted control.
    const at = BigInt(control.timestamp);
    const candidates = logs.filter(log => log.attrs['event.name'] === 'codex.user_prompt' &&
      log.attrs['conversation.id'] === control.data.session_id && integer(log.attrs.prompt_length) === control.data.prompt_length &&
      log.at <= at && at - log.at < 2_000_000_000n);
    const prompt = candidates.reduce<Log | undefined>((nearest, log) => !nearest || log.at > nearest.at ? log : nearest, undefined);
    if (prompt) logs.splice(logs.indexOf(prompt), 1);
  }
  const prompts = hooks.filter(row => row.data.hook_event_name === 'UserPromptSubmit');
  // Prompts from hooks retain the original text without enabling unscoped
  // prompt export for every conversation using the Codex process.
  for (let i = logs.length - 1; i >= 0; i--) {
    const log = logs[i]!;
    if (log.attrs['event.name'] === 'codex.user_prompt' && prompts.some(row =>
      row.data.session_id === log.attrs['conversation.id'] &&
      (BigInt(row.timestamp) - log.at < 1_000_000_000n && log.at - BigInt(row.timestamp) < 1_000_000_000n))) logs.splice(i, 1);
  }
  for (const span of spans.values()) {
    if (span.start < first || span.end > last) span.attrs['capture.incomplete'] = true;
    if (span.end > last) span.attrs['capture.end_incomplete'] = true;
    span.start = span.start < first ? first : span.start;
    span.end = span.end > last ? last : span.end;
    if (span.end < span.start) spans.delete(span.key);
  }
  const turns = new Map<string, Span>();
  for (const row of hooks) {
    const data = row.data, id = string(data.session_id), event = string(data.hook_event_name);
    const at = BigInt(row.timestamp), turn = string(data.turn_id), key = `hook:${id}:${turn}`;
    const attrs: Attrs = {'conversation.id': id};
    const log = (name: string, fields: Attrs) => logs.push({key: `${key}:${logs.length}`, trace: key, span: '', at,
      attrs: {...attrs, 'event.name': name, ...fields}});
    if (event === 'SessionStart') log('codex.conversation_starts', {model: string(data.model)});
    if (event === 'SubagentStart') logs.push({key: `${key}:child`, trace: key, span: '', at,
      attrs: {'conversation.id': string(data.agent_id), 'event.name': 'codex.conversation_starts', model: string(data.model)}});
    if (event === 'UserPromptSubmit') {
      log('codex.user_prompt', {prompt_length: integer(data.prompt_length) ?? string(data.prompt).length,
        ...(captureContents ? {prompt: string(data.prompt)} : {})});
      const native = [...spans.values()].find(span => span.name === 'session_task.turn' &&
        (span.attrs['conversation.id'] ?? span.attrs['thread.id']) === id && span.attrs['turn.id'] === turn);
      if (native) {
        // The native task span can start before session initialization. Prompt
        // hooks define the actual prompt window, including a mid-turn start.
        native.start = at;
        native.attrs['capture.started_before'] = data.started_before_capture === true;
        native.attrs['capture.incomplete'] = data.started_before_capture === true || native.attrs['capture.end_incomplete'] === true;
        turns.set(key, native);
      } else {
        const span: Span = {key, trace: key, parent: '', name: 'session_task.turn', start: at, end: last,
          error: false, attrs: {...attrs, 'turn.id': turn, 'capture.incomplete': true, 'capture.started_before': data.started_before_capture === true}};
        spans.set(key, span); turns.set(key, span);
      }
    }
    if (event === 'Stop' || event === 'Interrupt') {
      const span = turns.get(key);
      if (span) {span.end = at; span.attrs['capture.incomplete'] = event === 'Interrupt' || span.attrs['capture.started_before'] === true;}
    }
    const call = string(data.tool_use_id), tool = string(data.tool_name);
    if (event === 'PreToolUse' && !isControl(tool)) {
      const native = logs.some(log => log.attrs['event.name'] === 'codex.tool_result' &&
        log.attrs['conversation.id'] === id && log.attrs.call_id === call);
      if (!native) {
        const annotation = data.tool_input === undefined ? {} : toolArgumentAnnotations(data.tool_input, captureContents);
        if (annotation.truncated !== undefined) {annotation.args_truncated = annotation.truncated; delete annotation.truncated;}
        const slice: Slice = {id: `hook-tool:${id}:${call}`, session: id, track: 'Tool dispatch', name: tool === 'Bash' ? 'bash' : tool,
          start: at, end: last, flows: [], attrs: {kind: 'tool-execution', call_id: call, timing: 'hook-dispatch', incomplete: true, ...annotation}};
        tools.set(`${id}:${call}`, slice); extra.push(slice);
      }
    }
    if (event === 'PostToolUse') {
      const slice = tools.get(`${id}:${call}`);
      if (slice) {
        slice.end = at; slice.attrs.incomplete = false;
        const result = object(data.tool_response);
        const exit = typeof result.exit_code === 'number' ? result.exit_code : integer(data.exit_code);
        if (exit !== undefined) {slice.attrs.exit_code = exit; slice.attrs.is_error = exit !== 0;}
        else if (typeof result.isError === 'boolean' || typeof data.is_error === 'boolean')
          slice.attrs.is_error = typeof result.isError === 'boolean' ? result.isError : data.is_error as boolean;
      }
    }
    if (event === 'PreCompact') {
      const slice: Slice = {id: `compact:${id}:${at}`, session: id, track: 'Compaction', name: 'compaction', start: at, end: last,
        flows: [], attrs: {kind: 'compaction', trigger: string(data.trigger), incomplete: true}};
      extra.push(slice); compactions.set(id, slice);
    }
    if (event === 'PostCompact') {
      const slice = compactions.get(id);
      if (slice) {slice.end = at; slice.attrs.incomplete = false; compactions.delete(id);}
    }
  }
  return extra;
}
