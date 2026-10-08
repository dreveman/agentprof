// SPDX-License-Identifier: Apache-2.0
export const CONTEXT_SETUP_SQL = `
CREATE PERFETTO TABLE agentprof_context_snapshots AS
SELECT id AS event_id, arg_set_id, capture_id, session,
  ts + COALESCE(EXTRACT_ARG(arg_set_id, 'debug.context.sample_offset_ns'), 0) AS ts,
  EXTRACT_ARG(arg_set_id, 'debug.context.stage') AS stage,
  EXTRACT_ARG(arg_set_id, 'debug.context.basis') AS basis,
  EXTRACT_ARG(arg_set_id, 'debug.context.coverage') AS coverage,
  EXTRACT_ARG(arg_set_id, 'debug.context.baseline') AS baseline,
  EXTRACT_ARG(arg_set_id, 'debug.context.model') AS model,
  EXTRACT_ARG(arg_set_id, 'debug.context.estimated_tokens') AS estimated_tokens,
  EXTRACT_ARG(arg_set_id, 'debug.context.reported_tokens') AS reported_tokens,
  EXTRACT_ARG(arg_set_id, 'debug.context.window_tokens') AS window_tokens,
  EXTRACT_ARG(arg_set_id, 'debug.context.effective_window_tokens') AS effective_window_tokens,
  EXTRACT_ARG(arg_set_id, 'debug.context.compact_threshold_tokens') AS compact_threshold_tokens,
  EXTRACT_ARG(arg_set_id, 'debug.context.omitted_changes') AS omitted_changes,
  (SELECT JSON_GROUP_OBJECT(SUBSTR(a.key, LENGTH('debug.context.categories.') + 1), a.int_value)
    FROM args a WHERE a.arg_set_id = s.arg_set_id AND a.key GLOB 'debug.context.categories.*') AS categories
FROM agentprof_slices s WHERE EXTRACT_ARG(arg_set_id, 'debug.context.version') = 1;

CREATE PERFETTO TABLE agentprof_context_changes AS
WITH measured AS (
  SELECT s.*, CASE WHEN NOT s.baseline AND s.basis = LAG(s.basis) OVER (PARTITION BY s.capture_id ORDER BY s.ts, s.event_id)
    THEN LAG(s.estimated_tokens) OVER (PARTITION BY s.capture_id ORDER BY s.ts, s.event_id) END AS previous_estimated_tokens
  FROM agentprof_context_snapshots s
), prefixes AS (
  SELECT a.arg_set_id, SUBSTR(a.key, 1, LENGTH(a.key) - 3) AS prefix
  FROM args a WHERE a.key GLOB 'debug.context.changes[[]*].id'
), changes AS (
  SELECT s.event_id AS snapshot_id, s.capture_id, s.session, s.ts, COALESCE(EXTRACT_ARG(p.arg_set_id, 'debug.context.item_stage'), s.stage) AS stage, s.basis,
    s.baseline, s.estimated_tokens, s.reported_tokens,
    s.previous_estimated_tokens,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.id') AS item_id,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.category') AS category,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.change') AS change,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.tokens') AS tokens,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.delta_tokens') AS delta_tokens,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.chars') AS chars,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.label') AS label,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.source_id') AS source_id,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.source_kind') AS source_kind
  FROM prefixes p JOIN measured s USING(arg_set_id)
)
SELECT c.*, COALESCE((SELECT t.id FROM agentprof_tool_calls t
    WHERE t.capture_id = c.capture_id AND t.call_id = c.source_id
    AND c.source_id != '' ORDER BY t.ts DESC LIMIT 1), c.snapshot_id) AS event_id,
  (SELECT t.name FROM agentprof_tool_calls t WHERE t.capture_id = c.capture_id
    AND t.call_id = c.source_id AND c.source_id != '' ORDER BY t.ts DESC LIMIT 1) AS tool
FROM changes c;
`;

// Bound UI result sets; the complete context tables remain queryable in SQL.
export const CONTEXT_SAMPLE_LIMIT = 2000;
export const CONTEXT_CHANGE_LIMIT = 500;
export const CONTEXT_COMPACTION_LIMIT = 500;

export const CONTEXT_QUERIES = {
  context_compactions: `SELECT * FROM (
    SELECT id AS event_id, capture_id, ts, dur,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.pre_tokens'), EXTRACT_ARG(arg_set_id, 'debug.tokens_before')) AS before_tokens,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.post_tokens'), EXTRACT_ARG(arg_set_id, 'debug.tokens_after')) AS after_tokens
    FROM agentprof_slices WHERE kind = 'compaction' AND dur >= 0 AND NOT incomplete
    ORDER BY ts DESC, id DESC LIMIT ${CONTEXT_COMPACTION_LIMIT}
  ) ORDER BY ts, event_id`,
  context_latest: `SELECT s.*, h.root_capture_id, r.harness FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY capture_id ORDER BY ts DESC, event_id DESC) AS sample_rank
    FROM agentprof_context_snapshots
  ) s JOIN agentprof_capture_hierarchy h USING(capture_id)
    JOIN agentprof_capture_runs r USING(capture_id)
    WHERE s.sample_rank = 1 ORDER BY s.ts, s.event_id`,
  context_snapshots: `SELECT * FROM (
    SELECT s.*, h.root_capture_id, r.harness FROM agentprof_context_snapshots s
      JOIN agentprof_capture_hierarchy h USING(capture_id)
      JOIN agentprof_capture_runs r USING(capture_id)
      ORDER BY s.ts DESC, s.event_id DESC LIMIT ${CONTEXT_SAMPLE_LIMIT}
  ) ORDER BY ts, event_id`,
  context_changes: `SELECT * FROM agentprof_context_changes
    ORDER BY ABS(delta_tokens) DESC, ts LIMIT ${CONTEXT_CHANGE_LIMIT}`,
  context_history: `SELECT * FROM (
    SELECT c.ts, c.value AS tokens, t.capture_id, h.root_capture_id, r.session,
      r.context_window_tokens AS window_tokens
    FROM counter c JOIN agentprof_counter_tracks t ON t.id = c.track_id
    JOIN agentprof_capture_hierarchy h USING(capture_id)
    JOIN agentprof_capture_runs r USING(capture_id)
    WHERE t.name = 'llm.context.estimated_tokens' AND c.ts < r.end_ts
    ORDER BY c.ts DESC LIMIT ${CONTEXT_SAMPLE_LIMIT}
  ) ORDER BY ts`,
};
