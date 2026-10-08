// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {spawn} from 'node:child_process';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {createHash, randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {readConnection} from './plugin-config.ts';

const runtime = resolve(import.meta.dir, 'runtime/codex-tracing.mjs');
const root = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
async function command(home: string, args: string[], input = '', env: NodeJS.ProcessEnv = process.env) {
  const child = spawn('node', [runtime, ...args], {cwd: home, env, stdio: ['pipe', 'pipe', 'pipe']});
  let output = '', error = '';
  child.stdout.on('data', part => {output += part;}); child.stderr.on('data', part => {error += part;});
  child.stdin.end(input);
  const code = await new Promise<number | null>((done, reject) => {
    const timeout = setTimeout(() => {child.kill('SIGKILL'); reject(new Error(`Hook timed out: ${error}`));}, 15000);
    child.once('error', reject); child.once('exit', code => {clearTimeout(timeout); done(code);});
  });
  return {code, output, error};
}
async function hook(home: string, data: Record<string, unknown>, env = process.env, auto = false) {
  const result = await command(home, ['hook', '--state', join(home, 'agentprof'), ...(auto ? ['--auto-start'] : [])],
    JSON.stringify({session_id: root, cwd: home, ...data}), env);
  expect(result.code, result.error).toBe(0);
  return JSON.parse(result.output);
}
async function saved(path: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(path) && existsSync(`${path}.capture/summary.json`)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Trace was not saved: ${path}`);
}

test('installation migrates an owned fixed exporter only after the old listener is gone', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-migrate-'));
  let blocker: ReturnType<typeof createServer> | undefined;
  try {
    const state = join(home, 'agentprof'), bin = join(home, 'bin'); mkdirSync(state); mkdirSync(bin);
    const lease = createServer();
    await new Promise<void>(done => lease.listen(0, '127.0.0.1', done));
    const address = lease.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
    const port = address.port, token = randomBytes(32).toString('hex');
    await new Promise<void>(done => lease.close(() => done()));
    writeFileSync(join(state, 'connection.json'), JSON.stringify({port, token}), {mode: 0o600});
    const profile = join(home, 'agentprof.config.toml');
    const old = `[otel]\nexporter = {otlp-http={endpoint="http://127.0.0.1:${port}/v1/logs"}}\n`;
    writeFileSync(profile, old, {mode: 0o600});
    writeFileSync(join(state, 'profile.sha256'), createHash('sha256').update(old).digest('hex'));
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nif [ "$2" = add ]; then echo '${JSON.stringify({installedPath: resolve(import.meta.dir)})}'; fi\n`, {mode: 0o755});
    const env = {...process.env, PATH: `${bin}:${process.env.PATH}`};
    blocker = createServer();
    await new Promise<void>((done, reject) => {blocker!.once('error', reject); blocker!.listen(port, '127.0.0.1', done);});
    const blocked = await command(home, ['install', '--state', state, '--migrate'], '', env);
    expect(blocked.code).toBe(1); expect(readFileSync(profile, 'utf8')).toBe(old);
    await new Promise<void>(done => blocker!.close(() => done())); blocker = undefined;
    const installed = await command(home, ['install', '--state', state, '--migrate'], '', env);
    expect(installed.code, installed.error).toBe(0);
    expect(readFileSync(profile, 'utf8')).not.toContain('[otel]');
    expect(readFileSync(profile, 'utf8')).toContain('[[hooks.SessionStart]]');
    expect(existsSync(join(state, 'connection.json'))).toBe(false);
  } finally {
    if (blocker) await new Promise<void>(done => blocker!.close(() => done()));
    rmSync(home, {recursive: true, force: true});
  }
}, 10000);

