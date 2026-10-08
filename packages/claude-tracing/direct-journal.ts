// SPDX-License-Identifier: Apache-2.0
import {mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, existsSync, linkSync, unlinkSync, statSync} from 'node:fs';
import {resolve, dirname, join, isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClockReadings} from '../pi-tracing/extensions/pi-tracing/tracer.ts';
import {currentMachineIdentity} from '../pi-tracing/extensions/pi-tracing/machine.ts';
import {convertDirectObservations} from './direct.ts';
import type {Observation} from '../agent-tracing/trace.ts';
import {parseObservationJournal} from '../agent-tracing/journal.ts';

export function initializeDirectCapture(path?: string, pid = process.ppid) {
  const captureId = randomUUID();
  if (path !== undefined && (!path.trim() || !path.endsWith('.pftrace') || path.includes('\0')))
    throw new Error('output_path must name a .pftrace file.');
  const output = resolve(path ?? join('agentprof-traces', `claude-${new Date().toISOString().replace(/[:.]/g, '-')}-${captureId.slice(0, 8)}.pftrace`));
  const directory = `${output}.capture`;
  if (existsSync(output)) throw new Error(`Output already exists: ${output}`);
  mkdirSync(dirname(output), {recursive: true});
  mkdirSync(directory, {mode: 0o700});
  const clocks = captureClockReadings();
  const metadata = {output, directory, pid, captureId};
  const rows: Observation[] = [
    {source: 'process_start', timestamp: String(clocks.realtimeNs), data: {...metadata, machineId: currentMachineIdentity().id}},
    {source: 'clock_snapshot', timestamp: String(clocks.realtimeNs), data: Object.fromEntries(Object.entries(clocks).map(([k, v]) => [k, String(v)]))},
  ];
  writeFileSync(join(directory, 'metadata.json'), JSON.stringify(rows), {flag: 'wx', mode: 0o600});
  return metadata;
}

export function readDirectCapture(directory: string): Observation[] {
  const metadata: unknown = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
  if (!Array.isArray(metadata) || !metadata.every(row => row && typeof row === 'object' &&
      typeof row.source === 'string' && typeof row.timestamp === 'string' && row.data &&
      typeof row.data === 'object' && !Array.isArray(row.data))) throw new Error('Invalid Claude capture metadata');
  const rows: Observation[] = metadata;
  for (const file of readdirSync(directory).filter(p => /^events-\d+\.jsonl$/.test(p)).sort()) {
    const {rows: valid, corruptRecords} = parseObservationJournal(readFileSync(join(directory, file), 'utf8'));
    rows.push(...valid);
    if (corruptRecords) rows.push({source: 'recovery', timestamp: rows.at(-1)!.timestamp,
      data: {incomplete_chunk: file, corrupt_records: corruptRecords}});
  }
  return rows;
}

export function finishDirectCapture(directory: string): {output: string} & Record<string, unknown> {
  const rows = readDirectCapture(directory), identity = rows.find(r => r.source === 'process_start');
  const expected = resolve(directory);
  if (!expected.endsWith('.pftrace.capture') || !identity || typeof identity.data.output !== 'string' ||
      !isAbsolute(identity.data.output) || resolve(identity.data.output) !== expected.slice(0, -'.capture'.length) ||
      typeof identity.data.directory !== 'string' || resolve(identity.data.directory) !== expected ||
      typeof identity.data.captureId !== 'string' || !identity.data.captureId)
    throw new Error('Invalid Claude capture identity or output path');
  const output = identity.data.output, captureId = identity.data.captureId;
  const result = convertDirectObservations(rows);
  const corruptRecords = rows.filter(r => r.source === 'recovery').reduce((sum, r) => sum + Number(r.data.corrupt_records ?? 0), 0);
  const ownership = join(directory, 'published');
  // Only replace the exact file we last published; a user may replace the path
  // between /clear or /resume. First publication must never overwrite a file.
  const owned = existsSync(ownership) ? JSON.parse(readFileSync(ownership, 'utf8')) : undefined;
  const replace = existsSync(output);
  if (replace) {
    const current = statSync(output);
    if (![owned, owned?.previous].some(marker => marker?.captureId === captureId && marker.ino === current.ino && marker.dev === current.dev && marker.mtimeMs === current.mtimeMs))
      throw new Error(`Output already exists: ${output}`);
  }
  const temp = join(directory, 'recording.tmp');
  writeFileSync(temp, result.trace, {mode: 0o600});
  const published = statSync(temp);
  // Record the inode before publication so recovery also works if Claude dies
  // between publishing the first file and writing its summary.
  const marker = {captureId, ino: published.ino, dev: published.dev, mtimeMs: published.mtimeMs};
  writeFileSync(`${ownership}.tmp`, JSON.stringify({...marker, previous: owned}), {mode: 0o600});
  renameSync(`${ownership}.tmp`, ownership);
  if (replace) renameSync(temp, output);
  else {linkSync(temp, output); unlinkSync(temp);}
  writeFileSync(`${ownership}.tmp`, JSON.stringify(marker), {mode: 0o600});
  renameSync(`${ownership}.tmp`, ownership);
  if (existsSync(join(directory, 'error.txt'))) unlinkSync(join(directory, 'error.txt'));
  writeFileSync(join(directory, 'summary.json'), JSON.stringify({output, ...result.summary, corruptRecords}, null, 2) + '\n', {mode: 0o600});
  return {output, ...result.summary, corruptRecords};
}
