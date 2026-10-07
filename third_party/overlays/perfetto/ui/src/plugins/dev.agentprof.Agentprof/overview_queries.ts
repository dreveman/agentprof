// SPDX-License-Identifier: Apache-2.0

import {CONTEXT_SETUP_SQL, CONTEXT_QUERIES} from './context_queries';
import {SESSION_HIERARCHY_SQL} from './session_hierarchy';

export const OVERVIEW_SETUP_SQL = `
${SESSION_HIERARCHY_SQL}
CREATE PERFETTO TABLE agentprof_configuration AS
    SELECT capture_id, arg_set_id,
      COALESCE(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.harness'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_harness')), 'Not recorded') AS harness,
      COALESCE(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.provider'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_provider')), 'Not recorded') AS provider,
      COALESCE(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.model'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_model')), 'Not recorded') AS model,
      COALESCE(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.effort'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_effort')), 'Not recorded') AS effort,
      EXTRACT_ARG(arg_set_id, 'debug.context_window_tokens') AS context_window_tokens
    FROM agentprof_slices
    WHERE category IN ('pi.metadata', 'claude.metadata', 'codex.metadata', 'muse.metadata', 'agentprof.metadata') AND (name IN ('tracing', 'tracing-start', 'run-configuration')
      OR name GLOB 'profile ([0-9]*)');
CREATE PERFETTO TABLE agentprof_session_labels AS
SELECT capture_id, JSON_GROUP_ARRAY(label) AS session_labels FROM (
  SELECT DISTINCT c.capture_id, TRIM(a.string_value) AS label
  FROM agentprof_configuration c JOIN args a USING(arg_set_id)
  WHERE a.flat_key = 'debug.session_labels' AND a.key GLOB 'debug.session_labels[[]*'
    AND TRIM(a.string_value) != ''
  ORDER BY c.capture_id, label
) GROUP BY capture_id;
CREATE PERFETTO TABLE agentprof_capture_runs AS
WITH configuration AS (
    SELECT capture_id, GROUP_CONCAT(DISTINCT harness) AS harness,
      GROUP_CONCAT(DISTINCT provider) AS provider, GROUP_CONCAT(DISTINCT model) AS model,
      GROUP_CONCAT(DISTINCT effort) AS effort,
      MAX(context_window_tokens) AS context_window_tokens,
      COUNT(DISTINCT context_window_tokens) AS context_window_count
    FROM agentprof_configuration GROUP BY capture_id
  ), per_track AS (
    SELECT p.capture_id, t.id, t.name, MAX(c.value) AS maximum FROM counter c
    JOIN agentprof_counter_tracks t ON t.id = c.track_id
    JOIN agentprof_track_process p ON p.track_id = t.id
    WHERE t.name IN ('llm.tokens.input', 'llm.tokens.output', 'llm.context.estimated_tokens')
    GROUP BY p.capture_id, t.id, t.name
  ), tokens AS (
    SELECT capture_id,
      SUM(CASE WHEN name = 'llm.tokens.input' THEN maximum END) AS input_tokens,
      SUM(CASE WHEN name = 'llm.tokens.output' THEN maximum END) AS output_tokens,
      MAX(CASE WHEN name = 'llm.context.estimated_tokens' THEN maximum END) AS peak_context
    FROM per_track GROUP BY capture_id
  ), capture_peak AS (
    SELECT m.capture_id,
      MAX(EXTRACT_ARG(s.arg_set_id, 'debug.peak_context_tokens')) AS peak_context
    FROM agentprof_capture_markers m JOIN slice s ON s.id = m.slice_id
    GROUP BY m.capture_id
  ), captures AS (
    SELECT capture_id, session, MIN(ts) AS start_ts, MAX(ts + MAX(dur, 0)) AS end_ts,
      SUM(kind = 'turn') AS turns, SUM(kind = 'assistant-message') AS responses,
      SUM(kind = 'tool-execution') AS tools, SUM(incomplete) AS incomplete,
      (MAX(ts + MAX(dur, 0)) - MIN(ts)) / 1e6 AS duration_ms
    FROM agentprof_slices GROUP BY capture_id, session
  ) SELECT s.*, COALESCE(c.label, SUBSTR(c.recorded_id, 1, 8), 'Legacy capture') AS capture,
    c.recorded_id, configuration.harness, configuration.provider, configuration.model, labels.session_labels,
    configuration.effort, configuration.context_window_tokens,
    tokens.input_tokens, tokens.output_tokens,
    COALESCE(capture_peak.peak_context, tokens.peak_context) AS peak_context,
    CASE WHEN configuration.context_window_count = 1 AND configuration.context_window_tokens > 0
      THEN CAST(COALESCE(capture_peak.peak_context, tokens.peak_context) AS DOUBLE)
        / configuration.context_window_tokens END AS context_share
    FROM captures s LEFT JOIN agentprof_captures c USING(capture_id)
    LEFT JOIN agentprof_session_labels labels USING(capture_id)
    LEFT JOIN configuration USING(capture_id) LEFT JOIN tokens USING(capture_id)
    LEFT JOIN capture_peak USING(capture_id)
    ORDER BY s.start_ts, s.capture_id;

CREATE PERFETTO TABLE agentprof_messages AS
SELECT *,
  COALESCE(EXTRACT_ARG(arg_set_id, 'debug.provider'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_provider')) AS provider,
  COALESCE(EXTRACT_ARG(arg_set_id, 'debug.model'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_model')) AS model,
  CASE WHEN dur > 0 THEN dur ELSE
    COALESCE(EXTRACT_ARG(arg_set_id, 'debug.duration_ns'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_stream_duration_ns')) END AS message_ns,
  CASE WHEN dur > 0 THEN ts ELSE
    ts - COALESCE(EXTRACT_ARG(arg_set_id, 'debug.duration_ns'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_stream_duration_ns')) END AS message_start_ts,
  COALESCE(EXTRACT_ARG(arg_set_id, 'debug.first_content_ns'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_stream_first_content_ns')) AS first_ns,
  COALESCE(EXTRACT_ARG(arg_set_id, 'debug.input_tokens'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_input')) AS input_tokens,
  COALESCE(EXTRACT_ARG(arg_set_id, 'debug.output_tokens'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_output')) AS output_tokens,
  COALESCE(EXTRACT_ARG(arg_set_id, 'debug.cache_read_tokens'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_cacheRead')) AS cache_read_tokens
FROM agentprof_slices WHERE kind = 'assistant-message';

-- Sweep interval boundaries together so coincident starts/ends do not create
-- artificial concurrency. Only completed, measured intervals contribute.
CREATE PERFETTO TABLE agentprof_activity AS
WITH intervals AS (
  SELECT ts, ts + dur AS end_ts, 1 AS tools, 0 AS models, 0 AS scripts
  FROM agentprof_slices WHERE kind = 'tool-execution' AND NOT incomplete AND dur > 0
  UNION ALL
  SELECT message_start_ts, message_start_ts + message_ns, 0, 1, 0 FROM agentprof_messages
  WHERE message_ns > 0 AND NOT incomplete
  UNION ALL
  SELECT ts, ts + dur, 0, 0, 1 FROM agentprof_slices
  WHERE kind IN ('script', 'model-call') AND NOT incomplete AND dur > 0
), boundaries AS (
  SELECT ts, tools, models, scripts FROM intervals
  UNION ALL SELECT end_ts, -tools, -models, -scripts FROM intervals
), deltas AS (
  SELECT ts, SUM(tools) AS tools, SUM(models) AS models, SUM(scripts) AS scripts FROM boundaries GROUP BY ts
)
SELECT ts, LEAD(ts) OVER (ORDER BY ts) - ts AS dur,
  SUM(tools) OVER (ORDER BY ts) AS tools,
  SUM(models) OVER (ORDER BY ts) AS models,
  SUM(scripts) OVER (ORDER BY ts) AS scripts
FROM deltas;
${CONTEXT_SETUP_SQL}
`;

