// SPDX-License-Identifier: Apache-2.0
// Synthetic local per-hook process cost (not a production latency SLA).
// Run on Node 22+: bun tools/bench-hook-latency.ts [rounds]
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {randomUUID, createHash} from 'node:crypto';
import {configure, readConnection} from '../packages/codex-tracing/plugin-config.ts';
import {processStartMarker} from '../packages/agent-tracing/process-identity.ts';

const rounds = Number(process.argv[2] ?? 20);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 200) throw new Error('rounds must be 1..200');
const root = mkdtempSync(join(tmpdir(), 'agentprof-hook-bench-'));
const node = process.env.AGENTPROF_NODE ?? 'node';
const codex = resolve('packages/codex-tracing/runtime/codex-tracing.mjs');
const muse = resolve('packages/muse-tracing/runtime/muse-tracing.mjs');
const id = '11111111-1111-4111-8111-111111111111';
function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * p) - 1]!.toFixed(2));
}
async function run(args: string[], input: string, env = process.env) {
  const started = performance.now();
  const child = spawn(node, args, {env, stdio: ['pipe', 'pipe', 'pipe']});
  let error = '';
  child.stderr.on('data', chunk => {error += chunk;});
  child.stdout.resume(); child.stdin.end(input);
  const code = await new Promise<number | null>((done, reject) => {
    const timer = setTimeout(() => {child.kill(); reject(new Error('Hook timed out'));}, 10000);
    child.once('error', reject); child.once('exit', code => {clearTimeout(timer); done(code);});
  });
  if (code !== 0) throw new Error(`Hook exited ${code}: ${error}`);
  return performance.now() - started;
}
async function measure(name: string, args: string[], input: string, env = process.env) {
  await run(args, input, env); // Warm filesystem/cache; no model or network.
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) samples.push(await run(args, input, env));
  console.log(JSON.stringify({name, rounds, medianMs: percentile(samples, .5), p95Ms: percentile(samples, .95)}));
}
let server: ReturnType<typeof createServer> | undefined;
try {
  const state = join(root, 'codex/agentprof');
  mkdirSync(join(root, 'codex'), {recursive: true});
  await configure(state, join(root, 'codex'), codex);
  const connection = readConnection(state);
  let hookRequests = 0, healthRequests = 0;
  server = createServer((request, response) => {
    if (request.url === '/hook') hookRequests++;
    if (request.url === '/health') healthRequests++;
    response.writeHead(200, {'content-type': 'application/json',
      'x-agentprof-generation': connection.generation!,
      'x-agentprof-build': createHash('sha256').update(readFileSync(codex)).digest('hex')}); response.end('{}');
  });
  await new Promise<void>((done, reject) => {server!.once('error', reject); server!.listen(connection.port, '127.0.0.1', done);});
  await measure('bare Node process', ['-e', `process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write('{}'))`], '{}');
  await measure('Codex warm hook', [codex, 'hook', '--state', state],
    JSON.stringify({hook_event_name: 'SessionStart', session_id: id, cwd: root}));
  console.log(JSON.stringify({codexRequests: {hook: hookRequests, health: healthRequests}}));
  const data = join(root, 'muse/plugins/data/agentprof');
  mkdirSync(data, {recursive: true});
  const env = {...process.env, MUSE_PLUGIN_DATA_DIR: data};
  await measure('Muse idle PreLLMCall', [muse, 'hook'],
    JSON.stringify({hook_event_name: 'PreLLMCall', session_id: id, model: 'fixture-model'}), env);
  const path = join(data, 'sessions', `${id}.json`);
  const stateRecord = JSON.parse(readFileSync(path, 'utf8'));
  const timestamp = (BigInt(Date.now()) * 1_000_000n).toString();
  stateRecord.capture = {id: randomUUID(), session: id, pid: process.pid, machineId: 0,
    start: timestamp, end: timestamp, clocks: [{realtimeNs: timestamp, boottimeNs: timestamp}], catalog: [], hooks: []};
  // Model an already-healthy watcher; its startup belongs to capture start,
  // not the steady-state hook measurements, and must not leak a test process.
  stateRecord.watcher = process.pid;
  stateRecord.watcherStartMarker = processStartMarker(process.pid);
  writeFileSync(path, JSON.stringify(stateRecord), {mode: 0o600});
  await measure('Muse recording PreLLMCall', [muse, 'hook'],
    JSON.stringify({hook_event_name: 'PreLLMCall', session_id: id, model: 'fixture-model'}), env);
} finally {
  if (server) await new Promise<void>(done => server!.close(() => done()));
  rmSync(root, {recursive: true, force: true});
}
