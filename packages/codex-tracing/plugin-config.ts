// SPDX-License-Identifier: Apache-2.0
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve, basename} from 'node:path';
import {homedir} from 'node:os';
import {createHash, randomBytes} from 'node:crypto';

export interface Connection {port?: number; socket?: string; token: string; generation?: string; run?: true}

// Linux/macOS sockaddr_un paths have a small fixed limit independent of
// CODEX_HOME length. The random directory is private to this user and run.
export function privateSocketPath(generation: string) {
  if (!/^[0-9a-f]{32}$/.test(generation)) throw new Error('Invalid receiver generation.');
  const directory = mkdtempSync('/tmp/agentprof-codex-');
  chmodSync(directory, 0o700);
  return join(directory, `receiver-${generation}.sock`);
}
export function privateSocketDirectory(socket: string, generation: string): string | undefined {
  const directory = dirname(socket);
  if (dirname(directory) !== '/tmp' || !/^agentprof-codex-[A-Za-z0-9]{6}$/.test(basename(directory)) ||
      socket !== join(directory, `receiver-${generation}.sock`)) return;
  if (existsSync(directory)) {
    const stat = statSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
      throw new Error('Unsafe Codex recorder socket directory.');
  }
  return directory;
}
export function stateDirectory(pluginData?: string): string {
  if (pluginData) {
    // The host supplies PLUGIN_DATA even when it filters CODEX_HOME out of the
    // MCP environment. Find this Codex home's per-run session registry.
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
  const legacyPort = Number.isInteger(value.port) && value.port >= 1024 && value.port <= 65535;
  const privateSocket = value.run === true && typeof value.socket === 'string' &&
    /^[0-9a-f]{32}$/.test(value.generation) && privateSocketDirectory(value.socket, value.generation);
  if ((!legacyPort && !privateSocket) ||
      !/^[0-9a-f]{64}$/.test(value.token) ||
      (value.generation !== undefined && !/^[0-9a-f]{32}$/.test(value.generation)) ||
      (value.run !== undefined && value.run !== true))
    throw new Error('Invalid Agent Profiler connection configuration.');
  return value;
}

export const hookEvents = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];

// Both the installed profile and anonymous run profile share the same hooks.
// Only the latter adds a private OTLP exporter while its socket is owned.
function hookProfile(state: string, runtime: string, autoStart: boolean) {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const hookCommand = `${quote(process.execPath)} ${quote(runtime)} hook --state ${quote(state)}`;
  const windowsCommand = `"${process.execPath}" "${runtime}" hook --state "${state}"`;
  return '# Agent Profiler hooks (no persistent telemetry endpoint)\n' +
    '[features]\nhooks = true\n\n[plugins."agentprof@agentprof"]\nenabled = true\n\n' + hookEvents.map(event =>
      `[[hooks.${event}]]\n[[hooks.${event}.hooks]]\ntype = "command"\n` +
      `command = ${JSON.stringify(hookCommand + (autoStart && event === 'SessionStart' ? ' --auto-start' : ''))}\n` +
      `commandWindows = ${JSON.stringify(windowsCommand + (autoStart && event === 'SessionStart' ? ' --auto-start' : ''))}\n` +
      `timeout = ${['SessionEnd', 'Interrupt'].includes(event) ? 3 : 15}\n`).join('\n');
}

export function writeInstalledProfile(state: string, codexHome: string, runtime: string, autoStart = false) {
  mkdirSync(state, {recursive: true, mode: 0o700});
  const path = join(codexHome, 'agentprof.config.toml'), marker = join(state, 'profile.sha256');
  const profile = hookProfile(state, runtime, autoStart);
  if (existsSync(path) && readFileSync(path, 'utf8') !== profile) {
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (!existsSync(marker) || readFileSync(marker, 'utf8') !== hash)
      throw new Error(`Profile already exists with different settings: ${path}`);
  }
  const hash = createHash('sha256').update(profile).digest('hex');
  if (existsSync(path) && readFileSync(path, 'utf8') === profile &&
      existsSync(marker) && readFileSync(marker, 'utf8') === hash) return path;
  const nonce = randomBytes(8).toString('hex');
  const pending = join(state, 'profile-pending.sha256');
  const temporary = join(codexHome, `.agentprof-profile-${nonce}.tmp`);
  const temporaryMarker = join(state, `profile-${nonce}.tmp`);
  try {
    writeFileSync(temporary, profile, {flag: 'wx', mode: 0o600});
    writeFileSync(temporaryMarker, hash, {flag: 'wx', mode: 0o600});
    // If interrupted between the two renames, the pending hash proves the
    // hook-only profile is ours so a later install can recover the marker.
    writeFileSync(pending, hash, {mode: 0o600});
    renameSync(temporary, path);
    renameSync(temporaryMarker, marker);
    unlinkSync(pending);
  } finally {
    for (const file of [temporary, temporaryMarker]) if (existsSync(file)) unlinkSync(file);
  }
  return path;
}
