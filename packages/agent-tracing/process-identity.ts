// SPDX-License-Identifier: Apache-2.0
import {readFileSync} from 'node:fs';

/** Linux /proc stat field 22. The command in parentheses can itself contain
 * spaces or ')', so parse fields only after the final closing parenthesis. */
export function linuxProcessStartMarker(stat: string): string | undefined {
  const close = stat.lastIndexOf(')');
  const fields = close < 0 ? [] : stat.slice(close + 1).trim().split(/\s+/);
  const value = fields[19];
  return value && /^\d+$/.test(value) ? value : undefined;
}

export function processStartMarker(pid: number, platform = process.platform,
                                   read: (path: string, encoding: 'utf8') => string = (path, encoding) => readFileSync(path, encoding)): string | undefined {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return;
  try {return linuxProcessStartMarker(read(`/proc/${pid}/stat`, 'utf8'));} catch {return undefined;}
}

/** Missing markers (old state / unsupported platform / temporary procfs error)
 * degrade conservatively to PID liveness, never declaring a live owner dead. */
export function sameProcess(pid: number, marker?: string,
                            exists: (pid: number) => boolean = pidExists,
                            start: (pid: number) => string | undefined = processStartMarker): boolean {
  if (!exists(pid)) return false;
  if (!marker) return true;
  const current = start(pid);
  return current === undefined || current === marker;
}

export function pidExists(pid: number, signal: (pid: number, signal: 0) => void = process.kill): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {signal(pid, 0); return true;} catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
