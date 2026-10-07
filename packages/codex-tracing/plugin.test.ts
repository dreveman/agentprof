// SPDX-License-Identifier: Apache-2.0
import {test, expect, spyOn} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Collector} from './plugin-collector.ts';
import {configure, stateDirectory} from './plugin-config.ts';
import {publish} from './plugin-journal.ts';
import {convertObservations} from './convert.ts';
import {readOtel} from './otel.ts';
import {addHooks} from './plugin-observations.ts';
import {fixture, rootSession, childSession, epoch, at, log} from './fixture.ts';
import {SETUP_SQL} from '../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';

test('profile setup is private, repeatable and does not replace existing user configuration', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-config-'));
  try {
    writeFileSync(join(home, 'config.toml'), 'model = "keep-this"\n');
    const path = await configure(join(home, 'agentprof'), home);
    expect(await configure(join(home, 'agentprof'), home)).toBe(path);
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('model = "keep-this"\n');
    expect(readFileSync(path, 'utf8')).toContain('log_user_prompt = false');
    await configure(join(home, 'agentprof'), home, 'codex-tracing.mjs', true);
    expect(readFileSync(path, 'utf8')).toContain('--auto-start');
    writeFileSync(path, '# user profile');
    await expect(configure(join(home, 'agentprof'), home)).rejects.toThrow('different settings');
    expect(stateDirectory(join(home, 'plugins/data/agent-plugins/hash'))).toBe(join(home, 'agentprof'));
  } finally {rmSync(home, {recursive: true, force: true});}
});

test('plugin routes late native exports to the primary session and children without copying unrelated sessions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-plugin-capture-'));
  let clock = Number(epoch / 1_000_000n);
  const mocked = spyOn(Date, 'now').mockImplementation(() => clock);
  try {
    const collector = new Collector(join(directory, 'state'), 20);
    const hook = (session_id: string, hook_event_name: string, data = {}) => collector.hook(
      {session_id, hook_event_name, cwd: directory, model: 'fixture-model', ...data}, process.pid, String(BigInt(clock) * 1_000_000n));
    await hook(rootSession, 'SessionStart');
    const control = await hook(rootSession, 'UserPromptSubmit', {prompt: 'tracing start test.pftrace'});
    expect(control).toMatchObject({decision: 'block'});
    clock += 10;
    await hook(rootSession, 'UserPromptSubmit', {prompt: 'Record this prompt', turn_id: 'turn-main'});
    clock += 240;
    await hook(rootSession, 'SubagentStart', {agent_id: childSession, agent_type: 'auditor'});
    clock += 750;
    const stopping = collector.stop(rootSession);
    expect(collector.status(rootSession).state).toBe('saving');
    for (const row of fixture().filter(row => row.source.startsWith('/v1/'))) collector.ingest(row.data);
    collector.ingest({resourceLogs: [{scopeLogs: [{logRecords: [log(500,
      '10000000-0000-4000-8000-000000000003', 'codex.user_prompt', {prompt: 'PRIVATE OTHER SESSION'})]}]}]});
    const result = await stopping;
    expect(result).toMatchObject({state: 'saved', sessions: 2, responses: 3, nestedTools: 1, inputTokens: 260, outputTokens: 14});
    const journal = readFileSync(join(directory, 'test.pftrace.capture/observations.jsonl'), 'utf8');
    expect(journal).not.toContain('PRIVATE OTHER SESSION');
    expect(journal).toContain('Record this prompt');
    expect(() => publish(join(directory, 'test.pftrace.capture'))).toThrow('Output already exists');
    expect(collector.status(rootSession).state).toBe('saved');
    expect(() => collector.start(rootSession, 'test.pftrace')).toThrow('Output already exists');
    collector.start(rootSession, 'second.pftrace');
    await collector.stop(rootSession);
    expect(existsSync(join(directory, 'second.pftrace'))).toBe(true);
  } finally {mocked.mockRestore(); rmSync(directory, {recursive: true, force: true});}
});

test('content opt-out strips Codex hooks and OTLP before the persistent journal and trace', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-no-content-'));
  const mocked = spyOn(Date, 'now').mockReturnValue(Number(epoch / 1_000_000n));
  try {
    const collector = new Collector(join(directory, 'state'), 0, false);
    await collector.hook({session_id: rootSession, hook_event_name: 'SessionStart', cwd: directory}, process.pid, at(0));
    await collector.hook({session_id: rootSession, hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_PROMPT', turn_id: 'turn-main'}, process.pid, at(10));
    collector.start(rootSession, 'private.pftrace');
    await collector.hook({session_id: rootSession, hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_use_id: 'call', tool_input: {command: 'PRIVATE_COMMAND'}}, process.pid, at(11));
    for (const row of fixture().filter(row => row.source.startsWith('/v1/'))) collector.ingest(row.data);
    await collector.stop(rootSession);
    const journal = readFileSync(join(directory, 'private.pftrace.capture/observations.jsonl'), 'utf8');
    const trace = readFileSync(join(directory, 'private.pftrace'));
    for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_COMMAND', 'Check the recorded fixture.', 'Process exited with code 7', 'Check the sum']) {
      expect(journal).not.toContain(secret);
      expect(trace.includes(secret)).toBe(false);
    }
    expect(journal).toContain('"capture_contents":false');
    expect(journal).toContain('"prompt_length":14');
  } finally {mocked.mockRestore(); rmSync(directory, {recursive: true, force: true});}
});

