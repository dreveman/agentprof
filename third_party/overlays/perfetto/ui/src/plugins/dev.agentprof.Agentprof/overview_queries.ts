// SPDX-License-Identifier: Apache-2.0
// Thin UI query wrappers around the `dev.agentprof.*` PerfettoSQL modules.

export const TURN_PAGE_SIZE = 200;
export const TURN_EVENT_LIMIT = 500;
export const CONTEXT_SAMPLE_LIMIT = 2000;
export const CONTEXT_CHANGE_LIMIT = 500;
export const CONTEXT_COMPACTION_LIMIT = 500;

function validId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error('Invalid turn query identifier');
  }
}

export function turnsPageSelect(offset = 0): string {
  validId(offset);
  return `SELECT *, COUNT(*) OVER () AS total_turns
    FROM dev_agentprof_turns_with_prompts
    ORDER BY start_ts, prompt_id LIMIT ${TURN_PAGE_SIZE} OFFSET ${offset}`;
}

export function turnsPageQuery(offset = 0): string {
  return `INCLUDE PERFETTO MODULE dev.agentprof.turns;\n${turnsPageSelect(offset)}`;
}

export function turnEventsQuery(promptId: number): string {
  validId(promptId);
  return `INCLUDE PERFETTO MODULE dev.agentprof.turns;
    SELECT * FROM dev_agentprof_turn_waterfall(${promptId}, ${TURN_EVENT_LIMIT})`;
}

export const DETECT_QUERY = `INCLUDE PERFETTO MODULE dev.agentprof.captures;
  SELECT count FROM dev_agentprof_detected`;

export const WORKSPACE_TRACKS_QUERY = `INCLUDE PERFETTO MODULE dev.agentprof.sessions;
  SELECT * FROM dev_agentprof_tracks`;

export const WORKSPACE_COUNTERS_QUERY = `INCLUDE PERFETTO MODULE dev.agentprof.captures;
  SELECT t.id, t.display_name AS name,
    CASE WHEN t.name IN ('llm.tokens.input', 'llm.tokens.output') THEN 'Token usage'
      ELSE t.group_name END AS group_name, t.capture_id
  FROM dev_agentprof_counter_tracks t
  WHERE EXISTS (SELECT 1 FROM counter c WHERE c.track_id = t.id)
  ORDER BY t.id`;

export const TRACE_SLICE_DATASET_SQL = (trackId: number, utid: number | null) =>
  `SELECT id, ts, dur, name FROM dev_agentprof_slices WHERE ${
    utid === null ? `track_id = ${trackId}` : `utid = ${utid}`
  }`;

// Pure SELECT projections over `dev.agentprof.*` views/tables (reusable inside
// subqueries in trace verification scripts once the modules are included).
export const OVERVIEW_SELECTS = {
  turns: turnsPageSelect(),
  turn_unassigned: `SELECT * FROM dev_agentprof_turn_unassigned_totals`,
  context_compactions: `SELECT event_id, capture_id, ts, dur, before_tokens, after_tokens FROM (
    SELECT * FROM dev_agentprof_compactions WHERE dur >= 0 AND NOT incomplete
    ORDER BY ts DESC, event_id DESC LIMIT ${CONTEXT_COMPACTION_LIMIT}
  ) ORDER BY ts, event_id`,
  context_latest: `SELECT * FROM dev_agentprof_context_latest`,
  context_snapshots: `SELECT * FROM (
    SELECT * FROM dev_agentprof_context_observations
    ORDER BY ts DESC, event_id DESC LIMIT ${CONTEXT_SAMPLE_LIMIT}
  ) ORDER BY ts, event_id`,
  context_changes: `SELECT * FROM dev_agentprof_context_change_details
    ORDER BY ABS(delta_tokens) DESC, ts LIMIT ${CONTEXT_CHANGE_LIMIT}`,
  context_history: `SELECT * FROM (
    SELECT * FROM dev_agentprof_context_history
    ORDER BY ts DESC LIMIT ${CONTEXT_SAMPLE_LIMIT}
  ) ORDER BY ts`,
  runs: `SELECT * FROM dev_agentprof_root_sessions`,
  session_activity: `SELECT * FROM dev_agentprof_session_activity_bins`,
  capture_activity: `SELECT * FROM dev_agentprof_capture_activity_bins`,
  summary: `SELECT * FROM dev_agentprof_recording_summary`,
  headline: `SELECT * FROM dev_agentprof_recording_headline`,
  activity: `SELECT * FROM dev_agentprof_activity_summary`,
  concurrency: `SELECT * FROM dev_agentprof_tool_concurrency_bins`,
  models: `SELECT * FROM dev_agentprof_models`,
  responses: `SELECT id, session, provider, model, first_ns / 1e6 AS first_content_ms,
    message_ns / 1e6 AS duration_ms, input_tokens, output_tokens
    FROM dev_agentprof_messages ORDER BY ts LIMIT 200`,
  tools: `SELECT * FROM dev_agentprof_tools_overview`,
  slow: `SELECT id, name AS tool, CASE WHEN dur >= 0 THEN dur / 1e6 END AS duration_ms,
    incomplete, is_error, intent, arguments, args_truncated, kind, language, line_count
    FROM dev_agentprof_tool_call_details WHERE kind = 'tool-execution'
    ORDER BY incomplete DESC, dur DESC LIMIT 100`,
  scripts: `SELECT * FROM dev_agentprof_scripts LIMIT 100`,
  script_calls: `SELECT * FROM dev_agentprof_script_calls
    WHERE script_id IN (SELECT id FROM dev_agentprof_scripts LIMIT 100)
    ORDER BY script_id, ts, id`,
  sessions: `SELECT * FROM dev_agentprof_session_details`,
  health: `SELECT metric, MAX(value) AS value FROM dev_agentprof_capture_health GROUP BY metric_key, metric`,
} as const;

