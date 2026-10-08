// SPDX-License-Identifier: Apache-2.0
// Synthetic local hook benchmark, not a production latency measurement.
// Run: bun tools/bench-claude-direct.mjs
import {performance} from 'node:perf_hooks';

const sizes = [0, 100, 1000, 5000];
const rounds = Number(process.argv[2] ?? 25);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const percentile = (values, p) => values.slice().sort((a, b) => a - b)[Math.ceil(p * values.length) - 1]?.toFixed(3);

for (const hostDelayMs of [0, 5]) for (const messages of sizes) {
  const hooks = new Map(), usage = [], samples = [], firsts = [];
  const {register} = await import(`../packages/claude-tracing/hooks/direct.mjs?bench=${messages}-${hostDelayMs}-${Date.now()}`);
  register((name, matcher, handler) => hooks.set(name, handler ?? matcher), {show_controls: false});
  let saved, tick, messageReads = 0, stateWrites = 0;
  const $ = {
    env: {get: async name => name === 'AGENTPROF_TRACE_FILE' ? '/bench/capture.pftrace' : undefined}, plugin: {root: '/plugin'},
    session: {id: async () => 'bench', cwd: async () => '/bench', model: async () => 'model', version: async () => ({version: 'test'}),
      usage: async () => {usage.push(1); if (hostDelayMs) await delay(hostDelayMs); return {context: {tokens: 100, window: 200000}};},
      messages: async () => {messageReads++; if (hostDelayMs) await delay(hostDelayMs);
        return Array.from({length: messages}, (_, i) => ({role: 'user', text: `message-${i}`, toolUses: [], toolResults: []}));}},
    state: {get: async () => ({value: saved}), set: async (_, value) => {stateWrites++; if (hostDelayMs) await delay(hostDelayMs);
      saved = structuredClone(value);}},
    process: {run: async argv => ({exitCode: 0, stdout: JSON.stringify(argv[2] === 'init' ?
      {output: '/bench/capture.pftrace', directory: '/bench/capture.pftrace.capture', captureId: 'bench-capture'} : {}), stderr: ''})},
    fs: {write: async () => {}}, clock: {every: (_, callback) => {tick = callback; return {cancel() {}};}},
    command: {register: async () => ({})}, tool: {register: async spec => ({tool: spec.name})},
    ui: {log: async () => {}, invalidate() {}},
  };
  const call = (event, data = {}, next = async x => x) => hooks.get(event)($, data, next);
  await call('session.start');
  await tick?.(); // Keep capture-start baseline out of per-step checkpoint measurements.
  for (let i = 0; i < rounds; i++) {
    let started;
    const begin = performance.now();
    const stream = call('turn.step', {turnId: 'bench', index: i, model: 'model'}, async function* () {
      started = performance.now(); yield {kind: 'text', text: 'ok'}; return {usage: {model: 'model', input_tokens: 1, output_tokens: 1}};
    });
    await stream.next();
    samples.push(started - begin); firsts.push(performance.now() - begin);
    await stream.next();
  }
  console.log(JSON.stringify({messages, hostDelayMs, rounds, messagesCallsDuringCapture: messageReads,
    usageCalls: usage.length, stateWrites, dispatchMs: {median: percentile(samples, .5), p95: percentile(samples, .95)},
    firstYieldMs: {median: percentile(firsts, .5), p95: percentile(firsts, .95)}}));
}
