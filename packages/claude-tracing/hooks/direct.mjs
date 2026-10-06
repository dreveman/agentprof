// SPDX-License-Identifier: Apache-2.0
// Observe the normal session without changing prompts, streams or tool results.
let capture, session, segment = 0, awaitingSession = false, legacy = false, transition = 'idle', ending = false, initialized = false;
let controls = Promise.resolve(), checkpoints = Promise.resolve();
let countScope, countedItems = new Map();
const controlTools = new Map(), prompts = new Map(), toolScopes = new Map(), agents = new Map();
const epoch = Date.now(), monotonic = performance.now();
const encoder = new TextEncoder();
const now = () => String(BigInt(epoch) * 1000000n + BigInt(Math.round((performance.now() - monotonic) * 1000000)));
const text = value => typeof value === 'string' ? value.slice(0, 128 * 1024) : undefined;
const usage = value => value && Object.fromEntries(['model', 'input_tokens', 'output_tokens',
  'cache_read_input_tokens', 'cache_creation_input_tokens'].filter(k => value[k] !== undefined).map(k => [k, value[k]]));
const context = value => value && {tokens: value.tokens, window: value.window};
const readContext = async ($, includeMessages = false) => {
  let usage;
  try {usage = await $.session.usage({breakdown: 'summary'});} catch {usage = await $.session.usage();}
  const value = context(usage.context) ?? {}, b = usage.context?.breakdown;
  if (b) value.breakdown = {
    categories: b.categories.map(c => ({name: c.name, tokens: c.tokens, kind: c.kind})),
    raw_max_tokens: b.rawMaxTokens, auto_compact_threshold: b.autoCompactThreshold,
    total_tokens: b.totalTokens,
  };
  if (includeMessages) try {
    // Counts and call identities only, never a second copy of transcript text.
    value.items = (await $.session.messages()).flatMap((message, index) => {
      const role = message.role, items = [], chars = (message.text ?? '').length;
      if (chars) items.push({id: `message:${index}`, category: role === 'assistant' ? 'assistant' : 'prompts',
        chars, tokens: Math.ceil(chars / 4), label: role === 'assistant' ? 'Assistant history' : 'User prompt', source_kind: role === 'assistant' ? 'response' : 'prompt'});
      for (const result of message.toolResults ?? []) {
        const chars = (result.text ?? '').length;
        items.push({id: `result:${result.tool_use_id}`, category: 'results', chars, tokens: Math.ceil(chars / 4),
          source_id: result.tool_use_id, source_kind: 'tool', label: 'Tool result'});
      }
      for (const call of message.toolUses ?? []) {
        const chars = JSON.stringify(call.input ?? {}).length + (call.tool ?? '').length;
        items.push({id: `call:${call.tool_use_id}`, category: 'assistant', chars, tokens: Math.ceil(chars / 4),
          source_id: call.tool_use_id, source_kind: 'tool', label: 'Tool arguments'});
      }
      return items;
    });
  } catch {value.items_unavailable = true;}
  if (b && includeMessages) {
    const details = [
      ...(b.memoryFiles ?? []).map((entry, index) => ({id: `memory:${entry.type}:${index}`, category: 'rules', tokens: entry.tokens, label: 'Memory file'})),
      ...(b.mcpTools ?? []).filter(entry => entry.isLoaded).map(entry => ({id: `schema:${entry.name}`, category: 'tools', tokens: entry.tokens, label: entry.name.slice(0, 96)})),
      ...(b.skills?.skillFrontmatter ?? []).map(entry => ({id: `skill:${entry.name}`, category: 'skills', tokens: entry.tokens, label: entry.name.slice(0, 96)})),
      ...(b.agents ?? []).map(entry => ({id: `agent:${entry.agentType}`, category: 'tools', tokens: entry.tokens, label: entry.agentType.slice(0, 96)})),
    ];
    value.items = [...(value.items ?? []), ...details];
  }
  return value;
};
// A callback retains its recording and conversation segment, even when /resume
// revisits the same native session id or a new recording starts before it ends.
const scope = agentId => ({capture, session, segment, agent_id: agentId});
const record = (scope, event, phase, id, data = {}, timestamp = now()) => {
  const c = scope?.capture;
  if (!c?.active || c.error || awaitingSession || scope.session !== session || scope.segment !== segment) return;
  let line;
  try {
    const row = {source: 'claude.mod', timestamp,
      data: {event, phase, id, session_id: scope.session, segment: scope.segment, agent_id: scope.agent_id, ...data}};
    const reading = row.data.context;
    if (reading?.items) {
      const identity = `${c.captureId}:${scope.session}:${scope.segment}`;
      const reset = identity !== countScope;
      const previous = reset ? new Map() : countedItems;
      const current = new Map(reading.items.map(item => [item.id, item]));
      const changed = [...current.values()].filter(item => JSON.stringify(previous.get(item.id)) !== JSON.stringify(item));
      row.data.context = {...reading, items_reset: reset, item_changes: changed,
        removed_items: [...previous.keys()].filter(id => !current.has(id))};
      delete row.data.context.items;
      countScope = identity; countedItems = current;
    }
    line = JSON.stringify(row) + '\n';
    if (line.length > 512 * 1024) {
      // Preserve the operation even when a very large tool input cannot fit.
      delete row.data.arguments; delete row.data.prompt;
      row.data.content_omitted = true;
      line = JSON.stringify(row) + '\n';
    }
  } catch {c.dropped++; return;}
  const size = encoder.encode(line).length;
  // Leave room for the final loss count even after reaching the recording cap.
  if (event !== 'session' && c.totalBytes + size > 64 * 1024 * 1024) {c.dropped++; return;}
  c.rows.push(line); c.queuedBytes += size; c.totalBytes += size; c.published = false;
  if (['response', 'tool', 'compaction'].includes(event)) {
    const key = `${scope.agent_id ?? ''}:${event}:${id}`;
    if (phase === 'begin') c.open[key] = {event, id, agent_id: scope.agent_id, session: scope.session, segment: scope.segment};
    if (phase === 'end') delete c.open[key];
  }
};
const fail = ($, c, error) => {
  if (c.error) return;
  c.error = String(error); c.active = false; c.published = false; c.timer?.cancel();
  void $.ui.log(`Recording stopped: ${c.error}. Saved observations remain in ${c.directory}.`).catch(() => {});
  $.ui.invalidate('ui.render');
};
// Keep unflushed observations in Claude's host, not only the mod worker. A reload
// can replay an interrupted chunk at the same path before accepting more work.
const checkpoint = ($) => {
  checkpoints = checkpoints.then(async () => {
    const {timer, pending, ...saved} = capture ?? {};
    await $.state.set({plugin: 'agentprof', key: 'recorder'}, {
      session, segment, awaitingSession, capture: capture ? saved : null,
      prompts: [...prompts], agents: [...agents],
    });
  }).catch(error => {if (capture) fail($, capture, error);});
  return checkpoints;
};
const flush = ($, c) => {
  if (!c || c.error || (!c.rows.length && !c.batches.length)) return c?.pending;
  let body = '';
  const write = body => {
    const path = `${c.directory}/events-${String(c.chunk++).padStart(6, '0')}.jsonl`;
    c.batches.push({path, body});
  };
  // The host API caps each write at 4 MiB; this also fits non-ASCII JSON.
  for (const line of c.rows) {
    if (body.length + line.length > 512 * 1024) {write(body); body = '';}
    body += line;
  }
  if (body) write(body);
  c.rows = []; c.queuedBytes = 0;
  c.pending = c.pending.then(async () => {
    await checkpoint($);
    while (c.batches.length && !c.error) {
      const batch = c.batches[0];
      await $.fs.write(batch.path, batch.body);
      c.batches.shift();
      await checkpoint($);
    }
  }).catch(error => fail($, c, error));
  return c.pending;
};
const retain = async ($, c = capture) => {
  if (legacy) return;
  if (c?.queuedBytes > 256 * 1024) await flush($, c);
  else await checkpoint($);
};
const status = () => ({state: transition !== 'idle' ? transition : capture?.error ? 'error' : capture?.active ? 'recording' : 'idle',
  recording: capture?.active === true, published: capture?.published === true,
  ...(capture ? {path: capture.output, capture_id: capture.captureId, capture_directory: capture.directory,
    ...(capture.error ? {error: capture.error} : {})} : {})});