const OVERVIEW_MODULES: Record<keyof typeof OVERVIEW_SELECTS, string> = {
  turns: 'dev.agentprof.turns',
  turn_unassigned: 'dev.agentprof.turns',
  context_compactions: 'dev.agentprof.context',
  context_latest: 'dev.agentprof.context',
  context_snapshots: 'dev.agentprof.context',
  context_changes: 'dev.agentprof.context',
  context_history: 'dev.agentprof.context',
  runs: 'dev.agentprof.sessions',
  session_activity: 'dev.agentprof.activity',
  capture_activity: 'dev.agentprof.activity',
  summary: 'dev.agentprof.activity',
  headline: 'dev.agentprof.activity',
  activity: 'dev.agentprof.activity',
  concurrency: 'dev.agentprof.activity',
  models: 'dev.agentprof.models',
  responses: 'dev.agentprof.models',
  tools: 'dev.agentprof.tools',
  slow: 'dev.agentprof.tools',
  scripts: 'dev.agentprof.tools',
  script_calls: 'dev.agentprof.tools',
  sessions: 'dev.agentprof.sessions',
  health: 'dev.agentprof.captures',
};

export const OVERVIEW_QUERIES = Object.fromEntries(
  Object.entries(OVERVIEW_SELECTS).map(([key, select]) => [
    key,
    `INCLUDE PERFETTO MODULE ${OVERVIEW_MODULES[key as keyof typeof OVERVIEW_SELECTS]};\n${select}`,
  ]),
) as Record<keyof typeof OVERVIEW_SELECTS, string>;

export const COMMAND_QUERIES = {
  'Operation summary': `INCLUDE PERFETTO MODULE dev.agentprof.captures;
SELECT session, kind, COUNT(*) AS events, SUM(incomplete) AS incomplete,
  ROUND(SUM(CASE WHEN NOT incomplete THEN dur END) / 1e6, 3) AS completed_work_ms,
  ROUND(MAX(CASE WHEN NOT incomplete THEN dur END) / 1e6, 3) AS longest_completed_ms
FROM dev_agentprof_slices
WHERE kind IN ('turn', 'provider-request', 'tool-execution')
GROUP BY capture_id, session, kind ORDER BY session, kind`,
  'Slow tools': `INCLUDE PERFETTO MODULE dev.agentprof.tools;
SELECT id, ts, session, name AS tool, ROUND(dur / 1e6, 3) AS duration_ms,
  incomplete, is_error, call_id AS tool_call_id
FROM dev_agentprof_tool_calls
WHERE kind = 'tool-execution' ORDER BY dur DESC`,
  'Responses': `INCLUDE PERFETTO MODULE dev.agentprof.models;
SELECT id, ts, session, provider, model,
  first_ns / 1e6 AS first_content_ms,
  message_ns / 1e6 AS message_duration_ms,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, stop_reason
FROM dev_agentprof_messages ORDER BY ts`,
  'Child launches': `INCLUDE PERFETTO MODULE dev.agentprof.sessions;
SELECT id, ts, session, name, launch_duration_ms, incomplete,
  child_session, child_role, parent_session, correlation
FROM dev_agentprof_child_launches`,
  'Capture health': `INCLUDE PERFETTO MODULE dev.agentprof.captures;
SELECT track_id, metric AS name, value AS maximum_recorded_value
FROM dev_agentprof_capture_health`,
} as const;
