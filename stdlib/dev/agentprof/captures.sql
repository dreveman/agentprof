-- SPDX-License-Identifier: Apache-2.0

-- AgentProf capture discovery, track/process association, slice normalization,
-- configuration metadata, health counters, and per-capture inventory.

-- Count of slices matching a supported AgentProf recording schema.
CREATE PERFETTO VIEW dev_agentprof_detected AS
SELECT COUNT(*) AS count
FROM slice
WHERE
  category GLOB 'pi.*'
  OR (category IN (
    'claude.metadata',
    'codex.metadata',
    'muse.metadata',
    'agentprof.metadata'
  )
  AND EXTRACT_ARG(arg_set_id, 'debug.kind') = 'capture'
  AND EXTRACT_ARG(arg_set_id, 'debug.schema_version') = 1);

-- Map every track to its enclosing process (if any) and capture track fallback.
CREATE PERFETTO TABLE dev_agentprof_track_process AS
WITH RECURSIVE
  ancestry(track_id, ancestor_id) AS (
    SELECT id, id FROM track
    UNION
    SELECT a.track_id, t.parent_id
    FROM ancestry AS a
    JOIN track AS t
      ON t.id = a.ancestor_id
    WHERE
      t.parent_id IS NOT NULL
  )
SELECT
  a.track_id,
  MAX(COALESCE(p.upid, c.upid, th.upid)) AS upid,
  COALESCE(
    MAX(CASE WHEN t.name = 'agentprof.capture' THEN t.id END),
    -1 - MAX(COALESCE(p.upid, c.upid, th.upid)),
    -1 - a.track_id
  ) AS capture_id
FROM ancestry AS a
JOIN track AS t
  ON t.id = a.ancestor_id
LEFT JOIN process_track AS p
  ON p.id = a.ancestor_id
LEFT JOIN process_counter_track AS c
  ON c.id = a.ancestor_id
LEFT JOIN thread_track AS tt
  ON tt.id = a.ancestor_id
LEFT JOIN thread AS th
  ON th.utid = tt.utid
GROUP BY
  a.track_id;

-- Normalized AgentProf counter tracks across current and legacy metric names.
CREATE PERFETTO TABLE dev_agentprof_counter_tracks AS
WITH
  names(metric, display_name, group_name) AS (
    VALUES
      ('context.system', 'System instructions', 'Context'),
      (
        'context.rules',
        'Rules and memory',
        'Context'
      ), ('context.skills', 'Skills', 'Context'),
      (
        'context.tools',
        'Tool definitions',
        'Context'
      ), ('context.environment', 'Environment', 'Context'),
      (
        'context.prompts',
        'User prompts',
        'Context'
      ), ('context.assistant', 'Assistant history', 'Context'),
      (
        'context.results',
        'Tool results',
        'Context'
      ), ('context.summaries', 'Compaction summaries', 'Context'),
      (
        'context.overhead',
        'Harness overhead',
        'Context'
      ), ('context.messages', 'Conversation', 'Context'),
      (
        'context.unattributed',
        'Unattributed',
        'Context'
      ), ('llm.tokens.input', 'Input tokens', NULL),
      (
        'llm.tokens.output',
        'Output tokens',
        NULL
      ), ('llm.context.estimated_tokens', 'Context size', NULL),
      (
        'llm.context.window_tokens',
        'Context window',
        NULL
      ), ('runtime.rss', 'Resident memory', 'Runtime'),
      (
        'runtime.heap',
        'JS heap',
        'Runtime'
      ), ('runtime.cpu', 'CPU time (interval)', 'Runtime'),
      (
        'tracing.droppedEvents',
        'Dropped events',
        'Tracing'
      ), ('tracing.queueDepth', 'Queue depth', 'Tracing'),
      (
        'tracing.laneOverflows',
        'Lane overflows',
        'Tracing'
      )
  )
SELECT t.id, n.metric AS name, n.display_name, n.group_name, m.capture_id
FROM counter_track AS t
JOIN names AS n
  ON t.name IN (n.metric, n.display_name, 'Context: ' || n.display_name)
  OR (n.metric = 'llm.context.estimated_tokens'
  AND t.name = 'Context size (est.)')
JOIN dev_agentprof_track_process AS m
  ON m.track_id = t.id;

