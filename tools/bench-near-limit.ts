// SPDX-License-Identifier: Apache-2.0
// Generate a bounded, multi-process synthetic recording for Perfetto import/Overview profiling.
// Run: bun tools/bench-near-limit.ts [OUTPUT_DIR] [MAX_FILE_MB]
import {mkdtemp, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {Recorder} from '../packages/pi-tracing/extensions/pi-tracing/tracer.ts';
import {defaultConfig} from '../packages/pi-tracing/extensions/pi-tracing/config.ts';

const outDir = resolve(process.argv[2] ?? await mkdtemp(join(tmpdir(), 'agentprof-near-limit-')));
const maxFileMB = Number(process.argv[3] ?? 8);
if (!Number.isInteger(maxFileMB) || maxFileMB < 1 || maxFileMB > 1024) throw new Error('MAX_FILE_MB must be 1..1024');
await mkdir(outDir, {recursive: true});
const config = defaultConfig();
config.maxFileMB = maxFileMB; config.sampleHz = 0; config.finalizeDeadlineMs = 5000;
config.categories.runtime = false;
const make = (id: number, recordingDirectory?: string) => new Recorder({config: {...config, categories: {...config.categories}},
  outDir, sessionTag: `stress-${id}`, machineId: 42, collectChildren: true, recordingDirectory,
  identity: {pid: 200000 + id, processName: 'stress-pi', labels: [`session:stress-${id}`]}});
const owner = make(0);
if (!(await owner.start('near-limit')).started) throw new Error('Could not start owner');
const children = [make(1, owner.getRecordingDirectory()), make(2, owner.getRecordingDirectory()),
  make(3, owner.getRecordingDirectory())];
for (const child of children) if (!(await child.start()).started) throw new Error('Could not start child');
const payload = 'x'.repeat(4096);
const all = [owner, ...children];
// Aim near 90% of the configured cap, reserving estimated space for context
// rows/counters and publication descriptors. The output reports actual fill.
const contextSamples = Math.min(2500, maxFileMB * 300);
const targetEvents = Math.max(0, Math.floor((maxFileMB * 1024 * 1024 * 0.90 - contextSamples * 325 - 64 * 1024)
  / (payload.length + 125)));
for (let i = 0; i < targetEvents; i++) {
  const recorder = all[i % all.length]!;
  if (!recorder.emitInstant({cat: 'agent', trackUuid: recorder.trackSet()!.sessionUuid,
    name: 'synthetic-work', annotations: {payload, index: i}})) throw new Error(`Event ${i} dropped before target`);
  if (i % 40 === 39) await Bun.sleep(2); // Let bounded writers drain rather than measuring JS burst drops.
}
for (let i = 0; i < contextSamples; i++) {
  const recorder = all[i % all.length]!;
  const value = 100 + i;
  if (!recorder.emitInstant({cat: 'agent', trackUuid: recorder.trackSet()!.sessionUuid,
    name: 'context-sample', annotations: {context: {version: 1, stage: 'transcript-observed',
      basis: 'chars/4', coverage: 'partial', estimated_tokens: value,
      categories: {messages: value}, changes: [{id: `item-${i}`, category: 'prompts',
        change: 'added', tokens: 1, delta_tokens: 1}]}}})) throw new Error(`Context sample ${i} dropped`);
  recorder.emitCounter('llm.context.estimated_tokens', value);
  if (i % 40 === 39) await Bun.sleep(2);
}
for (const child of children) {
  const manifest = await child.stop('benchmark');
  if (manifest?.error || manifest?.shutdownTruncated) throw new Error(`Child publication failed: ${manifest?.error}`);
}
const manifest = await owner.stop('benchmark');
if (!manifest || manifest.error || manifest.shutdownTruncated) throw new Error(`Owner publication failed: ${manifest?.error}`);
console.log(JSON.stringify({path: manifest.path, maxFileMB, bytes: manifest.bytes,
  fillRatio: Number((manifest.bytes / (maxFileMB * 1024 * 1024)).toFixed(3)),
  packets: manifest.packets, dropped: manifest.droppedEvents, incomplete: manifest.incompleteProcesses,
  eventsRequested: targetEvents, contextSamples}, null, 2));