test('a shared Codex receiver honors a later session opt-out independently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-shared-policy-'));
  try {
    const collector = new Collector(join(directory, 'state'), 0);
    const other = childSession;
    await collector.hook({session_id: rootSession, hook_event_name: 'SessionStart', cwd: directory}, process.pid, at(0), false, true);
    collector.start(rootSession, 'enabled.pftrace', true);
    await collector.hook({session_id: other, hook_event_name: 'SessionStart', cwd: directory}, process.pid, at(0), false, false);
    collector.start(other, 'disabled.pftrace', false);
    await collector.hook({session_id: rootSession, hook_event_name: 'UserPromptSubmit', prompt: 'VISIBLE_A'}, process.pid, at(10), false, true);
    await collector.hook({session_id: other, hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_B'}, process.pid, at(10), false, false);
    await collector.stop(rootSession);
    await collector.stop(other);
    expect(readFileSync(join(directory, 'enabled.pftrace.capture/observations.jsonl'), 'utf8')).toContain('VISIBLE_A');
    const disabled = readFileSync(join(directory, 'disabled.pftrace.capture/observations.jsonl'), 'utf8');
    expect(disabled).not.toContain('PRIVATE_B');
    expect(disabled).toContain('"capture_contents":false');
    expect(readFileSync(join(directory, 'disabled.pftrace')).includes('PRIVATE_B')).toBe(false);
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test('session end saves automatically and compaction remains a measured span in Perfetto', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-plugin-end-'));
  const mocked = spyOn(Date, 'now').mockReturnValue(Number(epoch / 1_000_000n));
  try {
    const collector = new Collector(join(directory, 'state'), 0);
    await collector.hook({session_id: rootSession, hook_event_name: 'SessionStart', cwd: directory}, process.pid, at(0));
    collector.start(rootSession, 'exit.pftrace');
    await collector.hook({session_id: rootSession, hook_event_name: 'SessionEnd'}, process.pid, at(1000));
    expect(await collector.stop(rootSession)).toMatchObject({state: 'saved'});
    const rows = fixture();
    rows[0]!.data.recorder = 'codex-plugin-1'; rows[0]!.data.sessionId = rootSession;
    rows.push({source: 'codex.hook', timestamp: at(100), data: {session_id: rootSession, hook_event_name: 'PreCompact', trigger: 'auto'}});
    rows.push({source: 'codex.hook', timestamp: at(500), data: {session_id: rootSession, hook_event_name: 'PostCompact', trigger: 'auto'}});
    const trace = join(directory, 'compaction.pftrace');
    writeFileSync(trace, convertObservations(rows).trace);
    const sql = join(directory, 'check.sql');
    writeFileSync(sql, `${SETUP_SQL}\nSELECT COUNT(*) FROM agentprof_slices WHERE name='compaction' AND dur=400000000 AND incomplete=0;`);
    const check = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor'), [trace, '-q', sql], {encoding: 'utf8'});
    expect(check.status).toBe(0);
    expect(check.stdout.trim().split('\n').at(-1)).toBe('1');
  } finally {mocked.mockRestore(); rmSync(directory, {recursive: true, force: true});}
});

test('subagent tool hooks retain their own identity; separate primary recordings stay independent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-plugin-routing-'));
  const mocked = spyOn(Date, 'now').mockReturnValue(Number(epoch / 1_000_000n));
  try {
    const collector = new Collector(join(directory, 'state'), 0);
    const other = '10000000-0000-4000-8000-000000000003';
    for (const id of [rootSession, other]) {
      await collector.hook({session_id: id, hook_event_name: 'SessionStart', cwd: directory}, process.pid, at(0));
      collector.start(id, `${id}.pftrace`);
    }
    await collector.hook({session_id: rootSession, hook_event_name: 'SubagentStart', agent_id: childSession}, process.pid, at(0));
    await collector.hook({session_id: rootSession, hook_event_name: 'PreToolUse', agent_id: childSession,
      tool_name: 'Bash', tool_use_id: 'child-command', tool_input: {command: 'echo child'}}, process.pid, at(0));
    await expect(collector.stop(childSession)).rejects.toThrow('primary session');
    await collector.stop(rootSession);
    expect(collector.status(other).state).toBe('recording');
    await collector.stop(other);
    const rows = readFileSync(join(directory, `${rootSession}.pftrace.capture/observations.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const childHook = rows.find(row => row.source === 'codex.hook' && row.data.tool_use_id === 'child-command');
    expect(childHook.data).toMatchObject({session_id: childSession, parent_session: rootSession});
    expect(readFileSync(join(directory, `${other}.pftrace.capture/observations.jsonl`), 'utf8')).not.toContain('echo child');
  } finally {mocked.mockRestore(); rmSync(directory, {recursive: true, force: true});}
});

test('automatic capture starts once and compaction does not restart a manually stopped recording', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-plugin-auto-'));
  try {
    const collector = new Collector(join(directory, 'state'), 0);
    const hook = (source: string) => collector.hook({session_id: rootSession, hook_event_name: 'SessionStart', source, cwd: directory}, process.pid, String(BigInt(Date.now()) * 1_000_000n), true);
    await hook('startup');
    const output = collector.status(rootSession).output;
    await hook('compact');
    expect(collector.status(rootSession).output).toBe(output);
    await collector.stop(rootSession);
    await hook('compact');
    expect(collector.status(rootSession).state).toBe('saved');
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test('resuming a session updates its process and does not restart completed subagent captures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-plugin-resume-'));
  try {
    const collector = new Collector(join(directory, 'state'), 0);
    await collector.hook({session_id: rootSession, hook_event_name: 'SessionStart', cwd: directory}, 123456, at(0));
    await collector.hook({session_id: rootSession, hook_event_name: 'SubagentStart', agent_id: childSession}, 123456, at(0));
    await collector.hook({session_id: rootSession, hook_event_name: 'SubagentStop', agent_id: childSession}, 123456, at(1));
    await collector.hook({session_id: rootSession, hook_event_name: 'SessionEnd'}, 123456, at(2));
    await collector.hook({session_id: rootSession, hook_event_name: 'SessionStart', source: 'resume', cwd: directory}, process.pid, at(3));
    collector.start(rootSession, 'resumed.pftrace');
    const result = await collector.stop(rootSession);
    expect(result).toMatchObject({sessions: 1, state: 'saved'});
    const rows = readFileSync(join(directory, 'resumed.pftrace.capture/observations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows[0].data.pid).toBe(process.pid);
    expect(rows.some(row => row.data.session_id === childSession)).toBe(false);
  } finally {rmSync(directory, {recursive: true, force: true});}
});

test('prompt hooks exclude startup initialization and preserve partial recording boundaries', () => {
  for (const partial of [false, true]) {
    const rows = fixture();
    rows.push({source: 'codex.hook', timestamp: at(12), data: {
      session_id: rootSession, hook_event_name: 'UserPromptSubmit', turn_id: 'turn-main', prompt: 'Recorded prompt',
      started_before_capture: partial,
    }}, {source: 'codex.hook', timestamp: at(900), data: {
      session_id: rootSession, hook_event_name: 'Stop', turn_id: 'turn-main',
    }});
    const {spans, logs} = readOtel(rows);
    addHooks(rows, spans, logs, BigInt(at(11)), BigInt(at(1000)));
    expect(spans.get('root:prompt')).toMatchObject({start: BigInt(at(12)), end: BigInt(at(900)),
      attrs: {'capture.incomplete': partial}});
    const prompts = logs.filter(log => log.attrs['event.name'] === 'codex.user_prompt' && log.attrs['conversation.id'] === rootSession);
    expect(prompts.length).toBe(1);
    expect(prompts[0]!.attrs.prompt).toBe('Recorded prompt');
  }
});

test('typed recording controls do not leave an orphan prompt or an incomplete turn', () => {
  const rows = fixture();
  rows.push({source: 'codex.control', timestamp: at(15), data: {
    session_id: rootSession, turn_id: 'turn-main', action: 'stop', prompt_length: 12,
  }});
  const {spans, logs} = readOtel(rows);
  logs.find(log => log.attrs['event.name'] === 'codex.user_prompt' && log.attrs['conversation.id'] === rootSession)!.attrs.prompt_length = '12';
  addHooks(rows, spans, logs, BigInt(at(0)), BigInt(at(1000)));
  expect(spans.has('root:prompt')).toBe(false);
  expect(logs.filter(log => log.attrs['event.name'] === 'codex.user_prompt').map(log => log.attrs['conversation.id'])).toEqual([childSession]);
});

test('a truncated crash journal can be recovered without overwriting another recording', () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-plugin-recovery-'));
  try {
    const rows = fixture().filter(row => row.source !== 'process_end');
    rows[0]!.data.recorder = 'codex-plugin-1'; rows[0]!.data.sessionId = rootSession;
    const trace = join(directory, 'recovered.pftrace');
    writeFileSync(join(directory, 'observations.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n{"source":');
    expect(publish(directory, trace)).toMatchObject({output: trace, sessions: 2, responses: 3});
    const sql = join(directory, 'check.sql');
    writeFileSync(sql, `${SETUP_SQL}\nSELECT COUNT(*) FROM agentprof_slices WHERE kind='capture' AND incomplete=1;`);
    const check = spawnSync(process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor'), [trace, '-q', sql], {encoding: 'utf8'});
    expect(check.status).toBe(0);
    expect(Number(check.stdout.trim().split('\n').at(-1))).toBeGreaterThan(0);
    expect(() => publish(directory, trace)).toThrow('Output already exists');
  } finally {rmSync(directory, {recursive: true, force: true});}
});