-- OS thread tracks are shared across captures and have no capture parent. Join
-- their capture spans to the generic capture track using its recorded UUID.
CREATE PERFETTO TABLE dev_agentprof_capture_markers AS
SELECT
  s.id AS slice_id,
  COALESCE(root.id, m.capture_id) AS capture_id,
  COALESCE(
    EXTRACT_ARG(s.arg_set_id, 'debug.capture_id'),
    EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_capture_id')
  ) AS recorded_id,
  COALESCE(
    EXTRACT_ARG(s.arg_set_id, 'debug.session_id'),
    EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_session_id')
  ) AS session_id,
  COALESCE(
    EXTRACT_ARG(s.arg_set_id, 'debug.label'),
    EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_capture_label')
  ) AS label
FROM slice AS s
JOIN dev_agentprof_track_process AS m
  ON m.track_id = s.track_id
LEFT JOIN track AS root
  ON root.name = 'agentprof.capture'
  AND printf('%x', EXTRACT_ARG(root.source_arg_set_id, 'trace_id'))
  = COALESCE(
    EXTRACT_ARG(s.arg_set_id, 'debug.capture_id'),
    EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_capture_id')
  )
WHERE
  s.category IN (
    'pi.metadata',
    'claude.metadata',
    'codex.metadata',
    'muse.metadata',
    'agentprof.metadata'
  )
  AND (s.name IN ('tracing', 'tracing-start') OR s.name GLOB 'profile ([0-9]*)');

-- Deduplicated capture metadata keyed by trace-local capture_id.
CREATE PERFETTO TABLE dev_agentprof_captures AS
SELECT
  capture_id,
  MAX(recorded_id) AS recorded_id,
  MAX(session_id) AS session_id,
  MAX(label) AS label
FROM dev_agentprof_capture_markers
GROUP BY
  capture_id;

-- Perfetto's intrinsic slice table has no child-by-parent index. Materialize
-- parent edges only on tracks containing capture markers into an indexed
-- temporary SQLite table, propagate each marker downward stopping at nested
-- markers, and drop the temporary lookup immediately after.
DROP INDEX IF EXISTS _dev_agentprof_slice_parent_idx;

DROP TABLE IF EXISTS _dev_agentprof_slice_parent_lookup;

CREATE TABLE _dev_agentprof_slice_parent_lookup AS
SELECT s.id, s.parent_id
FROM slice AS s
WHERE
  s.parent_id IS NOT NULL
  AND s.track_id IN (
    SELECT DISTINCT marker.track_id
    FROM slice AS marker
    JOIN dev_agentprof_capture_markers AS m ON m.slice_id = marker.id
  );

CREATE INDEX _dev_agentprof_slice_parent_idx ON _dev_agentprof_slice_parent_lookup (
  parent_id
);

-- Nearest enclosing capture assignment for slices on shared tracks.
CREATE PERFETTO TABLE dev_agentprof_slice_capture AS
WITH RECURSIVE
  captured(id, capture_id) AS (
    SELECT slice_id, capture_id FROM dev_agentprof_capture_markers
    UNION ALL
    SELECT s.id, c.capture_id
    FROM _dev_agentprof_slice_parent_lookup AS s
    JOIN captured AS c
      ON s.parent_id = c.id
    WHERE
      s.id NOT IN (SELECT slice_id FROM dev_agentprof_capture_markers)
  )
SELECT c.id, c.capture_id
FROM captured AS c
JOIN slice AS s
  ON s.id = c.id
WHERE
  s.category GLOB 'pi.*'
  OR s.category GLOB 'claude.*'
  OR s.category GLOB 'codex.*'
  OR s.category GLOB 'muse.*'
  OR s.category GLOB 'agentprof.*';

DROP INDEX _dev_agentprof_slice_parent_idx;

DROP TABLE _dev_agentprof_slice_parent_lookup;

