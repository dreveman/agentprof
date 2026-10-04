// SPDX-License-Identifier: Apache-2.0
import {readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {decodeFields, tracePackets} from '../../../packages/pi-tracing/extensions/pi-tracing/test-proto.ts';
import {encodeVarint, framePacket} from '../../../packages/pi-tracing/extensions/pi-tracing/encoder.ts';
import {SETUP_SQL} from '../../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries.ts';
import {OVERVIEW_SETUP_SQL} from '../../../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries.ts';

const root = resolve(import.meta.dir, '../../..');
const batch = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: bun tools/experiments/harness-comparison/analyse.ts BATCH');
const manifest = JSON.parse(readFileSync(join(batch, 'recording.json'), 'utf8'));
const save = (name: string, value: unknown) => writeFileSync(join(batch, name), JSON.stringify(value, null, 2) + '\n');
const recordings = manifest.recordings as Array<Record<string, any>>;
const variantOf = (run: Record<string, any>) => run.variant ?? run.harness;
const variants: string[] = manifest.variants ?? ['pi', 'claude-code'];
const available = recordings.filter(r => existsSync(join(batch, r.path, 'trace.pftrace')));
if (!available.length) throw new Error('No traces');

function combine(runs: typeof recordings, output: string) {
  let nextSequence = 1;
  const machines = new Set<string>();
  const bytes = runs.map(run => {
    const data = readFileSync(join(batch, run.path, 'trace.pftrace'));
    const sequences = new Map<string, number>();
    const rewritten: Uint8Array[] = [];
    for (const packet of tracePackets(data)) {
      const fields = decodeFields(packet);
      const ids = fields.filter(f => f.number === 10);
      if (ids.length !== 1 || ids[0].value === undefined) throw new Error('Expected one packet sequence ID');
      const id = String(ids[0].value);
      if (!sequences.has(id)) sequences.set(id, nextSequence++);
      machines.add(String(fields.find(f => f.number === 98)?.value ?? 0));
      rewritten.push(framePacket(resequence(packet, sequences.get(id)!)));
    }
    return Buffer.concat(rewritten);
  });
  if (machines.size !== 1) throw new Error('Expected recordings from the same machine/boot');
  writeFileSync(output, Buffer.concat(bytes), {mode: 0o600});
}
// Each standalone Pi recording starts its sequence numbering at one. Rewrite
// only that packet envelope field; retain all payloads, clocks and timestamps.
function resequence(packet: Uint8Array, sequence: number) {
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = packet[offset++];
      if (byte === undefined) throw new Error('Truncated packet');
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value;
    }
    throw new Error('Invalid varint');
  };
  while (offset < packet.length) {
    const tag = Number(varint()), start = offset, wire = tag & 7;
    if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 2) {const length = Number(varint()); offset += length;}
    else if (wire === 5) offset += 4;
    else throw new Error('Unsupported wire type');
    if (offset > packet.length) throw new Error('Truncated field');
    if (tag === 80) return Buffer.concat([packet.subarray(0, start), Uint8Array.from(encodeVarint(sequence)), packet.subarray(offset)]);
  }
  throw new Error('Packet sequence not found');
}
combine(available, join(batch, 'all-runs.pftrace'));
mkdirSync(join(batch, 'traces'), {recursive: true});
for (const run of available) {
  // The multi-file picker requires distinct filenames, even across directories.
  copyFileSync(join(batch, run.path, 'trace.pftrace'),
    join(batch, 'traces', `${variantOf(run)}-${run.case}-round-${run.round}.pftrace`));
}
for (const name of manifest.cases) {
  const runs = available.filter(r => r.case === name);
  if (!runs.length) continue;
  combine(runs, join(batch, 'traces', `${name}-all-rounds.pftrace`));
  for (let round = 1; round <= manifest.rounds; round++) {
    const pair = runs.filter(r => r.round === round);
    if (pair.length === variants.length) combine(pair, join(batch, 'traces', `${name}-round-${round}.pftrace`));
  }
}
const sql = `${SETUP_SQL}\n${OVERVIEW_SETUP_SQL}\nSELECT JSON_OBJECT(
 'sessions', (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('session',r.session,'harness',r.harness,'model',r.model,
   'root_session',root.session,'role',CASE WHEN h.capture_id=h.root_capture_id THEN 'primary' ELSE 'reviewer' END,
   'wall_s',r.duration_ms/1000,'responses',r.responses,'tools',r.tools,'incomplete',r.incomplete,
   'input_tokens',r.input_tokens,'output_tokens',r.output_tokens,'peak_context',r.peak_context))
   FROM agentprof_capture_runs r JOIN agentprof_capture_hierarchy h USING(capture_id)
   JOIN agentprof_capture_runs root ON root.capture_id=h.root_capture_id),
 'messages', (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('session',m.session,'start_s',(m.ts-r.start_ts)/1e9,
   'duration_s',m.message_ns/1e9,'output_tokens',m.output_tokens,'input_tokens',m.input_tokens,
   'cache_read_tokens',m.cache_read_tokens,'cache_write_tokens',EXTRACT_ARG(m.arg_set_id,'debug.cache_write_tokens'),
   'first_content_s',m.first_ns/1e9,'timing',EXTRACT_ARG(m.arg_set_id,'debug.timing')))
   FROM agentprof_messages m JOIN agentprof_capture_runs r USING(capture_id)),
 'requests', (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('session',m.session,'start_s',(m.ts-r.start_ts)/1e9,
   'duration_s',m.dur/1e9,'status',EXTRACT_ARG(m.arg_set_id,'debug.status_code')))
   FROM agentprof_slices m JOIN agentprof_capture_runs r USING(capture_id) WHERE m.kind='provider-request'),
 'tools', (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('session',m.session,'name',m.name,'start_s',(m.ts-r.start_ts)/1e9,
   'duration_s',m.dur/1e9,'error',m.is_error,'incomplete',m.incomplete,
   'kind',m.kind,'parent_call_id',m.parent_call_id,'call_id',m.call_id))
   FROM agentprof_tool_calls m JOIN agentprof_capture_runs r USING(capture_id)),
 'errors', (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('name',name,'value',value)) FROM stats WHERE severity='error' AND value>0),
 'flows', (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('source_session',a.session,'target_session',b.session))
   FROM flow f JOIN agentprof_slices a ON a.id=f.slice_out JOIN agentprof_slices b ON b.id=f.slice_in
   WHERE a.name IN ('Agent','subagent') AND b.name='prompt-input'),
 'health', (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('name',t.name,'maximum',c.value)) FROM counter c JOIN agentprof_counter_tracks t ON t.id=c.track_id
   WHERE t.name IN ('tracing.droppedEvents','tracing.laneOverflows') AND c.value>0)
) AS report;`;
writeFileSync(join(batch, 'analysis.sql'), sql);
const result = spawnSync(join(root, 'third_party/src/perfetto/tools/trace_processor'),
  [join(batch, 'all-runs.pftrace'), '-q', join(batch, 'analysis.sql')], {encoding: 'utf8', maxBuffer: 30 * 1024 * 1024});
