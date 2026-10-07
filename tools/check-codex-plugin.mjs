// SPDX-License-Identifier: Apache-2.0
// Validate the installed package and native MCP discovery without model calls.
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';

const home = await mkdtemp(join(tmpdir(), 'agentprof-codex-host-'));
const env = {...process.env, CODEX_HOME: home};
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
const runtime = resolve('packages/codex-tracing/runtime/codex-tracing.mjs');
let host;
try {
  const install = spawnSync(process.execPath, [runtime, 'install'], {env, encoding: 'utf8'});
  assert.equal(install.status, 0, install.stderr || install.stdout);
  const base = await readFile(join(home, 'config.toml'), 'utf8');
  const profile = (await readFile(join(home, 'agentprof.config.toml'), 'utf8'))
    .replace('[plugins."agentprof@agentprof"]\nenabled = true\n\n', '');
  // app-server has no CLI profile flag. Load the generated profile in this
  // disposable test home; the user's configuration is never touched.
  await writeFile(join(home, 'config.toml'), `${base}\n${profile}`, {mode: 0o600});
  host = spawn('codex', ['app-server', '--stdio'], {env, stdio: ['pipe', 'pipe', 'pipe']});
  const pending = new Map();
  let serial = 0;
  const lines = createInterface({input: host.stdout});
  lines.on('line', line => {
    const message = JSON.parse(line), request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
  });
  host.stderr.resume();
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => {pending.delete(id); reject(new Error(`Timed out: ${method}`));}, 20000);
    pending.set(id, {resolve, reject, timer});
    host.stdin.write(JSON.stringify({id, method, params}) + '\n');
  });
  await call('initialize', {clientInfo: {name: 'agentprof-plugin-check', version: '1'}, capabilities: {experimentalApi: true}});
  host.stdin.write(JSON.stringify({method: 'initialized'}) + '\n');
  const hooks = await call('hooks/list', {cwds: [home]});
  const ownHooks = hooks.data[0].hooks.filter(hook => JSON.stringify(hook).includes('codex-tracing.mjs'));
  assert.equal(ownHooks.length, 11, 'Generated profile exposes every recording hook');
  assert.deepEqual(hooks.data[0].errors, []);
  const thread = await call('thread/start', {cwd: home, model: 'gpt-6-luna', approvalPolicy: 'never', sandbox: 'read-only'});
  assert.ok(thread.thread.id);
  let server;
  for (let attempt = 0; attempt < 40; attempt++) {
    server = (await call('mcpServerStatus/list')).data.find(item => item.name === 'tracing');
    if (server?.tools && Object.keys(server.tools).length) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.deepEqual(Object.keys(server?.tools ?? {}).sort(), ['tracing_start', 'tracing_status', 'tracing_stop']);
  assert.equal(server.pluginId, 'agentprof@agentprof');
  assert.equal(server.toolsError, null);
  console.log('PASS Codex plugin installation, profile hooks and native tool discovery without model credentials');
} finally {
  if (host) {
    host.stdin.end();
    const timeout = setTimeout(() => host.kill('SIGKILL'), 3000);
    await new Promise(resolve => host.once('exit', resolve));
    clearTimeout(timeout);
  }
  // The receiver now reserves the profile port between sessions; dispose the
  // disposable test home's detached receiver before removing its state.
  try {
    const owner = JSON.parse(await readFile(join(home, 'agentprof/receiver-owner.json'), 'utf8'));
    if (Number.isInteger(owner.pid) && owner.pid > 0) process.kill(owner.pid, 'SIGTERM');
  } catch {}
  await rm(home, {recursive: true, force: true});
}
