// SPDX-License-Identifier: Apache-2.0
import {mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync, writeFileSync, existsSync, linkSync, unlinkSync} from 'node:fs';
import {dirname, join, resolve, isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClockReadings} from '../pi-tracing/extensions/pi-tracing/tracer.ts';
import {currentMachineIdentity} from '../pi-tracing/extensions/pi-tracing/machine.ts';
import {convertObservations, type Observation} from './convert.ts';
import {omitContent} from '../agent-tracing/content.ts';
import {parseObservationJournal} from '../agent-tracing/journal.ts';

export const now = () => String(BigInt(Date.now()) * 1_000_000n);
export class Journal {
  readonly output: string;
  readonly directory: string;
  readonly start = now();
  private fd: number;
  private bytes = 0;
  dropped = 0;
  constructor(readonly sessionId: string, pid: number, cwd: string, path?: string, public captureContents = true) {
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
      capture_contents: this.captureContents,
    }});
    this.clock();
  }
  clock() {
    this.add({source: 'clock_snapshot', timestamp: now(), data: Object.fromEntries(
      Object.entries(captureClockReadings()).map(([key, value]) => [key, String(value)]))});
  }
  add(row: Observation) {
    const safe = this.captureContents || ['process_start', 'process_end', 'clock_snapshot', 'session_metadata'].includes(row.source)
      ? row : {...row, data: row.source === 'codex.hook'
        ? Object.fromEntries(Object.entries(row.data).filter(([key]) => [
          'hook_event_name', 'session_id', 'parent_session', 'agent_id', 'agent_type', 'turn_id',
          'tool_name', 'tool_use_id', 'model', 'source', 'trigger', 'prompt_length', 'started_before_capture',
          'exit_code', 'is_error',
        ].includes(key))) : omitContent(row.data) as Record<string, unknown>};
    const line = JSON.stringify(safe) + '\n';
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
  const {rows, corruptRecords} = parseObservationJournal(readFileSync(join(directory, 'observations.jsonl'), 'utf8'));
  if (corruptRecords) rows.push({source: 'recovery', timestamp: rows.at(-1)?.timestamp ?? now(),
    data: {incomplete: true, corrupt_records: corruptRecords}});
  const original = rows.find(r => r.source === 'process_start')?.data.output;
  if (!output && (typeof original !== 'string' || !isAbsolute(original) ||
      !resolve(directory).endsWith('.pftrace.capture') || resolve(original) !== resolve(directory).slice(0, -'.capture'.length)))
    throw new Error('Invalid Codex capture identity or output path.');
  const target = output ? resolve(output) : original as string;
  if (!target || !target.endsWith('.pftrace')) throw new Error('Missing trace output path.');
  if (existsSync(target)) throw new Error(`Output already exists: ${target}`);
  const result = convertObservations(rows);
  const temporary = join(directory, `recording-${randomUUID()}.tmp`);
  writeFileSync(temporary, result.trace, {flag: 'wx', mode: 0o600});
  try {linkSync(temporary, target);} finally {unlinkSync(temporary);}
  const summary = {output: target, ...result.summary, corruptRecords};
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {mode: 0o600});
  return summary;
}
