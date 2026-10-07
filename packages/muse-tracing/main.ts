// SPDX-License-Identifier: Apache-2.0
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {dirname, resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {hook, control, dataDirectory, atomicJson, readJson, catalog, ensureWatcher, watch} from './record.ts';
import {object, string} from './native.ts';
import {controlPrompt} from './convert.ts';

const tools = ['start', 'stop', 'status'].map(action => ({
  name: `tracing_${action}`,
  description: action === 'start' ? 'Start recording this Muse Code session and its recorded subagents. Returns the local Perfetto trace output path.' :
    action === 'stop' ? 'Stop recording and save this session’s Perfetto trace. Returns the saved file path.' : 'Get this session’s recording state and output path.',
  inputSchema: {type: 'object', properties: action === 'start' ? {output_path: {type: 'string', description: 'New .pftrace path, relative to the session working directory.'}} : {}, additionalProperties: false},
  annotations: {readOnlyHint: action === 'status', destructiveHint: false, openWorldHint: false},
}));
const script = fileURLToPath(import.meta.url);
async function mcp(data: string) {
  const session = process.env.MUSE_SESSION_ID ?? '';
  const lines = createInterface({input: process.stdin, crlfDelay: Infinity});
  const reply = (id: unknown, result: unknown) => console.log(JSON.stringify({jsonrpc: '2.0', id, result}));
  for await (const line of lines) {
    if (line.length > 1024 * 1024) continue;
    let m; try {m = JSON.parse(line);} catch {continue;}
    if (m.id === undefined) continue;
    if (m.method === 'initialize') {reply(m.id, {protocolVersion: '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'agentprof', version: '0.2.0'}}); continue;}
    if (m.method === 'tools/list') {reply(m.id, {tools}); continue;}
    if (m.method === 'ping') {reply(m.id, {}); continue;}
    if (m.method !== 'tools/call') {console.log(JSON.stringify({jsonrpc: '2.0', id: m.id, error: {code: -32601, message: 'Method not found'}})); continue;}
    try {
      const params = object(m.params), name = string(params.name), args = object(params.arguments);
      if (!tools.some(t => t.name === name)) throw new Error('Unknown tracing tool');
      if (Object.keys(args).some(k => name !== 'tracing_start' || k !== 'output_path') || (args.output_path !== undefined && typeof args.output_path !== 'string')) throw new Error('Invalid tracing arguments');
      const result = await control(data, session, name.slice(8), args.output_path);
      if (result.state === 'recording') await ensureWatcher(data, session, script);
      reply(m.id, {content: [{type: 'text', text: JSON.stringify(result)}]});
    } catch (e) {reply(m.id, {isError: true, content: [{type: 'text', text: String(e)}]});}
  }
}
const args = process.argv.slice(2), action = args.shift(), data = dataDirectory();
try {
  if (action === 'hook') {
    const payload = object(JSON.parse(readFileSync(0, 'utf8')));
    try {
      const result = await hook(data, payload, process.ppid,
        () => ensureWatcher(data, string(payload.session_id), script));
      console.log(JSON.stringify(result));
    }
    catch (error) {
      const message = `Agent Profiler: ${String(error)}`;
      console.log(JSON.stringify(payload.hook_event_name === 'UserPromptSubmit' && controlPrompt(string(payload.prompt)) ?
        {decision: 'block', reason: message, systemMessage: message} : {systemMessage: message}));
    }
  } else if (action === 'mcp') await mcp(data);
  else if (action === 'watch') await watch(data, args[args.indexOf('--session') + 1] ?? '');
  else if (action === 'install') {
    const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const install = spawnSync('muse', ['plugins', 'install', plugin, '--scope', args.includes('--project') ? 'project' : 'user'], {stdio: 'inherit', env: {...process.env, MUSE_NO_AUTO_UPDATE: '1'}});
    if (install.status !== 0) throw new Error(`Muse plugin installation failed: ${install.error ?? install.status}`);
    await mkdir(data, {recursive: true, mode: 0o700});
    try {await atomicJson(join(data, 'catalog.json'), {at: Date.now(), models: await catalog('muse', data)});} catch {}
    console.log('Installed Agent Profiler. Review and enable its hooks and tools with:\n  muse plugins approve agentprof\nThen start Muse normally and type: tracing start\nType tracing stop to save, or exit Muse to finish recording.');
  } else if (action === 'configure') {
    if (args.length !== 1 || !['--auto-start', '--manual', '--no-content', '--capture-content'].includes(args[0]!))
      throw new Error('Use configure --auto-start|--manual|--no-content|--capture-content');
    await mkdir(data, {recursive: true, mode: 0o700});
    const previous = await readJson(join(data, 'config.json')) ?? {};
    const next = args[0] === '--auto-start' ? {auto_start: true} : args[0] === '--manual' ? {auto_start: false} :
      {capture_contents: args[0] === '--capture-content'};
    await atomicJson(join(data, 'config.json'), {...previous, ...next});
    console.log(`Muse tracing: ${args[0]}`);
  } else if (['start', 'stop', 'status', 'recover'].includes(action ?? '')) {
    const index = args.indexOf('--session'), id = index >= 0 ? args.splice(index, 2)[1] : process.env.MUSE_SESSION_ID;
    if (!id) throw new Error('Provide --session SESSION_ID, or use the recording controls inside Muse.');
    const result = await control(data, id, action!, args[0]);
    if (result.state === 'recording') await ensureWatcher(data, id, script);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Usage: agentprof-muse install [--project] | configure --auto-start|--manual|--no-content|--capture-content | start [OUTPUT.pftrace] --session ID | stop|status|recover --session ID');
    if (action && action !== '--help') process.exitCode = 2;
  }
} catch (e) {console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1;}