writeFileSync(join(batch, 'analysis.log'), result.stderr);
if (result.status !== 0) throw new Error(result.stderr);
const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!.slice(1, -1));
save('analysis.json', report);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
function union(intervals: Array<{start_s: number; duration_s: number}>) {
  let last = -Infinity, total = 0;
  for (const i of intervals.filter(i => i.duration_s >= 0).sort((a, b) => a.start_s - b.start_s)) {
    const end = i.start_s + i.duration_s;
    total += Math.max(0, end - Math.max(last, i.start_s));
    last = Math.max(last, end);
  }
  return total;
}
const readEvents = (path: string) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').flatMap(line => {
  try {return [JSON.parse(line)];} catch {return [];}
}) : [];
function readNativeUsage(run: Record<string, any>) {
  const usage = {input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0};
  const native = readEvents(join(batch, run.path, 'events.jsonl'));
  if (run.harness === 'pi') {
    const child = readEvents(join(batch, run.path, 'reviewer/events.jsonl'));
    for (const e of [...native, ...child].filter(e => e.type === 'message_end' && e.message?.role === 'assistant')) {
      const u = e.message.usage ?? {};
      usage.input_tokens += u.input ?? 0;
      usage.output_tokens += u.output ?? 0;
      usage.cache_read_tokens += u.cacheRead ?? 0;
      usage.cache_write_tokens += u.cacheWrite ?? 0;
    }
  } else {
    const final = native.findLast(e => e.type === 'result');
    for (const u of Object.values(final?.modelUsage ?? {}) as any[]) {
      usage.input_tokens += u.inputTokens ?? 0;
      usage.output_tokens += u.outputTokens ?? 0;
      usage.cache_read_tokens += u.cacheReadInputTokens ?? 0;
      usage.cache_write_tokens += u.cacheCreationInputTokens ?? 0;
    }
  }
  return usage;
}
const results: Array<Record<string, any>> = recordings.map(run => {
  const nativeUsage = readNativeUsage(run);
  if (!available.includes(run)) return {...run, traceErrors: ['Finalized trace unavailable; inspect stderr.log'],
    usage: nativeUsage, nativeUsage, sessions: [], wallSeconds: null};
  const sessions = report.sessions.filter((s: any) => s.root_session === run.sessionId);
  const primary = sessions.find((s: any) => s.role === 'primary');
  const ids = new Set(sessions.map((s: any) => s.session));
  const messages = report.messages.filter((m: any) => ids.has(m.session));
  const mainMessages = messages.filter((m: any) => m.session === run.sessionId);
  const requests = report.requests.filter((r: any) => r.session === run.sessionId).sort((a: any, b: any) => a.start_s - b.start_s);
  const tools = report.tools.filter((t: any) => t.session === run.sessionId);
  const errors = [];
  if (!primary) errors.push('Primary capture missing');
  if (sessions.some((s: any) => s.model !== manifest.model)) errors.push('Unexpected model');
  if (sessions.some((s: any) => s.incomplete)) errors.push('Incomplete spans');
  if (mainMessages.length !== run.primaryResponses) errors.push('Primary response count mismatch');
  if (messages.length - mainMessages.length !== run.reviewerResponses) errors.push('Reviewer response count mismatch');
  if (tools.length !== (run.primaryExecutedCalls ?? run.primaryToolCalls)) errors.push('Primary tool count mismatch');
  if (run.scriptCalls !== undefined && tools.filter((t: any) => t.kind === 'script').length !== run.scriptCalls) {
    errors.push('Script count mismatch');
  }
  if (run.nestedToolCalls !== undefined && tools.filter((t: any) => t.parent_call_id).length !== run.nestedToolCalls) {
    errors.push('Nested tool count mismatch');
  }
  if (tools.some((t: any) => t.parent_call_id && !tools.some((p: any) => p.call_id === t.parent_call_id && p.kind === 'script'))) {
    errors.push('Nested tool missing its script');
  }
  if (report.tools.filter((t: any) => ids.has(t.session) && t.session !== run.sessionId).length !== run.reviewerToolCalls) {
    errors.push('Reviewer tool count mismatch');
  }
  if (run.case === 'reviewer' && (sessions.length !== 2 || report.flows.filter((f: any) => f.source_session === run.sessionId).length !== 1)) {
    errors.push('Reviewer capture or delegation flow missing');
  }
  const usage = {input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0};
  for (const m of messages) for (const key of Object.keys(usage) as Array<keyof typeof usage>) usage[key] += m[key] ?? 0;
  if (JSON.stringify(usage) !== JSON.stringify(nativeUsage)) errors.push('Usage differs from native result');
  const exchange = union([...mainMessages, ...requests]);
  const covered = union([...mainMessages, ...requests, ...tools]);
  return {...run, traceErrors: errors, sessions, usage, nativeUsage,
    wallSeconds: primary?.wall_s, primaryModelExchangeSeconds: exchange,
    primaryRequestToHeadersSeconds: requests.length ? sum(requests.map((r: any) => r.duration_s)) : null,
    firstRequestToHeadersSeconds: requests[0]?.duration_s ?? null,
    primaryResponseSeconds: sum(mainMessages.map((m: any) => m.duration_s)),
    primaryToolWorkSeconds: sum(tools.filter((t: any) => t.kind !== 'script').map((t: any) => t.duration_s)),
    primaryScriptSeconds: sum(tools.filter((t: any) => t.kind === 'script').map((t: any) => t.duration_s)),
    primaryToolActiveSeconds: union(tools),
    primaryUncoveredSeconds: primary ? Math.max(0, primary.wall_s - covered) : null,
    primaryToolErrors: tools.filter((t: any) => t.error).length};
});
save('results.json', results);
function median(values: number[]) {
  const v = [...values].sort((a, b) => a - b), n = v.length;
  return n % 2 ? v[Math.floor(n / 2)] : (v[n / 2 - 1] + v[n / 2]) / 2;
}
function metric(runs: typeof results, key: string, digits = 1) {
  const values = runs.map(r => r[key]).filter(v => typeof v === 'number');
  return values.length ? `${median(values).toFixed(digits)} (${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)})` : 'Unavailable';
}
const lines = ['# Harness comparison results', '',
  `Model: \`${manifest.model}\`; thinking off. Pi ${manifest.piVersion}; Claude ${manifest.claudeVersion}.`, '',
  'All attempts are retained. Times and counts are medians (min–max), including nonconforming attempts.',
  'Elapsed time is external process wall time, including startup and tracing finalization. Missing traces remain in the elapsed-time and native-usage results.',
  'Interpret a timing comparison only alongside correctness and protocol adherence. Provider cache state and latency are uncontrolled.', '',
  '| Case | Variant | Correct | Protocol passed | Valid captures | Elapsed seconds | Primary responses | Output tokens, including reviewer |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
for (const name of manifest.cases) for (const harness of variants) {
  const runs = results.filter(r => r.case === name && variantOf(r) === harness);
  if (!runs.length) continue;
  const withOutput = runs.map(r => ({...r, output: r.usage.output_tokens}));
  lines.push(`| ${name} | ${harness} | ${runs.filter(r => r.correct).length}/${runs.length} | ${runs.filter(r => !r.protocolIssues.length).length}/${runs.length} | ${runs.filter(r => !r.traceErrors.length).length}/${runs.length} | ${metric(runs, 'processWallSeconds')} | ${metric(runs, 'primaryResponses', 0)} | ${metric(withOutput, 'output', 0)} |`);
}
if (manifest.cases.includes('parallel')) {
lines.push('', '## Parallel scheduling', '',
  'Each command waits one second. Tool grouping is checked in the native transcript; concurrency is independently measured inside the command processes.', '',
  '| Harness | Workload seconds | Peak concurrent jobs |', '| --- | ---: | ---: |');
for (const harness of variants) {
  const runs = results.filter(r => r.case === 'parallel' && variantOf(r) === harness);
  if (runs.length) lines.push(`| ${harness} | ${metric(runs, 'workloadWindowSeconds', 2)} | ${metric(runs, 'workloadPeakConcurrency', 0)} |`);
}
}
if (variants.includes('pi-codemode')) {
  lines.push('', '## Scripted tool use', '',
    'Assistant tool calls count outer calls. Executed tools count the underlying read, edit, write and shell calls, excluding script wrappers. Input includes cache reads and writes. Peak context uses Pi\'s context estimate or Claude\'s measured request input; these are not identical measurements.', '',
    '| Variant | Assistant tool calls | Scripts | Executed tools | Nested tools | Total input tokens | Peak context |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const variant of variants) {
    const runs = results.filter(r => variantOf(r) === variant).map(r => ({...r,
      executed: r.primaryExecutedCalls - r.scriptCalls,
      totalInput: r.usage.input_tokens + r.usage.cache_read_tokens + r.usage.cache_write_tokens,
      peakContext: r.sessions.find((s: any) => s.role === 'primary')?.peak_context}));
    if (runs.length) lines.push(`| ${variant} | ${metric(runs, 'primaryToolCalls', 0)} | ${metric(runs, 'scriptCalls', 0)} | ${metric(runs, 'executed', 0)} | ${metric(runs, 'nestedToolCalls', 0)} | ${metric(runs, 'totalInput', 0)} | ${metric(runs, 'peakContext', 0)} |`);
  }
}
lines.push('', '## Primary session time breakdown', '',
  'Only available traces contribute to this breakdown; see capture counts above. Missing measurements are never zero-filled.',
  'Model exchange joins Pi request-to-headers and response spans; Claude supplies native whole-request spans. These are approximate comparable boundaries, not a claim of identical API instrumentation.',
  'Tool work is summed duration, excludes script wrappers and may overlap. In the reviewer case, collection can include waiting for the child. Uncovered time is unclassified, not automatically harness overhead.', '',
  '| Case | Variant | Model exchange seconds | Tool work seconds | Uncovered seconds | Pi request-to-headers seconds | Pi first request-to-headers seconds |',
  '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
for (const name of manifest.cases) for (const harness of variants) {
  const runs = results.filter(r => r.case === name && variantOf(r) === harness);
  if (runs.length) lines.push(`| ${name} | ${harness} | ${metric(runs, 'primaryModelExchangeSeconds')} | ${metric(runs, 'primaryToolWorkSeconds')} | ${metric(runs, 'primaryUncoveredSeconds')} | ${metric(runs, 'primaryRequestToHeadersSeconds')} | ${metric(runs, 'firstRequestToHeadersSeconds')} |`);
}
lines.push('', '## Deviations and capture validation', '');
for (const run of results) {
  const issues = [...run.protocolIssues, ...run.traceErrors];
  if (!run.correct) issues.unshift('Incorrect result');
  if (issues.length) lines.push(`- ${run.case}, round ${run.round}, ${variantOf(run)}: ${issues.join('; ')}.`);
}
lines.push(`- Import error statistics: ${JSON.stringify(report.errors)}. Capture loss counters above zero: ${JSON.stringify(report.health)}.`,
  '- Native usage, primary/reviewer response counts, tool counts, pinned model and reviewer flows are checked in results.json.', '',
  '## Recordings', '', 'Open these in the updated local UI. Each recording contains the original clocks and packets; no timestamp alignment or synthetic sessions are introduced.', '');
for (const name of manifest.cases) {
  if (!available.some(r => r.case === name)) continue;
  const links = [`[all rounds](traces/${name}-all-rounds.pftrace)`,
    ...Array.from({length: manifest.rounds}, (_, i) => i + 1)
      .filter(round => available.filter(r => r.case === name && r.round === round).length === variants.length)
      .map(round => `[round ${round}](traces/${name}-round-${round}.pftrace)`)];
  lines.push(`- ${name}: ${links.join(', ')}.`);
}
lines.push('', 'The raw streams, exact commands, input hashes, workload audit and validation logs are retained per run. No built-in example is replaced.', '');
writeFileSync(join(batch, 'RESULTS.md'), lines.join('\n'));
console.log(lines.join('\n'));
if (report.errors.length || report.health.length || results.some(r => r.traceErrors.length)) process.exitCode = 1;
