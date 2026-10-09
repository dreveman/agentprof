// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {tracePackets, decodeFields} from './test-proto.ts';

test('Pi recorder starts, records and publishes under the Node runtime on PATH', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentprof-node-recorder-'));
  try {
    const module = (name: string) => JSON.stringify(resolve(import.meta.dir, name));
    const entry = join(directory, 'entry.ts');
    await writeFile(entry, `
      import assert from 'node:assert/strict';
      import {Recorder} from ${module('tracer.ts')};
      import {defaultConfig} from ${module('config.ts')};
      import {probeCryptoRandom} from ${module('probe.ts')};
      import {randomCorrelationId} from ${module('workflow.ts')};
      import {randomFlowId} from ${module('tracks.ts')};
      const config = defaultConfig(); config.sampleHz = 0; config.finalizeDeadlineMs = 5000;
      assert.equal(probeCryptoRandom().ok, true);
      assert.match(randomCorrelationId(), /^[a-f0-9]{8}$/);
      const recorder = new Recorder({config, outDir: process.argv[2], sessionTag: 'node-fixture',
        identity: {pid: process.pid, processName: 'pi', labels: []}});
      assert.equal((await recorder.start()).started, true);
      const span = recorder.beginSlice({cat: 'agent', name: 'prompt',
        trackUuid: recorder.trackSet().sessionUuid, flowIds: [randomFlowId(new Set())]});
      assert.notEqual(span, null); recorder.emitEnd(span);
      const result = await recorder.stop('test');
      assert.ok(result.path.endsWith('.pftrace'));
      console.log(JSON.stringify({path: result.path, node: process.version}));
    `);
    const build = await Bun.build({entrypoints: [entry], target: 'node', format: 'esm'});
    expect(build.success, String(build.logs)).toBe(true);
    const runtime = join(directory, 'recorder.mjs');
    await writeFile(runtime, await build.outputs[0]!.text());
    const run = spawnSync('node', [runtime, directory], {encoding: 'utf8', timeout: 15000});
    expect(run.status, run.stderr).toBe(0);
    const manifest = JSON.parse(run.stdout);
    const packets = tracePackets(await readFile(manifest.path));
    expect(packets.length).toBeGreaterThan(1);
    expect(packets.some(packet => decodeFields(packet).some(field => field.number === 6))).toBe(true);
    expect(packets.some(packet => decodeFields(packet).some(field => field.number === 60))).toBe(true);
    expect(packets.some(packet => decodeFields(packet).some(field => field.number === 11))).toBe(true);
  } finally {await rm(directory, {recursive: true, force: true});}
}, 20000);
