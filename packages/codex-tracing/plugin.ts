// SPDX-License-Identifier: Apache-2.0
import {spawn, spawnSync} from 'node:child_process';
import {readFileSync, existsSync, openSync, closeSync} from 'node:fs';
import {connect} from 'node:net';
import {createInterface} from 'node:readline';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {configure, readConnection, stateDirectory} from './plugin-config.ts';
import {serve} from './plugin-collector.ts';
import {publish, now} from './plugin-journal.ts';
import {object, string} from './otel.ts';
import {captureContentsEnabled} from '../agent-tracing/content.ts';
import {processStartMarker} from '../agent-tracing/process-identity.ts';
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
class VersionError extends Error {}
async function request(path: string, data: unknown = {}): Promise<Record<string, unknown>> {
  const connection = readConnection(state);
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: `Bearer ${connection.token}`},
      body: JSON.stringify({...object(data), capture_contents: captureContents}),
      signal: AbortSignal.timeout(path === '/stop' ? 30000 : 12000)});
  } catch (error) {throw new TransportError(`Local recorder connection failed: ${String(error)}`);}
  if (connection.generation && response.headers.get('x-agentprof-generation') !== connection.generation)
    throw new Error(`Unexpected receiver on port ${connection.port}. Reinstall Agent Profiler and restart Codex; native OTLP endpoints cannot change mid-run.`);
  const endingHook = path === '/hook' && object(object(data).hook).hook_event_name === 'SessionEnd';
  // Compatible old receivers must remain stoppable/inspectable while an
  // active recording prevents their replacement. Do not send new work there.
  if (!['/health', '/shutdown', '/stop', '/status'].includes(path) && !endingHook &&
      response.headers.get('x-agentprof-build') !== buildId)
    throw new VersionError('Receiver build differs from this plugin. Finish active recordings before upgrading the receiver.');
  const result = object(await response.json());
  if (!response.ok) throw new Error(response.status === 403 ?
    `Receiver authentication failed on port ${connection.port}; reinstall Agent Profiler and restart Codex if another process owns this port.` :
    string(result.error) || `Recorder returned ${response.status}`);
  return result;
}

// The pre-build receiver has no build header, but its authenticated /status
// and 403 Forbidden response can distinguish it from a service reusing its
// port. An inconclusive probe must not discard a potentially active capture.
async function legacyReceiver(port: number): Promise<'legacy' | 'other' | 'unknown'> {
  try {
    const challenge = await fetch(`http://127.0.0.1:${port}/health`, {method: 'POST',
      headers: {'content-type': 'application/json', authorization: 'Bearer invalid-agentprof-probe'},
      body: '{}', signal: AbortSignal.timeout(1500)});
    if (challenge.status !== 403 || object(await challenge.json()).error !== 'Forbidden') return 'other';
    const id = randomUUID(), status = await request('/status', {session_id: id});
    return status.state === 'idle' && status.session_id === id ? 'legacy' : 'unknown';
  } catch {return 'unknown';}
}

const portOccupied = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect({host: '127.0.0.1', port});
  let done = false;
  const finish = (occupied: boolean) => {if (done) return; done = true; socket.destroy(); resolve(occupied);};
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(200, () => finish(false));
});

async function ensureReceiver() {
  const health = async (expected = readConnection(state)) => {
    try {const status = await request('/health');
      return status.ready === true && (!expected.generation || status.generation === expected.generation) ? status : null;
    } catch {return null;}
  };
  if ((await health())?.build === buildId) return;
  const release = await acquireDirectoryLease(join(state, 'receiver-lifecycle.lock'), 3000);
  try {
    const connection = readConnection(state); // Re-read after a concurrent rebind.
    const current = await health(connection);
    if (current?.build === buildId) return;
    if (current) {
      if (Number(current.active_captures) > 0) throw new Error('Receiver upgrade is waiting for active recordings to finish. Retry installation afterward.');
      try {await request('/shutdown');}
      catch {throw new Error('Old receiver cannot shut down safely. Stop it after saving recordings, then retry installation.');}
      for (let attempt = 0; attempt < 30 && await portOccupied(connection.port); attempt++) await delay(50);
    }
    if (await portOccupied(connection.port)) throw new Error(`Receiver port ${connection.port} is occupied by another process. Run agentprof-codex install and restart Codex; the current OTLP profile cannot change ports mid-run.`);
    const log = openSync(join(state, 'receiver.log'), 'a', 0o600);
    let child;
    try {child = spawn(process.execPath, [script, 'serve', '--state', state], {detached: true, windowsHide: true, stdio: ['ignore', log, log]});}
    finally {closeSync(log);}
    await new Promise<void>((done, reject) => {child.once('spawn', done); child.once('error', reject);});
    child.unref();
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await health(connection))?.build === buildId) return;
      await delay(50);
    }
    if (await portOccupied(connection.port)) throw new Error(`Receiver port ${connection.port} is occupied but did not authenticate. Reinstall Agent Profiler and restart Codex.`);
    throw new Error('Local recorder did not start. Check agentprof/receiver.log in your Codex home.');
  } finally {release();}
}

