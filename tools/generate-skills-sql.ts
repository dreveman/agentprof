// SPDX-License-Identifier: Apache-2.0
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {SETUP_SQL} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/queries';
import {OVERVIEW_SETUP_SQL} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/overview_queries';
import {TURN_CLEANUP_SQL, TURNS_SETUP_SQL} from '../third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/turns_queries';

const root = resolve(import.meta.dir, '..');
const scripts = resolve(root, 'ai/skills/dev.agentprof/workflows/agentprof/scripts');
const header = '-- SPDX-License-Identifier: Apache-2.0\n' +
  '-- Exported from AgentProf reader SQL. Standalone: no UI or build dependency.\n';

function replaceOnce(sql: string, from: string, to: string): string {
  if (sql.indexOf(from) < 0 || sql.indexOf(from) !== sql.lastIndexOf(from)) {
    throw new Error(`Reader SQL changed: expected one ${from}`);
  }
  return sql.replace(from, to);
}

const argumentsStart = 'CREATE PERFETTO TABLE agentprof_tool_arguments AS';
const argumentsEnd = '-- Older recordings kept arguments on preflight rather than execution spans.';
if (!SETUP_SQL.includes(argumentsStart) || !SETUP_SQL.includes(argumentsEnd)) {
  throw new Error('Reader SQL changed: tool argument table boundaries missing');
}
// Analysis does not need to materialize every captured tool payload.
const reader = SETUP_SQL.slice(0, SETUP_SQL.indexOf(argumentsStart)) +
  `CREATE PERFETTO TABLE agentprof_tool_arguments AS
SELECT CAST(NULL AS INTEGER) AS arg_set_id, CAST(NULL AS STRING) AS arguments WHERE 0;

` + SETUP_SQL.slice(SETUP_SQL.indexOf(argumentsEnd)) + OVERVIEW_SETUP_SQL;
const withoutIntent = replaceOnce(reader,
  "COALESCE(NULLIF(TRIM(EXTRACT_ARG(s.arg_set_id, 'debug.intent')), ''),\n    NULLIF(TRIM(EXTRACT_ARG(p.arg_set_id, 'debug.intent')), '')) AS intent,",
  'NULL AS intent,');
const setup = replaceOnce(withoutIntent,
  "EXTRACT_ARG(p.arg_set_id, p.prefix || '.label') AS label,", 'NULL AS label,');
const turns = replaceOnce(TURNS_SETUP_SQL,
  "SUBSTR(EXTRACT_ARG(s.arg_set_id, 'debug.text'), 1, 2048) AS prompt_text,",
  'NULL AS prompt_text,');

// Namespace only declared SQL objects, never debug annotations or column names.
const declarations = /\b(?:TABLE|INDEX)(?: IF EXISTS)? (agentprof_\w+)/g;
const objects = [...new Set([...`${setup}\n${turns}`.matchAll(declarations)].map(m => m[1]))];
function namespace(sql: string): string {
  for (const name of objects) {
    sql = sql.replace(new RegExp(`\\b${name}\\b`, 'g'), name.replace('agentprof_', 'agentprof_skill_'));
  }
  return sql.trim() + '\n';
}
const cleanup = [...new Set([...setup.matchAll(/\bTABLE (agentprof_\w+)/g)].map(m => m[1]))]
  .map(name => `DROP TABLE IF EXISTS ${name};`).join('\n');
const outputs = {
  'agentprof_setup.sql': header + namespace(TURN_CLEANUP_SQL + '\n' + cleanup + '\n' + setup) + `
DROP TABLE IF EXISTS agentprof_skill_scope;
CREATE TABLE agentprof_skill_scope(capture_id INTEGER PRIMARY KEY);
DROP VIEW IF EXISTS agentprof_skill_selected_captures;
CREATE VIEW agentprof_skill_selected_captures AS
SELECT * FROM agentprof_skill_capture_runs
WHERE NOT EXISTS (SELECT 1 FROM agentprof_skill_scope)
  OR capture_id IN (SELECT capture_id FROM agentprof_skill_scope);
`,
  'agentprof_turns.sql': header + namespace(turns),
};

await mkdir(scripts, {recursive: true});
for (const [name, sql] of Object.entries(outputs)) {
  const path = resolve(scripts, name);
  if (process.argv.includes('--check')) {
    if (await readFile(path, 'utf8') !== sql) throw new Error(`Stale ${name}; run npm run build:skills-sql`);
  } else {
    await writeFile(path, sql);
  }
}
console.log(`PASS ${Object.keys(outputs).length} standalone AgentProf SQL exports`);
