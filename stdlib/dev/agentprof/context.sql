-- SPDX-License-Identifier: Apache-2.0

-- AgentProf context composition snapshots, item-level token deltas, sampled
-- context counter history, and compaction spans.

INCLUDE PERFETTO MODULE dev.agentprof.captures;

INCLUDE PERFETTO MODULE dev.agentprof.sessions;

INCLUDE PERFETTO MODULE dev.agentprof.tools;

-- Recorded context composition snapshots (schema version 1).
CREATE PERFETTO TABLE dev_agentprof_context_snapshots AS
SELECT
  id AS event_id,
  arg_set_id,
  capture_id,
  session,
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
  (
    SELECT
      JSON_GROUP_OBJECT(
        SUBSTR(a.key, LENGTH('debug.context.categories.') + 1),
        a.int_value
      )
    FROM args AS a
    WHERE
      a.arg_set_id = s.arg_set_id
      AND a.key GLOB 'debug.context.categories.*'
  ) AS categories
FROM dev_agentprof_slices AS s
WHERE
  EXTRACT_ARG(arg_set_id, 'debug.context.version') = 1;

-- Item-level context additions, replacements, and removals (no raw item labels).
CREATE PERFETTO TABLE dev_agentprof_context_changes AS
WITH
  measured AS (
    SELECT
      s.*,
      CASE
        WHEN NOT s.baseline
        AND s.basis
        = LAG(s.basis) OVER (
          PARTITION BY
            s.capture_id
          ORDER BY s.ts, s.event_id
        ) THEN LAG(s.estimated_tokens) OVER (
          PARTITION BY
            s.capture_id
          ORDER BY s.ts, s.event_id
        )
      END AS previous_estimated_tokens
    FROM dev_agentprof_context_snapshots AS s
  ),
  prefixes AS (
    SELECT a.arg_set_id, SUBSTR(a.key, 1, LENGTH(a.key) - 3) AS prefix
    FROM args AS a
    WHERE
      a.key GLOB 'debug.context.changes[[]*].id'
  ),
  changes AS (
    SELECT
      s.event_id AS snapshot_id,
      p.arg_set_id,
      p.prefix,
      s.capture_id,
      s.session,
      s.ts,
      COALESCE(EXTRACT_ARG(p.arg_set_id, 'debug.context.item_stage'), s.stage) AS stage,
      s.basis,
      s.baseline,
      s.estimated_tokens,
      s.reported_tokens,
      s.previous_estimated_tokens,
      EXTRACT_ARG(p.arg_set_id, p.prefix || '.id') AS item_id,
      EXTRACT_ARG(p.arg_set_id, p.prefix || '.category') AS category,
      EXTRACT_ARG(p.arg_set_id, p.prefix || '.change') AS change,
      EXTRACT_ARG(p.arg_set_id, p.prefix || '.tokens') AS tokens,
      EXTRACT_ARG(p.arg_set_id, p.prefix || '.delta_tokens') AS delta_tokens,
      EXTRACT_ARG(p.arg_set_id, p.prefix || '.chars') AS chars,
      EXTRACT_ARG(p.arg_set_id, p.prefix || '.source_id') AS source_id,
      EXTRACT_ARG(p.arg_set_id, p.prefix || '.source_kind') AS source_kind
    FROM prefixes AS p
    JOIN measured AS s USING (arg_set_id)
  )
SELECT
  c.*,
  COALESCE(
    (
      SELECT t.id
      FROM dev_agentprof_tool_calls AS t
      WHERE
        t.capture_id = c.capture_id
        AND t.call_id = c.source_id
        AND c.source_id != ''
      ORDER BY
        t.ts DESC
      LIMIT 1
    ),
    c.snapshot_id
  ) AS event_id,
  (
    SELECT t.name
    FROM dev_agentprof_tool_calls AS t
    WHERE
      t.capture_id = c.capture_id
      AND t.call_id = c.source_id
      AND c.source_id != ''
    ORDER BY
      t.ts DESC
    LIMIT 1
  ) AS tool
