// SPDX-License-Identifier: Apache-2.0
// Exercise the distributable plugin with Claude's validator, mod host and installer.
import {cpSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'agentprof-claude-'));
const repository = join(directory, 'marketplace'), plugin = join(repository, 'packages/claude-tracing');
const run = (...args) => {
  const result = spawnSync(process.env.CLAUDE_BIN ?? 'claude', args, {
    cwd: directory, env: {...process.env, CLAUDE_CONFIG_DIR: join(directory, 'config')}, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`claude ${args.join(' ')} failed (${result.status})`);
};
try {
  mkdirSync(join(plugin, '.claude-plugin'), {recursive: true});
  for (const file of ['.claude-plugin/plugin.json', 'hooks', 'types', 'runtime', 'README.md'])
    cpSync(resolve(root, 'packages/claude-tracing', file), join(plugin, file), {recursive: true});
  cpSync(join(root, '.claude-plugin'), join(repository, '.claude-plugin'), {recursive: true});
  run('plugin', 'validate', '--strict', repository);
  run('plugin', 'validate', '--strict', plugin);
  run('plugin', 'marketplace', 'add', repository);
  run('plugin', 'install', 'agentprof@agentprof');
  // Native host tests go in the staged package; converter tests use Bun separately.
  cpSync(join(root, 'tests/claude-plugin'), join(plugin, 'tests'), {recursive: true});
  run('plugin', 'test', plugin);
  console.log('Claude plugin installation and native host checks passed.');
} finally {
  rmSync(directory, {recursive: true, force: true});
}
