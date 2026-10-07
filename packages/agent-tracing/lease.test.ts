// SPDX-License-Identifier: Apache-2.0
import {test, expect} from 'bun:test';
import {mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireDirectoryLease, reaperCommand} from './lease.ts';
const linuxTest = process.platform === 'linux' ? test : test.skip;

test('stale recovery chooses a crash-released kernel primitive per platform', () => {
  expect(reaperCommand('/tmp/lock', 3000, 'linux')[0]).toBe('flock');
  expect(reaperCommand('/tmp/lock', 3000, 'darwin')[0]).toBe('lockf');
  const [binary, args] = reaperCommand('C:\\agentprof\\lock', 3000, 'win32');
  expect(binary).toBe('powershell.exe');
  expect(args.join(' ')).toContain('System.Threading.Mutex');
  expect(args.join(' ')).toContain('Global\\agentprof_');
  expect(reaperCommand('c:\\AGENTPROF\\LOCK', 3000, 'win32')[1]).toEqual(args);
  expect(args.join(' ')).toContain('AbandonedMutexException');
});

test('directory lease serializes contenders and fences old releases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentprof-lease-')), lock = join(root, 'start.lock');
  try {
    const release = await acquireDirectoryLease(lock);
    const pending = acquireDirectoryLease(lock, 1000);
    await Bun.sleep(30);
    expect(existsSync(lock)).toBe(true);
    release();
    const second = await pending;
    const nonce = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).nonce;
    release(); // An old owner must not remove the successor.
    expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).nonce).toBe(nonce);
    second(); expect(existsSync(lock)).toBe(false);
  } finally {rmSync(root, {recursive: true, force: true});}
});

linuxTest('concurrent stale-lock recovery admits only one owner at a time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentprof-reapers-')), lock = join(root, 'start.lock');
  try {
    mkdirSync(lock);
    const old = new Date(Date.now() - 30_000); utimesSync(lock, old, old);
    let active = 0, peak = 0;
    await Promise.all(Array.from({length: 8}, async () => {
      const release = await acquireDirectoryLease(lock, 3000);
      active++; peak = Math.max(active, peak);
      await Bun.sleep(5);
      active--; release();
    }));
    expect(peak).toBe(1);
    expect(existsSync(lock)).toBe(false);
  } finally {rmSync(root, {recursive: true, force: true});}
});

linuxTest('an orphaned kernel reaper lockfile does not wedge recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentprof-reaper-orphan-')), lock = join(root, 'start.lock');
  try {
    mkdirSync(lock); writeFileSync(`${lock}.reaper.flock`, '');
    const old = new Date(Date.now() - 30_000);
    utimesSync(lock, old, old);
    const release = await acquireDirectoryLease(lock, 1500);
    expect(existsSync(join(lock, 'owner.json'))).toBe(true);
    expect(existsSync(`${lock}.reaper.flock`)).toBe(true);
    release();
  } finally {rmSync(root, {recursive: true, force: true});}
});

linuxTest('old ownerless startup locks are recovered but fresh ones are not stolen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentprof-orphan-')), lock = join(root, 'start.lock');
  try {
    mkdirSync(lock);
    await expect(acquireDirectoryLease(lock, 100)).rejects.toThrow('Timed out');
    const old = new Date(Date.now() - 30_000); utimesSync(lock, old, old);
    const release = await acquireDirectoryLease(lock, 1000);
    expect(existsSync(join(lock, 'owner.json'))).toBe(true);
    release();
  } finally {rmSync(root, {recursive: true, force: true});}
});