-- All AgentProf slices normalized across Pi, Claude Code, Codex, and Muse.
CREATE PERFETTO TABLE dev_agentprof_slices AS
SELECT
  s.*,
  COALESCE(t.name, th.name || ' ' || th.tid, 'Thread ' || th.tid) AS track_name,
  m.upid,
  tt.utid,
  COALESCE(sc.capture_id, m.capture_id) AS capture_id,
  COALESCE(cap.label, SUBSTR(cap.recorded_id, 1, 8), 'Legacy capture') AS capture,
  COALESCE(
    cap.session_id,
    (
      SELECT SUBSTR(a.string_value, 9)
      FROM args AS a
      WHERE
        a.arg_set_id = p.arg_set_id
        AND a.key GLOB 'chrome.process_label*'
        AND a.string_value GLOB 'session:*'
      LIMIT 1
    ),
    'process ' || COALESCE(CAST(m.upid AS TEXT), 'unknown')
  ) AS session,
  COALESCE(
    CASE WHEN s.name = 'codemode' AND s.category = 'pi.tools' THEN 'script' END,
    COALESCE(
      EXTRACT_ARG(s.arg_set_id, 'debug.kind'),
      EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_event_kind')
    ),
    CASE
      WHEN (',' || s.category || ',') GLOB '*,pi.agent,*'
      AND s.name = 'prompt' THEN 'prompt'
      WHEN s.category = 'pi.agent'
      AND s.name = 'turn' THEN 'turn'
      WHEN s.category = 'pi.llm'
      AND s.name IN ('request', 'provider-request') THEN 'provider-request'
      WHEN s.category = 'pi.tools'
      AND (t.name IN ('tools', 'Tools') OR t.name GLOB 'tools.lane.*') THEN 'tool-execution'
      WHEN s.category = 'pi.llm'
      AND s.name GLOB 'assistant ttft=*' THEN 'assistant-message'
      ELSE 'other'
    END
  ) AS kind,
  (s.dur < 0
  OR COALESCE(
    COALESCE(
      EXTRACT_ARG(s.arg_set_id, 'debug.incomplete'),
      EXTRACT_ARG(s.arg_set_id, 'debug.pi_tracing_incomplete')
    ),
    0
  )
  OR COALESCE(
    COALESCE(
      EXTRACT_ARG(s.arg_set_id, 'debug.incomplete'),
      EXTRACT_ARG(s.arg_set_id, 'debug.pi_tracing_providerIncomplete')
    ),
    0
  )) AS incomplete
FROM slice AS s
JOIN track AS t
  ON t.id = s.track_id
LEFT JOIN dev_agentprof_track_process AS m
  ON m.track_id = t.id
LEFT JOIN thread_track AS tt
  ON tt.id = t.id
LEFT JOIN thread AS th
  ON th.utid = tt.utid
LEFT JOIN dev_agentprof_slice_capture AS sc
  ON sc.id = s.id
LEFT JOIN process AS p
  ON p.upid = m.upid
LEFT JOIN dev_agentprof_captures AS cap
  ON cap.capture_id = COALESCE(sc.capture_id, m.capture_id)
WHERE
  s.category GLOB 'pi.*'
  OR s.category GLOB 'claude.*'
  OR s.category GLOB 'codex.*'
  OR s.category GLOB 'muse.*'
  OR s.category GLOB 'agentprof.*';

-- Recorded harness, provider, model, effort, and context window spans.
CREATE PERFETTO TABLE dev_agentprof_configuration AS
SELECT
  capture_id,
  arg_set_id,
  COALESCE(
    COALESCE(
      EXTRACT_ARG(arg_set_id, 'debug.harness'),
      EXTRACT_ARG(arg_set_id, 'debug.agentprof_harness')
    ),
    'Not recorded'
  ) AS harness,
  COALESCE(
    COALESCE(
      EXTRACT_ARG(arg_set_id, 'debug.provider'),
      EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_provider')
    ),
    'Not recorded'
  ) AS provider,
  COALESCE(
    COALESCE(
      EXTRACT_ARG(arg_set_id, 'debug.model'),
      EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_model')
    ),
    'Not recorded'
  ) AS model,
  COALESCE(
    COALESCE(
      EXTRACT_ARG(arg_set_id, 'debug.effort'),
      EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_effort')
    ),
    'Not recorded'
  ) AS effort,
  EXTRACT_ARG(arg_set_id, 'debug.context_window_tokens') AS context_window_tokens
FROM dev_agentprof_slices
WHERE
  category IN (
    'pi.metadata',
    'claude.metadata',
    'codex.metadata',
    'muse.metadata',
    'agentprof.metadata'
  )
  AND (name IN ('tracing', 'tracing-start', 'run-configuration')
  OR name GLOB 'profile ([0-9]*)');

-- Distinct user/session labels attached to each capture.
CREATE PERFETTO TABLE dev_agentprof_session_labels AS
SELECT capture_id, JSON_GROUP_ARRAY(label) AS session_labels
FROM (
  SELECT DISTINCT c.capture_id, TRIM(a.string_value) AS label
  FROM dev_agentprof_configuration AS c
  JOIN args AS a USING (arg_set_id)
  WHERE
    a.flat_key = 'debug.session_labels'
    AND a.key GLOB 'debug.session_labels[[]*'
    AND TRIM(a.string_value) != ''
  ORDER BY
    c.capture_id,
    label
)
GROUP BY
  capture_id;

