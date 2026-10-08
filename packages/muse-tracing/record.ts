// SPDX-License-Identifier: Apache-2.0
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {mkdir, mkdtemp, readFile, writeFile, rename, rm, link, readlink, realpath, stat, open} from 'node:fs/promises';
import {dirname, join, resolve, isAbsolute, sep} from 'node:path';
import {homedir, tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {captureClockReadings} from '../pi-tracing/extensions/pi-tracing/tracer.ts';
import {currentMachineIdentity} from '../pi-tracing/extensions/pi-tracing/machine.ts';
import {convert, controlPrompt, type Capture} from './convert.ts';
import {readExport, validSession, string, object, integer, type NativeSession} from './native.ts';
import {processStartMarker, sameProcess} from '../agent-tracing/process-identity.ts';
import {captureContentsEnabled} from '../agent-tracing/content.ts';

const execute = promisify(execFile);
export const now = () => (BigInt(Date.now()) * 1000000n).toString();
export const dataDirectory = () => process.env.MUSE_PLUGIN_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'muse/plugins/data/agentprof');
export const clock = () => {const c = captureClockReadings(); return {realtimeNs: c.realtimeNs.toString(), boottimeNs: c.boottimeNs.toString()};};
export interface Recording {
  session: string; pid: number; processStartMarker?: string; cwd: string; binary: string; lastSeen: string;
  parentSession?: string;
  model?: string; provider?: string; effort?: string;
  configuration?: Capture['hooks'];
  capture?: Capture; stopping?: boolean; watcher?: number; watcherStartMarker?: string;
  output?: string; saved?: string; summary?: Record<string, unknown>;
}
export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {await writeFile(temporary, JSON.stringify(value), {mode: 0o600, flag: 'wx'}); await rename(temporary, path);}
  finally {await rm(temporary, {force: true});}
}
export async function readJson(path: string): Promise<any> {
  try {return JSON.parse(await readFile(path, 'utf8'));} catch (e: any) {if (e.code === 'ENOENT') return undefined; throw e;}
}
export function statePath(data: string, id: string) {
  if (!validSession(id)) throw new Error('Muse did not supply a valid session identity');
  return join(data, 'sessions', `${id}.json`);
}
async function locked<T>(data: string, id: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = statePath(data, id), lock = `${path}.lock`;
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const deadline = Date.now() + 60000;
  while (true) {
    try {await mkdir(lock, {mode: 0o700}); break;} catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      // A crashed writer leaves a lock. Wait out the maximum export duration
      // before reclaiming it; never race a live writer on a slow filesystem.
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 120000) {await rm(lock, {recursive: true, force: true}); continue;}
      } catch (error: any) {if (error.code === 'ENOENT') continue; throw error;}
      if (Date.now() >= deadline) throw new Error('Recording is busy. Retry shortly.');
      await delay(50);
    }
  }
  try {return await fn(path);} finally {await rm(lock, {recursive: true, force: true});}
}
function nativeEnv(data: string) {
  // Muse clears XDG variables in plugin children. Restore only its data root,
  // derived from the host-supplied plugin data directory, for session lookup.
  return {...process.env, MUSE_NO_AUTO_UPDATE: '1', XDG_DATA_HOME: resolve(data, '../../../..')};
}
export async function catalog(binary = 'muse', data = dataDirectory()): Promise<Capture['catalog']> {
  const host = spawn(binary, ['serve'], {env: nativeEnv(data), stdio: ['pipe', 'pipe', 'pipe']});
  host.stderr.resume();
  let serial = 0;
  const pending = new Map<number, {resolve: (value: any) => void; reject: (e: Error) => void}>();
  const fail = (e: Error) => {for (const p of pending.values()) p.reject(e); pending.clear();};
  host.once('error', fail); host.once('exit', () => fail(new Error('Muse catalog host exited')));
  const lines = createInterface({input: host.stdout});
  lines.on('line', line => {
    try {const m = JSON.parse(line), p = pending.get(m.id); if (p) {pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);}} catch {}
  });

  const send = (method: string, params = {}) => new Promise<any>((resolve, reject) => {
    const id = ++serial; pending.set(id, {resolve, reject}); host.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
  });
  const timer = setTimeout(() => {fail(new Error('Timed out reading Muse model catalog')); host.kill();}, 10000);
  try {
    await send('initialize', {clientInfo: {name: 'agentprof', version: '0.2.0'}});
    host.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'initialized', params: {}}) + '\n');
    const result = await send('model/list');
    return (result.models ?? []).filter((m: any) => integer(m.contextLimit)).map((m: any) =>
      ({model: string(m.modelId), provider: string(m.providerId), context: m.contextLimit}));
  } finally {clearTimeout(timer); lines.close(); host.stdin.end(); host.kill();}
}
export async function exportSessions(recording: Recording, data: string): Promise<NativeSession[]> {
  const result: NativeSession[] = [], seen = new Set<string>(), deadline = Date.now() + 45000;
  const temporary = await mkdtemp(join(tmpdir(), 'agentprof-muse-export-'));
  const visit = async (id: string, parent?: NativeSession, role?: string, path?: string) => {
    if (seen.has(id)) return;
    if (seen.size >= 128 || Date.now() >= deadline) {if (parent) parent.missingChildren.push(id); return;}
    seen.add(id);
    try {
      const exported = join(temporary, `${id}.json`);
      await execute(recording.binary, ['export', '--session', path || id, '--out', exported], {
        env: nativeEnv(data), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
      });
      if ((await stat(exported)).size > 256 * 1024 * 1024) throw new Error('Muse session export exceeds 256 MiB');
      const session = readExport(JSON.parse(await readFile(exported, 'utf8')), id, recording.capture!.capture_contents !== false);
      await rm(exported);
      const configuration = (await readJson(statePath(data, id)))?.configuration ?? [];
      for (const h of configuration) if (!recording.capture!.hooks.some(n => n.session === h.session && n.at === h.at)) recording.capture!.hooks.push(h);
      recording.capture!.hooks.sort((a, b) => BigInt(a.at) < BigInt(b.at) ? -1 : BigInt(a.at) > BigInt(b.at) ? 1 : 0);
      if (parent) {session.parent = parent.id; session.role = role;}
      result.push(session);
      for (const r of session.records) if (r.data.child_session_id && BigInt(r.at) <= BigInt(recording.capture!.end)) {
        // Prefer a recorded native path only when it remains under Muse's own
        // sessions directory. Otherwise resolve the explicit child ID.
        const candidate = string(r.data.child_session_log_path), root = resolve(data, '../../../sessions');
        // Muse 1.4 stores root UUIDv7 sessions by UTC creation date and child
        // links relative to that session's directory. Do not search other logs.
        let parentLog = path;
        if (!parentLog && id[14] === '7') {
          const date = new Date(Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toISOString().slice(0, 10).replaceAll('-', '/');
          parentLog = join(root, date, id, 'session.jsonl');
        }
        let childPath: string | undefined;
        if (candidate && (isAbsolute(candidate) || parentLog)) {
          try {
            const resolved = await realpath(resolve(parentLog ? dirname(parentLog) : root, candidate));
            if (resolved.startsWith(await realpath(root) + sep)) childPath = resolved;
          } catch {}
        }
        await visit(r.data.child_session_id, session, r.data.role, childPath);
      }
    } catch (e) {
      if (!parent) throw e;
      parent.missingChildren.push(id);
    }
  };
  try {await visit(recording.session); return result;}
  finally {await rm(temporary, {recursive: true, force: true});}
}
export async function control(data: string, id: string, action: string, output?: string) {
  return locked(data, id, async path => {
    const record: Recording | undefined = await readJson(path);
    if (!record) throw new Error('No session hook received. Install and approve the Agent Profiler plugin, then start a new Muse session.');
    if (action === 'start' && !record.capture) {
      const config = await readJson(join(data, 'config.json'));
      const target = resolve(record.cwd, output ?? config?.output_directory ?? join(record.cwd, 'agentprof-traces'),
        ...(output ? [] : [`muse-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}-${randomUUID().slice(0, 8)}.pftrace`]));
      if (!target.endsWith('.pftrace')) throw new Error('Output path must end in .pftrace');
      await mkdir(dirname(target), {recursive: true, mode: 0o700});
      try {await stat(target); throw new Error(`Output already exists: ${target}`);} catch (e: any) {if (e.code !== 'ENOENT') throw e;}
      let models: Capture['catalog'] = [];
      const cached = await readJson(join(data, 'catalog.json'));
      if (cached && Date.now() - cached.at < 86400000) models = cached.models;
      else try {models = await catalog(record.binary, data); await atomicJson(join(data, 'catalog.json'), {at: Date.now(), models});} catch {}
      record.capture = {id: randomUUID(), session: id, pid: record.pid, machineId: currentMachineIdentity().id,
        start: now(), end: now(), clocks: [clock()], catalog: models, hooks: [],
        capture_contents: config?.capture_contents !== false && captureContentsEnabled(process.env.AGENTPROF_CAPTURE_CONTENTS),
        processStartMarker: record.processStartMarker ?? processStartMarker(record.pid)};
      if (record.model) record.capture.hooks.push({at: record.capture.start, session: id, event: 'PreLLMCall',
        model: record.model, provider: record.provider, effort: record.effort});
      record.output = target; record.saved = undefined; record.summary = undefined; record.stopping = false;
      record.watcher = undefined; record.watcherStartMarker = undefined;
      await atomicJson(path, record);
    } else if (['stop', 'recover', 'finish'].includes(action) && record.capture) {
      if (!record.stopping) {record.capture.end = now(); record.capture.clocks.push(clock()); record.stopping = true;}
      if (action === 'recover') record.capture.incomplete = true;
      // Save the boundary before export: a failed export is recoverable and a
      // retry cannot silently include later work in this recording.
      await atomicJson(path, record);
      const sessions = await exportSessions(record, data);
      if (action === 'finish' && record.stopping) {
        const end = sessions[0]?.records.findLast(r => r.kind === 'session_end');
        if (end && BigInt(end.at) >= BigInt(record.capture.start) && BigInt(end.at) <= BigInt(record.capture.end)) record.capture.end = end.at;
        if ((!end && !sameProcess(record.pid, record.capture.processStartMarker)) ||
            (end?.data.exit_reason && end.data.exit_reason !== 'clean')) record.capture.incomplete = true;
      }
      const converted = convert(record.capture, sessions);
      const temporary = join(dirname(record.output!), `.agentprof-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, converted.trace, {flag: 'wx', mode: 0o600});
        await link(temporary, record.output!); // Atomic, and never overwrites an existing recording.
      } finally {await rm(temporary, {force: true});}
      record.saved = record.output; record.summary = converted.summary; record.capture = undefined; record.stopping = false;
      await atomicJson(path, record);
    } else if (!['start', 'stop', 'recover', 'status', 'finish'].includes(action)) throw new Error('Unknown recording action');
    return {state: record.capture ? record.stopping ? 'pending' : 'recording' : record.saved ? 'saved' : 'idle',
      session_id: id, output_path: record.output ?? record.saved, ...(record.summary ? {summary: record.summary} : {})};
  });
}
async function binaryForPid(pid: number): Promise<string> {
  if (process.platform === 'linux') try {
    const executable = await readlink(`/proc/${pid}/exe`);
    if (/(?:^|\/)muse(?:-bin[^/]*)?$/.test(executable)) return executable;
  } catch {}
  return 'muse';
}

export async function hook(data: string, payload: Record<string, any>, pid = process.ppid,
                           onWatcherNeeded?: () => Promise<void>) {
  const id = string(payload.session_id), event = string(payload.hook_event_name), at = now();
  const marker = processStartMarker(pid);
  let missingWatcher = false;
  const command = string(payload.prompt).trim();
  await locked(data, id, async path => {
    let record: Recording | undefined = await readJson(path);
    if (!record) record = {session: id, pid, processStartMarker: marker,
      cwd: string(payload.cwd) || process.cwd(), binary: await binaryForPid(pid), lastSeen: at};
    const changed = record.pid !== pid || !!record.processStartMarker && !!marker && record.processStartMarker !== marker;
    if (changed) {
      if (event !== 'SessionStart' || record.capture)
        throw new Error(`Previous capture needs recovery: agentprof-muse recover --session ${id}`);
      record.pid = pid; record.processStartMarker = marker;
      record.cwd = string(payload.cwd) || record.cwd; record.binary = await binaryForPid(pid);
      record.watcher = undefined; record.watcherStartMarker = undefined;
      record.configuration = undefined;
    } else if (!record.processStartMarker) record.processStartMarker = marker;
    record.lastSeen = at;
    if (payload.model) record.model = string(payload.model);
    if (payload.model_provider) record.provider = string(payload.model_provider);
    if (event === 'PreLLMCall') {
      const options = object(payload.options);
      const effort = options['meta.reasoning.effort'] ?? options['reasoning.effort'] ?? options.reasoning_effort;
      record.effort = string(effort) || undefined;
      const h = {at, session: id, event, model: record.model, provider: record.provider, effort: record.effort};
      const previous = record.configuration?.at(-1);
      if (!previous || previous.model !== h.model || previous.provider !== h.provider || previous.effort !== h.effort) {
        record.configuration ??= []; record.configuration.push(h);
        // Only configuration changes are retained while idle, never prompts or
        // usage. This also supplies accurate settings for recorded child logs.
        if (record.configuration.length > 4096) record.configuration.shift();
      }
    }
    if (record.capture && !record.stopping && ['PreLLMCall', 'PreCompact', 'PostCompact'].includes(event)) {
      record.capture.hooks.push({at, session: id, event, model: record.model, provider: record.provider,
        effort: record.effort, trigger: string(payload.trigger) || undefined});
      if (BigInt(at) - BigInt(record.capture.clocks.at(-1)!.realtimeNs) > 60000000000n) record.capture.clocks.push(clock());
    }
    missingWatcher = !!record.capture && !record.stopping &&
      (!record.watcher || !sameProcess(record.watcher, record.watcherStartMarker));
    await atomicJson(path, record);
  });
  if (event === 'SubagentStart' && validSession(string(payload.child_session_id))) {
    const child = string(payload.child_session_id), parent: Recording = await readJson(statePath(data, id));
    if (child !== id) await locked(data, child, async path => {
      const record = await readJson(path) ?? {session: child, pid, processStartMarker: marker,
        cwd: parent.cwd, binary: parent.binary, lastSeen: at};
      record.parentSession = id; await atomicJson(path, record);
    });
  }
  if (event === 'UserPromptSubmit' && controlPrompt(command)) {
    const [, action, output] = /^(?:\/)?tracing (start|stop|status)(?:\s+(.+))?$/.exec(command)!;
    const result = await control(data, id, action!, output);
    if (result.state === 'recording') await onWatcherNeeded?.();
    const message = `Agent Profiler: ${result.state}${result.output_path ? ` — ${result.output_path}` : ''}`;
    return {decision: 'block', reason: message, systemMessage: message};
  }
  if (event === 'SessionStart' && payload.source !== 'fork' && !(await readJson(statePath(data, id)))?.parentSession &&
      (process.env.AGENTPROF_MUSE_AUTO_START === '1' || (await readJson(join(data, 'config.json')))?.auto_start)) {
    const result = await control(data, id, 'start');
    if (result.state === 'recording') await onWatcherNeeded?.();
    return {systemMessage: `Agent Profiler recording: ${result.output_path}`};
  }
  if (event === 'SessionEnd') {
    const result = await control(data, id, 'finish');
    if (result.state === 'saved') return {systemMessage: `Agent Profiler trace saved: ${result.output_path}`};
  }
  if (missingWatcher) await onWatcherNeeded?.();
  return {};
}

export async function ensureWatcher(data: string, id: string, script: string) {
  await locked(data, id, async path => {
    const record: Recording | undefined = await readJson(path);
    if (!record?.capture || (record.watcher && sameProcess(record.watcher, record.watcherStartMarker))) return;
    const log = await open(join(data, 'watcher.log'), 'a', 0o600);
    try {
      const child = spawn(process.execPath, [script, 'watch', '--session', id], {env: {...process.env, MUSE_PLUGIN_DATA_DIR: data},
        detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd]});
      await new Promise<void>((resolve, reject) => {child.once('spawn', resolve); child.once('error', reject);});
      child.unref(); record.watcher = child.pid;
      record.watcherStartMarker = child.pid === undefined ? undefined : processStartMarker(child.pid);
      await atomicJson(path, record);
    } finally {await log.close();}
  });
}
export async function watch(data: string, id: string) {
  const initial: Recording | undefined = await readJson(statePath(data, id));
  if (!initial?.capture) return;
  const captureId = initial.capture.id;
  const owner = {pid: initial.pid, marker: initial.capture.processStartMarker ?? initial.processStartMarker};
  while (true) {
    const record: Recording | undefined = await readJson(statePath(data, id));
    if (record?.capture?.id !== captureId) return;
    if (!sameProcess(owner.pid, owner.marker)) {
      const result = await control(data, id, 'finish');
      console.log(`Agent Profiler trace saved: ${result.output_path}`); return;
    }
    await delay(1000);
  }
}
