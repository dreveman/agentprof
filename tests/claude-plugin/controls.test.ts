// SPDX-License-Identifier: Apache-2.0
import {expect, test, mock} from 'claude-code/testing';

// These run inside the real Claude mod host, without credentials or model calls.
test('installed recording controls render, start, stop and preserve native tool results', async ($, on) => {
  mock.env(on, {});
  mock.clock(on);
  const writes: string[] = [], commands: string[][] = [];
  const usageRequests: unknown[] = [];
  on('session.id', () => ({value: 'test-session'}));
  on('session.cwd', () => ({value: '/project'}));
  on('session.model', () => ({value: 'claude-haiku-4-5'}));
  on('session.version', () => ({value: {version: '2.1.289'}}));
  on('session.usage', (_, e) => {
    usageRequests.push(e);
    return {value: {context: {tokens: 100, window: 200000, breakdown: {
      categories: [{name: 'Messages', kind: 'used', tokens: 120}, {name: 'Free space', kind: 'free', tokens: 199880}],
      totalTokens: 120, rawMaxTokens: 200000, autoCompactThreshold: 167000,
      memoryFiles: [{type: 'project', tokens: 20}],
    }}}};
  });
  on('session.messages', () => ({value: [{role: 'user', text: 'private prompt text', toolUses: [],
    toolResults: [{tool_use_id: 'read-1', text: 'private tool output', isError: false}]}]}));
  on('process.run', (_, e) => {
    commands.push(e.argv);
    return {value: {exitCode: 0, stdout: JSON.stringify(e.argv[2] === 'init' ? {
      output: '/project/test.pftrace', directory: '/project/test.pftrace.capture', captureId: 'test-capture',
    } : {sessions: 1}), stderr: ''}};
  });
  on('fs.write', (_, e) => {writes.push(e.text); return {value: undefined};});
  on('ui.log', () => ({value: undefined}));
  on('ui.render', () => ({type: 'Text', props: {}, children: ['Other plugin']}));
  on('command.register', (_, e) => ({value: {command: e.name}}));
  on('tool.register', (_, e) => ({value: {tool: `mcp__agentprof__${e.name}`}}));
  on('session.start', (_, e) => ({cwd: e.cwd}));
  on('tool.call', () => ({result: 'original result'}));
  on('turn.step', async function* (_, e) {
    yield {kind: 'text', index: 0, text: 'unchanged response'};
    return {turnId: e.turnId, index: e.index, answer: 'unchanged response', toolUses: [], stopReason: 'end_turn', usage: {model: 'claude-haiku-4-5', input_tokens: 100, output_tokens: 3,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0}};
  });
  await $.session.start({cwd: '/project'});
  const ui = await $.ui.mount({plugin: 'agentprof', component: 'AbovePrompt', surface: 'terminal', props: {hasSurvey: false, isWorking: false, maxRows: 8}});
  expect(await ui.find({type: 'Button', key: 'toggle-tracing'})).toBeDefined();
  await ui.press({key: 'toggle-tracing'});
  const started = await $.command.run({command: 'tracing', args: 'status'});
  expect(started.text).toContain('Recording: /project/test.pftrace');
  expect((await $.tool.call({tool: 'Bash', command: 'pwd'})).result).toBe('original result');
  const stream = $.turn.step({turnId: 'turn-1', index: 0, model: 'claude-haiku-4-5', messageCount: 1});
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(chunks).toEqual([{kind: 'text', index: 0, text: 'unchanged response'}]);
  for await (const _ of $.turn.step({turnId: 'turn-2', index: 0, model: 'claude-haiku-4-5', messageCount: 1})) {}
  const stopped = await $.tool.call({tool: 'mcp__agentprof__tracing_stop'});
  const status = JSON.parse(stopped.result as string);
  expect(status.published).toBe(true);
  expect(status.recording).toBe(false);
  expect(commands.map(c => c[2])).toEqual(['init', 'finish']);
  expect(writes.join('')).toContain('"tool":"Bash"');
  expect(writes.join('')).not.toContain('mcp__agentprof__tracing_stop');
  expect(writes.join('')).toContain('"breakdown"');
  expect(writes.join('')).toContain('"source_id":"read-1"');
  expect(writes.join('')).not.toContain('private prompt text');
  expect(writes.join('')).not.toContain('private tool output');
  const observations = writes.join('').trim().split('\n').map(line => JSON.parse(line));
  const contexts = observations.map(row => row.data?.context).filter(value => value?.item_changes);
  expect(contexts.length).toBe(3);
  expect(contexts.slice(1).every(value => value.item_changes.length === 0 && value.removed_items.length === 0)).toBe(true);
  expect(usageRequests.every((request: any) => request.breakdown === 'summary')).toBe(true);
});
