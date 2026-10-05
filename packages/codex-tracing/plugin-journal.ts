// SPDX-License-Identifier: Apache-2.0
import {mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, writeFileSync, existsSync, linkSync, unlinkSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClockReadings} from '../pi-tracing/extensions/pi-tracing/tracer.ts';
import {currentMachineIdentity} from '../pi-tracing/extensions/pi-tracing/machine.ts';
import {convertObservations, type Observation} from './convert.ts';

export const now = () => String(BigInt(Date.now()) * 1_000_000n);
export class Journal {
  readonly output: string;
  readonly directory: string;
  readonly start = now();
  private fd: number;
  private bytes = 0;
  dropped = 0;
  constructor(readonly sessionId: string, pid: number, cwd: string, path?: string) {
    if (path !== undefined && (!path.trim() || !path.endsWith('.pftrace') || path.includes('\0')))
      throw new Error('output_path must name a .pftrace file.');
    const captureId = randomUUID();
    this.output = resolve(cwd, path ?? join('agentprof-traces', `codex-${new Date().toISOString().replace(/[:.]/g, '-')}-${captureId.slice(0, 8)}.pftrace`));
    this.directory = `${this.output}.capture`;
    if (existsSync(this.output)) throw new Error(`Output already exists: ${this.output}`);
    mkdirSync(dirname(this.output), {recursive: true});
    mkdirSync(this.directory, {mode: 0o700});
    this.fd = openSync(join(this.directory, 'observations.jsonl'), 'wx', 0o600);
    this.add({source: 'process_start', timestamp: this.start, data: {
      pid, captureId, sessionId, output: this.output, machineId: currentMachineIdentity().id, recorder: 'codex-plugin-1',
    }});
    this.clock();
  }
  clock() {
    this.add({source: 'clock_snapshot', timestamp: now(), data: Object.fromEntries(
      Object.entries(captureClockReadings()).map(([key, value]) => [key, String(value)]))});
  }
  add(row: Observation) {
    const line = JSON.stringify(row) + '\n';
    const size = Buffer.byteLength(line);
    if (this.bytes + size > 128 * 1024 * 1024 && row.source !== 'process_end') {this.dropped++; return;}
    writeSync(this.fd, line); this.bytes += size;
  }
  flush() {fsyncSync(this.fd);}
  close(end: string, incomplete: boolean) {
    this.add({source: 'process_end', timestamp: end, data: {dropped: this.dropped, incomplete}});
    this.flush(); closeSync(this.fd);
  }
}

export function publish(directory: string, output?: string) {
  const text = readFileSync(join(directory, 'observations.jsonl'), 'utf8');
  const lines = text.split('\n'), tail = lines.pop();
  const rows: Observation[] = lines.filter(Boolean).map(line => JSON.parse(line));
  if (tail) rows.push({source: 'recovery', timestamp: rows.at(-1)?.timestamp ?? now(), data: {incomplete: true}});
  const target = output ? resolve(output) : String(rows.find(r => r.source === 'process_start')?.data.output ?? '');
  if (!target || !target.endsWith('.pftrace')) throw new Error('Missing trace output path.');
  if (existsSync(target)) throw new Error(`Output already exists: ${target}`);
  const result = convertObservations(rows);
  const temporary = join(directory, `recording-${randomUUID()}.tmp`);
  writeFileSync(temporary, result.trace, {flag: 'wx', mode: 0o600});
  try {linkSync(temporary, target);} finally {unlinkSync(temporary);}
  const summary = {output: target, ...result.summary};
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
  return summary;
}
