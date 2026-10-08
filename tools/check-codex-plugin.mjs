// SPDX-License-Identifier: Apache-2.0
// Validate the installed package and native MCP discovery without model calls.
import assert from 'node:assert/strict';
import {access, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';

const home = await mkdtemp(join(tmpdir(), 'agentprof-codex-host-'));
const env = {...process.env, CODEX_HOME: home};
delete env.OPENAI_API_KEY;
delete env.CODEX_API_KEY;
const marketplace = resolve('.');
let host;
try {
  const addMarketplace = spawnSync('codex', ['plugin', 'marketplace', 'add', marketplace], {env, encoding: 'utf8'});
  assert.equal(addMarketplace.status, 0, addMarketplace.stderr || addMarketplace.stdout);
  const install = spawnSync('codex', ['plugin', 'add', 'agentprof@agentprof', '--json'], {env, encoding: 'utf8'});
  assert.equal(install.status, 0, install.stderr || install.stdout);
  assert.equal(JSON.parse(install.stdout).pluginId, 'agentprof@agentprof');
  await assert.rejects(access(join(home, 'agentprof.config.toml')), {code: 'ENOENT'});
  // No generated agentprof.config.toml: bundled hooks and MCP must both be
  // discoverable from the installed native plugin without any model call.
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
  let hostError = '';
  host.stderr.on('data', data => {hostError += data;});
  host.on('exit', (code, signal) => {if (code !== 0) console.error(`Host exited ${code ?? signal}: ${hostError}`);});
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
  assert.equal(ownHooks.length, 11, 'Native plugin exposes every bundled recording hook');
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
  console.log('PASS Codex marketplace installation, bundled hooks and MCP discovery without model credentials');
} finally {
  if (host) {
    if (host.exitCode === null && host.signalCode === null) {
      host.stdin.end();
      const timeout = setTimeout(() => host.kill('SIGKILL'), 3000);
      await new Promise(resolve => host.once('exit', resolve));
      clearTimeout(timeout);
    }
  }
  await rm(home, {recursive: true, force: true});
}
