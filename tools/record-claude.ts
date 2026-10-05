// SPDX-License-Identifier: Apache-2.0
// One-run capture launcher. Raw observations remain available for replay.
import {mkdirSync, openSync, writeSync, closeSync, fsyncSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {currentMachineIdentity} from '../packages/pi-tracing/extensions/pi-tracing/machine.ts';
import {captureClockReadings} from '../packages/pi-tracing/extensions/pi-tracing/tracer.ts';
import {convertObservations, type Observation} from '../packages/claude-tracing/convert.ts';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator !== 1 || !args[0] || args.includes('--help')) {
  console.error('Usage: bun tools/record-claude.ts OUTPUT.pftrace -- [claude arguments]\nCaptures one Claude process, including its subagents. Use -p for a headless run.');
  process.exit(args.includes('--help') ? 0 : 2);
}
const output = resolve(args[0]);
const childArgs = args.slice(separator + 1);
if (!childArgs.includes('-p') && !childArgs.includes('--print')) throw new Error('This prototype requires Claude print mode (-p).');
if (childArgs.includes('--output-format')) throw new Error('The launcher selects stream-json output for metadata capture.');
if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
const rawDirectory = `${output}.capture`;
mkdirSync(dirname(output), {recursive: true});
mkdirSync(rawDirectory, {mode: 0o700});
const journal = openSync(`${rawDirectory}/observations.jsonl`, 'wx', 0o600);
const token = randomUUID();
const timestamp = () => String(BigInt(Date.now()) * 1_000_000n);
let bytes = 0;
let dropped = 0;
function record(source: string, data: unknown) {
  const line = JSON.stringify({source, timestamp: timestamp(), data}) + '\n';
  if (source !== 'process_end' && bytes + Buffer.byteLength(line) > 128 * 1024 * 1024) {dropped++; return;}
  writeSync(journal, line);
  bytes += Buffer.byteLength(line);
}
const snapshot = () => record('clock_snapshot', Object.fromEntries(Object.entries(captureClockReadings()).map(([key, value]) => [key, value.toString()])));
snapshot();
const server = Bun.serve({hostname: '127.0.0.1', port: 0, maxRequestBodySize: 8 * 1024 * 1024,
  async fetch(request) {
    if (request.method !== 'POST' || request.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, {status: 403});
    const path = new URL(request.url).pathname;
    if (!['/hook', '/v1/traces', '/v1/logs'].includes(path)) return new Response(null, {status: 404});
    try {record(path, await request.json()); return Response.json({});}
    catch {dropped++; return new Response(null, {status: 400});}
  },
});
const endpoint = `http://127.0.0.1:${server.port}`;
const plugin = resolve(import.meta.dir, '../packages/claude-tracing/legacy');
const start = timestamp();
const child = Bun.spawn(['claude', '--plugin-dir', plugin, '--output-format', 'stream-json', '--verbose', ...childArgs], {
  stdin: 'inherit', stdout: 'pipe', stderr: 'inherit',
  env: {...process.env,
    AGENTPROF_CAPTURE_ENDPOINT: endpoint, AGENTPROF_CAPTURE_TOKEN: token,
    CLAUDE_CODE_ENABLE_TELEMETRY: '1', CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
    OTEL_TRACES_EXPORTER: 'otlp', OTEL_LOGS_EXPORTER: 'otlp', OTEL_METRICS_EXPORTER: 'none',
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${endpoint}/v1/logs`,
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: `Authorization=Bearer ${token}`, OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${token}`,
    OTEL_TRACES_EXPORT_INTERVAL: '1000', OTEL_LOGS_EXPORT_INTERVAL: '1000',
    OTEL_LOG_USER_PROMPTS: '1', OTEL_LOG_TOOL_DETAILS: '1', OTEL_LOG_TOOL_CONTENT: '0',
    OTEL_LOG_ASSISTANT_RESPONSES: '0', OTEL_LOG_RAW_API_BODIES: '0',
  },
});
record('process_start', {pid: child.pid, start, machineId: currentMachineIdentity().id, command: 'claude', captureId: randomUUID()});
const outputTask = (async () => {
  let pending = '';
  const decoder = new TextDecoder();
  for await (const bytes of child.stdout) {
    process.stdout.write(bytes);
    pending += decoder.decode(bytes, {stream: true});
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (value.type === 'result') record('result', {session_id: value.session_id, modelUsage: value.modelUsage,
          usage: value.usage, is_error: value.is_error, num_turns: value.num_turns});
      } catch { /* Other CLI output is still passed through unchanged. */ }
    }
    if (pending.length > 8 * 1024 * 1024) {pending = ''; dropped++;}
  }
})();
const flush = setInterval(() => fsyncSync(journal), 1000);
const clocks = setInterval(snapshot, 60_000);
const forward = (signal: NodeJS.Signals) => child.kill(signal);
const interrupt = () => forward('SIGINT');
const terminate = () => forward('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
const code = await child.exited;
await outputTask;
record('process_end', {pid: child.pid, code, dropped});
// Exporters flush before normal process exit. Finish any request already accepted.
await server.stop(false);
clearInterval(flush);
clearInterval(clocks);
fsyncSync(journal);
closeSync(journal);
process.off('SIGINT', interrupt);
process.off('SIGTERM', terminate);
console.error(`Agent Profiler observations: ${rawDirectory}/observations.jsonl`);
const observations = readFileSync(`${rawDirectory}/observations.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Observation);
const result = convertObservations(observations);
writeFileSync(output, result.trace, {flag: 'wx', mode: 0o600});
writeFileSync(`${rawDirectory}/summary.json`, JSON.stringify(result.summary, null, 2) + '\n', {mode: 0o600});
console.error(`Agent Profiler trace: ${output}`);
process.exitCode = code;
