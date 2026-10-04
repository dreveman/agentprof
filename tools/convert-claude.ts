// SPDX-License-Identifier: Apache-2.0
import {readFileSync, writeFileSync} from 'node:fs';
import {convertObservations, type Observation} from '../packages/claude-tracing/convert.ts';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: bun tools/convert-claude.ts observations.jsonl OUTPUT.pftrace');
const rows = readFileSync(input, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Observation);
const result = convertObservations(rows);
writeFileSync(output, result.trace, {flag: 'wx', mode: 0o600});
console.log(JSON.stringify(result.summary, null, 2));
