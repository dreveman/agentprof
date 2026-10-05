// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {SETUP_SQL} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';
import {CONTEXT_CATEGORIES} from '../packages/pi-tracing/extensions/pi-tracing/context.ts';

const binary = process.env.PERFETTO_TRACE_PROCESSOR ?? resolve('third_party/src/perfetto/tools/trace_processor');
const categoryTracks = `name GLOB 'Context: *' OR name IN (${Object.values(CONTEXT_CATEGORIES).map(name => `'${name}'`).join(',')})`;
for (const directory of ['pi-opus-5', 'pi-codemode', 'harness-comparison', 'claude-coding', 'codex-coding', 'muse-coding']) {
  const source = `examples/${directory}`;
  const manifest = JSON.parse(readFileSync(`${source}/recording.json`, 'utf8'));
  const files: string[] = manifest.bundledFile ? [manifest.bundledFile]
    : [...new Set<string>(manifest.recordings.map((r: {file: string}) => r.file))];
  for (const file of files) {
    const sql = `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}\nSELECT
      (SELECT COUNT(*) FROM agentprof_capture_runs) =
        (SELECT COUNT(DISTINCT capture_id) FROM agentprof_context_snapshots),
      (SELECT COUNT(*) FROM agentprof_context_snapshots WHERE estimated_tokens > 0) > 0,
      (SELECT COUNT(*) FROM agentprof_context_changes WHERE NOT baseline AND delta_tokens > 0) > 0,
      (SELECT COUNT(*) FROM counter_track WHERE (${categoryTracks}) AND unit = 'tokens') > 0,
      NOT EXISTS (SELECT 1 FROM counter_track WHERE (${categoryTracks}) AND unit IS NOT 'tokens'),
      NOT EXISTS (SELECT 1 FROM (
        SELECT t.name, c.value, ROW_NUMBER() OVER(PARTITION BY c.track_id ORDER BY c.ts DESC) AS latest
        FROM counter c JOIN counter_track t ON t.id = c.track_id WHERE ${categoryTracks}
      ) WHERE latest = 1 AND value != 0),
      NOT EXISTS (SELECT 1 FROM stats WHERE (severity = 'error' OR name = 'track_event_parser_errors') AND value > 0);`;
    const result = spawnSync(binary, [`${source}/${file}`, '-Q', sql], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').at(-1), '1,1,1,1,1,1,1', `${directory}/${file}: ${result.stdout}`);
  }
}
console.log('PASS context data in every example: sessions, snapshots, additions, token units, final zeros and import health');
