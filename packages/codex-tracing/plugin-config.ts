// SPDX-License-Identifier: Apache-2.0
import {chmodSync, existsSync, mkdtempSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, resolve, basename} from 'node:path';
import {homedir} from 'node:os';

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
    // Plugin hooks supply PLUGIN_DATA. Legacy MCP processes locate the same
    // Codex home from their plugin root (the MCP config uses cwd=".").
    let directory = resolve(pluginData);
    while (dirname(directory) !== directory) {
      if (basename(directory) === 'plugins') return join(dirname(directory), 'agentprof');
      directory = dirname(directory);
    }
    throw new Error('Cannot locate Codex home from plugin data or root.');
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
