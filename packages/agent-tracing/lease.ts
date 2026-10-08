// SPDX-License-Identifier: Apache-2.0
import {existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join, win32} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {processStartMarker, sameProcess} from './process-identity.ts';

/** A kernel lock serializes stale-owner removal. The helper blocks on stdin
 * after announcing acquisition; a crash closes that pipe and releases flock,
 * so an orphaned lockfile cannot wedge later callers. Fail closed if flock is
 * unavailable rather than risking simultaneous stale reapers. */
export function reaperCommand(path: string, timeoutMs: number, platform = process.platform): [string, string[]] {
  const seconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
  const command = 'printf "READY\\n"; cat >/dev/null';
  if (platform === 'win32') {
    let parent = win32.dirname(path);
    try {parent = realpathSync.native(parent);} catch {} // Test/early setup paths may not exist yet.
    const canonical = win32.join(parent, win32.basename(path)).toLowerCase();
    const name = `Global\\agentprof_${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
    const powershell = `$m = [System.Threading.Mutex]::new($false, '${name}'); ` +
      `$locked = $false; try {$locked = $m.WaitOne(${timeoutMs})} ` +
      `catch [System.Threading.AbandonedMutexException] {$locked = $true}; ` +
      `if (!$locked) {exit 2}; [Console]::Out.WriteLine('READY'); ` +
      `[Console]::In.ReadToEnd() | Out-Null; $m.ReleaseMutex(); $m.Dispose()`;
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershell]];
  }
  if (platform === 'darwin') return ['lockf', ['-t', seconds, `${path}.reaper.lock`, 'sh', '-c', command]];
  return ['flock', ['-x', '-w', seconds, `${path}.reaper.lock`, 'sh', '-c', command]];
}

async function acquireReaper(path: string, timeoutMs: number): Promise<() => void> {
  const [binary, args] = reaperCommand(path, timeoutMs);
  const child = spawn(binary, args, {stdio: ['pipe', 'pipe', 'pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => {stderr += chunk;});
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {child.kill(); reject(new Error('Timed out waiting for stale-owner recovery lock'));}, timeoutMs + 1000);
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (/READY\r?\n/.test(output)) {clearTimeout(timer); resolve();}
    });
    child.once('error', error => {clearTimeout(timer); reject(error);});
    child.once('exit', code => {clearTimeout(timer); reject(new Error(`Stale-owner recovery lock failed (${code}): ${stderr}`));});
  });
  return () => {child.stdin.end();};
}

/** Cross-process short-lived directory lease. Missing owner state is reclaimed
 * only after a grace period; cleanup is serialized by a kernel flock so a
 * successor inode cannot be moved by a competing stale reaper. */
export async function acquireDirectoryLease(path: string, timeoutMs = 5000): Promise<() => void> {
  const nonce = randomUUID(), deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync(path, {mode: 0o700});
      try {writeFileSync(join(path, 'owner.json'), JSON.stringify({pid: process.pid,
        marker: processStartMarker(process.pid), nonce}), {flag: 'wx', mode: 0o600});}
      catch (error) {rmSync(path, {recursive: true, force: true}); throw error;}
      const owner = statSync(path);
      return () => {
        try {
          const current = statSync(path), stored = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
          if (current.dev !== owner.dev || current.ino !== owner.ino || stored.nonce !== nonce) return;
          const quarantine = `${path}.release-${nonce}`;
          renameSync(path, quarantine);
          const moved = statSync(quarantine);
          if (moved.dev === owner.dev && moved.ino === owner.ino) rmSync(quarantine, {recursive: true, force: true});
          else if (!existsSync(path)) renameSync(quarantine, path);
        } catch {} // Best effort; a stale lease can be reclaimed later.
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const before = statSync(path);
        let stale = false;
        try {
          const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
          stale = typeof owner.pid === 'number' && !sameProcess(owner.pid, owner.marker);
        } catch {stale = Date.now() - before.mtimeMs > 15000;}
        if (stale) {
          const releaseReaper = await acquireReaper(path, timeoutMs);
          try {
            const current = statSync(path);
            let stillStale = false;
            try {
              const owner = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
              stillStale = typeof owner.pid === 'number' && !sameProcess(owner.pid, owner.marker);
            } catch {stillStale = Date.now() - current.mtimeMs > 15000;}
            if (stillStale && current.dev === before.dev && current.ino === before.ino && current.mtimeMs === before.mtimeMs) {
              const quarantine = `${path}.stale-${nonce}`;
              renameSync(path, quarantine);
              rmSync(quarantine, {recursive: true, force: true});
            }
          } finally {releaseReaper();}
          continue;
        }
      } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
      await delay(50);
    }
  }
  throw new Error(`Timed out waiting for receiver lease: ${path}`);
}
