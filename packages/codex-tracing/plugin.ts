// SPDX-License-Identifier: Apache-2.0
import {spawn, spawnSync} from 'node:child_process';
import {readFileSync, openSync, closeSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {configure, readConnection, stateDirectory} from './plugin-config.ts';
import {serve} from './plugin-collector.ts';
import {publish, now} from './plugin-journal.ts';
import {object, string} from './otel.ts';
import {captureContentsEnabled} from '../agent-tracing/content.ts';

const script = fileURLToPath(import.meta.url);
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

async function request(path: string, data: unknown = {}): Promise<Record<string, unknown>> {
  const connection = readConnection(state);
  const response = await fetch(`http://127.0.0.1:${connection.port}${path}`, {method: 'POST',
    headers: {'content-type': 'application/json', authorization: `Bearer ${connection.token}`},
    body: JSON.stringify({...object(data), capture_contents: captureContents}), signal: AbortSignal.timeout(12000)});
  const result = object(await response.json());
  if (!response.ok) throw new Error(string(result.error) || `Recorder returned ${response.status}`);
  return result;
}

async function ensureReceiver() {
  readConnection(state);
  try {await request('/health'); return;} catch {}
  const log = openSync(join(state, 'receiver.log'), 'a', 0o600);
  const child = spawn(process.execPath, [script, 'serve', '--state', state], {detached: true, windowsHide: true, stdio: ['ignore', log, log]});
  closeSync(log);
  await new Promise<void>((done, reject) => {child.once('spawn', done); child.once('error', reject);});
  child.unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    try {await request('/health'); return;} catch {}
    await delay(50);
  }
  throw new Error('Local recorder did not start. Check agentprof/receiver.log in your Codex home.');
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
      await ensureReceiver();
      const result = await request(`/${name.slice('tracing_'.length)}`, {...object(params.arguments), session_id: id});
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
      await ensureReceiver();
      console.log(JSON.stringify(await request('/hook', {hook, pid: process.ppid, timestamp, auto_start: args.includes('--auto-start')})));
    } catch (error) {
      // Observability must never deny a user's tool call or keep a turn alive.
      const message = `Agent Profiler: ${String(error)}. Run agentprof-codex install and restart with codex --no-daemon -p agentprof.`;
      const control = hook.hook_event_name === 'UserPromptSubmit' && /^tracing (start|stop|status)(?:\s|$)/.test(string(hook.prompt).trim());
      console.log(JSON.stringify(control ? {decision: 'block', reason: message} : {systemMessage: message}));
    }
  } else if (command === 'install') {
    const root = resolve(dirname(script), '../../..');
    const market = spawnSync('codex', ['plugin', 'marketplace', 'add', root], {stdio: 'inherit'});
    if (market.status !== 0) throw new Error(`Codex marketplace installation failed: ${market.error ?? market.status}`);
    const install = spawnSync('codex', ['plugin', 'add', 'agentprof@agentprof', '--json'], {encoding: 'utf8'});
    if (install.status !== 0) throw new Error(`Codex plugin installation failed: ${install.stderr || install.error || install.status}`);
    const installed = object(JSON.parse(install.stdout));
    const runtime = join(string(installed.installedPath), 'runtime/codex-tracing.mjs');
    const profile = await configure(state, dirname(state), runtime, args.includes('--auto-start'));
    console.log(`Created ${profile}\nStart Codex with: codex --no-daemon -p agentprof\nReview and trust the recording hooks in /hooks, then type: tracing start\nType tracing stop to save, or exit Codex to finish the recording.`);
  } else if (command === 'recover' && args[0]) console.log(JSON.stringify(publish(resolve(args[0]), args[1])));
  else if (['start', 'stop', 'status'].includes(command ?? '')) {
    const id = option('--session');
    if (!id) throw new Error('Provide --session SESSION_ID, or use the recording tools inside Codex.');
    await ensureReceiver();
    console.log(JSON.stringify(await request(`/${command}`, {session_id: id, output_path: args[0]})));
  } else {
    console.log('Usage: agentprof-codex install | start [OUTPUT.pftrace] --session ID | stop --session ID | status --session ID | recover CAPTURE_DIRECTORY [OUTPUT.pftrace]');
    if (command && command !== '--help') process.exitCode = 2;
  }
} catch (error) {console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;}