function activitySeriesSql(includeSubagents: boolean): string {
  const capture = (alias: string) => includeSubagents ? 'h.root_capture_id' : `${alias}.capture_id`;
  const hierarchy = includeSubagents ? 'JOIN agentprof_capture_hierarchy h USING(capture_id)' : '';
  return `WITH RECURSIVE bins(n) AS (
    SELECT 0 UNION ALL SELECT n + 1 FROM bins WHERE n < 47
  ), bounds AS (
    SELECT ${capture('r')} AS capture_id, MIN(r.start_ts) AS start_ts,
      MAX(r.end_ts) AS end_ts
    FROM agentprof_capture_runs r ${hierarchy}
    GROUP BY ${capture('r')}
  ), intervals AS (
    SELECT ${capture('m')} AS capture_id, m.message_start_ts AS ts,
      m.message_start_ts + m.message_ns AS end_ts
    FROM agentprof_messages m ${hierarchy}
    WHERE m.message_ns > 0 AND NOT m.incomplete
    UNION ALL
    SELECT ${capture('s')}, s.ts, s.ts + s.dur
    FROM agentprof_slices s ${hierarchy}
    WHERE s.kind IN ('tool-execution', 'script', 'model-call') AND s.dur > 0 AND NOT s.incomplete
  ), measured AS (
    SELECT DISTINCT capture_id FROM intervals
  ), boundaries AS (
    SELECT capture_id, ts, 1 AS delta FROM intervals
    UNION ALL SELECT capture_id, end_ts, -1 FROM intervals
  ), deltas AS (
    SELECT capture_id, ts, SUM(delta) AS delta FROM boundaries
    GROUP BY capture_id, ts
  ), segments AS (
    SELECT capture_id, ts,
      LEAD(ts) OVER (PARTITION BY capture_id ORDER BY ts) AS end_ts,
      SUM(delta) OVER (PARTITION BY capture_id ORDER BY ts) AS active
    FROM deltas
  ), ranges AS (
    SELECT b.capture_id, bins.n AS bin,
      b.start_ts + (b.end_ts - b.start_ts) * bins.n / 48 AS ts,
      b.start_ts + (b.end_ts - b.start_ts) * (bins.n + 1) / 48 AS end_ts
    FROM bounds b CROSS JOIN bins
  ) SELECT r.capture_id, r.bin,
    CASE WHEN m.capture_id IS NULL OR r.end_ts <= r.ts THEN NULL ELSE
      MIN(1.0, COALESCE(SUM(MAX(0, MIN(s.end_ts, r.end_ts) - MAX(s.ts, r.ts))), 0)
        * 1.0 / (r.end_ts - r.ts)) END AS busy_fraction
    FROM ranges r LEFT JOIN measured m USING(capture_id)
    LEFT JOIN segments s ON s.capture_id = r.capture_id AND s.active > 0
      AND s.end_ts > r.ts AND s.ts < r.end_ts
    GROUP BY r.capture_id, r.bin ORDER BY r.capture_id, r.bin`;
}

