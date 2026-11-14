// SPDX-License-Identifier: Apache-2.0
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

function findRepoRoot(): string {
  for (const candidate of ['.', '..', '../..', '../../..']) {
    const dir = resolve(candidate);
    if (existsSync(resolve(dir, 'stdlib/dev/agentprof/captures.sql'))) {
      return dir;
    }
  }
  return resolve('.');
}

export const STDLIB_DIR = resolve(findRepoRoot(), 'stdlib/dev/agentprof');
export const STDLIB_PACKAGE_ARG = `${STDLIB_DIR}@dev.agentprof`;

export const INCLUDE_CORE_MODULES_SQL = `
INCLUDE PERFETTO MODULE dev.agentprof.captures;
INCLUDE PERFETTO MODULE dev.agentprof.models;
INCLUDE PERFETTO MODULE dev.agentprof.sessions;
INCLUDE PERFETTO MODULE dev.agentprof.tools;
INCLUDE PERFETTO MODULE dev.agentprof.context;
INCLUDE PERFETTO MODULE dev.agentprof.activity;
`;

export const INCLUDE_ALL_MODULES_SQL = `
${INCLUDE_CORE_MODULES_SQL}
INCLUDE PERFETTO MODULE dev.agentprof.turns;
INCLUDE PERFETTO MODULE dev.agentprof.runtime;
`;
