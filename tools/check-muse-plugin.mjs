// SPDX-License-Identifier: Apache-2.0
// Credential-free native Muse package, marketplace and approval checks.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const temporary = mkdtempSync(join(tmpdir(), 'agentprof-muse-plugin-check-'));
const home = join(temporary, 'home'), data = join(temporary, 'data');
const config = join(temporary, 'config'), cache = join(temporary, 'cache');
const state = join(temporary, 'state'), runtime = join(temporary, 'runtime');
for (const directory of [home, data, config, cache, state, runtime]) mkdirSync(directory, {mode: 0o700});
const env = {...process.env, HOME: home, XDG_DATA_HOME: data, XDG_CONFIG_HOME: config,
  XDG_CACHE_HOME: cache, XDG_STATE_HOME: state, XDG_RUNTIME_DIR: runtime,
  MUSE_NO_AUTO_UPDATE: '1'};
// An inherited Muse-specific override must not escape the isolated test home.
for (const name of ['MUSE_HOME', 'MUSE_CONFIG_DIR', 'MUSE_PLUGIN_DATA_DIR']) delete env[name];
const call = (...args) => {
  const result = spawnSync('muse', ['plugins', ...args, '--json'], {encoding: 'utf8', env, timeout: 60000});
  assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
  return JSON.parse(result.stdout);
};
try {
  const manifest = call('validate', 'packages/muse-tracing');
  assert.equal(manifest.valid, true);
  assert.deepEqual(manifest.diagnostics, []);
  assert.equal(manifest.capabilities.hooks.length, 7);
  assert.equal(manifest.capabilities.mcp_servers.length, 1);
  const marketplace = call('marketplace', 'add', 'agentprof', resolve('.'));
  assert.equal(marketplace.marketplace.plugin_count, 1);
  const installed = call('install', 'agentprof@agentprof');
  const catalog = JSON.parse(readFileSync('marketplace.json', 'utf8'));
  assert.equal(installed.installed.package_sha256, catalog.plugins[0].integrity.digest);
  assert.equal(installed.plugin.capabilities.hooks.length, 7);
  assert.equal(installed.plugin.capabilities.mcp_servers.length, 1);
  const approved = call('approve', 'agentprof');
  assert.equal(approved.runtime_capabilities.length, 8);
  assert.ok(approved.runtime_capabilities.every(capability => capability.enabled && capability.trusted_definition_hash));
  console.log('PASS Muse native marketplace installation, digest, seven hooks, MCP and approval without model credentials');
} finally {rmSync(temporary, {recursive: true, force: true});}
