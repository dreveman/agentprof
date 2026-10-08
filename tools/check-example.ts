// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { Recorder } from "../packages/pi-tracing/extensions/pi-tracing/tracer.ts";
import { defaultConfig } from "../packages/pi-tracing/extensions/pi-tracing/config.ts";
import { resolve } from "node:path";
import assert from 'node:assert/strict';
import {toolDescription} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/tool_description.ts';
import { QUERIES, SETUP_SQL } from "../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts";

import { OVERVIEW_SETUP_SQL, OVERVIEW_QUERIES } from "../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts";

const binary = process.env.PERFETTO_TRACE_PROCESSOR ?? resolve("third_party/src/perfetto/tools/trace_processor");
const path = resolve("artifacts/examples/synthetic.pftrace");
function query(sql: string, tracePath = path): string {
  const result = spawnSync(binary, [tracePath, "-Q", sql], {encoding: "utf8"});
  if (result.error || result.status !== 0) throw new Error(`${result.error ?? "Query failed"}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
for (const [name, sql] of Object.entries({...QUERIES, ...OVERVIEW_QUERIES})) {
  query(`${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}\n${sql}`);
  console.log(`PASS ${name}`);
}
const result = query(`${SETUP_SQL}
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM agentprof_slices WHERE kind = 'tool-execution') = 5 AND
    (SELECT COUNT(*) FROM agentprof_slices WHERE kind = 'tool-execution' AND incomplete) = 1 AND
    (SELECT SUM(dur) FROM agentprof_slices WHERE kind = 'tool-execution' AND NOT incomplete) = 1750000000 AND
    (SELECT COUNT(*) FROM agentprof_slices WHERE session = 'agentprof-example') > 0 AND
    (SELECT COUNT(*) FROM flow) > 0 AND
    (SELECT COUNT(*) FROM agentprof_slices WHERE EXTRACT_ARG(arg_set_id, 'debug.is_error') = 1) = 1 AND
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.first_content_ns')
      FROM agentprof_slices WHERE kind = 'assistant-message' ORDER BY ts LIMIT 1) = 250000000 AND
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.output_tokens')
      FROM agentprof_slices WHERE kind = 'assistant-message' ORDER BY ts LIMIT 1) = 20 AND
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.cache_write_tokens')
      FROM agentprof_slices WHERE kind = 'assistant-message' ORDER BY ts LIMIT 1) IS NULL
  THEN 'AGENTPROF_OK' ELSE 'AGENTPROF_FAILED' END AS result`);
if (!result.includes('AGENTPROF_OK')) throw new Error(result);
console.log('PASS example semantics: sessions, overlap, failure, incomplete, flow, usage');

const overview = query(`${SETUP_SQL}
${OVERVIEW_SETUP_SQL}
SELECT CASE WHEN
 (SELECT MAX(tools) FROM agentprof_activity WHERE dur > 0) = 2 AND
 (SELECT SUM(dur) FROM agentprof_activity WHERE tools > 1) = 250000000 AND
 (SELECT SUM(dur) FROM agentprof_activity WHERE tools > 0 AND models > 0) = 200000000 AND
 (SELECT SUM(dur) FROM agentprof_activity WHERE models > 0 AND tools = 0) = 1700000000 AND
 (SELECT SUM(dur) FROM agentprof_activity WHERE tools > 0 AND models = 0) = 1300000000 AND
 (SELECT COUNT(*) FROM agentprof_messages WHERE input_tokens IS NULL) = 1
 THEN 'OVERVIEW_OK' ELSE 'OVERVIEW_FAILED' END AS result`);
if (!overview.includes('OVERVIEW_OK')) throw new Error(overview);
console.log('PASS overview: interval union, overlap, concurrency, missing usage');

// Scripts enclose their child work but must not inflate tool concurrency or
// completed-work totals. Leave this fixture for browser drilldown checks too.
const scriptDir = resolve('artifacts/examples/codemode');
await mkdir(scriptDir, {recursive: true});
const scriptConfig = defaultConfig();
scriptConfig.sampleHz = 0;
scriptConfig.finalizeDeadlineMs = 5000;
const scriptRecorder = new Recorder({config: scriptConfig, outDir: scriptDir, sessionTag: 'script',
  identity: {pid: 432, processName: 'pi', labels: ['session:script-session']}, machineId: 101});
scriptRecorder.setRunConfiguration({model: 'fixture', provider: 'synthetic', sessionLabels: ['codemode']});
if (!(await scriptRecorder.start()).started) throw new Error('Script fixture failed');
const scriptBase = scriptRecorder.captureTimestamp();
const scriptAt = (ns: number) => scriptBase + BigInt(ns);
const scriptSpan = scriptRecorder.beginToolSlice('script', 'codemode', scriptAt(1), undefined,
  {kind: 'script', deferBegin: true, annotations: {intent: 'Inspect tracing hooks', args: {code: 'await tools.read({path: "src/index.ts"})'}}})!;
const scriptRead = scriptRecorder.beginToolSlice('read', 'read', scriptAt(2), undefined,
  {annotations: {parent_call_id: 'script', args: {path: 'src/index.ts', offset: 10, limit: 20}}})!;
scriptRecorder.emitInstant({cat: 'tools', trackUuid: scriptRecorder.trackSet()!.sessionUuid,
  name: 'tool-preflight', tNs: scriptAt(2), annotations: {call_id: 'grep', args: {pattern: 'pi.on', path: 'src'}}});
const scriptGrep = scriptRecorder.beginToolSlice('grep', 'grep', scriptAt(3), undefined,
  {annotations: {parent_call_id: 'script'}})!;
scriptRecorder.emitEnd(scriptRead, {is_error: false}, scriptAt(4));
scriptRecorder.emitEnd(scriptGrep, {is_error: true}, scriptAt(5));
scriptRecorder.emitEnd(scriptSpan, {is_error: false}, scriptAt(10));
const emptyScript = scriptRecorder.beginToolSlice('empty', 'codemode', scriptAt(11), undefined,
  {kind: 'script', annotations: {language: 'JavaScript', line_count: 1}})!;
scriptRecorder.emitEnd(emptyScript, {is_error: false}, scriptAt(12));
const scriptManifest = await scriptRecorder.stop('fixture');
if (!scriptManifest || scriptManifest.shutdownTruncated) throw new Error('Script fixture did not finalize');
const scriptPath = resolve(scriptDir, 'scripts.pftrace');
await copyFile(scriptManifest.path, scriptPath);
const scriptCheck = query(`${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM (${OVERVIEW_QUERIES.scripts})) = 2
    AND (SELECT SUM(calls) FROM (${OVERVIEW_QUERIES.scripts})) = 2
    AND (SELECT COUNT(*) FROM (${OVERVIEW_QUERIES.script_calls})) = 2
    AND (SELECT COUNT(*) FROM (${OVERVIEW_QUERIES.script_calls}) WHERE is_error = 1) = 1
    AND (SELECT SUM(calls) FROM (${OVERVIEW_QUERIES.tools})) = 2
    AND (SELECT MAX(tools) FROM agentprof_activity WHERE dur > 0) = 2
    AND (SELECT SUM(dur) FROM agentprof_activity WHERE tools > 0) = 3
    AND (SELECT SUM(dur) FROM agentprof_activity WHERE scripts > 0 AND tools = 0) = 7
    AND (SELECT session_labels FROM (${OVERVIEW_QUERIES.runs})) = '["codemode"]'
    AND (SELECT intent FROM (${OVERVIEW_QUERIES.scripts}) WHERE calls = 2) = 'Inspect tracing hooks'
    AND (SELECT language FROM (${OVERVIEW_QUERIES.scripts}) WHERE calls = 0) = 'JavaScript'
    AND (SELECT line_count FROM (${OVERVIEW_QUERIES.scripts}) WHERE calls = 0) = 1
    AND (SELECT arguments FROM (${OVERVIEW_QUERIES.script_calls}) WHERE tool = 'read')
      LIKE '%src/index.ts%'
    AND (SELECT arguments FROM (${OVERVIEW_QUERIES.script_calls}) WHERE tool = 'grep')
      LIKE '%pi.on%'
    AND (SELECT COUNT(*) FROM (${OVERVIEW_QUERIES.slow}) WHERE arguments IS NOT NULL) = 2
  THEN 'SCRIPTS_OK' ELSE 'FAILED' END AS result`, scriptPath);
if (!scriptCheck.includes('SCRIPTS_OK')) throw new Error(scriptCheck);
console.log('PASS codemode: script drilldown, empty scripts, errors, and non-overlapping work accounting');
assert.equal(toolDescription('Run tests', JSON.stringify({command: 'npm test'})), 'Run tests');
assert.equal(toolDescription('  ', JSON.stringify({command: 'npm test\necho done'})), 'npm test\necho done');
assert.equal(toolDescription(undefined, JSON.stringify({path: 'file.ts', oldText: 'before', newText: 'after'})),
  'file.ts\n− before\n+ after');
assert.equal(toolDescription(undefined, JSON.stringify({path: 'file.ts', offset: '10', limit: '20'})),
  'file.ts · offset 10 · limit 20');
assert.equal(toolDescription(undefined, JSON.stringify({pattern: 'pi.on', path: 'src'})), 'pi.on in src');
assert.equal(toolDescription(undefined, JSON.stringify({'options[0]': 'hello'})), 'options[0]: hello');
assert.equal(toolDescription(undefined, undefined), undefined);
assert.equal(toolDescription('Count hooks', undefined, {language: 'JavaScript', lineCount: 8}), 'Count hooks');
assert.equal(toolDescription(undefined, undefined, {language: 'Python', lineCount: 3}), 'Python · 3 lines');
assert.equal(toolDescription(undefined, JSON.stringify({code: 'one\r\n\r\ntwo\r\n'}),
  {language: 'JavaScript'}), 'JavaScript · 3 lines');
assert.equal(toolDescription(undefined, JSON.stringify({code: 'one\ntwo'}),
  {language: 'JavaScript', truncated: true}), 'JavaScript · ≥2 lines');
assert.equal(toolDescription(undefined, JSON.stringify({code: 'one\ntwo'}),
  {language: 'JavaScript', lineCount: 12, truncated: true}), 'JavaScript · 12 lines');
assert.equal(toolDescription(undefined, undefined, {language: 'JavaScript'}), 'JavaScript');
assert.equal(toolDescription(undefined, undefined, {lineCount: 1}), 'Script · 1 line');
console.log('PASS invocation descriptions: intent, commands, edits, paging, search, generic arguments, missing data');

const counters = query(`
  SELECT CASE WHEN
    (SELECT GROUP_CONCAT(value, ',') FROM
      (SELECT CAST(c.value AS INT) AS value FROM counter c JOIN counter_track t ON t.id = c.track_id
       WHERE t.name = 'Input tokens' ORDER BY c.ts)) = '0,100,280,0' AND
    (SELECT GROUP_CONCAT(value, ',') FROM
      (SELECT CAST(c.value AS INT) AS value FROM counter c JOIN counter_track t ON t.id = c.track_id
       WHERE t.name = 'Output tokens' ORDER BY c.ts)) = '0,20,65,0' AND
    (SELECT GROUP_CONCAT(value, ',') FROM
      (SELECT CAST(c.value AS INT) AS value FROM counter c JOIN counter_track t ON t.id = c.track_id
       WHERE t.name = 'Context size' ORDER BY c.ts)) = '100,260,400,0,120,0' AND
    (SELECT GROUP_CONCAT(value, ',') FROM
      (SELECT CAST(c.value AS INT) AS value FROM counter c JOIN counter_track t ON t.id = c.track_id
       WHERE t.name = 'Context window' ORDER BY c.ts)) = '200000,0' AND
    (SELECT COUNT(*) FROM counter_track WHERE unit = 'tokens') = 4
  THEN 'COUNTERS_OK' ELSE 'COUNTERS_FAILED' END AS result`);
if (!counters.includes('COUNTERS_OK')) throw new Error(counters);
console.log('PASS counters: cumulative input/output, context gauge and window, token units');

const counterDescriptors = query(`INCLUDE PERFETTO MODULE viz.summary.track_event;
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM _track_event_tracks_ordered_groups
      WHERE is_counter = 1 AND name IN ('Context size', 'Context window')
        AND unit = 'tokens' AND y_axis_share_key = 'llm.context.tokens') = 2 AND
    (SELECT COUNT(DISTINCT parent_id) FROM _track_event_tracks_ordered_groups
      WHERE is_counter = 1 AND name IN ('Context size', 'Context window')) = 1 AND
    NOT EXISTS (SELECT 1 FROM counter_track WHERE unit IS NULL OR unit = '')
  THEN 'COUNTER_DESCRIPTORS_OK' ELSE 'COUNTER_DESCRIPTORS_FAILED' END AS result`);
if (!counterDescriptors.includes('COUNTER_DESCRIPTORS_OK')) throw new Error(counterDescriptors);
console.log('PASS counter descriptors: units and shared context Y-axis');

const runSummary = query(`${SETUP_SQL}
  ${OVERVIEW_SETUP_SQL}
  SELECT CASE WHEN
    (SELECT model FROM (${OVERVIEW_QUERIES.runs})) = 'opus-5' AND
    (SELECT harness FROM (${OVERVIEW_QUERIES.runs})) = 'pi' AND
    (SELECT effort FROM (${OVERVIEW_QUERIES.runs})) = 'high' AND
    (SELECT input_tokens FROM (${OVERVIEW_QUERIES.runs})) = 280 AND
    (SELECT output_tokens FROM (${OVERVIEW_QUERIES.runs})) = 65 AND
    (SELECT peak_context FROM (${OVERVIEW_QUERIES.runs})) = 450 AND
    (SELECT prompt_text FROM (${OVERVIEW_QUERIES.runs})) IS NULL AND
    (SELECT context_window_tokens FROM (${OVERVIEW_QUERIES.runs})) = 200000 AND
    ABS((SELECT context_share FROM (${OVERVIEW_QUERIES.runs})) - 0.00225) < 0.0000001 AND
    ABS((SELECT tokens_per_s FROM (${OVERVIEW_QUERIES.runs})) -
      (SELECT output_tokens_per_s FROM (${OVERVIEW_QUERIES.headline}))) < 0.0000001 AND
    ABS((SELECT model_busy_ms FROM (${OVERVIEW_QUERIES.runs})) -
      (SELECT model_busy_ms FROM (${OVERVIEW_QUERIES.headline}))) < 0.0000001 AND
    (SELECT peak_model_responses FROM (${OVERVIEW_QUERIES.runs})) =
      (SELECT peak_model_responses FROM (${OVERVIEW_QUERIES.headline})) AND
    (SELECT peak_model_responses FROM (${OVERVIEW_QUERIES.runs})) > 0 AND
    (SELECT output_tokens_per_s FROM (${OVERVIEW_QUERIES.headline})) > 0 AND
    (SELECT model_busy_ms FROM (${OVERVIEW_QUERIES.headline})) > 0 AND
    (SELECT wall_window_ms FROM (${OVERVIEW_QUERIES.headline})) >
      (SELECT model_busy_ms FROM (${OVERVIEW_QUERIES.headline})) AND
    (SELECT EXTRACT_ARG(arg_set_id, 'debug.peak_context_tokens')
      FROM agentprof_slices WHERE name = 'profile (1)') = 450 AND
    (SELECT COUNT(*) FROM agentprof_slices WHERE name = 'compact' AND dur = 50000000
      AND EXTRACT_ARG(arg_set_id, 'debug.status') = 'success') = 1 AND
    (SELECT turns FROM (${OVERVIEW_QUERIES.runs})) = 2 AND
    (SELECT responses FROM (${OVERVIEW_QUERIES.runs})) = 3 AND
    (SELECT tools FROM (${OVERVIEW_QUERIES.runs})) = 5 AND
    (SELECT incomplete FROM (${OVERVIEW_QUERIES.runs})) = 1 AND
    (SELECT single_model FROM (${OVERVIEW_QUERIES.summary})) = 1
  THEN 'SUMMARY_OK' ELSE 'SUMMARY_FAILED' END AS result`);
if (!runSummary.includes('SUMMARY_OK')) throw new Error(runSummary);
console.log('PASS run summary: model context window, reported totals, observed peak');

const sessionActivity = query(`${SETUP_SQL}
  ${OVERVIEW_SETUP_SQL}
  CREATE PERFETTO TABLE activity_bins AS ${OVERVIEW_QUERIES.session_activity};
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM activity_bins) = 48 AND
    (SELECT COUNT(*) FROM activity_bins WHERE busy_fraction > 0) > 0 AND
    ABS((SELECT SUM(busy_fraction) FROM activity_bins) *
      (SELECT duration_ms FROM (${OVERVIEW_QUERIES.runs})) / 48 - 3200) < 1
  THEN 'ACTIVITY_SERIES_OK' ELSE 'ACTIVITY_SERIES_FAILED' END AS result`);
if (!sessionActivity.includes('ACTIVITY_SERIES_OK')) throw new Error(sessionActivity);
console.log('PASS session activity series: measured model/tool union across the recorded window');

// Captures from the same process/session must stay separate, including when
// counters reset or a configuration field is missing. Keep files for the UI test.
const comparisonDir = resolve('artifacts/examples/comparison');
await mkdir(comparisonDir, {recursive: true});
const comparisonCopies: {source: string; target: string}[] = [];
for (const [i, label] of ['code-mode', 'classic', 'unknown'].entries()) {
  const config = defaultConfig();
  config.sampleHz = 0;
  if (i === 2) config.categories.llm = false;
  const recorder = new Recorder({config, outDir: comparisonDir, sessionTag: 'comparison',
    identity: {pid: 1234, processName: 'pi', labels: [i === 2 ? 'session:other-session' : 'session:comparison-session'],
      mainThread: {tid: 1234, name: 'pi'}},
    machineId: i === 2 ? 202 : 101});
  if (i < 2) recorder.setRunConfiguration({model: `model-${i}`, provider: 'synthetic',
    effort: 'high', contextWindowTokens: 100000 + i * 100000});
  const started = await recorder.start(label);
  if (!started.started) throw new Error(started.message);
  for (let turn = 0; turn <= i; turn++) {
    const span = recorder.beginSlice({cat: 'agent', trackUuid: recorder.trackSet()!.sessionUuid, name: 'turn'});
    if (span !== null) recorder.emitEnd(span);
  }
  recorder.recordTokenUsage({usage: {input: 100 + i * 80, output: 20 + i * 25}});
  recorder.recordContextTokens(400 - i * 140);
  if (i === 1) recorder.setRunConfiguration({model: 'model-2', provider: 'synthetic',
    effort: 'low', contextWindowTokens: 300000});
  const manifest = await recorder.stop('comparison');
  if (!manifest) throw new Error('Capture did not complete');
  const file = resolve(comparisonDir, `${label}.pftrace`);
  await copyFile(manifest.path, file);
  comparisonCopies.push({source: manifest.path, target: file});
}
// Ensure the named copies still exist after all synthetic recorders have
// finished; an overlapping fixture cleanup can remove an earlier copy.
for (const {source, target} of comparisonCopies) if (!existsSync(target)) await copyFile(source, target);
const mergedPath = resolve(comparisonDir, 'comparison.tar');
const tar = spawnSync('tar', ['-cf', mergedPath, '-C', comparisonDir, 'code-mode.pftrace', 'classic.pftrace', 'unknown.pftrace']);
if (tar.status !== 0) throw new Error(String(tar.stderr));
const comparison = query(`${SETUP_SQL}
${OVERVIEW_SETUP_SQL}
CREATE PERFETTO TABLE comparison_runs AS ${OVERVIEW_QUERIES.runs};
SELECT CASE WHEN
  (SELECT COUNT(*) FROM comparison_runs) = 3 AND
  (SELECT COUNT(DISTINCT recorded_id) FROM comparison_runs) = 3 AND
  (SELECT COUNT(DISTINCT session) FROM comparison_runs) = 2 AND
  (SELECT COUNT(*) FROM thread WHERE name = 'pi' AND tid = 1234) = 2 AND
  (SELECT COUNT(DISTINCT utid) FROM agentprof_slices WHERE name = 'profile (1)') = 2 AND
  (SELECT COUNT(*) FROM agentprof_slices WHERE name = 'profile (1)' AND utid IS NOT NULL) = 3 AND
  (SELECT turns FROM comparison_runs WHERE capture = 'code-mode') = 1 AND
  (SELECT turns FROM comparison_runs WHERE capture = 'classic') = 2 AND
  (SELECT turns FROM comparison_runs WHERE capture = 'unknown') = 3 AND
  (SELECT input_tokens FROM comparison_runs WHERE capture = 'code-mode') = 100 AND
  (SELECT output_tokens FROM comparison_runs WHERE capture = 'code-mode') = 20 AND
  (SELECT peak_context FROM comparison_runs WHERE capture = 'code-mode') = 400 AND
  (SELECT context_window_tokens FROM comparison_runs WHERE capture = 'code-mode') = 100000 AND
  ABS((SELECT context_share FROM comparison_runs WHERE capture = 'code-mode') - 0.004) < 0.0000001 AND
  (SELECT input_tokens FROM comparison_runs WHERE capture = 'classic') = 180 AND
  (SELECT output_tokens FROM comparison_runs WHERE capture = 'classic') = 45 AND
  (SELECT peak_context FROM comparison_runs WHERE capture = 'classic') = 260 AND
  (SELECT context_window_tokens FROM comparison_runs WHERE capture = 'classic') = 300000 AND
  (SELECT context_share FROM comparison_runs WHERE capture = 'classic') IS NULL AND
  (SELECT model FROM comparison_runs WHERE capture = 'classic') = 'model-1,model-2' AND
  (SELECT model FROM comparison_runs WHERE capture = 'unknown') = 'Not recorded' AND
  (SELECT input_tokens FROM comparison_runs WHERE capture = 'unknown') IS NULL AND
  (SELECT context_window_tokens FROM comparison_runs WHERE capture = 'unknown') IS NULL AND
  (SELECT COUNT(*) FROM comparison_runs WHERE prompt_text IS NULL AND prompt_id IS NULL) = 3 AND
  (SELECT COUNT(*) FROM comparison_runs WHERE tokens_per_s IS NULL AND model_busy_ms IS NULL
    AND peak_model_responses IS NULL) = 3 AND
  (SELECT COUNT(*) FROM (${OVERVIEW_QUERIES.session_activity})) = 144 AND
  (SELECT COUNT(*) FROM (${OVERVIEW_QUERIES.session_activity}) WHERE busy_fraction IS NOT NULL) = 0 AND
  (SELECT context_share FROM comparison_runs WHERE capture = 'unknown') IS NULL AND
  (SELECT clock_errors FROM (${OVERVIEW_QUERIES.summary})) = 0 AND
  (SELECT single_model FROM (${OVERVIEW_QUERIES.summary})) = 0 AND
  (SELECT MAX(start_ts) - MIN(start_ts) FROM comparison_runs) < 10000000000
