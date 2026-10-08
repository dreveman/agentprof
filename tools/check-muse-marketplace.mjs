// SPDX-License-Identifier: Apache-2.0
// Muse marketplace integrity covers every byte of the installed native bundle.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const root = resolve('packages/muse-tracing');
const marketplacePath = resolve('marketplace.json');
const catalog = JSON.parse(readFileSync(marketplacePath, 'utf8'));
const entry = catalog.plugins?.find(plugin => plugin.name === 'agentprof');
const manifest = JSON.parse(readFileSync(join(root, '.muse-plugin/plugin.json'), 'utf8'));
assert.equal(catalog.schemaVersion, 1);
assert.equal(catalog.source, 'local');
assert.equal(entry?.name, manifest.name);
assert.equal(entry?.version, manifest.version);
assert.deepEqual(entry?.install, {transport: 'local-path', source: './packages/muse-tracing'});
assert.equal(entry?.availability?.status, 'available');

function files(directory, prefix = '') {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const path = join(directory, entry.name), relative = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Muse package cannot contain a symlink: ${relative}`);
    if (entry.isDirectory()) return files(path, `${relative}/`);
    if (!entry.isFile()) throw new Error(`Unsupported Muse package entry: ${relative}`);
    return [[relative, path]];
  });
}
const hash = createHash('sha256');
for (const [relative, path] of files(root).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
  hash.update(relative); hash.update(Buffer.from([0]));
  hash.update(readFileSync(path)); hash.update(Buffer.from([0xff]));
}
const digest = `sha256:${hash.digest('hex')}`;
if (process.argv.includes('--update')) {
  entry.integrity.digest = digest;
  writeFileSync(marketplacePath, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Updated Muse marketplace digest: ${digest}`);
} else {
  assert.equal(entry?.integrity?.digest, digest,
    'Muse package changed: run node tools/check-muse-marketplace.mjs --update');
  console.log(`PASS Muse marketplace digest: ${digest}`);
}
