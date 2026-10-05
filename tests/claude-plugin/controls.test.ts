// SPDX-License-Identifier: Apache-2.0
import {expect, test, mock} from 'claude-code/testing';

// These run inside the real Claude mod host, without credentials or model calls.
test('installed recording controls render, start, stop and preserve native tool results', async ($, on) => {
  mock.env(on, {});
  mock.clock(on);
  const writes: string[] = [], commands: string[][] = [];
  on('session.id', () => ({value: 'test-session'}));
  on('session.cwd', () => ({value: '/project'}));
  on('session.model', () => ({value: 'claude-haiku-4-5'}));
  on('session.version', () => ({value: {version: '2.1.289'}}));
  on('session.usage', () => ({value: {context: {tokens: 100, window: 200000}}}));
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
  await $.session.start({cwd: '/project'});
  const ui = await $.ui.mount({plugin: 'agentprof', component: 'AbovePrompt', surface: 'terminal', props: {hasSurvey: false, isWorking: false, maxRows: 8}});
  expect(await ui.find({type: 'Button', key: 'toggle-tracing'})).toBeDefined();
  await ui.press({key: 'toggle-tracing'});
  const started = await $.command.run({command: 'tracing', args: 'status'});
  expect(started.text).toContain('Recording: /project/test.pftrace');
  expect((await $.tool.call({tool: 'Bash', command: 'pwd'})).result).toBe('original result');
  const stopped = await $.tool.call({tool: 'mcp__agentprof__tracing_stop'});
  const status = JSON.parse(stopped.result as string);
  expect(status.published).toBe(true);
  expect(status.recording).toBe(false);
  expect(commands.map(c => c[2])).toEqual(['init', 'finish']);
  expect(writes.join('')).toContain('"tool":"Bash"');
  expect(writes.join('')).not.toContain('mcp__agentprof__tracing_stop');
});
