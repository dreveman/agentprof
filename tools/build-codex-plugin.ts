// SPDX-License-Identifier: Apache-2.0
import {resolve} from 'node:path';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
const result = await Bun.build({entrypoints: [resolve('packages/codex-tracing/plugin.ts')], target: 'node', format: 'esm'});
if (!result.success) throw new Error(result.logs.join('\n'));
const text = '#!/usr/bin/env node\n' + await result.outputs[0]!.text();
const path = resolve('packages/codex-tracing/runtime/codex-tracing.mjs');
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== text) throw new Error('Codex plugin bundle is stale. Run npm run build:codex.');
} else {
  mkdirSync(resolve('packages/codex-tracing/runtime'), {recursive: true});
  writeFileSync(path, text, {mode: 0o755});
}
