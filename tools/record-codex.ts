// SPDX-License-Identifier: Apache-2.0
import {mkdirSync, openSync, writeSync, closeSync, fsyncSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {currentMachineIdentity} from '../packages/pi-tracing/extensions/pi-tracing/machine.ts';
import {captureClockReadings} from '../packages/pi-tracing/extensions/pi-tracing/tracer.ts';
import {convertObservations, type Observation} from '../packages/codex-tracing/convert.ts';
import {capturedSessionIds, sessionMetadata} from '../packages/codex-tracing/metadata.ts';
import {captureContentsEnabled, omitContent} from '../packages/agent-tracing/content.ts';

const args = process.argv.slice(2), separator = args.indexOf('--');
if (separator !== 1 || !args[0]) {
  console.error('Usage: bun tools/record-codex.ts OUTPUT.pftrace -- [codex exec options] PROMPT\nRecords one Codex exec process and its logical subagents. Requires Codex CLI 0.160.0 or compatible telemetry.');
  process.exit(args.includes('--help') ? 0 : 2);
}
const output = resolve(args[0]), childArgs = args.slice(separator + 1);
const captureContents = captureContentsEnabled(process.env.AGENTPROF_CAPTURE_CONTENTS);
if (childArgs[0] === 'exec') childArgs.shift();
if (childArgs.includes('--ephemeral')) throw new Error('--ephemeral is unsupported: context limits require the captured session metadata.');
if (childArgs.some(a => /^otel[.=]|^--config=otel[.=]/.test(a))) throw new Error('The recorder configures the Codex OTel exporters.');
if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
const directory = `${output}.capture`;
mkdirSync(dirname(output), {recursive: true});
mkdirSync(directory, {mode: 0o700});
const journal = openSync(join(directory, 'observations.jsonl'), 'wx', 0o600);
const timestamp = () => String(BigInt(Date.now()) * 1_000_000n);
let bytes = 0, dropped = 0;
function record(source: string, data: unknown, at = timestamp()) {
  const line = JSON.stringify({source, timestamp: at, data: captureContents || ['process_start', 'process_end', 'clock_snapshot', 'session_metadata'].includes(source)
    ? data : source === 'cli' ? {type: (data as any)?.type, thread_id: (data as any)?.thread_id} : omitContent(data)}) + '\n';
  if (source !== 'process_end' && bytes + Buffer.byteLength(line) > 128 * 1024 * 1024) {dropped++; return;}
  writeSync(journal, line); bytes += Buffer.byteLength(line);
}
const read = (): Observation[] => readFileSync(join(directory, 'observations.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const snapshot = () => record('clock_snapshot', Object.fromEntries(Object.entries(captureClockReadings()).map(([key, v]) => [key, v.toString()])));
const token = randomUUID();
const server = Bun.serve({hostname: '127.0.0.1', port: 0, maxRequestBodySize: 8 * 1024 * 1024,
  async fetch(request) {
    if (request.method !== 'POST' || request.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, {status: 403});
    const path = new URL(request.url).pathname;
    if (!['/v1/logs', '/v1/traces'].includes(path)) return new Response(null, {status: 404});
    try {
      const body = Buffer.from(await request.arrayBuffer());
      const decoded = request.headers.get('content-encoding') === 'gzip' ? gunzipSync(body, {maxOutputLength: 8 * 1024 * 1024}) : body;
      record(path, JSON.parse(decoded.toString())); return Response.json({});
    } catch {dropped++; return new Response(null, {status: 400});}
  },
});
const exporter = (path: string) => `{otlp-http={endpoint=${JSON.stringify(`http://127.0.0.1:${server.port}${path}`)},protocol="json",headers={Authorization="Bearer ${token}"}}}`;
const flush = setInterval(() => fsyncSync(journal), 1000);
const clocks = setInterval(snapshot, 60_000);
let child: ReturnType<typeof Bun.spawn> | undefined;
const interrupt = () => child?.kill('SIGINT');
const terminate = () => child?.kill('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
try {
  snapshot();
  const start = timestamp();
  const processChild = Bun.spawn(['codex', '--no-daemon', 'exec', '--json',
    '-c', `otel.exporter=${exporter('/v1/logs')}`, '-c', `otel.trace_exporter=${exporter('/v1/traces')}`,
    '-c', `otel.log_user_prompt=${captureContents}`, ...childArgs], {stdin: 'inherit', stdout: 'pipe', stderr: 'inherit'});
  child = processChild;
  record('process_start', {pid: child.pid, captureId: randomUUID(), machineId: currentMachineIdentity().id, capture_contents: captureContents}, start);
  const stdout = (async () => {
    let pending = ''; const decoder = new TextDecoder();
    for await (const buffer of processChild.stdout) {
      process.stdout.write(buffer); pending += decoder.decode(buffer, {stream: true});
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        try {record('cli', JSON.parse(line));} catch { /* Non-JSON diagnostics are still forwarded. */ }
      }
      if (pending.length > 8 * 1024 * 1024) {pending = ''; dropped++;}
    }
  })();
  const code = await child.exited, end = timestamp();
  await stdout;
  await server.stop(false); // Drain requests flushed by Codex at shutdown.
  const sessions = capturedSessionIds(read());
  let transcripts = 0;
  try {
    transcripts = await sessionMetadata(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions'), sessions,
      data => record('session_metadata', data));
  } catch (error) {console.error(`Codex metadata unavailable: ${String(error)}`);}
  record('process_end', {pid: child.pid, code, dropped, transcripts}, end);
  fsyncSync(journal);
  console.error(`Agent Profiler observations: ${directory}/observations.jsonl`);
  const result = convertObservations(read());
  writeFileSync(output, result.trace, {flag: 'wx', mode: 0o600});
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(result.summary, null, 2) + '\n', {mode: 0o600});
  console.error(`Agent Profiler trace: ${output}`);
  if (transcripts < sessions.length) console.error('Context limits are unavailable for sessions without recorded metadata.');
  process.exitCode = code;
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  clearInterval(flush); clearInterval(clocks); await server.stop(true);
  fsyncSync(journal); closeSync(journal);
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
}
