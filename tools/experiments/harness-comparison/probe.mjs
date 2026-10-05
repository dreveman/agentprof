// SPDX-License-Identifier: Apache-2.0
// A measured local workload, independent of either harness's tool telemetry.
import {appendFileSync, readFileSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';

const config = JSON.parse(readFileSync(new URL('./probe-data.json', import.meta.url), 'utf8'));
const [mode, key, ...extra] = process.argv.slice(2);
const record = (phase) => appendFileSync(process.env.AGENTPROF_PROBE_AUDIT,
  JSON.stringify({mode, key, phase, pid: process.pid, ns: String(process.hrtime.bigint())}) + '\n');
if (extra.length) throw new Error('Expected exactly a mode and key');
if (mode === 'step') {
  const index = config.chain.indexOf(key);
  if (index < 0 || index === config.chain.length - 1) throw new Error('Invalid chain key');
  record('start');
  console.log(JSON.stringify(index === config.chain.length - 2
    ? {done: config.chain[index + 1]}
    : {next: config.chain[index + 1]}));
} else if (mode === 'job' && Object.hasOwn(config.jobs, key)) {
  record('start');
  // An explicit fixed-delay scheduler diagnostic, not a simulated real service.
  await setTimeout(config.delayMs);
  console.log(JSON.stringify({job: key, value: config.jobs[key]}));
} else {
  throw new Error('Invalid probe invocation');
}
record('end');
