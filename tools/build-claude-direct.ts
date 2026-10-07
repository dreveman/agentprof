// SPDX-License-Identifier: Apache-2.0
import {resolve} from 'node:path';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
const build = await Bun.build({entrypoints: [resolve('packages/claude-tracing/direct-writer.ts')], target: 'node', format: 'esm'});
if (!build.success) throw new Error(build.logs.join('\n'));
for (const output of build.outputs) {
  const text = '// SPDX-License-Identifier: Apache-2.0\n' + await output.text();
  const path = resolve('packages/claude-tracing/runtime/direct-writer.mjs');
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== text) throw new Error('Claude writer bundle is stale. Run npm run build:claude.');
  } else {
    mkdirSync(resolve('packages/claude-tracing/runtime'), {recursive: true});
    writeFileSync(path, text);
  }
}
