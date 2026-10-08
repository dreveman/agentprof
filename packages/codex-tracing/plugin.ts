// SPDX-License-Identifier: Apache-2.0
// Codex plugin entry point. Hooks and MCP tools communicate with an on-demand
// Unix-socket recorder; no installed profile exports native telemetry.
import {spawn, spawnSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync} from 'node:fs';
import {request as httpRequest} from 'node:http';
import {connect} from 'node:net';
import {createInterface} from 'node:readline';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {privateSocketPath, readConnection, stateDirectory, writeInstalledProfile, type Connection} from './plugin-config.ts';
import {serve} from './plugin-collector.ts';
import {publish, now} from './plugin-journal.ts';
import {object, string} from './otel.ts';
import {captureContentsEnabled} from '../agent-tracing/content.ts';
import {processStartMarker, sameProcess} from '../agent-tracing/process-identity.ts';
import {acquireDirectoryLease} from '../agent-tracing/lease.ts';

const script = fileURLToPath(import.meta.url);
const buildId = createHash('sha256').update(readFileSync(script)).digest('hex');
const captureContents = captureContentsEnabled(process.env.AGENTPROF_CAPTURE_CONTENTS);
const args = process.argv.slice(2), command = args.shift();
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return;
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2); return value;
}
const state = resolve(option('--state') ?? stateDirectory(option('--plugin-data')));

