// SPDX-License-Identifier: Apache-2.0
// Native package validation needs Muse, but no model call or credentials.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const result = spawnSync('muse', ['plugins', 'validate', 'packages/muse-tracing', '--json'],
  {encoding: 'utf8', env: {...process.env, MUSE_NO_AUTO_UPDATE: '1'}});
assert.equal(result.status, 0, result.stderr || result.stdout);
const manifest = JSON.parse(result.stdout);
assert.equal(manifest.valid, true);
assert.deepEqual(manifest.diagnostics, []);
assert.equal(manifest.capabilities.hooks.length, 7);
assert.equal(manifest.capabilities.mcp_servers.length, 1);
console.log('PASS Muse native plugin manifest, hook entrypoints and MCP packaging');