export const OVERVIEW_QUERIES = {
  ...CONTEXT_QUERIES,
  runs: `WITH totals AS (
    SELECT h.root_capture_id AS capture_id, MIN(r.start_ts) AS start_ts,
      (MAX(r.end_ts) - MIN(r.start_ts)) / 1e6 AS duration_ms,
      SUM(r.turns) AS turns, SUM(r.responses) AS responses, SUM(r.tools) AS tools,
      SUM(r.incomplete) AS incomplete, SUM(r.input_tokens) AS input_tokens,
      SUM(r.output_tokens) AS output_tokens, MAX(r.peak_context) AS peak_context,
      MAX(r.context_window_tokens) AS context_window_tokens,
      MAX(r.context_share) AS context_share,
      COUNT(*) - 1 AS subagents
    FROM agentprof_capture_runs r JOIN agentprof_capture_hierarchy h USING(capture_id)
    GROUP BY h.root_capture_id
  ), configuration AS (
    SELECT h.root_capture_id AS capture_id,
      GROUP_CONCAT(DISTINCT COALESCE(c.harness, 'Not recorded')) AS harness,
      GROUP_CONCAT(DISTINCT COALESCE(c.provider, 'Not recorded')) AS provider,
      GROUP_CONCAT(DISTINCT COALESCE(c.model, 'Not recorded')) AS model,
      JSON_GROUP_ARRAY(DISTINCT JSON_OBJECT('provider', c.provider, 'model', c.model)) AS model_identities,
      GROUP_CONCAT(DISTINCT COALESCE(c.effort, 'Not recorded')) AS effort
    FROM agentprof_capture_hierarchy h LEFT JOIN agentprof_configuration c USING(capture_id)
    WHERE h.capture_id = h.root_capture_id
    GROUP BY h.root_capture_id
  ), prompts AS (
    SELECT capture_id, id AS prompt_id,
      SUBSTR(EXTRACT_ARG(arg_set_id, 'debug.text'), 1, 2048) AS prompt_text,
      ROW_NUMBER() OVER (PARTITION BY capture_id ORDER BY ts, id) AS prompt_number
    FROM agentprof_slices
    WHERE name = 'prompt' AND TRIM(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.text'), '')) != ''
  ), token_rates AS (
    SELECT h.root_capture_id AS capture_id,
      SUM(m.output_tokens) * 1e9 / SUM(m.message_ns) AS tokens_per_s
    FROM agentprof_messages m JOIN agentprof_capture_hierarchy h USING(capture_id)
    WHERE m.output_tokens IS NOT NULL AND m.message_ns > 0 AND NOT m.incomplete
    GROUP BY h.root_capture_id
  ), model_intervals AS (
    SELECT h.root_capture_id AS capture_id, m.message_start_ts AS ts,
      m.message_start_ts + m.message_ns AS end_ts
    FROM agentprof_messages m JOIN agentprof_capture_hierarchy h USING(capture_id)
    WHERE m.message_ns > 0 AND NOT m.incomplete
  ), model_boundaries AS (
    SELECT capture_id, ts, 1 AS delta FROM model_intervals
    UNION ALL SELECT capture_id, end_ts, -1 FROM model_intervals
  ), model_deltas AS (
    SELECT capture_id, ts, SUM(delta) AS delta FROM model_boundaries
    GROUP BY capture_id, ts
  ), model_activity AS (
    SELECT capture_id, LEAD(ts) OVER (PARTITION BY capture_id ORDER BY ts) - ts AS dur,
      SUM(delta) OVER (PARTITION BY capture_id ORDER BY ts) AS active
    FROM model_deltas
  ), model_busy AS (
    SELECT capture_id, SUM(CASE WHEN active > 0 AND dur > 0 THEN dur END) / 1e6 AS model_busy_ms,
      MAX(CASE WHEN active > 0 AND dur > 0 THEN active END) AS peak_model_responses
    FROM model_activity GROUP BY capture_id
  ) SELECT t.*, r.session, r.capture, r.recorded_id,
    p.prompt_id, p.prompt_text, token_rates.tokens_per_s,
    model_busy.model_busy_ms, model_busy.peak_model_responses,
    c.harness, c.provider, c.model, c.model_identities, c.effort, r.session_labels
    FROM totals t JOIN agentprof_capture_runs r USING(capture_id)
    JOIN configuration c USING(capture_id)
    LEFT JOIN prompts p ON p.capture_id = t.capture_id AND p.prompt_number = 1
    LEFT JOIN token_rates USING(capture_id)
    LEFT JOIN model_busy USING(capture_id)
    ORDER BY t.start_ts, t.capture_id`,
  session_activity: activitySeriesSql(true),
  capture_activity: activitySeriesSql(false),
  summary: `SELECT
    (SELECT COUNT(DISTINCT root_capture_id) FROM agentprof_capture_hierarchy) AS sessions,
    (SELECT SUM(capture_id != root_capture_id) FROM agentprof_capture_hierarchy) AS subagents,
    (SELECT COUNT(*) = 1 AND MIN(model IS NOT NULL AND model != '') FROM (
      SELECT DISTINCT
        COALESCE(EXTRACT_ARG(arg_set_id, 'debug.provider'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_provider')) AS provider,
        COALESCE(EXTRACT_ARG(arg_set_id, 'debug.model'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_model')) AS model
      FROM agentprof_slices
      WHERE kind = 'assistant-message' OR
        (category IN ('pi.metadata', 'claude.metadata', 'codex.metadata', 'muse.metadata', 'agentprof.metadata') AND (name IN ('tracing', 'tracing-start', 'run-configuration')
          OR name GLOB 'profile ([0-9]*)'))
    )) AS single_model,
    SUM(kind = 'turn') AS turns, SUM(kind = 'assistant-message') AS responses,
    SUM(kind = 'script') AS scripts,
    SUM(kind = 'tool-execution') AS tools, SUM(incomplete) AS incomplete,
    SUM(CASE WHEN kind = 'capture' THEN COALESCE(EXTRACT_ARG(arg_set_id, 'debug.unavailable_child_sessions'), 0) ELSE 0 END) AS unavailable_children,
    (MAX(ts + MAX(dur, 0)) - MIN(ts)) / 1e6 AS duration_ms,
    (SELECT COUNT(DISTINCT COALESCE(t.machine_id, 0)) FROM track t
      JOIN agentprof_track_process p ON p.track_id = t.id
      WHERE p.capture_id IN (SELECT capture_id FROM agentprof_slices)) AS machines,
    (SELECT COALESCE(SUM(value), 0) FROM stats WHERE name IN (
      'clock_sync_failure_no_path', 'clock_sync_failure_undeferrable_packet_loss',
      'clock_sync_unrelatable_clock_domains', 'trace_sorter_negative_timestamp_dropped',
      'invalid_clock_snapshots')) AS clock_errors
    FROM agentprof_slices`,
  headline: `SELECT
    (SELECT SUM(output_tokens) * 1e9 / SUM(message_ns) FROM agentprof_messages
      WHERE output_tokens IS NOT NULL AND message_ns > 0 AND NOT incomplete) AS output_tokens_per_s,
    (SELECT SUM(dur) / 1e6 FROM agentprof_activity WHERE dur > 0 AND models > 0) AS model_busy_ms,
    (SELECT MAX(models) FROM agentprof_activity WHERE dur > 0 AND models > 0) AS peak_model_responses,
    (SELECT (MAX(ts + MAX(dur, 0)) - MIN(ts)) / 1e6 FROM agentprof_slices) AS wall_window_ms`,
  activity: `SELECT
    SUM(CASE WHEN tools > 0 AND models = 0 THEN dur ELSE 0 END) / 1e6 AS tools_only_ms,
    SUM(CASE WHEN models > 0 AND tools = 0 THEN dur ELSE 0 END) / 1e6 AS models_only_ms,
    SUM(CASE WHEN models > 0 AND tools > 0 THEN dur ELSE 0 END) / 1e6 AS overlap_ms,
    SUM(CASE WHEN scripts > 0 AND tools = 0 AND models = 0 THEN dur ELSE 0 END) / 1e6 AS scripts_only_ms,
    MAX(tools) AS peak_tools,
    SUM(CASE WHEN tools > 1 THEN dur ELSE 0 END) / 1e6 AS parallel_ms,
    SUM(CASE WHEN tools > 0 THEN dur ELSE 0 END) / 1e6 AS tool_active_ms
    FROM agentprof_activity WHERE dur > 0`,
  concurrency: `WITH RECURSIVE bins(n) AS (
    SELECT 0 UNION ALL SELECT n + 1 FROM bins WHERE n < 39
  ), bounds AS (
    SELECT MIN(ts) AS start, MAX(ts + dur) AS end FROM agentprof_activity WHERE dur > 0
  ), windows AS (
    SELECT n, start + (end - start) * n / 40 AS ts,
      start + (end - start) * (n + 1) / 40 AS end_ts, start FROM bins, bounds
  ) SELECT w.n, (w.ts - w.start) / 1e6 AS offset_ms,
    COALESCE(MAX(a.tools), 0) AS tools FROM windows w
    LEFT JOIN agentprof_activity a ON a.ts < w.end_ts AND a.ts + a.dur > w.ts
    WHERE w.ts IS NOT NULL GROUP BY w.n ORDER BY w.n`,
  models: `SELECT provider, model, COUNT(*) AS responses,
    AVG(first_ns) / 1e6 AS first_content_ms, COUNT(first_ns) AS latency_samples,
    AVG(message_ns) / 1e6 AS duration_ms,
    SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    COUNT(input_tokens) AS input_samples, COUNT(output_tokens) AS output_samples
    FROM agentprof_messages GROUP BY provider, model ORDER BY responses DESC`,
  responses: `SELECT id, session, provider, model, first_ns / 1e6 AS first_content_ms,
    message_ns / 1e6 AS duration_ms, input_tokens, output_tokens
    FROM agentprof_messages ORDER BY ts LIMIT 200`,
  tools: `SELECT name AS tool, COUNT(*) AS calls,
    SUM(CASE WHEN NOT incomplete THEN dur END) / 1e6 AS work_ms,
    MAX(CASE WHEN NOT incomplete THEN dur END) / 1e6 AS longest_ms,
    SUM(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.is_error'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_tool_is_error')) = 1) AS errors,
    COUNT(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.is_error'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_tool_is_error'))) AS outcomes,
    SUM(incomplete) AS incomplete
    FROM agentprof_slices WHERE kind = 'tool-execution'
    GROUP BY name ORDER BY work_ms DESC`,
  slow: `SELECT id, name AS tool, CASE WHEN dur >= 0 THEN dur / 1e6 END AS duration_ms, incomplete,
    is_error, intent, arguments, args_truncated, kind, language, line_count
    FROM agentprof_tool_calls WHERE kind = 'tool-execution' ORDER BY incomplete DESC, dur DESC LIMIT 100`,
  scripts: `SELECT p.id, p.name AS script, CASE WHEN p.dur >= 0 THEN p.dur / 1e6 END AS duration_ms,
    p.is_error, p.incomplete, p.intent, p.arguments, p.args_truncated, p.kind, p.language, p.line_count, COUNT(c.id) AS calls
    FROM agentprof_tool_calls p LEFT JOIN agentprof_script_children c ON c.script_id = p.id
    WHERE p.kind = 'script' GROUP BY p.id ORDER BY p.ts LIMIT 100`,
  script_calls: `SELECT c.script_id, t.id, t.name AS tool, c.depth,
    t.kind, CASE WHEN t.dur >= 0 THEN t.dur / 1e6 END AS duration_ms,
    t.is_error, t.incomplete, t.intent, t.arguments, t.args_truncated,
    t.language, t.line_count
    FROM agentprof_script_children c JOIN agentprof_tool_calls t ON t.id = c.id
    WHERE c.script_id IN (SELECT id FROM agentprof_tool_calls WHERE kind = 'script' ORDER BY ts LIMIT 100)
    ORDER BY c.script_id, t.ts, t.id`,
  sessions: `WITH roles AS (
    SELECT capture_id,
      MAX(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.child_role'),
        EXTRACT_ARG(arg_set_id, 'debug.childRole'))) AS child_role,
      MAX(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.subagent_type'),
        EXTRACT_ARG(arg_set_id, 'debug.subagentType'))) AS subagent_type
    FROM agentprof_slices GROUP BY capture_id
  ), configuration AS (
    SELECT capture_id,
      JSON_GROUP_ARRAY(DISTINCT JSON_OBJECT('provider', provider, 'model', model)) AS model_identities
    FROM agentprof_configuration GROUP BY capture_id
  ), prompts AS (
    SELECT capture_id, id AS prompt_id,
      SUBSTR(EXTRACT_ARG(arg_set_id, 'debug.text'), 1, 2048) AS prompt_text,
      ROW_NUMBER() OVER (PARTITION BY capture_id ORDER BY ts, id) AS prompt_number
    FROM agentprof_slices
    WHERE name = 'prompt' AND TRIM(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.text'), '')) != ''
  ), token_rates AS (
    SELECT capture_id, SUM(output_tokens) * 1e9 / SUM(message_ns) AS tokens_per_s
    FROM agentprof_messages
    WHERE output_tokens IS NOT NULL AND message_ns > 0 AND NOT incomplete
    GROUP BY capture_id
  ), model_intervals AS (
    SELECT capture_id, message_start_ts AS ts,
      message_start_ts + message_ns AS end_ts
    FROM agentprof_messages WHERE message_ns > 0 AND NOT incomplete
  ), model_boundaries AS (
    SELECT capture_id, ts, 1 AS delta FROM model_intervals
    UNION ALL SELECT capture_id, end_ts, -1 FROM model_intervals
  ), model_deltas AS (
    SELECT capture_id, ts, SUM(delta) AS delta FROM model_boundaries
    GROUP BY capture_id, ts
  ), model_activity AS (
    SELECT capture_id, LEAD(ts) OVER (PARTITION BY capture_id ORDER BY ts) - ts AS dur,
      SUM(delta) OVER (PARTITION BY capture_id ORDER BY ts) AS active
    FROM model_deltas
  ), model_busy AS (
    SELECT capture_id, SUM(CASE WHEN active > 0 AND dur > 0 THEN dur END) / 1e6 AS model_busy_ms,
      MAX(CASE WHEN active > 0 AND dur > 0 THEN active END) AS peak_model_responses
    FROM model_activity GROUP BY capture_id
  ) SELECT s.capture_id, h.root_capture_id, h.parent_capture_id,
    s.session, s.capture, s.recorded_id,
    p.prompt_id, p.prompt_text, h.is_subagent,
    CASE WHEN h.is_subagent = 0 THEN 'Primary'
      WHEN NULLIF(r.subagent_type, '') IS NOT NULL
        THEN 'Subagent · ' || r.subagent_type
      ELSE 'Subagent' END AS role,
    s.harness, s.provider, s.model, c.model_identities, s.effort, s.session_labels,
    s.input_tokens, s.output_tokens, s.peak_context,
    s.context_window_tokens, s.context_share,
    token_rates.tokens_per_s, model_busy.model_busy_ms,
    model_busy.peak_model_responses, s.duration_ms,
    s.turns, s.responses, s.tools, s.incomplete
    FROM agentprof_capture_runs s
    JOIN agentprof_capture_hierarchy h USING(capture_id)
    LEFT JOIN configuration c USING(capture_id)
    LEFT JOIN roles r USING(capture_id)
    LEFT JOIN prompts p ON p.capture_id = s.capture_id AND p.prompt_number = 1
    LEFT JOIN token_rates USING(capture_id)
    LEFT JOIN model_busy USING(capture_id)
    ORDER BY s.start_ts, s.capture_id`,
  health: `SELECT t.display_name AS metric, MAX(c.value) AS value FROM counter c
    JOIN agentprof_counter_tracks t ON t.id = c.track_id
    WHERE t.name IN ('tracing.droppedEvents', 'tracing.laneOverflows') GROUP BY t.name`,
} as const;