async function requestWithReceiver(path: string, data: unknown) {
  try {return await request(path, data);} catch (error) {
    if (!(error instanceof TransportError || error instanceof VersionError)) throw error;
    await ensureReceiver();
    return request(path, data);
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
  // Do not require the receiver at initialization: installed tools should be
  // discoverable and explain setup even when the profile has not been created.
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
      const result = await requestWithReceiver(`/${name.slice('tracing_'.length)}`, {...object(params.arguments), session_id: id});
      reply(message.id, {content: [{type: 'text', text: JSON.stringify(result)}], isError: result.state === 'error'});
    } catch (error) {reply(message.id, {isError: true, content: [{type: 'text', text: `${String(error)}\nRun agentprof-codex install once, then codex --no-daemon -p agentprof and review /hooks.`}]});}
  };
  for await (const line of lines) {
    if (line.length > 1024 * 1024) continue;
    try {void handle(object(JSON.parse(line)));} catch {}
  }
}

try {
  if (command === 'serve') await serve(state);
  else if (command === 'mcp') await mcp();
  else if (command === 'hook') {
    const timestamp = now(), hook = object(JSON.parse(readFileSync(0, 'utf8')));
    try {
      console.log(JSON.stringify(await requestWithReceiver('/hook', {hook, pid: process.ppid, timestamp,
        process_start_marker: processStartMarker(process.ppid), auto_start: args.includes('--auto-start')})));
    } catch (error) {
      // Observability must never deny a user's tool call or keep a turn alive.
      const message = `Agent Profiler: ${String(error)}. Run agentprof-codex install and restart with codex --no-daemon -p agentprof.`;
      const control = hook.hook_event_name === 'UserPromptSubmit' && /^tracing (start|stop|status)(?:\s|$)/.test(string(hook.prompt).trim());
      console.log(JSON.stringify(control ? {decision: 'block', reason: message} : {systemMessage: message}));
    }
  } else if (command === 'install') {
    // Check the receiver before changing an owned profile. Receivers shipped
    // before build fencing have no authenticated shutdown protocol; replacing
    // their hook command first would strand an otherwise working installation.
    const hasConnection = existsSync(join(state, 'connection.json'));
    let mustRebind = false;
    if (hasConnection) {
      let current: Record<string, unknown> | undefined;
      try {current = await request('/health');}
      catch (error) {
        // A legacy connection has no generation header. An unrelated process
        // may reuse its port and return any status or even non-JSON: only a
        // still-occupied port needs rebinding, not a dead receiver.
        if (!(error instanceof TransportError)) mustRebind = await portOccupied(readConnection(state).port);
      }
      if (current?.ready === true && current.build === undefined) {
        const owner = await legacyReceiver(readConnection(state).port);
        if (owner === 'legacy')
          throw new Error('An older Agent Profiler receiver is still running and cannot be upgraded safely. Finish or exit existing Codex sessions, wait for its receiver to exit, then retry install. The tracing profile was not changed.');
        if (owner === 'unknown')
          throw new Error('Cannot verify the receiver on the configured port. Stop it and retry install; the tracing profile was not changed.');
        mustRebind = true;
      }
      if (!mustRebind) try {await ensureReceiver();}
      catch (error) {
        if (!String(error).includes('Receiver port')) throw error;
        mustRebind = true;
      }
    }
    const root = resolve(dirname(script), '../../..');
    const market = spawnSync('codex', ['plugin', 'marketplace', 'add', root], {stdio: 'inherit'});
    if (market.status !== 0) throw new Error(`Codex marketplace installation failed: ${market.error ?? market.status}`);
    const install = spawnSync('codex', ['plugin', 'add', 'agentprof@agentprof', '--json'], {encoding: 'utf8'});
    if (install.status !== 0) throw new Error(`Codex plugin installation failed: ${install.stderr || install.error || install.status}`);
    const installed = object(JSON.parse(install.stdout));
    const runtime = join(string(installed.installedPath), 'runtime/codex-tracing.mjs');
    let profile = await configure(state, dirname(state), runtime, args.includes('--auto-start'), mustRebind);
    // Bind before the user starts Codex: its OTLP endpoints are fixed for the
    // lifetime of that process. Retry a collision only while installing.
    for (let attempt = 0; attempt < 3; attempt++) try {await ensureReceiver(); break;}
    catch (error) {
      if (!String(error).includes('Receiver port') || attempt === 2) throw error;
      profile = await configure(state, dirname(state), runtime, args.includes('--auto-start'), true);
    }
    console.log(`Created ${profile}\nReceiver is listening. Start or restart Codex with: codex --no-daemon -p agentprof\nReview and trust the recording hooks in /hooks, then type: tracing start\nType tracing stop to save, or exit Codex to finish the recording.`);
  } else if (command === 'recover' && args[0]) console.log(JSON.stringify(publish(resolve(args[0]), args[1])));
  else if (command === 'receiver-stop') {
    try {console.log(JSON.stringify(await request('/shutdown')));}
    catch (error) {
      if (!(error instanceof TransportError)) throw error;
      console.log(JSON.stringify({state: 'idle', message: 'Receiver is not running.'}));
    }
  } else if (['start', 'stop', 'status'].includes(command ?? '')) {
    const id = option('--session');
    if (!id) throw new Error('Provide --session SESSION_ID, or use the recording tools inside Codex.');
    console.log(JSON.stringify(await requestWithReceiver(`/${command}`, {session_id: id, output_path: args[0]})));
  } else {
    console.log('Usage: agentprof-codex install | start [OUTPUT.pftrace] --session ID | stop --session ID | status --session ID | receiver-stop | recover CAPTURE_DIRECTORY [OUTPUT.pftrace]');
    if (command && command !== '--help') process.exitCode = 2;
  }
} catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