const statusText = value => value.error ? `Tracing failed: ${value.error}${value.capture_directory ? `\nSaved observations: ${value.capture_directory}` : ''}` :
  value.recording ? `Recording: ${value.path}` : value.published ? `Tracing is idle. Last saved trace: ${value.path}` : 'Tracing is idle.';

const startRecording = async ($, path) => {
  if (ending) return {...status(), started: false, error: 'Claude is exiting.'};
  if (capture?.active) return {...status(), started: false, error: 'A recording is already active. Stop it before starting another.'};
  if (path !== undefined && (typeof path !== 'string' || !path.trim() || !path.endsWith('.pftrace') || path.includes('\0')))
    return {...status(), started: false, error: 'output_path must name a .pftrace file.'};
  transition = 'starting';
  try {
    const root = await $.session.id(), model = await $.session.model(), version = (await $.session.version()).version;
    const reading = await readContext($, true);
    let provider = 'anthropic';
    if (['1', 'true'].includes(await $.env.get('CLAUDE_CODE_USE_BEDROCK'))) provider = 'bedrock';
    else if (['1', 'true'].includes(await $.env.get('CLAUDE_CODE_USE_VERTEX'))) provider = 'vertex';
    else if (['1', 'true'].includes(await $.env.get('CLAUDE_CODE_USE_FOUNDRY'))) provider = 'foundry';
    const result = await $.process.run(['node', `${$.plugin.root}/runtime/direct-writer.mjs`, 'init', ...(path === undefined ? [] : [path])],
      {cwd: await $.session.cwd()});
    if (result.exitCode !== 0) throw new Error(result.stderr.trim());
    const c = {...JSON.parse(result.stdout), active: true, published: false, provider, version, started: now(),
      rows: [], batches: [], open: {}, queuedBytes: 0, totalBytes: 0, dropped: 0, chunk: 0, pending: Promise.resolve()};
    capture = c; session = root; awaitingSession = false;
    record(scope(), 'session', 'begin', session, {model, provider, version, context: reading});
    // Agent-triggered starts happen within a prompt. Preserve its description,
    // but never pretend its full duration was recorded.
    for (const [id, prompt] of prompts) if (prompt.session === session)
      record(scope(prompt.agent_id), 'prompt', 'begin', id, {...prompt.data, started_before_capture: true});
    for (const [id, agent] of agents) if (agent.session === session)
      record(scope(), 'agent', 'begin', id, {...agent.data, started_before_capture: true});
    await retain($, c);
    if (c.error) throw new Error(c.error);
    c.timer = $.clock.every(1000, () => flush($, c));
    return {...status(), state: 'recording', started: true};
  } catch (error) {return {...status(), state: capture?.active ? 'recording' : 'idle', started: false, error: String(error)};}
  finally {transition = 'idle'; $.ui.invalidate('ui.render');}
};
const save = async ($, reason, keepRecording = false, background = false) => {
  const c = capture;
  if (!c?.active) return {...status(), stopped: false, error: c?.error ?? 'No recording is active.'};
  transition = 'stopping';
  record(scope(), 'session', 'end', session, {reason, dropped: c.dropped});
  if (keepRecording) {
    // /clear, /resume and /branch continue the same file. Native SessionStart
    // supplies the next identity, even when resuming the same session id.
    awaitingSession = true;
    c.open = {};
    await flush($, c);
    transition = 'idle';
    return {...status(), stopped: false};
  }
  c.active = false; c.timer?.cancel();
  try {
    await flush($, c);
    if (c.error) throw new Error(c.error);
    const result = await $.process.run(['node', `${$.plugin.root}/runtime/direct-writer.mjs`, background ? 'finalize' : 'finish', c.directory]);
    if (result.exitCode !== 0) throw new Error(result.stderr.trim());
    const summary = JSON.parse(result.stdout);
    c.published = !background;
    await checkpoint($);
    return {...status(), state: 'idle', stopped: true, saving: background, summary,
      ...(summary.incompleteOperations ? {warning: `Recording includes ${summary.incompleteOperations} incomplete operations. See the trace for details.`} : {})};
  } catch (error) {fail($, c, error); return {...status(), state: 'error', stopped: true, published: false, error: c.error};}
  finally {transition = 'idle'; await checkpoint($); $.ui.invalidate('ui.render');}
};
const control = ($, action, path, reason = 'manual', keepRecording = false, background = false) => {
  if (legacy) return Promise.resolve({state: 'unavailable', recording: false, published: false, error: 'Tracing is managed by the OpenTelemetry launcher.'});
  if (action === 'status') return Promise.resolve(status());
  // A stop waits for a pending start, and a new start waits for publication.
  const result = controls.then(() => action === 'start' ? startRecording($, path) : save($, reason, keepRecording, background));
  controls = result.catch(() => {});
  return result;
};
const command = async ($, args) => {
  const match = /^(\S+)?(?:\s+([\s\S]*))?$/.exec(args.trim()), action = match?.[1] ?? 'status';
  let path = match?.[2];
  if (action === 'help' || !['start', 'stop', 'status'].includes(action) || (action !== 'start' && path))
    return {text: 'Usage: /tracing start [output.pftrace] | stop | status', exitCode: action === 'help' ? 0 : 1};
  if (path && ['"', "'"].includes(path[0])) {
    if (path.at(-1) !== path[0] || path.length < 2) return {text: 'The output path has an unmatched quote.', exitCode: 1};
    path = path.slice(1, -1);
  }
  const result = await control($, action, path);
  return {text: result.error ? `${result.error}${result.path ? `\nTrace: ${result.path}` : ''}` : result.started ? `Recording started: ${result.path}` :
    result.stopped ? `Saved trace: ${result.path}` : statusText(result), exitCode: result.error ? 1 : 0};
};