-- Summary row per recorded capture (before parent/subagent rollup).
CREATE PERFETTO TABLE dev_agentprof_capture_runs AS
WITH
  configuration AS (
    SELECT
      capture_id,
      GROUP_CONCAT(DISTINCT harness) AS harness,
      GROUP_CONCAT(DISTINCT provider) AS provider,
      GROUP_CONCAT(DISTINCT model) AS model,
      GROUP_CONCAT(DISTINCT effort) AS effort,
      MAX(context_window_tokens) AS context_window_tokens,
      COUNT(DISTINCT context_window_tokens) AS context_window_count
    FROM dev_agentprof_configuration
    GROUP BY
      capture_id
  ),
  per_track AS (
    SELECT p.capture_id, t.id, t.name, MAX(c.value) AS maximum
    FROM counter AS c
    JOIN dev_agentprof_counter_tracks AS t
      ON t.id = c.track_id
    JOIN dev_agentprof_track_process AS p
      ON p.track_id = t.id
    WHERE
      t.name IN (
        'llm.tokens.input',
        'llm.tokens.output',
        'llm.context.estimated_tokens'
      )
    GROUP BY
      p.capture_id,
      t.id,
      t.name
  ),
  tokens AS (
    SELECT
      capture_id,
      SUM(CASE WHEN name = 'llm.tokens.input' THEN maximum END) AS input_tokens,
      SUM(CASE WHEN name = 'llm.tokens.output' THEN maximum END) AS output_tokens,
      MAX(CASE WHEN name = 'llm.context.estimated_tokens' THEN maximum END) AS peak_context
    FROM per_track
    GROUP BY
      capture_id
  ),
  capture_peak AS (
    SELECT
      m.capture_id,
      MAX(EXTRACT_ARG(s.arg_set_id, 'debug.peak_context_tokens')) AS peak_context
    FROM dev_agentprof_capture_markers AS m
    JOIN slice AS s
      ON s.id = m.slice_id
    GROUP BY
      m.capture_id
  ),
  captures AS (
    SELECT
      capture_id,
      session,
      MIN(ts) AS start_ts,
      MAX(ts + MAX(dur, 0)) AS end_ts,
      SUM(kind = 'prompt') AS turns,
      SUM(kind = 'assistant-message') AS responses,
      SUM(kind = 'tool-execution') AS tools,
      SUM(incomplete) AS incomplete,
      (MAX(ts + MAX(dur, 0)) - MIN(ts)) / 1e6 AS duration_ms
    FROM dev_agentprof_slices
    GROUP BY
      capture_id,
      session
  )
SELECT
  s.*,
  COALESCE(c.label, SUBSTR(c.recorded_id, 1, 8), 'Legacy capture') AS capture,
  c.recorded_id,
  configuration.harness,
  configuration.provider,
  configuration.model,
  labels.session_labels,
  configuration.effort,
  configuration.context_window_tokens,
  tokens.input_tokens,
  tokens.output_tokens,
  COALESCE(capture_peak.peak_context, tokens.peak_context) AS peak_context,
  CASE
    WHEN configuration.context_window_count = 1
    AND configuration.context_window_tokens > 0 THEN CAST(COALESCE(
      capture_peak.peak_context,
      tokens.peak_context
    ) AS DOUBLE)
    / configuration.context_window_tokens
  END AS context_share
FROM captures AS s
LEFT JOIN dev_agentprof_captures AS c USING (capture_id)
LEFT JOIN dev_agentprof_session_labels AS labels USING (capture_id)
LEFT JOIN configuration USING (capture_id)
LEFT JOIN tokens USING (capture_id)
LEFT JOIN capture_peak USING (capture_id)
ORDER BY
  s.start_ts,
  s.capture_id;

-- Maximum recorded diagnostic counter values (dropped events, lane overflows).
CREATE PERFETTO VIEW dev_agentprof_capture_health AS
SELECT
  t.id AS track_id,
  t.capture_id,
  t.name AS metric_key,
  t.display_name AS metric,
  MAX(c.value) AS value
FROM counter AS c
JOIN dev_agentprof_counter_tracks AS t
  ON t.id = c.track_id
WHERE
  t.name IN ('tracing.droppedEvents', 'tracing.laneOverflows')
GROUP BY
  t.id,
  t.capture_id,
  t.name,
  t.display_name
ORDER BY
  t.id;