FROM changes AS c;

-- Lazy detail projection adding item labels for bounded UI Context tables.
CREATE PERFETTO VIEW dev_agentprof_context_change_details AS
SELECT c.*, EXTRACT_ARG(c.arg_set_id, c.prefix || '.label') AS label
FROM dev_agentprof_context_changes AS c;

-- Latest recorded context snapshot per capture joined with session metadata.
CREATE PERFETTO VIEW dev_agentprof_context_latest AS
SELECT s.*, h.root_capture_id, r.harness
FROM (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY capture_id ORDER BY ts DESC, event_id DESC) AS sample_rank
  FROM dev_agentprof_context_snapshots
) AS s
JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
JOIN dev_agentprof_capture_runs AS r USING (capture_id)
WHERE
  s.sample_rank = 1
ORDER BY
  s.ts,
  s.event_id;

-- Context snapshots enriched with root capture and harness for UI filtering.
CREATE PERFETTO VIEW dev_agentprof_context_observations AS
SELECT s.*, h.root_capture_id, r.harness
FROM dev_agentprof_context_snapshots AS s
JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
JOIN dev_agentprof_capture_runs AS r USING (capture_id);

-- Per-capture context pressure summary combining counter peak and latest snapshot.
CREATE PERFETTO VIEW dev_agentprof_context_summary AS
WITH
  ranked AS (
    SELECT
      *,
      ROW_NUMBER() OVER (
        PARTITION BY
          capture_id
        ORDER BY ts DESC, event_id DESC
      ) AS rank
    FROM dev_agentprof_context_snapshots
  )
SELECT
  r.capture_id,
  r.peak_context,
  r.context_window_tokens,
  r.context_share,
  c.event_id AS latest_snapshot_id,
  c.ts AS latest_snapshot_ts,
  c.stage,
  c.basis,
  c.coverage,
  c.model AS snapshot_model,
  c.estimated_tokens,
  c.reported_tokens,
  c.window_tokens,
  c.effective_window_tokens,
  c.compact_threshold_tokens,
  c.omitted_changes,
  c.categories,
  (
    SELECT COUNT(*)
    FROM dev_agentprof_context_snapshots AS s
    WHERE
      s.capture_id = r.capture_id
  ) AS snapshots,
  (
    SELECT COUNT(*)
    FROM dev_agentprof_context_changes AS s
    WHERE
      s.capture_id = r.capture_id
  ) AS retained_changes
FROM dev_agentprof_capture_runs AS r
LEFT JOIN ranked AS c
  ON c.capture_id = r.capture_id
  AND c.rank = 1
ORDER BY
  r.start_ts,
  r.capture_id;

-- Sampled context token counter series within each capture's active window.
CREATE PERFETTO VIEW dev_agentprof_context_history AS
SELECT
  c.ts,
  c.value AS tokens,
  t.capture_id,
  h.root_capture_id,
  r.session,
  r.context_window_tokens AS window_tokens
FROM counter AS c
JOIN dev_agentprof_counter_tracks AS t
  ON t.id = c.track_id
JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
JOIN dev_agentprof_capture_runs AS r USING (capture_id)
WHERE
  t.name = 'llm.context.estimated_tokens'
  AND c.ts < r.end_ts;

-- Recorded context compaction operations with before/after token counts.
CREATE PERFETTO VIEW dev_agentprof_compactions AS
SELECT
  id AS event_id,
  capture_id,
  ts,
  dur,
  incomplete,
  CASE WHEN NOT incomplete AND dur >= 0 THEN dur / 1e6 END AS duration_ms,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.pre_tokens'),
    EXTRACT_ARG(arg_set_id, 'debug.tokens_before')
  ) AS before_tokens,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.post_tokens'),
    EXTRACT_ARG(arg_set_id, 'debug.tokens_after')
  ) AS after_tokens
FROM dev_agentprof_slices
WHERE
  kind = 'compaction';
