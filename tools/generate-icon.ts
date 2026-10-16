// SPDX-License-Identifier: Apache-2.0
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {AGENTPROF_ICON_SVG} from '../third_party/overlays/perfetto/ui/src/core/embedder/agentprof_icon';

const directory = resolve(import.meta.dir, '../third_party/overlays/perfetto/ui/src/assets');
const path = resolve(directory, 'agentprof-icon.svg');
const svg = '<!-- SPDX-License-Identifier: Apache-2.0 -->\n' + AGENTPROF_ICON_SVG + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== svg) throw new Error('Stale favicon; run bun tools/generate-icon.ts');
} else {
  await mkdir(directory, {recursive: true});
  await writeFile(path, svg);
}