export function register(on, options) {
  on('session.start', async ($, e, next) => {
    legacy = Boolean(await $.env.get('AGENTPROF_CAPTURE_ENDPOINT'));
    if (legacy) return next(e);
    session = await $.session.id();
    const {value} = await $.state.get({plugin: 'agentprof', key: 'recorder'});
    const held = value ? JSON.parse(JSON.stringify(value)) : undefined;
    const restored = held?.session === session;
    if (restored) {
      segment = held.segment; awaitingSession = held.awaitingSession;
      for (const [id, prompt] of held.prompts ?? []) prompts.set(id, prompt);
      for (const [id, agent] of held.agents ?? []) agents.set(id, agent);
      if (held.capture) {
        capture = {...held.capture, pending: Promise.resolve()};
        // A worker reload cannot resume its old middleware callbacks. Keep the
        // observations, but bound those operations and mark their ends unknown.
        for (const op of Object.values(capture.open))
          record({...op, capture}, op.event, 'end', op.id, {incomplete: true});
        await flush($, capture);
        if (capture.active && !capture.error) capture.timer = $.clock.every(1000, () => flush($, capture));
      }
    }
    await $.command.register({name: 'tracing', description: 'Start, stop or inspect an Agent Profiler recording',
      argumentHint: 'start [output.pftrace] | stop | status', immediate: true});
    const startTool = await $.tool.register({name: 'tracing_start',
      description: 'Start an Agent Profiler recording of this Claude session and its subagents. Await this before the work to measure. Optionally choose an unused .pftrace output_path, absolute or relative to the project directory. Returns the absolute path and capture_id. Call tracing_stop after the work to save it.',
      inputSchema: {type: 'object', properties: {output_path: {type: 'string', description: 'An unused .pftrace file path. Omit for a unique file under agentprof-traces/.'}}, additionalProperties: false}});
    controlTools.set(startTool.tool, 'start');
    const stopTool = await $.tool.register({name: 'tracing_stop',
      description: 'Stop and save the active Agent Profiler recording. Returns the saved .pftrace path, capture_id and published status. In-flight work is marked incomplete; wait for measured work to finish before stopping.',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false}});
    controlTools.set(stopTool.tool, 'stop');
    const statusTool = await $.tool.register({name: 'tracing_status',
      description: 'Read Agent Profiler recording state, current or last trace path, capture_id and whether the trace has been saved.',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false}});
    controlTools.set(statusTool.tool, 'status');
    const file = await $.env.get('AGENTPROF_TRACE_FILE');
    if (!restored && (file || options.auto_start)) {
      const result = await control($, 'start', file || undefined);
      await $.ui.log(result.started ? `Recording to ${result.path}` : statusText(result));
    }
    await checkpoint($);
    initialized = true;
    return next(e);
  });
  on('command.run', {command: 'tracing'}, ($, e) => command($, e.args));
  on('ui.render', {component: 'AbovePrompt'}, async ($, e, next) => {
    if (legacy || options.show_controls === false || e.props.hasSurvey) return next(e);
    await $.state.get({plugin: 'agentprof', key: 'recorder'});
    const {Box, Text, Button} = $.ui.resolve(e), current = status();
    const children = [Text({bold: true, children: ['Agent Profiler']}),
      Text({children: [current.recording ? '● Recording' : current.error ? 'Recording failed' : transition !== 'idle' ? transition : 'Idle']})];
    if (transition === 'idle') children.push(Button({key: 'toggle-tracing',
      label: current.recording ? 'Stop recording' : 'Start recording', hotkey: 'r',
      onPress: async () => {
        const result = await command($, capture?.active ? 'stop' : 'start');
        await $.ui.log(result.text);
      }}));
    const other = await next(e);
    return Box({flexDirection: 'column', children: [
      Box({flexDirection: 'row', columnGap: 1, children}),
      Text({dimColor: true, wrap: 'truncate-middle', children: [current.error ? statusText(current) :
        current.path ?? 'Ctrl+X then Tab, R to record · /tracing start [path]']}),
      ...(other ? [other] : []),
    ]});
  });
  on('classic.SessionStart', async ($, e, next) => {
    // Native startup may precede session.start. Do not overwrite a reload's
    // checkpoint, or mistake a fresh idle checkpoint for restored recording.
    if (!initialized) return next(e);
    if (e.session_id !== session || awaitingSession) {
      session = e.session_id; segment++; awaitingSession = false; prompts.clear(); agents.clear(); toolScopes.clear();
      if (capture?.active) {
        try {record(scope(), 'session', 'begin', session, {model: e.model, provider: capture.provider,
          version: capture.version, context: await readContext($)});}
        catch (error) {fail($, capture, error);}
      }
    }
    await retain($);
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    const data = {prompt: text(e.text), prompt_length: e.text.length};
    prompts.set(e.turnId, {session, data, agent_id: e.agentId});
    record(scope(e.agentId), 'prompt', 'begin', e.turnId, data);
    await retain($);
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    prompts.delete(e.turnId);
    if (e.agentId) agents.delete(e.agentId);
    record(scope(e.agentId), 'prompt', 'end', e.turnId, {aborted: e.isAborted});
    await retain($);
    return next(e);
  });
  on('turn.step', async function* ($, e, next) {
    const s = scope(e.agentId), c = s.capture;
    if (!c?.active || c.error) return yield* next(e);
    const id = `${e.turnId}:${e.index}`;
    let firstContent, firstText, complete = false;
    let inputContext;
    if (!e.agentId) try {inputContext = await readContext($, true);} catch {}
    const start = performance.now();
    record(s, 'response', 'begin', id, {turn_id: e.turnId, model: e.model, effort: e.effort, context: inputContext});
    await retain($, c);
    const stream = next(e);
    try {
      while (true) {
        const item = await stream.next();
        if (item.done) {
          complete = true;
          record(s, 'response', 'end', id, {usage: usage(item.value?.usage),
            stop_reason: item.value?.stopReason, first_content_ms: firstContent, first_text_ms: firstText});
          // The session API describes the main conversation, never a child's window.
          if (!e.agentId && c.active) {
            try {record(s, 'context', 'sample', id, {model: await $.session.model(), context: await readContext($)});} catch {}
          }
          await retain($, c);
          return item.value;
        }
        const kind = item.value.kind;
        if (['text', 'thinking', 'tool', 'input'].includes(kind)) firstContent ??= performance.now() - start;
        if (kind === 'text') firstText ??= performance.now() - start;
        yield item.value;
      }
    } finally {
      if (!complete) {
        record(s, 'response', 'end', id, {incomplete: true, first_content_ms: firstContent, first_text_ms: firstText});
        await retain($, c);
        await stream.return?.();
      }
    }
  });
  on('tool.call', async ($, e, next) => {
    const action = controlTools.get(e.tool);
    if (action) {
      const result = await control($, action, e.output_path, 'tool');
      // Registered tools use Claude's MCP output shape: text or content blocks.
      return {result: JSON.stringify(result), ...(result.error ? {isError: true} : {})};
    }
    const {tool, tool_use_id: id, agentId, ...args} = e, s = scope(agentId);
    const key = `${agentId ?? ''}:${id}`;
    toolScopes.set(key, s);
    record(s, 'tool', 'begin', id, {tool, arguments: args});
    await retain($, s.capture);
    let completed = false;
    try {
      const result = await next(e); completed = true;
      record(s, 'tool', 'end', id, {is_error: result.isError === true || Boolean(result.deny), denied: Boolean(result.deny)});
      return result;
    } finally {
      if (!completed) record(s, 'tool', 'end', id, {incomplete: true});
      toolScopes.delete(key);
      await retain($, s.capture);
    }
  });
  const execution = (e, failed) => {
    if (!controlTools.has(e.tool_name)) record(toolScopes.get(`${e.agent_id ?? ''}:${e.tool_use_id}`), 'execution', 'end', e.tool_use_id,
      {tool: e.tool_name, duration_ms: e.duration_ms, is_error: failed, interrupted: e.is_interrupt});
  };
  on('classic.PostToolUse', async ($, e, next) => {execution(e, false); return next(e);});
  on('classic.PostToolUseFailure', async ($, e, next) => {execution(e, true); return next(e);});
  on('agent.spawn', async ($, e, next) => {
    const at = now(), s = scope();
    const result = await next(e);
    if (result.agentId && s.session === session && s.segment === segment) {
      const data = {agent_id: result.agentId,
      parent_agent_id: e.parentAgentId, call_id: e.tool_use_id, model: result.model,
      role: e.subagentType, prompt: text(e.prompt), prompt_length: e.prompt.length};
      agents.set(result.agentId, {session, data});
      if (capture !== s.capture && capture?.active)
        record(scope(), 'agent', 'begin', result.agentId, {...data, started_before_capture: true}, capture.started);
      else record(s, 'agent', 'begin', result.agentId, data, at);
      await retain($);
    }
    return result;
  });
  on('session.compact', async ($, e, next) => {
    const id = crypto.randomUUID(), s = scope(e.agentId);
    record(s, 'compaction', 'begin', id, {trigger: e.trigger});
    await retain($, s.capture);
    let completed = false;
    try {
      const result = await next(e); completed = true;
      let compactContext, compactModel;
      if (!e.agentId && !result.skip) try {compactContext = await readContext($, true); compactModel = await $.session.model();} catch {}
      record(s, 'compaction', 'end', id, {context: compactContext, model: compactModel, success: !result.skip, skipped: Boolean(result.skip),
        pre_tokens: result.tokensBefore, post_tokens: result.tokensAfter, usage: usage(result.usage)});
      return result;
    } finally {
      if (!completed) record(s, 'compaction', 'end', id, {success: false, incomplete: true});
      await retain($, s.capture);
    }
  });
  on('session.measure', async ($, e, next) => {
    const s = scope();
    if (s.capture?.active) {
      try {record(s, 'context', 'sample', session, {model: await $.session.model(), context: context(e.context)});}
      catch (error) {fail($, s.capture, error);}
    }
    await retain($);
    return next(e);
  });
  on('session.end', async ($, e, next) => {
    const continuing = ['clear', 'resume'].includes(e.reason);
    ending = !continuing;
    if (capture?.active || transition !== 'idle') {
      const result = await control($, 'stop', undefined, e.reason, continuing, !continuing);
      if (result.published && !result.error) await $.ui.log(`Saved recording: ${result.path}`);
      else if (result.saving) await $.ui.log(`Saving recording: ${result.path}. If interrupted, recover from ${result.capture_directory}.`);
    }
    return next(e);
  });
}
