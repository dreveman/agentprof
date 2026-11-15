// SPDX-License-Identifier: Apache-2.0
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {AGENTPROF_ICON_SVG} from '../third_party/overlays/perfetto/ui/src/core/embedder/agentprof_icon';

const directory = resolve(import.meta.dir, '../third_party/overlays/perfetto/ui/src/assets');
const path = resolve(directory, 'agentprof-icon.svg');
const svg = '<!-- SPDX-License-Identifier: Apache-2.0 -->\n' + AGENTPROF_ICON_SVG + '\n';

const iosMarkDirectory = resolve(
  import.meta.dir,
  '../ios/AgentProf/Resources/Assets.xcassets/AgentProfMark.imageset',
);
const iosMarkPath = resolve(iosMarkDirectory, 'AgentProfMark.svg');
const iosMarkSvg =
  '<!-- SPDX-License-Identifier: Apache-2.0 -->\n' +
  AGENTPROF_ICON_SVG.replace('<svg ', '<svg width="22" height="22" ') +
  '\n';

const iosAppIconDirectory = resolve(
  import.meta.dir,
  '../ios/AgentProf/Resources/Assets.xcassets/AppIcon.appiconset',
);
const iosAppIconPath = resolve(iosAppIconDirectory, 'AppIcon.png');

if (process.argv.includes('--check')) {
  if ((await readFile(path, 'utf8')) !== svg) {
    throw new Error('Stale favicon; run bun tools/generate-icon.ts');
  }
  if ((await readFile(iosMarkPath, 'utf8')) !== iosMarkSvg) {
    throw new Error('Stale iOS mark; run bun tools/generate-icon.ts');
  }
  const iconStat = await stat(iosAppIconPath);
  if (iconStat.size < 1024) {
    throw new Error('Missing iOS AppIcon.png; run bun tools/generate-icon.ts --app-icon');
  }
} else {
  await mkdir(directory, {recursive: true});
  await writeFile(path, svg);
  await mkdir(iosMarkDirectory, {recursive: true});
  await writeFile(iosMarkPath, iosMarkSvg);
  if (process.argv.includes('--app-icon')) {
    const require = createRequire(
      resolve(import.meta.dir, '../third_party/src/perfetto/ui/package.json'),
    );
    const {chromium} = require('@playwright/test');
    const browser = await chromium.launch({headless: true});
    try {
      const page = await browser.newPage({
        viewport: {width: 1024, height: 1024},
        deviceScaleFactor: 1,
      });
      const inlineSvg = AGENTPROF_ICON_SVG.replace(
        '<svg ',
        '<svg width="760" height="760" ',
      );
      await page.setContent(`<!doctype html><html><body style="margin:0;width:1024px;height:1024px;display:flex;align-items:center;justify-content:center;background:radial-gradient(circle at 50% 35%, #192847 0%, #0d1424 72%, #090e1a 100%);"><div style="width:760px;height:760px;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 28px 44px rgba(0,0,0,0.45));">${inlineSvg}</div></body></html>`);
      const png = await page.screenshot({type: 'png', omitBackground: false});
      await mkdir(iosAppIconDirectory, {recursive: true});
      await writeFile(iosAppIconPath, png);
    } finally {
      await browser.close();
    }
  }
}
