// SPDX-License-Identifier: Apache-2.0
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve, basename} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';

export interface Connection {port: number; token: string}
export function stateDirectory(pluginData?: string): string {
  if (pluginData) {
    // The host supplies PLUGIN_DATA even when it filters CODEX_HOME out of the
    // MCP environment. Keep the receiver shared by sessions in that Codex home.
    let directory = resolve(pluginData);
    while (dirname(directory) !== directory) {
      if (basename(directory) === 'plugins') return join(dirname(directory), 'agentprof');
      directory = dirname(directory);
    }
    throw new Error('Cannot locate Codex home from PLUGIN_DATA.');
  }
  return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'agentprof');
}

export function readConnection(state: string): Connection {
  const value = JSON.parse(readFileSync(join(state, 'connection.json'), 'utf8'));
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535 ||
      !/^[0-9a-f]{64}$/.test(value.token)) throw new Error('Invalid Agent Profiler connection configuration.');
  return value;
}

export const hookEvents = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];

export async function configure(state: string, codexHome: string, runtime = 'codex-tracing.mjs', autoStart = false) {
  mkdirSync(state, {recursive: true, mode: 0o700});
  if (!existsSync(join(state, 'connection.json'))) {
    const listener = createServer();
    await new Promise<void>((done, reject) => {listener.once('error', reject); listener.listen(0, '127.0.0.1', done);});
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Cannot allocate local telemetry port.');
    const port = address.port;
    await new Promise<void>(done => listener.close(() => done()));
    try {writeFileSync(join(state, 'connection.json'), JSON.stringify({port, token: randomBytes(32).toString('hex')}), {flag: 'wx', mode: 0o600});}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
  }
  const connection = readConnection(state);
  const exporter = (path: string) => `{ otlp-http = { endpoint = "http://127.0.0.1:${connection.port}/v1/${path}", protocol = "json", headers = { Authorization = "Bearer ${connection.token}" } } }`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const hookCommand = `${quote(process.execPath)} ${quote(runtime)} hook --state ${quote(state)}`;
  const windowsCommand = `"${process.execPath}" "${runtime}" hook --state "${state}"`;
  const profile = '# Agent Profiler Codex profile\n' +
    '# Native timing is exported only to the local recording plugin.\n' +
    '[features]\nhooks = true\n\n' +
    '[plugins."agentprof@agentprof"]\nenabled = true\n\n' +
    '[otel]\n' + `exporter = ${exporter('logs')}\ntrace_exporter = ${exporter('traces')}\n` +
    'log_user_prompt = false\n\n' + hookEvents.map(event =>
      `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\n` +
      `command = ${JSON.stringify(hookCommand + (autoStart && event === 'SessionStart' ? ' --auto-start' : ''))}\n` +
      `commandWindows = ${JSON.stringify(windowsCommand + (autoStart && event === 'SessionStart' ? ' --auto-start' : ''))}\n` +
      `timeout = ${['SessionEnd', 'Interrupt'].includes(event) ? 3 : 15}\n`).join('\n');
  const path = join(codexHome, 'agentprof.config.toml');
  const marker = join(state, 'profile.sha256');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  if (existsSync(path) && readFileSync(path, 'utf8') !== profile) {
    const owned = existsSync(marker) && readFileSync(marker, 'utf8') === hash(readFileSync(path, 'utf8'));
    if (!owned) throw new Error(`Profile already exists with different settings: ${path}`);
  }
  writeFileSync(path, profile, {mode: 0o600});
  writeFileSync(marker, hash(profile), {mode: 0o600});
  return path;
}
