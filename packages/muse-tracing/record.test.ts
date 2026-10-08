// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {mkdtemp, mkdir, writeFile, readFile, rm, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {atomicJson, control, hook, readJson, statePath, watch, ensureWatcher} from './record.ts';
import {processStartMarker} from '../agent-tracing/process-identity.ts';

const session = '11111111-1111-4111-8111-111111111111';
const linuxTest = process.platform === 'linux' ? test : test.skip;
async function setup() {
  const temporary = await mkdtemp(join(tmpdir(), 'muse-plugin-')), data = join(temporary, 'muse/plugins/data/agentprof');
  await mkdir(data, {recursive: true});
  await atomicJson(join(data, 'catalog.json'), {at: Date.now(), models: [{model: 'test', provider: 'meta', context: 1000}]});
  await hook(data, {hook_event_name: 'SessionStart', session_id: session, cwd: temporary, model: 'test', model_provider: 'meta'}, process.pid);
  const binary = join(temporary, 'fake-muse');
  await writeFile(binary, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.argv[process.argv.indexOf('--out')+1],JSON.stringify({export_schema_version:1, diagnostics:{}, sessions:[{session_id:${JSON.stringify(session)}}], events:[{kind:'record',envelope:{id:'record',stream:{id:${JSON.stringify(session)}},recorded_at:Date.now()*1000,payload:{kind:'session_end',record:{exit_reason:'clean'}}}}]}));\n`, {mode: 0o700});
  await chmod(binary, 0o700);
  const info = await readJson(statePath(data, session)); info.binary = binary; await atomicJson(statePath(data, session), info);
  return {temporary, data};
}
test('manual controls return paths, are idempotent and save on session exit without overwrites', async () => {
  const {temporary, data} = await setup();
  try {
    const started = await hook(data, {hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'tracing start trace.pftrace'}, process.pid);
    expect(started.decision).toBe('block');
    expect(started.reason).toContain(join(temporary, 'trace.pftrace'));
    const first = await control(data, session, 'status');
    expect(await control(data, session, 'start', 'different.pftrace')).toEqual(first);
    await hook(data, {hook_event_name: 'PreLLMCall', session_id: session, model: 'test', model_provider: 'meta', options: {'meta.reasoning.effort': 'high'}, messages: [{text: 'not copied'}]}, process.pid);
    const recorded = await readFile(statePath(data, session), 'utf8');
    expect(recorded).not.toContain('not copied'); expect(recorded).toContain('high');
    const end = await hook(data, {hook_event_name: 'SessionEnd', session_id: session}, process.pid);
    expect(end.systemMessage).toContain('trace saved');
    expect((await readFile(join(temporary, 'trace.pftrace'))).length).toBeGreaterThan(0);
    expect((await control(data, session, 'stop')).state).toBe('saved');
    await expect(control(data, session, 'start', 'trace.pftrace')).rejects.toThrow('already exists');
    await expect(control(data, '../bad', 'start')).rejects.toThrow('valid session');
  } finally {await rm(temporary, {recursive: true, force: true});}
});
test('content policy is persisted at Muse capture start for export and recovery', async () => {
  const {temporary, data} = await setup();
  try {
    await atomicJson(join(data, 'config.json'), {capture_contents: false});
    await control(data, session, 'start', 'metadata.pftrace');
    expect((await readJson(statePath(data, session))).capture.capture_contents).toBe(false);
    await control(data, session, 'stop');
    expect((await readFile(join(temporary, 'metadata.pftrace'))).length).toBeGreaterThan(0);
  } finally {await rm(temporary, {recursive: true, force: true});}
});

test('failed publication keeps the capture and stop boundary for a retry', async () => {
  const {temporary, data} = await setup();
  try {
    await control(data, session, 'start', 'trace.pftrace');
    await writeFile(join(temporary, 'trace.pftrace'), 'keep');
    await expect(control(data, session, 'stop')).rejects.toThrow();
    expect(await readFile(join(temporary, 'trace.pftrace'), 'utf8')).toBe('keep');
    const first = await readJson(statePath(data, session)); expect(first.capture).toBeDefined();
    expect((await control(data, session, 'status')).state).toBe('pending');
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(control(data, session, 'stop')).rejects.toThrow();
    expect((await readJson(statePath(data, session))).capture.end).toBe(first.capture.end);
  } finally {await rm(temporary, {recursive: true, force: true});}
});
test('MCP tools use the host session identity and cannot select another session', async () => {
  const {temporary, data} = await setup();
  const host = spawn('node', [resolve('packages/muse-tracing/runtime/muse-tracing.mjs'), 'mcp'], {
    env: {...process.env, MUSE_PLUGIN_DATA_DIR: data, MUSE_SESSION_ID: session}, stdio: ['pipe', 'pipe', 'pipe']});
  const pending = new Map<number, (r: any) => void>(); let id = 0;
  const lines = createInterface({input: host.stdout});
  lines.on('line', line => {const m = JSON.parse(line); pending.get(m.id)?.(m.result); pending.delete(m.id);});
  const call = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
    const number = ++id, timer = setTimeout(() => reject(new Error('MCP timed out')), 5000);
    pending.set(number, r => {clearTimeout(timer); resolve(r);}); host.stdin.write(JSON.stringify({jsonrpc: '2.0', id: number, method, params}) + '\n');
  });
  try {
    await call('initialize');
    expect((await call('tools/list')).tools.map((t: any) => t.name)).toEqual(['tracing_start', 'tracing_stop', 'tracing_status']);
    expect((await call('tools/call', {name: 'tracing_start', arguments: {session_id: 'another'}})).isError).toBe(true);
    const result = await call('tools/call', {name: 'tracing_start', arguments: {output_path: 'mcp.pftrace'}});
    expect(JSON.parse(result.content[0].text)).toMatchObject({state: 'recording', session_id: session});
    const stop = await call('tools/call', {name: 'tracing_stop', arguments: {}});
    expect(JSON.parse(stop.content[0].text).state).toBe('saved');
  } finally {host.stdin.end(); host.kill(); lines.close(); await rm(temporary, {recursive: true, force: true});}
});
test('process-exit fallback saves when the host omits SessionEnd and ignores later capture generations', async () => {
  const {temporary, data} = await setup();
  const host = spawn('node', ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'});
  await new Promise<void>((resolve, reject) => {host.once('spawn', resolve); host.once('error', reject);});
  try {
    const record = await readJson(statePath(data, session)); record.pid = host.pid;
    record.processStartMarker = processStartMarker(host.pid!); await atomicJson(statePath(data, session), record);
    await control(data, session, 'start', 'first.pftrace');
    const first = watch(data, session);
    await new Promise(resolve => setTimeout(resolve, 20));
    await control(data, session, 'stop');
    await control(data, session, 'start', 'second.pftrace');
    await first;
    expect((await control(data, session, 'status')).state).toBe('recording');
    const second = watch(data, session);
    const exited = new Promise(resolve => host.once('exit', resolve)); host.kill(); await exited;
    await second;
    expect((await control(data, session, 'status')).state).toBe('saved');
    expect((await readFile(join(temporary, 'second.pftrace'))).length).toBeGreaterThan(0);
  } finally {host.kill(); await rm(temporary, {recursive: true, force: true});}
});
linuxTest('Muse SessionStart detects a recycled host PID even when the numeric PID is unchanged', async () => {
  const {temporary, data} = await setup();
  try {
    const path = statePath(data, session);
    const first = await readJson(path); first.processStartMarker = '1'; await atomicJson(path, first);
    await hook(data, {hook_event_name: 'SessionStart', session_id: session, cwd: temporary}, process.pid);
    const refreshed = await readJson(path);
    expect(refreshed.processStartMarker).toBe(processStartMarker(process.pid));
    await control(data, session, 'start', 'reused.pftrace');
    const pending = await readJson(path); pending.processStartMarker = '1'; await atomicJson(path, pending);
    await expect(hook(data, {hook_event_name: 'SessionStart', session_id: session}, process.pid))
      .rejects.toThrow('needs recovery');
    expect((await readJson(path)).capture).toBeDefined();
  } finally {await rm(temporary, {recursive: true, force: true});}
});

linuxTest('Muse watcher finalizes when its recorded owner PID has a new start marker', async () => {
  const {temporary, data} = await setup();
  try {
    await control(data, session, 'start', 'owner-reused.pftrace');
    const path = statePath(data, session), record = await readJson(path);
    record.capture.processStartMarker = '1'; await atomicJson(path, record);
    await watch(data, session);
    expect((await control(data, session, 'status')).state).toBe('saved');
    // The retained native journal has a clean session_end, so watcher-based
    // finalization is complete despite the recycled numeric PID.
    expect((await readFile(join(temporary, 'owner-reused.pftrace'))).includes('incomplete')).toBe(false);
  } finally {await rm(temporary, {recursive: true, force: true});}
});

test('Muse retries a missing watcher on the next ordinary recorded hook without an idle lock', async () => {
  const {temporary, data} = await setup();
  try {
    let attempts = 0;
    await hook(data, {hook_event_name: 'PreLLMCall', session_id: session}, process.pid, async () => {attempts++;});
    expect(attempts).toBe(0);
    await control(data, session, 'start', 'retry.pftrace');
    await hook(data, {hook_event_name: 'PreLLMCall', session_id: session}, process.pid, async () => {attempts++;});
    expect(attempts).toBe(1);
    const path = statePath(data, session), record = await readJson(path);
    record.watcher = process.pid; record.watcherStartMarker = processStartMarker(process.pid); await atomicJson(path, record);
    await hook(data, {hook_event_name: 'PreLLMCall', session_id: session}, process.pid, async () => {attempts++;});
    expect(attempts).toBe(1);
    await control(data, session, 'stop');
  } finally {await rm(temporary, {recursive: true, force: true});}
});

linuxTest('Muse replaces a watcher whose PID was reused by another process', async () => {
  const {temporary, data} = await setup();
  let watcher: number | undefined;
  try {
    await control(data, session, 'start', 'watcher.pftrace');
    const path = statePath(data, session), record = await readJson(path);
    record.watcher = process.pid; record.watcherStartMarker = '1'; await atomicJson(path, record);
    await ensureWatcher(data, session, resolve('packages/muse-tracing/runtime/muse-tracing.mjs'));
    const replaced = await readJson(path); watcher = replaced.watcher;
    expect(watcher).not.toBe(process.pid);
    expect(replaced.watcherStartMarker).toBe(processStartMarker(watcher!));
    await control(data, session, 'stop');
  } finally {
    if (watcher) try {process.kill(watcher, 'SIGTERM');} catch {}
    await rm(temporary, {recursive: true, force: true});
  }
});

test('environment opt-in starts a native plugin recording without a configure command', async () => {
  const {temporary, data} = await setup();
  const child = '33333333-3333-4333-8333-333333333333';
  const previous = process.env.AGENTPROF_MUSE_AUTO_START;
  try {
    process.env.AGENTPROF_MUSE_AUTO_START = '1';
    const started = await hook(data, {hook_event_name: 'SessionStart', session_id: child, cwd: temporary,
      source: 'startup', model: 'test', model_provider: 'meta'}, process.pid);
    expect(started.systemMessage).toContain('Agent Profiler recording:');
    expect((await readJson(statePath(data, child))).capture).toBeDefined();
  } finally {
    if (previous === undefined) delete process.env.AGENTPROF_MUSE_AUTO_START;
    else process.env.AGENTPROF_MUSE_AUTO_START = previous;
    await rm(temporary, {recursive: true, force: true});
  }
});

test('automatic recording does not create separate recordings for subagents or forks', async () => {
  const {temporary, data} = await setup(), child = '22222222-2222-4222-8222-222222222222';
  try {
    await atomicJson(join(data, 'config.json'), {auto_start: true});
    await hook(data, {hook_event_name: 'SubagentStart', session_id: session, child_session_id: child}, process.pid);
    await hook(data, {hook_event_name: 'SessionStart', session_id: child, source: 'startup'}, process.pid);
    const record = await readJson(statePath(data, child));
    expect(record.parentSession).toBe(session); expect(record.capture).toBeUndefined();
    await hook(data, {hook_event_name: 'SessionStart', session_id: session, source: 'fork'}, process.pid);
    expect((await control(data, session, 'status')).state).toBe('idle');
    const multi = await hook(data, {hook_event_name: 'UserPromptSubmit', session_id: session, prompt: 'tracing start\nExplain this command.'}, process.pid);
    expect(multi).toEqual({});
  } finally {await rm(temporary, {recursive: true, force: true});}
});
