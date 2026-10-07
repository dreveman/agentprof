// SPDX-License-Identifier: Apache-2.0
// Check owned source and distribution metadata; dependency licenses remain their own.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {extname} from 'node:path';

const files = execFileSync('git', ['ls-files', '-z'], {encoding: 'utf8'}).split('\0').filter(Boolean);
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.scss', '.css', '.sh', '.sql', '.proto', '.html', '.svg']);
const headers = new Set([
  '// SPDX-License-Identifier: Apache-2.0', '# SPDX-License-Identifier: Apache-2.0',
  '/* SPDX-License-Identifier: Apache-2.0 */', '<!-- SPDX-License-Identifier: Apache-2.0 -->',
  '-- SPDX-License-Identifier: Apache-2.0',
]);
const missing = [];
let sources = 0;
for (const file of files) {
  if (!extensions.has(extname(file)) && file !== 'tools/perfetto') continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const header = lines[lines[0].startsWith('#!') ? 1 : 0]?.trim();
  if (!headers.has(header)) missing.push(file);
  sources++;
}
assert.deepEqual(missing, [], 'First-party source files need an Apache-2.0 SPDX header after any shebang');

const json = file => JSON.parse(readFileSync(file, 'utf8'));
const lock = json('package-lock.json');
for (const [file, key] of [['package.json', ''], ['packages/pi-tracing/package.json', 'packages/pi-tracing']]) {
  assert.equal(json(file).license, 'Apache-2.0', file);
  assert.equal(lock.packages[key].license, 'Apache-2.0', `Lockfile metadata for ${file}`);
}
for (const file of files.filter(file => file.endsWith('/plugin.json'))) {
  const license = json(file).license;
  if (license !== undefined) assert.equal(license, 'Apache-2.0', file);
}
const license = readFileSync('LICENSE', 'utf8');
assert.ok(license.includes('Version 2.0, January 2004'), 'Root license is Apache-2.0');
for (const directory of ['pi-tracing', 'claude-tracing', 'claude-tracing/legacy', 'codex-tracing', 'muse-tracing']) {
  const file = `packages/${directory}/LICENSE`;
  assert.equal(readFileSync(file, 'utf8'), license, `${file} must ship the full Apache license`);
}
console.log(`PASS Apache-2.0 licensing: ${sources} source files, package metadata and distributable plugin licenses`);