test('install refuses a different runtime while its old plugin receiver is live', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-upgrade-'));
  try {
    await hook(home, {hook_event_name: 'SessionStart', source: 'startup'});
    const state = join(home, 'agentprof'), before = readConnection(state);
    const altered = join(home, 'next-build.mjs');
    writeFileSync(altered, readFileSync(runtime, 'utf8') + '\n// simulated next build\n');
    const bin = join(home, 'bin'); mkdirSync(bin);
    const invoked = join(home, 'installer-invoked');
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\necho invoked > '${invoked}'\n`, {mode: 0o755});
    const upgrade = spawn('node', [altered, 'install', '--state', state], {cwd: home,
      env: {...process.env, PATH: `${bin}:${process.env.PATH}`}, stdio: ['ignore', 'pipe', 'pipe']});
    let error = ''; upgrade.stderr!.on('data', data => {error += data;});
    const code = await new Promise<number | null>(done => upgrade.once('exit', done));
    expect(code).toBe(1); expect(error).toContain('earlier plugin build');
    expect(existsSync(invoked)).toBe(false);
    expect(readConnection(state).generation).toBe(before.generation);
    await hook(home, {hook_event_name: 'SessionEnd'});
  } finally {rmSync(home, {recursive: true, force: true});}
}, 12000);

test('ordinary Codex hooks record without OTLP, a launcher, or a persistent receiver', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-only-'));
  try {
    await hook(home, {hook_event_name: 'SessionStart', source: 'startup', model: 'fixture-model'});
    const conn = readConnection(join(home, 'agentprof'));
    expect(conn.port).toBeUndefined();
    expect(conn.socket?.startsWith('/tmp/agentprof-codex-')).toBe(true);
    expect(statSync(join(home, 'agentprof')).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(conn.socket!)).mode & 0o777).toBe(0o700);
    expect(statSync(conn.socket!).mode & 0o777).toBe(0o600);
    const output = join(home, 'test.pftrace');
    expect((await hook(home, {hook_event_name: 'UserPromptSubmit', prompt: 'tracing start test.pftrace'})).decision).toBe('block');
    await hook(home, {hook_event_name: 'UserPromptSubmit', prompt: 'Review the code', turn_id: 'turn1'});
    await hook(home, {hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call1', tool_input: {command: 'echo hello'}});
    await hook(home, {hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call1', tool_response: {exit_code: 0}});
    await hook(home, {hook_event_name: 'SubagentStart', agent_id: childId, agent_type: 'reviewer'});
    await hook(home, {hook_event_name: 'SessionStart', session_id: childId, parent_session: root});
    await hook(home, {hook_event_name: 'UserPromptSubmit', session_id: childId, prompt: 'Review tests', turn_id: 'turn2'});
    await hook(home, {hook_event_name: 'SessionEnd', session_id: childId});
    await hook(home, {hook_event_name: 'SessionEnd'});
    await saved(output);
    expect(readFileSync(output).length).toBeGreaterThan(100);
    const summary = JSON.parse(readFileSync(`${output}.capture/summary.json`, 'utf8'));
    expect(summary).toMatchObject({sessions: 2, tools: 1});
    const connectionFile = join(home, 'agentprof/connection.json');
    for (let attempt = 0; attempt < 500 && (existsSync(conn.socket!) || existsSync(connectionFile)); attempt++)
      await Bun.sleep(10);
    expect(existsSync(conn.socket!)).toBe(false);
    expect(existsSync(connectionFile)).toBe(false);
  } finally {rmSync(home, {recursive: true, force: true});}
}, 30000);

test('a long Codex home still gets a bounded private recorder socket', async () => {
  const base = mkdtempSync(join(tmpdir(), 'codex-plugin-long-home-'));
  const home = join(base, 'nested-' + 'x'.repeat(120)); mkdirSync(home);
  try {
    await hook(home, {hook_event_name: 'SessionStart', source: 'startup'});
    const connection = readConnection(join(home, 'agentprof'));
    expect(connection.socket!.length).toBeLessThan(100);
    await hook(home, {hook_event_name: 'SessionEnd'});
  } finally {rmSync(base, {recursive: true, force: true});}
}, 12000);

test('automatic recording starts on the ordinary SessionStart hook', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-auto-'));
  try {
    const started = await hook(home, {hook_event_name: 'SessionStart', source: 'startup'}, process.env, true);
    expect(started.systemMessage).toContain('recording to');
    const path = started.systemMessage.split('recording to ')[1];
    await hook(home, {hook_event_name: 'SessionEnd'});
    await saved(path);
    expect(readFileSync(path).length).toBeGreaterThan(100);
  } finally {rmSync(home, {recursive: true, force: true});}
}, 15000);

test('concurrent unrelated Codex sessions keep separate private captures', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-parallel-'));
  try {
    await Promise.all([root, childId].map(session_id =>
      hook(home, {hook_event_name: 'SessionStart', source: 'startup', session_id})));
    const connection = readConnection(join(home, 'agentprof'));
    await Promise.all([root, childId].map((session_id, index) => hook(home,
      {hook_event_name: 'UserPromptSubmit', session_id, prompt: `tracing start separate-${index}.pftrace`})));
    await hook(home, {hook_event_name: 'UserPromptSubmit', session_id: root, prompt: 'ONLY_ROOT'});
    await hook(home, {hook_event_name: 'UserPromptSubmit', session_id: childId, prompt: 'ONLY_OTHER'});
    await Promise.all([root, childId].map(session_id => hook(home, {hook_event_name: 'SessionEnd', session_id})));
    for (const index of [0, 1]) await saved(join(home, `separate-${index}.pftrace`));
    const first = readFileSync(join(home, 'separate-0.pftrace.capture/observations.jsonl'), 'utf8');
    const second = readFileSync(join(home, 'separate-1.pftrace.capture/observations.jsonl'), 'utf8');
    expect(first).toContain('ONLY_ROOT'); expect(first).not.toContain('ONLY_OTHER');
    expect(second).toContain('ONLY_OTHER'); expect(second).not.toContain('ONLY_ROOT');
    expect(readConnection(join(home, 'agentprof')).generation).toBe(connection.generation);
  } finally {rmSync(home, {recursive: true, force: true});}
}, 20000);

test('a hook retries across idle receiver socket teardown without sending to an old endpoint', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-restart-'));
  try {
    await hook(home, {hook_event_name: 'SessionStart', source: 'startup'});
    await hook(home, {hook_event_name: 'SessionEnd'});
    const old = readConnection(join(home, 'agentprof'));
    unlinkSync(old.socket!); // Simulate the listener disappearing just after owner inspection.
    await Bun.sleep(1200);
    const restarted = await hook(home, {hook_event_name: 'SessionStart', source: 'resume'});
    expect(restarted.systemMessage).toBeUndefined();
    const next = readConnection(join(home, 'agentprof'));
    expect(next.generation).not.toBe(old.generation);
    await hook(home, {hook_event_name: 'SessionEnd'});
  } finally {rmSync(home, {recursive: true, force: true});}
}, 20000);

test('an abruptly exiting Codex host finalizes an incomplete trace and releases its socket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-crash-'));
  let host: ReturnType<typeof spawn> | undefined;
  try {
    const script = join(home, 'fake-host.mjs');
    writeFileSync(script, `import {spawnSync} from 'node:child_process';
const runtime = process.env.AGENTPROF_RUNTIME, home = process.cwd(), state = home + '/agentprof';
const send = data => {
  const r = spawnSync(process.execPath, [runtime,'hook','--state',state],
    {encoding:'utf8',input:JSON.stringify({session_id:'${root}',cwd:home,...data})});
  if (r.status !== 0 || JSON.parse(r.stdout).systemMessage) throw new Error(r.stderr+r.stdout);
};
send({hook_event_name:'SessionStart',source:'startup'});
send({hook_event_name:'UserPromptSubmit',prompt:'tracing start crash.pftrace'});
console.log('CAPTURE_STARTED');
setInterval(()=>{},1000);
`);
    host = spawn('node', [script], {cwd: home, env: {...process.env, AGENTPROF_RUNTIME: runtime},
      stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', error = '';
    host.stdout!.on('data', data => {output += data;}); host.stderr!.on('data', data => {error += data;});
    for (let attempt = 0; attempt < 500 && !output.includes('CAPTURE_STARTED'); attempt++) await Bun.sleep(10);
    expect(output, error).toContain('CAPTURE_STARTED');
    const socket = readConnection(join(home, 'agentprof')).socket!;
    host.kill('SIGKILL');
    await saved(join(home, 'crash.pftrace'));
    expect(readFileSync(join(home, 'crash.pftrace.capture/observations.jsonl'), 'utf8')).toContain('"incomplete":true');
    for (let attempt = 0; attempt < 500 && existsSync(socket); attempt++) await Bun.sleep(10);
    expect(existsSync(socket)).toBe(false);
  } finally {if (host && host.exitCode === null) host.kill('SIGKILL'); rmSync(home, {recursive: true, force: true});}
}, 20000);

test('plugin-only recording imports real transcript usage without native telemetry', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-transcript-'));
  try {
    const transcript = join(home, 'session.jsonl');
    await hook(home, {hook_event_name: 'SessionStart', source: 'startup', transcript_path: transcript});
    await hook(home, {hook_event_name: 'UserPromptSubmit', prompt: 'tracing start tokens.pftrace'});
    await hook(home, {hook_event_name: 'UserPromptSubmit', prompt: 'Inspect the files', turn_id: 'turn1'});
    const timestamp = new Date().toISOString();
    const rows = [
      {type: 'session_meta', timestamp, payload: {id: root, model_provider: 'OpenAI', cli_version: '0.160.0'}},
      {type: 'turn_context', timestamp, payload: {model: 'fixture-model', effort: 'high', turn_id: 'turn1'}},
      {type: 'token_usage_record', timestamp, payload: {thread_id: root, turn_id: 'turn1'}},
      {type: 'event_msg', timestamp, payload: {type: 'token_count', info: {model_context_window: 200000,
        last_token_usage: {input_tokens: 120, output_tokens: 10, cached_input_tokens: 20}}}},
    ];
    writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    await hook(home, {hook_event_name: 'SessionEnd'});
    const output = join(home, 'tokens.pftrace'); await saved(output);
    const summary = JSON.parse(readFileSync(`${output}.capture/summary.json`, 'utf8'));
    expect(summary).toMatchObject({responses: 1, inputTokens: 120, outputTokens: 10, unmeasuredResponses: 1});
    const journal = readFileSync(`${output}.capture/observations.jsonl`, 'utf8');
    expect(journal).toContain('Inspect the files'); // Only the in-window hook prompt carries text.
    expect(journal).toContain('"model_context_window":200000');
  } finally {rmSync(home, {recursive: true, force: true});}
}, 15000);

test('metadata-only plugin hooks never persist prompt or tool values', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-private-'));
  const env = {...process.env, AGENTPROF_CAPTURE_CONTENTS: '0'};
  try {
    await hook(home, {hook_event_name: 'SessionStart', source: 'startup'}, env);
    await hook(home, {hook_event_name: 'UserPromptSubmit', prompt: 'tracing start secret.pftrace'}, env);
    await hook(home, {hook_event_name: 'UserPromptSubmit', prompt: 'PRIVATE_PROMPT', turn_id: 'turn1'}, env);
    await hook(home, {hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call1',
      tool_input: {command: 'PRIVATE_COMMAND'}}, env);
    await hook(home, {hook_event_name: 'SessionEnd'}, env);
    const output = join(home, 'secret.pftrace'); await saved(output);
    const journal = readFileSync(`${output}.capture/observations.jsonl`, 'utf8');
    expect(journal).not.toContain('PRIVATE_PROMPT');
    expect(journal).not.toContain('PRIVATE_COMMAND');
    expect(readFileSync(output).includes('PRIVATE_PROMPT')).toBe(false);
  } finally {rmSync(home, {recursive: true, force: true});}
}, 30000);

test('Codex MCP tools use its host-supplied session without a supervised launcher', async () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-plugin-mcp-'));
  try {
    await hook(home, {hook_event_name: 'SessionStart', source: 'startup'});
    const pluginData = join(home, 'plugins/data/agent-plugins/hash');
    const call = {jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {name: 'tracing_start', _meta: {threadId: root}, arguments: {output_path: 'mcp.pftrace'}}};
    const result = await command(home, ['mcp', '--plugin-data', pluginData], JSON.stringify(call) + '\n');
    expect(result.code, result.error).toBe(0);
    expect(result.output).toContain('recording');
    await hook(home, {hook_event_name: 'SessionEnd'});
    await saved(join(home, 'mcp.pftrace'));
  } finally {rmSync(home, {recursive: true, force: true});}
}, 30000);