-- Per-capture coverage and health inventory (no raw prompt or tool payloads).
CREATE PERFETTO VIEW dev_agentprof_inventory AS
SELECT
  r.capture_id,
  r.session,
  r.capture,
  r.harness,
  r.provider,
  r.model,
  r.effort,
  r.context_window_tokens,
  r.duration_ms AS retained_extent_ms,
  r.turns AS prompts,
  r.responses,
  r.tools,
  r.incomplete,
  (
    SELECT COUNT(*)
    FROM dev_agentprof_slices AS m
    WHERE
      m.capture_id = r.capture_id
      AND m.kind = 'assistant-message'
      AND NOT m.incomplete
      AND CASE
        WHEN m.dur > 0 THEN m.dur
        ELSE COALESCE(
          EXTRACT_ARG(m.arg_set_id, 'debug.duration_ns'),
          EXTRACT_ARG(m.arg_set_id, 'debug.agentprof_stream_duration_ns')
        )
      END
      >= 0
  ) AS measured_responses,
  (
    SELECT COUNT(*)
    FROM dev_agentprof_slices AS m
    WHERE
      m.capture_id = r.capture_id
      AND m.kind = 'assistant-message'
      AND NOT m.incomplete
      AND COALESCE(
        EXTRACT_ARG(m.arg_set_id, 'debug.first_content_ns'),
        EXTRACT_ARG(m.arg_set_id, 'debug.agentprof_stream_first_content_ns')
      )
      >= 0
  ) AS first_content_samples,
  (
    SELECT COUNT(*)
    FROM dev_agentprof_slices AS m
    WHERE
      m.capture_id = r.capture_id
      AND m.kind = 'assistant-message'
      AND COALESCE(
        EXTRACT_ARG(m.arg_set_id, 'debug.output_tokens'),
        EXTRACT_ARG(m.arg_set_id, 'debug.agentprof_usage_output')
      ) IS NOT NULL
  ) AS output_usage_samples,
  (
    SELECT COUNT(*)
    FROM dev_agentprof_slices AS c
    WHERE
      c.capture_id = r.capture_id
      AND EXTRACT_ARG(c.arg_set_id, 'debug.context.version') = 1
  ) AS context_snapshots,
  (
    SELECT COUNT(DISTINCT t.name)
    FROM dev_agentprof_counter_tracks AS t
    WHERE
      t.capture_id = r.capture_id
      AND t.name IN ('runtime.rss', 'runtime.heap', 'runtime.cpu')
  ) AS runtime_metrics,
  (
    SELECT MAX(c.value)
    FROM counter AS c
    JOIN dev_agentprof_counter_tracks AS t
      ON t.id = c.track_id
    WHERE
      t.capture_id = r.capture_id
      AND t.name = 'tracing.droppedEvents'
  ) AS dropped_events,
  (
    SELECT MAX(c.value)
    FROM counter AS c
    JOIN dev_agentprof_counter_tracks AS t
      ON t.id = c.track_id
    WHERE
      t.capture_id = r.capture_id
      AND t.name = 'tracing.laneOverflows'
  ) AS lane_overflows,
  (
    SELECT MAX(c.value)
    FROM counter AS c
    JOIN dev_agentprof_counter_tracks AS t
      ON t.id = c.track_id
    WHERE
      t.capture_id = r.capture_id
      AND t.name = 'tracing.queueDepth'
  ) AS queue_depth_peak,
  (
    SELECT SUM(EXTRACT_ARG(s.arg_set_id, 'debug.unavailable_child_sessions'))
    FROM dev_agentprof_slices AS s
    WHERE
      s.capture_id = r.capture_id
      AND s.kind = 'capture'
  ) AS unavailable_children,
  (
    SELECT COUNT(DISTINCT COALESCE(t.machine_id, 0))
    FROM dev_agentprof_slices AS s
    JOIN track AS t
      ON t.id = s.track_id
    WHERE
      s.capture_id = r.capture_id
  ) AS machines,
  (
    SELECT COALESCE(SUM(value), 0)
    FROM stats
    WHERE
      name IN (
        'clock_sync_failure_no_path',
        'clock_sync_failure_undeferrable_packet_loss',
        'clock_sync_unrelatable_clock_domains',
        'trace_sorter_negative_timestamp_dropped',
        'invalid_clock_snapshots'
      )
  ) AS trace_clock_errors
FROM dev_agentprof_capture_runs AS r
ORDER BY
  r.start_ts,
  r.capture_id;
