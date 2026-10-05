// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {resolve} from 'node:path';

async function recorder(env = {AGENTPROF_TRACE_FILE: '/recording.pftrace'}, shared = {}, options = {}) {
  const hooks = new Map(), files = [], processes = [], logs = [], commands = [], tools = [];
  let captures = 0;
  // Each module instance models one Claude mod worker.
  const {register} = await import(`./hooks/direct.mjs?test=${crypto.randomUUID()}`);
  register((name, matcher, handler) => hooks.set(name, handler ?? matcher), options);
  const $ = {
    env: {get: async name => env[name]}, plugin: {root: '/plugin'},
    process: {run: async args => {
      processes.push(args);
      if (args[2] === 'init') {
        const output = resolve('/project', args[3] ?? `agentprof-traces/recording-${++captures}.pftrace`);
        return {exitCode: 0, stdout: JSON.stringify({output, directory: `${output}.capture`, captureId: crypto.randomUUID()}), stderr: ''};
      }
      return {exitCode: 0, stdout: '{}', stderr: ''};
    }},
    command: {register: async spec => {commands.push(spec); return {command: spec.name};}},
    tool: {register: async spec => {tools.push(spec); return {tool: `mcp__agentprof__${spec.name}`};}},
    fs: {write: async (path, data) => {files.push({path, data});}},
    state: {get: async () => ({value: shared.value}), set: async (ref, value) => {shared.value = structuredClone(value); return {isSet: true, version: 1};}},
    ui: {log: async message => {logs.push(message);}, invalidate() {},
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button'].map(type => [type, props => ({type, props})]))},
    session: {id: async () => 'session', cwd: async () => '/project', model: async () => 'model', version: async () => ({version: '2.1.289'}),
      usage: async () => ({context: {window: 200000, tokens: 100}})},
    clock: {every: () => ({cancel() {}})},
  };
  const call = (name, event, next = async e => e) => hooks.get(name)($, event, next);
  // Claude can dispatch its native startup hook before the mod's session.start.
  await call('classic.SessionStart', {session_id: 'session', source: 'startup', model: 'model'});
  await call('session.start', {});
  const finish = async () => {
    await call('session.end', {sessionId: 'session', reason: 'prompt_input_exit'});
    return files.flatMap(f => f.data.trim().split('\n').map(line => JSON.parse(line)));
  };
  const tool = async (name, args = {}) => {
    const output = await call('tool.call', {tool: `mcp__agentprof__tracing_${name}`, tool_use_id: crypto.randomUUID(), ...args},
      async () => {throw new Error('Control tool should be handled by the plugin');});
    // The real host rejects arbitrary objects as registered MCP tool output.
    expect(typeof output.result).toBe('string');
    return {...output, result: JSON.parse(output.result)};
  };
  return {call, finish, tool, $, processes, files, logs, commands, tools, shared};
}

test('observation preserves streamed chunks and final usage without per-tool processes', async () => {
  const r = await recorder();
  const chunks = [{kind: 'thinking', text: 'private'}, {kind: 'text', text: 'answer'}];
  const answer = {usage: {model: 'model', input_tokens: 5, output_tokens: 7}, answer: 'answer', stopReason: 'end_turn'};
  const input = {turnId: 'turn', index: 0, model: 'model'};
  const stream = r.call('turn.step', input, async function* (e) {
    expect(e).toBe(input);
    for (const chunk of chunks) yield chunk;
    return answer;
  });
  expect((await stream.next()).value).toBe(chunks[0]);
  expect((await stream.next()).value).toBe(chunks[1]);
  expect((await stream.next()).value).toBe(answer);
  const result = {result: {output: 'private output'}, isError: false};
  expect(await r.call('tool.call', {tool: 'Bash', tool_use_id: 'tool', command: 'pwd'}, async () => result)).toBe(result);
  expect(r.processes).toHaveLength(1);
  const rows = await r.finish();
  expect(r.processes).toHaveLength(2);
  const response = rows.find(r => r.data.event === 'response' && r.data.phase === 'end');
  expect(response.data.usage).toEqual(answer.usage);
  expect(response.data.first_content_ms).toBeGreaterThanOrEqual(0);
  expect(response.data.first_text_ms).toBeGreaterThanOrEqual(response.data.first_content_ms);
  expect(JSON.stringify(rows)).not.toContain('private');
  expect(JSON.stringify(rows)).not.toContain('answer');
});

test('cancellation closes the underlying model stream and records an incomplete response', async () => {
  const r = await recorder();
  let closed = false;
  const stream = r.call('turn.step', {turnId: 'turn', index: 0, model: 'model'}, async function* () {
    try {yield {kind: 'text', text: 'partial'}; yield {kind: 'text', text: 'later'};}
    finally {closed = true;}
  });
  await stream.next();
  await stream.return();
  expect(closed).toBe(true);
  const rows = await r.finish();
  expect(rows.find(r => r.data.event === 'response' && r.data.phase === 'end').data.incomplete).toBe(true);
});

test('tool exceptions and denied results pass through unchanged', async () => {
  const r = await recorder(), error = new Error('Interrupted');
  await expect(r.call('tool.call', {tool: 'Bash', tool_use_id: 'failure'}, async () => {throw error;})).rejects.toBe(error);
  const denied = {deny: 'No permission'};
  expect(await r.call('tool.call', {tool: 'Bash', tool_use_id: 'denied'}, async () => denied)).toBe(denied);
  const rows = await r.finish();
  expect(rows.find(r => r.data.event === 'tool' && r.data.phase === 'end' && r.data.id === 'failure').data.incomplete).toBe(true);
  expect(rows.find(r => r.data.event === 'tool' && r.data.phase === 'end' && r.data.id === 'denied').data.denied).toBe(true);
});

test('disabled and legacy capture do not start a writer or query per-response context', async () => {
  for (const env of [{}, {AGENTPROF_TRACE_FILE: '/recording', AGENTPROF_CAPTURE_ENDPOINT: 'legacy'}]) {
    const r = await recorder(env);
    r.$.session.model = async () => {throw new Error('Unexpected query');};
    const answer = {usage: {output_tokens: 1}};
    const stream = r.call('turn.step', {turnId: 'turn', index: 0}, async function* () {return answer;});
    expect((await stream.next()).value).toBe(answer);
    await r.call('session.measure', {context: {window: 200000}});
    expect(await r.finish()).toEqual([]);
    expect(r.processes).toEqual([]);
  }
});

test('large tool inputs preserve the operation and failing capture I/O does not change tool outcomes', async () => {
  const r = await recorder();
  const result = {result: 'ok'};
  expect(await r.call('tool.call', {tool: 'Write', tool_use_id: 'large', content: 'a'.repeat(600000)}, async () => result)).toBe(result);
  const rows = await r.finish();
  expect(rows.find(r => r.data.event === 'tool' && r.data.phase === 'begin').data.content_omitted).toBe(true);
  expect(r.files.every(f => Buffer.byteLength(f.data) < 4 * 1024 * 1024)).toBe(true);

  const broken = await recorder();
  broken.$.fs.write = async () => {throw new Error('Disk full');};
  expect(await broken.call('tool.call', {tool: 'Read', tool_use_id: 'ok'}, async () => result)).toBe(result);
  await broken.finish();
  expect(broken.logs.some(line => line.includes('Disk full'))).toBe(true);
});

test('commands are immediate, paths remain literal, and controls never become traced tools', async () => {
  const r = await recorder({});
  expect(r.commands[0]).toMatchObject({name: 'tracing', immediate: true});
  expect(r.tools.map(t => t.name)).toEqual(['tracing_start', 'tracing_stop', 'tracing_status']);
  expect((await r.tool('status')).result).toMatchObject({state: 'idle', recording: false, published: false});
  const command = args => r.call('command.run', {command: 'tracing', args});
  expect((await command('start "traces/a $(literal) file.pftrace"')).exitCode).toBe(0);
  expect(r.processes[0].at(-1)).toBe('traces/a $(literal) file.pftrace');
  const current = (await r.tool('status')).result;
  expect(current).toMatchObject({state: 'recording', path: '/project/traces/a $(literal) file.pftrace', published: false});
  const duplicate = await r.tool('start', {output_path: 'second.pftrace'});
  expect(duplicate.isError).toBe(true);
  expect(duplicate.result.capture_id).toBe(current.capture_id);
  expect(r.processes).toHaveLength(1);
  expect((await command('status')).text).toContain(current.path);
  expect((await command('stop')).text).toBe(`Saved trace: ${current.path}`);
  expect((await r.tool('status')).result).toMatchObject({state: 'idle', published: true, capture_id: current.capture_id});
  expect((await r.tool('stop')).isError).toBe(true);
  const rows = await r.finish();
  expect(rows.some(r => r.data.event === 'tool')).toBe(false);
  expect(rows.filter(r => r.data.event === 'session' && r.data.phase === 'end')).toHaveLength(1);
  expect((await command('start "unfinished')).exitCode).toBe(1);
  expect((await command('stop extra')).exitCode).toBe(1);
});

test('concurrent starts serialize, and a stop waits for initialization', async () => {
  const r = await recorder({});
  let release;
  const ready = new Promise(resolve => {release = resolve;});
  const run = r.$.process.run;
  r.$.process.run = async args => {if (args[2] === 'init') await ready; return run(args);};
  const first = r.tool('start'), duplicate = r.tool('start'), stop = r.tool('stop');
  await Bun.sleep(1);
  expect((await r.tool('status')).result.state).toBe('starting');
  release();
  expect((await first).result.started).toBe(true);
  expect((await duplicate).isError).toBe(true);
  expect((await stop).result).toMatchObject({stopped: true, published: true});
  expect(r.processes.map(args => args[2])).toEqual(['init', 'finish']);
});

test('stop/start separates delayed streams and tools while retaining the current prompt excerpt', async () => {
  const r = await recorder({});
  await r.call('turn.start', {turnId: 'task', text: 'Measure this task'});
  const first = (await r.tool('start', {output_path: 'first.pftrace'})).result;
  let release;
  const ready = new Promise(resolve => {release = resolve;});
  const delayed = r.call('tool.call', {tool: 'Bash', tool_use_id: 'old', command: 'slow'}, async () => {
    await ready;
    await r.call('classic.PostToolUse', {tool_name: 'Bash', tool_use_id: 'old', duration_ms: 1});
    return {result: 'done'};
  });
  const stream = r.call('turn.step', {turnId: 'task', index: 0, model: 'model'}, async function* () {
    yield {kind: 'text', text: 'partial'};
    return {usage: {input_tokens: 1000, output_tokens: 1000}};
  });
  await stream.next();
  await r.tool('stop');
  const second = (await r.tool('start', {output_path: 'second.pftrace'})).result;
  expect(second.capture_id).not.toBe(first.capture_id);
  release(); await delayed; await stream.next();
  const newStream = r.call('turn.step', {turnId: 'task', index: 1, model: 'model'}, async function* () {
    return {usage: {input_tokens: 2, output_tokens: 3}};
  });
  await newStream.next();
  await r.call('turn.complete', {turnId: 'task', isAborted: false});
  await r.tool('stop');
  const rows = directory => r.files.filter(f => f.path.startsWith(directory + '/')).flatMap(f => f.data.trim().split('\n').map(JSON.parse));
  expect(rows(first.capture_directory).some(r => r.data.phase === 'end' && ['tool', 'response'].includes(r.data.event))).toBe(false);
  const nextRows = rows(second.capture_directory);
  expect(nextRows.some(r => r.data.id === 'old' || r.data.id === 'task:0')).toBe(false);
  expect(nextRows.find(r => r.data.event === 'prompt' && r.data.phase === 'begin').data).toMatchObject({prompt: 'Measure this task', started_before_capture: true});
  expect(nextRows.find(r => r.data.event === 'response' && r.data.phase === 'end').data.usage.output_tokens).toBe(3);
});

test('invalid paths and failed initialization leave controls usable', async () => {
  const r = await recorder({});
  expect((await r.tool('start', {output_path: 'bad.txt'})).isError).toBe(true);
  expect(r.processes).toHaveLength(0);
  const run = r.$.process.run;
  r.$.process.run = async () => ({exitCode: 1, stdout: '', stderr: 'Output already exists'});
  expect((await r.tool('start')).result.error).toContain('Output already exists');
  expect((await r.tool('status')).result.state).toBe('idle');
  r.$.process.run = run;
  expect((await r.tool('start')).result.started).toBe(true);
  expect((await r.tool('stop')).result.published).toBe(true);
});

test('failed publication reports the retained journal, never a successfully saved trace', async () => {
  const r = await recorder({});
  await r.tool('start');
  r.$.process.run = async () => ({exitCode: 1, stdout: '', stderr: 'Disk full'});
  const stopped = await r.tool('stop');
  expect(stopped.isError).toBe(true);
  expect(stopped.result).toMatchObject({stopped: true, published: false, recording: false, state: 'error'});
  expect(stopped.result.capture_directory).toContain('.capture');
  expect((await r.tool('status')).result.error).toContain('Disk full');
  expect(r.logs.some(line => line.includes('Saved recording:'))).toBe(false);
});

test('reload restores buffered events, paths and controls without restarting auto capture', async () => {
  const first = await recorder();
  await first.call('turn.start', {turnId: 'task', text: 'Retain this prompt'});
  const id = (await first.tool('status')).result.capture_id;
  const second = await recorder({AGENTPROF_TRACE_FILE: '/recording.pftrace'}, first.shared);
  expect(second.processes).toHaveLength(0);
  expect((await second.tool('status')).result).toMatchObject({recording: true, capture_id: id});
  await second.call('turn.complete', {turnId: 'task'});
  await second.tool('stop');
  const events = [...first.files, ...second.files].flatMap(f => f.data.trim().split('\n').map(JSON.parse));
  expect(events.filter(r => r.data.event === 'session' && r.data.phase === 'begin')).toHaveLength(1);
  expect(events.find(r => r.data.event === 'prompt' && r.data.phase === 'begin').data.prompt).toBe('Retain this prompt');
  expect(events.some(r => r.data.event === 'prompt' && r.data.phase === 'end')).toBe(true);
  const stopped = await recorder({AGENTPROF_TRACE_FILE: '/recording.pftrace'}, second.shared);
  expect(stopped.processes).toHaveLength(0);
  expect((await stopped.tool('status')).result).toMatchObject({recording: false, published: true});
});

test('reload replays an interrupted journal write without allocating a different chunk', async () => {
  const first = await recorder();
  first.$.fs.write = async () => {throw new Error('Worker interrupted');};
  await first.call('turn.start', {turnId: 'task', text: 'hello'});
  // Emulate a worker dying during the first write, before it can persist failure.
  let checkpoint;
  const set = first.$.state.set;
  first.$.state.set = async (ref, value) => {await set(ref, value); if (value.capture.batches.length && !checkpoint) checkpoint = structuredClone(value);};
  await first.tool('stop');
  checkpoint.capture.active = true;
  const recovered = await recorder({}, {value: checkpoint});
  expect(recovered.files[0].path).toBe(checkpoint.capture.batches[0].path);
  expect(recovered.files[0].data).toBe(checkpoint.capture.batches[0].body);
});

test('clear and same-id resume keep the file but isolate capture windows and late tools', async () => {
  const r = await recorder();
  let release;
  const ready = new Promise(resolve => {release = resolve;});
  const delayed = r.call('tool.call', {tool: 'Bash', tool_use_id: 'old'}, async () => {await ready; return {result: 'done'};});
  await Bun.sleep(1);
  await r.call('session.end', {sessionId: 'session', reason: 'resume'});
  expect((await r.tool('status')).result).toMatchObject({recording: true, published: false});
  // Claude resets host state on clear; module state remains alive.
  r.shared.value = undefined;
  await r.call('classic.SessionStart', {session_id: 'session', source: 'resume', model: 'model'});
  release(); await delayed;
  await r.call('turn.start', {turnId: 'new', text: 'Resumed task'});
  await r.tool('stop');
  const events = r.files.flatMap(f => f.data.trim().split('\n').map(JSON.parse));
  expect(events.filter(r => r.data.event === 'session' && r.data.phase === 'begin').map(r => r.data.segment)).toEqual([0, 1]);
  expect(events.some(r => r.data.id === 'old' && r.data.phase === 'end')).toBe(false);
  expect(r.processes.map(args => args[2])).toEqual(['init', 'finish']);
});

test('active subagents are adopted as partial prompts on a later recording', async () => {
  const r = await recorder({});
  await r.call('agent.spawn', {tool_use_id: 'spawn', prompt: 'Child task', subagentType: 'worker'}, async () => ({agentId: 'child', model: 'model'}));
  await r.tool('start');
  const events = await r.finish();
  expect(events.find(r => r.data.event === 'agent').data).toMatchObject({agent_id: 'child', prompt: 'Child task', started_before_capture: true});
});

test('shutdown launches a one-shot finalizer and never claims it has already published', async () => {
  const r = await recorder();
  await r.finish();
  expect(r.processes.at(-1)[2]).toBe('finalize');
  expect(r.logs.some(line => line.startsWith('Saving recording:'))).toBe(true);
  expect(r.logs.some(line => line.startsWith('Saved recording:'))).toBe(false);
});

test('recording controls preserve other bands, yield to surveys, and use a focused hotkey', async () => {
  const r = await recorder({});
  const other = {type: 'Text', props: {children: ['Another plugin']}};
  const render = () => r.call('ui.render', {component: 'AbovePrompt', props: {}}, async () => other);
  const idle = await render();
  expect(idle.props.children.at(-1)).toBe(other);
  const button = idle.props.children[0].props.children.find(c => c.type === 'Button');
  expect(button.props).toMatchObject({hotkey: 'r', label: 'Start recording'});
  await button.props.onPress();
  const active = await render();
  expect(active.props.children[0].props.children.find(c => c.type === 'Button').props.label).toBe('Stop recording');
  expect(active.props.children[1].props.children[0]).toContain('.pftrace');
  expect(await r.call('ui.render', {component: 'AbovePrompt', props: {hasSurvey: true}}, async () => other)).toBe(other);
});

test('configured automatic start survives native startup ordering and does not restart on reload', async () => {
  const options = {auto_start: true, show_controls: false};
  const r = await recorder({}, {}, options);
  expect((await r.tool('status')).result.recording).toBe(true);
  expect(r.processes.map(c => c[2])).toEqual(['init']);
  const other = {type: 'Text'};
  expect(await r.call('ui.render', {props: {}}, async () => other)).toBe(other);
  await r.tool('stop');
  const reloaded = await recorder({}, r.shared, options);
  expect((await reloaded.tool('status')).result).toMatchObject({recording: false, published: true});
  expect(reloaded.processes).toHaveLength(0);
});