THEN 'COMPARISON_OK' ELSE 'COMPARISON_FAILED' END AS result`, mergedPath);
if (!comparison.includes('COMPARISON_OK')) throw new Error(comparison);
console.log('PASS comparison: separate captures sharing PID/session, multiple machines, configuration changes, missing counters');

const expectedStarts = query(`${SETUP_SQL}
${OVERVIEW_SETUP_SQL}
SELECT capture, CAST(start_ts AS TEXT) AS start_ns FROM (${OVERVIEW_QUERIES.runs})`, mergedPath);
const expected = Object.fromEntries(expectedStarts.trim().split('\n').slice(1).map(line => {
  const [label, ns] = line.replaceAll('"', '').split(',');
  return [label, ns];
}));
await writeFile(resolve(comparisonDir, 'expected-starts.json'), JSON.stringify(expected));

// Logical agents sharing a process retain separate captures, without assigning
// either agent's identity to the process labels.
const logicalDir = resolve('artifacts/examples/logical-agents');
await mkdir(logicalDir, {recursive: true});
for (const session of ['agent-a', 'agent-b']) {
  const config = defaultConfig();
  config.sampleHz = 0;
  // Retention runs asynchronously; keep recorder output away from named UI fixtures.
  const recorder = new Recorder({config, outDir: resolve(logicalDir, 'captures'), sessionTag: session,
    identity: {pid: 4321, processName: 'shared-host', labels: []}, machineId: 101});
  if (!(await recorder.start(session)).started) throw new Error('Logical agent fixture failed');
  const span = recorder.beginSlice({cat: 'agent', trackUuid: recorder.trackSet()!.sessionUuid, name: 'turn'});
  if (span !== null) recorder.emitEnd(span);
  const manifest = await recorder.stop('fixture');
  if (!manifest) throw new Error('Logical agent fixture did not finalize');
  await copyFile(manifest.path, resolve(logicalDir, `${session}.pftrace`));
}
// A generic agent track can also have no process association at all.
const {buildTracePacket, buildTrackDescriptor, buildTrackEvent, framePacket, CLOCK_REALTIME,
  TRACK_EVENT_INSTANT} = await import('../packages/pi-tracing/extensions/pi-tracing/encoder.ts');
const {buildSnapshotPacket} = await import('../packages/pi-tracing/extensions/pi-tracing/tracks.ts');
const now = BigInt(Date.now()) * 1_000_000n;
const packet = (fields: Parameters<typeof buildTracePacket>[0]) => framePacket(buildTracePacket({
  timestampNs: now, clockId: CLOCK_REALTIME, seqId: 333, machineId: 101, ...fields,
}));
await writeFile(resolve(logicalDir, 'unattached.pftrace'), Buffer.concat([
  buildSnapshotPacket({seqId: 333, machineId: 101, sourceClockId: CLOCK_REALTIME,
    sourceNs: now, realtimeNs: now, boottimeNs: now}),
  packet({trackDescriptor: buildTrackDescriptor({uuid: 9001n, name: 'agentprof.capture'})}),
  packet({trackDescriptor: buildTrackDescriptor({uuid: 9002n, name: 'agent.lifecycle', parentUuid: 9001n})}),
  packet({trackEvent: buildTrackEvent({trackUuid: 9002n, type: TRACK_EVENT_INSTANT,
    categories: ['pi.metadata'], name: 'tracing-start', debugAnnotations: {
      'session_id': 'unattached-agent', 'capture_id': 'unattached',
      'label': 'unattached',
    }})}),
]));
console.log('Generated shared-process and unattached logical-agent fixtures');

// Older fields and the recorded assistant-response name must still work,
// including alongside current annotations in one trace.
const legacyPath = resolve(logicalDir, 'legacy-annotations.pftrace');
await writeFile(legacyPath, Buffer.concat([
  packet({trackDescriptor: buildTrackDescriptor({uuid: 9101n, name: 'agentprof.capture'})}),
  packet({trackDescriptor: buildTrackDescriptor({uuid: 9102n, name: 'llm.responses', parentUuid: 9101n})}),
  packet({trackEvent: buildTrackEvent({trackUuid: 9102n, type: TRACK_EVENT_INSTANT,
    categories: ['pi.metadata'], name: 'tracing-start', debugAnnotations: {
      'agentprof.session.id': 'legacy-agent', 'agentprof.capture.id': '238d',
      'agentprof.capture.label': 'legacy-label', 'agentprof.harness': 'pi',
      'agentprof.llm.model': 'legacy-model', 'agentprof.llm.provider': 'legacy-provider',
      'agentprof.llm.effort': 'high',
    }})}),
  ...[
    {'agentprof.event.kind': 'assistant-message', 'agentprof.usage.input': 100,
      'agentprof.usage.output': 20, 'agentprof.stream.duration_ns': 100,
      'agentprof.llm.model': 'legacy-model', 'agentprof.llm.provider': 'legacy-provider',
      'agentprof.stream.first_content_ns': 25, 'agentprof.llm.stopReason': 'stop'},
    {kind: 'assistant-message', input_tokens: 200, output_tokens: 30, duration_ns: 100,
      model: 'legacy-model', provider: 'legacy-provider', first_content_ns: 50, stop_reason: 'stop'},
  ].map(debugAnnotations => packet({trackEvent: buildTrackEvent({trackUuid: 9102n,
    type: TRACK_EVENT_INSTANT, categories: ['pi.llm'], name: 'assistant-response', debugAnnotations})})),
]));
const compatible = query(`${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM agentprof_slices WHERE session = 'legacy-agent' AND capture = 'legacy-label') = 3
    AND (SELECT SUM(input_tokens) FROM agentprof_messages) = 300
    AND (SELECT SUM(output_tokens) FROM agentprof_messages) = 50
    AND (SELECT SUM(first_ns) FROM agentprof_messages) = 75
    AND (SELECT COUNT(*) FROM agentprof_messages WHERE model = 'legacy-model' AND provider = 'legacy-provider') = 2
    AND (SELECT COUNT(*) FROM (${OVERVIEW_QUERIES.runs}) WHERE model = 'legacy-model' AND effort = 'high') = 1
    THEN 'COMPATIBLE' ELSE 'FAILED' END`, legacyPath);
if (!compatible.includes('COMPATIBLE')) throw new Error(compatible);
console.log('PASS annotation compatibility: legacy and short names in the same trace');

// Hierarchies include nested workers while preserving orphan, ambiguous, and
// cyclic sessions. All captures share one real process to exercise that case too.
const hierarchyPath = resolve(logicalDir, 'hierarchy.pftrace');
const hierarchyPackets: Uint8Array[] = [
  buildSnapshotPacket({seqId: 333, machineId: 101, sourceClockId: CLOCK_REALTIME,
    sourceNs: now, realtimeNs: now, boottimeNs: now}),
  packet({trackDescriptor: buildTrackDescriptor({uuid: 10000n,
    process: {pid: 8765, processName: 'shared-host', labels: []}})}),
];
const hierarchyCaptures = [
  {session: 'root', start: 0, end: 100, input: 100, output: 10, context: 400, model: 'parent-model'},
  {session: 'child', parent: 'root', start: 10, end: 120, input: 200, output: 20, context: 600, model: 'worker-model'},
  {session: 'grandchild', parent: 'child', start: 20, end: 80, input: 300, output: 30, context: 500, model: 'worker-model'},
  {session: 'unknown-usage', parent: 'root', start: 30, end: 70},
  {session: 'orphan', parent: 'absent', start: 0, end: 100},
  {session: 'duplicate', start: 0, end: 100},
  {session: 'duplicate', start: 0, end: 100},
  {session: 'ambiguous', parent: 'duplicate', start: 10, end: 90},
  {session: 'cycle-a', parent: 'cycle-b', start: 0, end: 100},
  {session: 'cycle-b', parent: 'cycle-a', start: 0, end: 100},
];
for (const [i, c] of hierarchyCaptures.entries()) {
  const root = 10100n + BigInt(i) * 10n;
  const ts = (offset: number) => now + BigInt(offset) * 1_000_000n;
  hierarchyPackets.push(
    packet({trackDescriptor: buildTrackDescriptor({uuid: root, name: 'agentprof.capture',
      parentUuid: 10000n, siblingMergeBehavior: 2})}),
    packet({trackDescriptor: buildTrackDescriptor({uuid: root + 1n, name: 'agent.lifecycle', parentUuid: root})}),
    packet({timestampNs: ts(c.start), trackEvent: buildTrackEvent({trackUuid: root + 1n,
      type: 1, categories: ['pi.metadata'], name: 'tracing', debugAnnotations: {
        session_id: c.session, capture_id: root.toString(16), label: `${c.session}-${i}`,
        harness: i === 0 ? 'fixture-harness' : 'pi', provider: 'synthetic', model: c.model ?? 'unknown', effort: 'high',
        ...(i === 0 ? {session_labels: ['sandbox, network-off', 'plan', 'plan', '', '  ', 42]} :
          i === 1 ? {session_labels: ['worker', 'mode "B"']} :
          i === 2 ? {session_labels: []} : {}),
        ...(c.parent ? (c.session === 'grandchild'
          ? {parentSession: c.parent, childRole: 'subagent'} // Older recording mixed into the family.
          : {parent_session: c.parent, child_role: 'subagent'}) : {}),
      }})}),
    packet({timestampNs: ts(c.start + 1), trackEvent: buildTrackEvent({trackUuid: root + 1n,
      type: TRACK_EVENT_INSTANT, categories: ['pi.agent'], name: 'turn'})}),
    packet({timestampNs: ts(c.end), trackEvent: buildTrackEvent({trackUuid: root + 1n,
      type: 2, categories: ['pi.metadata']})}),
  );
  for (const [j, [name, value]] of [
    ['llm.tokens.input', c.input], ['llm.tokens.output', c.output],
    ['llm.context.estimated_tokens', c.context],
    ['runtime.rss', i === 0 ? 1024 : undefined],
    ['tracing.droppedEvents', i === 0 ? 0 : undefined],
  ].entries()) {
    if (value === undefined) continue;
    hierarchyPackets.push(
      packet({trackDescriptor: buildTrackDescriptor({uuid: root + 2n + BigInt(j),
        name: String(name), parentUuid: root, counter: {unit: 0, unitName: 'tokens'}})}),
      packet({timestampNs: ts(c.start + 2), trackEvent: buildTrackEvent({trackUuid: root + 2n + BigInt(j),
        type: 4, categories: ['pi.llm'], counterValue: BigInt(value)})}),
    );
  }
}
await writeFile(hierarchyPath, Buffer.concat(hierarchyPackets));
const hierarchy = query(`${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}
  CREATE PERFETTO TABLE runs AS ${OVERVIEW_QUERIES.runs};
  SELECT CASE WHEN
    (SELECT COUNT(*) FROM runs) = 7 AND
    (SELECT COUNT(*) FROM agentprof_capture_runs) = 10 AND
    EXISTS (SELECT 1 FROM runs WHERE session = 'root' AND subagents = 3
      AND input_tokens = 600 AND output_tokens = 60 AND peak_context = 600
      AND turns = 4 AND duration_ms = 120
      AND model = 'parent-model' AND model_identities NOT LIKE '%worker-model%'
      AND session_labels = '["plan","sandbox, network-off"]') AND
    EXISTS (SELECT 1 FROM (${OVERVIEW_QUERIES.sessions})
      WHERE session = 'child' AND model = 'worker-model'
        AND JSON_EXTRACT(session_labels, '$[0]') = 'mode "B"'
        AND JSON_EXTRACT(session_labels, '$[1]') = 'worker') AND
    (SELECT COUNT(*) FROM agentprof_capture_runs WHERE session_labels IS NOT NULL) = 2 AND
    (SELECT COUNT(*) FROM runs WHERE session IN ('child', 'grandchild', 'unknown-usage')) = 0 AND
    (SELECT COUNT(*) FROM runs WHERE session IN ('orphan', 'ambiguous', 'cycle-a', 'cycle-b')
      AND input_tokens IS NULL AND peak_context IS NULL) = 4 AND
    (SELECT sessions FROM (${OVERVIEW_QUERIES.summary})) = 7 AND
    (SELECT single_model FROM (${OVERVIEW_QUERIES.summary})) = 0 AND
    (SELECT COUNT(DISTINCT upid) FROM agentprof_slices) = 1
  THEN 'HIERARCHY_OK' ELSE 'HIERARCHY_FAILED' END`, hierarchyPath);
if (!hierarchy.includes('HIERARCHY_OK')) throw new Error(hierarchy);
console.log('PASS subagent rollup: nested/shared-process workers, mixed models, missing usage, orphans, ambiguous parents, cycles');