class TransportError extends Error {}
const portBound = (port: number) => new Promise<boolean>(resolve => {
  const client = connect({host: '127.0.0.1', port});
  let done = false;
  const finish = (bound: boolean) => {if (done) return; done = true; client.destroy(); resolve(bound);};
  client.once('connect', () => finish(true));
  client.once('error', error => finish((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED'));
  client.setTimeout(200, () => finish(true));
});
function ownerConnection(): Connection | undefined {
  if (!existsSync(join(state, 'connection.json'))) return;
  const connection = readConnection(state);
  if (!connection.run || !connection.socket)
    throw new Error('An old fixed-endpoint profile must be migrated before recording. Close old Codex sessions and run agentprof-codex install --migrate.');
  try {
    const owner = JSON.parse(readFileSync(join(state, 'receiver-owner.json'), 'utf8'));
    if (owner.generation === connection.generation && Number.isSafeInteger(owner.pid) &&
        sameProcess(owner.pid, owner.marker)) return connection;
  } catch {}
}
async function request(path: string, data: unknown, connection: Connection): Promise<Record<string, unknown>> {
  if (!connection.socket || !ownerConnection()) throw new TransportError('No plugin receiver owns this socket.');
  const body = JSON.stringify({...object(data), capture_contents: captureContents});
  const response = await new Promise<{status: number; headers: import('node:http').IncomingHttpHeaders; text: string}>((done, reject) => {
    const client = httpRequest({socketPath: connection.socket, path, method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${connection.token}`}, timeout: 12000}, reply => {
      let text = '';
      reply.on('data', chunk => {text += chunk; if (text.length > 1024 * 1024) reply.destroy();});
      reply.once('end', () => done({status: reply.statusCode ?? 0, headers: reply.headers, text}));
      reply.once('error', error => reject(new TransportError(String(error))));
    });
    client.once('timeout', () => client.destroy(new TransportError('Recorder request timed out.')));
    client.once('error', error => reject(new TransportError(String(error)))); client.end(body);
  });
  if (response.headers['x-agentprof-generation'] !== connection.generation ||
      response.headers['x-agentprof-build'] !== buildId) throw new Error('Plugin receiver does not match this installed runtime.');
  const result = object(JSON.parse(response.text));
  if (response.status >= 400) throw new Error(string(result.error) || `Recorder returned ${response.status}`);
  return result;
}
async function ensureReceiver(): Promise<Connection> {
  const current = ownerConnection();
  if (current) return current;
  mkdirSync(state, {recursive: true, mode: 0o700});
  const release = await acquireDirectoryLease(join(state, 'receiver-lifecycle.lock'), 10000);
  try {
    const live = ownerConnection(); if (live) return live;
    if (existsSync(join(state, 'connection.json'))) {
      const previous = readConnection(state);
      if (previous.socket) {
        try {unlinkSync(previous.socket);} catch {}
        try {rmdirSync(dirname(previous.socket));} catch {}
      }
      unlinkSync(join(state, 'connection.json'));
    }
    try {unlinkSync(join(state, 'receiver-owner.json'));} catch {}
    const log = openSync(join(state, 'receiver.log'), 'a', 0o600);
    let child;
    try {child = spawn(process.execPath, [script, 'serve', '--state', state],
      {detached: true, windowsHide: true, stdio: ['ignore', log, log]});}
    finally {closeSync(log);}
    await new Promise<void>((done, reject) => {child.once('spawn', done); child.once('error', reject);});
    child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      const connection = ownerConnection();
      if (connection) try {
        if ((await request('/health', {}, connection)).build === buildId) return connection;
      } catch {}
      await delay(50);
    }
    throw new Error('Plugin receiver did not start. Check agentprof/receiver.log in the Codex home.');
  } finally {release();}
}
async function requestWithReceiver(path: string, data: unknown) {
  const connection = await ensureReceiver();
  try {return await request(path, data, connection);}
  catch (error) {
    if (!(error instanceof TransportError)) throw error;
    // The old Unix listener may be closing between liveness inspection and
    // connect. Wait for its owner to release the socket, then use a new one.
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!ownerConnection()) return request(path, data, await ensureReceiver());
      await delay(50);
    }
    throw error;
  }
}

export const tools = ['start', 'stop', 'status'].map(action => ({
  name: `tracing_${action}`,
  description: action === 'start' ? 'Start a local Agent Profiler recording of this Codex session and its subagents. Returns the trace output path.' :
    action === 'stop' ? 'Stop this recording and begin saving asynchronously. Returns a saving state and output path immediately; call tracing_status later to confirm saved or error.' :
    'Get this session’s recording state and trace path.',
  inputSchema: {type: 'object', properties: action === 'start' ? {output_path: {type: 'string', description: 'Optional new .pftrace path, relative to the session working directory.'}} : {}, additionalProperties: false},
  annotations: {readOnlyHint: action === 'status', destructiveHint: false, openWorldHint: false},
}));

async function mcp() {
  const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
  const reply = (id: unknown, result: unknown) => console.log(JSON.stringify({jsonrpc: '2.0', id, result}));
  const handle = async (message: Record<string, unknown>) => {
    if (message.id === undefined) return;
    const params = object(message.params);
    if (message.method === 'initialize') return reply(message.id, {protocolVersion: '2024-11-05',
      capabilities: {tools: {}}, serverInfo: {name: 'agentprof', version: '0.2.0'}});
    if (message.method === 'tools/list') return reply(message.id, {tools});
    if (message.method === 'ping') return reply(message.id, {});
    if (message.method !== 'tools/call') return console.log(JSON.stringify({jsonrpc: '2.0', id: message.id,
      error: {code: -32601, message: 'Method not found'}}));
    try {
      const name = string(params.name);
      if (!tools.some(tool => tool.name === name)) throw new Error('Unknown tracing tool.');
      const metadata = object(params._meta);
      const id = string(metadata.threadId) || string(object(metadata['x-codex-turn-metadata']).thread_id);
      if (!id) throw new Error('Codex did not supply the current session identity. Requires Codex CLI 0.160.0 or compatible.');
      const result = await requestWithReceiver(`/${name.slice('tracing_'.length)}`,
        {...object(params.arguments), session_id: id});
      reply(message.id, {content: [{type: 'text', text: JSON.stringify(result)}], isError: result.state === 'error'});
    } catch (error) {reply(message.id, {isError: true, content: [{type: 'text', text: `${String(error)}\nEnable the Agent Profiler profile with codex -p agentprof and review /hooks.`}]});}
  };
  for await (const line of lines) {
    if (line.length > 1024 * 1024) continue;
    try {void handle(object(JSON.parse(line)));} catch {}
  }
}

try {
  if (process.platform === 'win32' && ['install', 'serve', 'hook', 'mcp', 'start', 'stop', 'status'].includes(command ?? ''))
    throw new Error('The Codex plugin recorder requires a private Unix socket; Windows is not supported yet.');
  if (command === 'serve') {
    mkdirSync(state, {recursive: true, mode: 0o700});
    const generation = randomBytes(16).toString('hex'), socket = privateSocketPath(generation);
    try {await serve(state, {socket, token: randomBytes(32).toString('hex'), generation, run: true});}
    catch (error) {rmSync(dirname(socket), {recursive: true, force: true}); throw error;}
  } else if (command === 'mcp') await mcp();
  else if (command === 'hook') {
    const timestamp = now(), hook = object(JSON.parse(readFileSync(0, 'utf8')));
    try {
      console.log(JSON.stringify(await requestWithReceiver('/hook', {hook, pid: process.ppid, timestamp,
        process_start_marker: processStartMarker(process.ppid), auto_start: args.includes('--auto-start')})));
    } catch (error) {
      const message = `Agent Profiler: ${String(error)}. Enable the profile with codex -p agentprof and review /hooks.`;
      const control = hook.hook_event_name === 'UserPromptSubmit' && /^tracing (start|stop|status)(?:\s|$)/.test(string(hook.prompt).trim());
      console.log(JSON.stringify(control ? {decision: 'block', reason: message} : {systemMessage: message}));
    }
  } else if (command === 'install') {
    mkdirSync(state, {recursive: true, mode: 0o700});
    const release = await acquireDirectoryLease(join(state, 'install.lock'), 10000);
    let legacyRelease: (() => void) | undefined;
    try {
      legacyRelease = await acquireDirectoryLease(join(state, 'receiver-lifecycle.lock'), 30000);
      if (args.some(arg => !['--migrate', '--auto-start'].includes(arg)))
        throw new Error('Usage: agentprof-codex install [--migrate] [--auto-start]');
      const profile = join(dirname(state), 'agentprof.config.toml');
      const marker = join(state, 'profile.sha256'), pending = join(state, 'profile-pending.sha256');
      if (existsSync(profile)) {
        const hash = createHash('sha256').update(readFileSync(profile)).digest('hex');
        if (existsSync(pending) && readFileSync(pending, 'utf8') === hash &&
            !readFileSync(profile, 'utf8').includes('[otel]')) renameSync(pending, marker);
        if (!existsSync(marker) || hash !== readFileSync(marker, 'utf8'))
          throw new Error('The Agent Profiler profile was edited. Nothing was changed; resolve it manually before installing.');
      }
      const previous = existsSync(join(state, 'connection.json')) ? readConnection(state) : undefined;
      if (previous?.run && ownerConnection()) try {await request('/health', {}, previous);}
      catch (error) {
        if (String(error).includes('does not match this installed runtime'))
          throw new Error('A receiver from an earlier plugin build is still active. Close its Codex sessions before reinstalling.');
        throw error;
      }
      const legacyPort = previous && !previous.run ? previous.port : undefined;
      if (existsSync(profile) && readFileSync(profile, 'utf8').includes('[otel]') && !args.includes('--migrate'))
        throw new Error('An old fixed-endpoint profile exists. Close old Codex sessions, stop its receiver, then rerun install --migrate.');
      if (legacyPort && await portBound(legacyPort))
        throw new Error('The old receiver still owns its port. Close old Codex sessions and stop it before migrating.');
      const root = resolve(dirname(script), '../../..');
      const market = spawnSync('codex', ['plugin', 'marketplace', 'add', root], {stdio: 'inherit'});
      if (market.status !== 0) throw new Error(`Codex marketplace installation failed: ${market.error ?? market.status}`);
      const installed = spawnSync('codex', ['plugin', 'add', 'agentprof@agentprof', '--json'], {encoding: 'utf8'});
      if (installed.status !== 0) throw new Error(`Codex plugin installation failed: ${installed.stderr || installed.error || installed.status}`);
      const runtime = join(string(object(JSON.parse(installed.stdout)).installedPath), 'runtime/codex-tracing.mjs');
      if (legacyPort && await portBound(legacyPort)) throw new Error('The old receiver restarted during installation; close old sessions and retry.');
      const hooks = writeInstalledProfile(state, dirname(state), runtime, args.includes('--auto-start'));
      if (legacyPort && await portBound(legacyPort)) throw new Error('Old receiver restarted during migration; its connection was retained.');
      if (previous && !previous.run) unlinkSync(join(state, 'connection.json'));
      console.log(`Plugin installed: ${hooks}. Start Codex normally with: codex -p agentprof`);
    } finally {legacyRelease?.(); release();}
  } else if (command === 'recover' && args[0]) console.log(JSON.stringify(publish(resolve(args[0]), args[1])));
  else if (['start', 'stop', 'status'].includes(command ?? '')) {
    const id = option('--session');
    if (!id) throw new Error('Provide --session SESSION_ID, or use the recording tools inside Codex.');
    console.log(JSON.stringify(await requestWithReceiver(`/${command}`, {session_id: id, output_path: args[0]})));
  } else {
    console.log('Usage: agentprof-codex install [--migrate] [--auto-start] | start [OUTPUT.pftrace] --session ID | stop --session ID | status --session ID | recover CAPTURE_DIRECTORY [OUTPUT.pftrace]');
    if (command && command !== '--help') process.exitCode = 2;
  }
} catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
