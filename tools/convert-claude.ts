// SPDX-License-Identifier: Apache-2.0
import {readFileSync, writeFileSync, statSync} from 'node:fs';
import {convertObservations, type Observation} from '../packages/claude-tracing/convert.ts';
import {readDirectCapture} from '../packages/claude-tracing/direct-journal.ts';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: bun tools/convert-claude.ts CAPTURE_DIRECTORY_OR_JSONL OUTPUT.pftrace');
const rows = statSync(input).isDirectory() ? readDirectCapture(input) :
  readFileSync(input, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Observation);
const result = convertObservations(rows);
writeFileSync(output, result.trace, {flag: 'wx', mode: 0o600});
console.log(JSON.stringify(result.summary, null, 2));
