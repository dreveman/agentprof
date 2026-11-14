-- SPDX-License-Identifier: Apache-2.0

-- AgentProf interval-union occupancy, concurrency histograms, and 48-bin
-- session/capture sparklines.

INCLUDE PERFETTO MODULE dev.agentprof.captures;

INCLUDE PERFETTO MODULE dev.agentprof.models;

INCLUDE PERFETTO MODULE dev.agentprof.sessions;

-- Sweep interval boundaries together across the recording so coincident
-- starts/ends never inflate concurrency. Only completed measured spans count.
CREATE PERFETTO TABLE dev_agentprof_activity AS
WITH
  intervals AS (
    SELECT ts, ts + dur AS end_ts, 1 AS tools, 0 AS models, 0 AS scripts
    FROM dev_agentprof_slices
    WHERE
      kind = 'tool-execution'
      AND NOT incomplete
      AND dur > 0
    UNION ALL
    SELECT message_start_ts, message_start_ts + message_ns, 0, 1, 0
    FROM dev_agentprof_messages
    WHERE
      message_ns > 0
      AND NOT incomplete
    UNION ALL
    SELECT ts, ts + dur, 0, 0, 1
    FROM dev_agentprof_slices
    WHERE
      kind IN ('script', 'model-call')
      AND NOT incomplete
      AND dur > 0
  ),
  boundaries AS (
    SELECT ts, tools, models, scripts FROM intervals
    UNION ALL
    SELECT end_ts, -tools, -models, -scripts FROM intervals
  ),
  deltas AS (
    SELECT
      ts,
      SUM(tools) AS tools,
      SUM(models) AS models,
      SUM(scripts) AS scripts
    FROM boundaries
    GROUP BY
      ts
  )
SELECT
  ts,
  LEAD(ts) OVER (ORDER BY ts) - ts AS dur,
  SUM(tools) OVER (ORDER BY ts) AS tools,
  SUM(models) OVER (ORDER BY ts) AS models,
  SUM(scripts) OVER (ORDER BY ts) AS scripts
FROM deltas;

-- Trace-wide recording counts, machine count, and clock-sync error total.
CREATE PERFETTO VIEW dev_agentprof_recording_summary AS
SELECT
  (SELECT COUNT(DISTINCT root_capture_id) FROM dev_agentprof_capture_hierarchy) AS sessions,
  (
    SELECT SUM(capture_id != root_capture_id)
    FROM dev_agentprof_capture_hierarchy
  ) AS subagents,
  (
    SELECT COUNT(*) = 1 AND MIN(model IS NOT NULL AND model != '')
    FROM (
      SELECT DISTINCT
        COALESCE(
          EXTRACT_ARG(arg_set_id, 'debug.provider'),
          EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_provider')
        ) AS provider,
        COALESCE(
          EXTRACT_ARG(arg_set_id, 'debug.model'),
          EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_model')
        ) AS model
      FROM dev_agentprof_slices
      WHERE
        kind = 'assistant-message'
        OR (category IN (
          'pi.metadata',
          'claude.metadata',
          'codex.metadata',
          'muse.metadata',
          'agentprof.metadata'
        )
        AND (name IN ('tracing', 'tracing-start', 'run-configuration')
        OR name GLOB 'profile ([0-9]*)'))
    )
  ) AS single_model,
  SUM(kind = 'prompt') AS turns,
  SUM(kind = 'assistant-message') AS responses,
  SUM(kind = 'script') AS scripts,
  SUM(kind = 'tool-execution') AS tools,
  SUM(incomplete) AS incomplete,
  SUM(
    CASE
      WHEN kind = 'capture' THEN COALESCE(
        EXTRACT_ARG(arg_set_id, 'debug.unavailable_child_sessions'),
        0
      )
      ELSE 0
    END
  ) AS unavailable_children,
  (MAX(ts + MAX(dur, 0)) - MIN(ts)) / 1e6 AS duration_ms,
  (
    SELECT COUNT(DISTINCT COALESCE(t.machine_id, 0))
    FROM track AS t
    JOIN dev_agentprof_track_process AS p
      ON p.track_id = t.id
    WHERE
      p.capture_id IN (SELECT capture_id FROM dev_agentprof_slices)
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
  ) AS clock_errors
FROM dev_agentprof_slices;

-- Trace-wide headline metrics for the Summary tab.
CREATE PERFETTO VIEW dev_agentprof_recording_headline AS
SELECT
  (
    SELECT SUM(output_tokens) * 1e9 / SUM(message_ns)
    FROM dev_agentprof_messages
    WHERE
      output_tokens IS NOT NULL
      AND message_ns > 0
      AND NOT incomplete
  ) AS output_tokens_per_s,
  (
    SELECT SUM(dur) / 1e6
    FROM dev_agentprof_activity
    WHERE
      dur > 0
      AND models > 0
  ) AS model_busy_ms,
  (SELECT MAX(models) FROM dev_agentprof_activity WHERE dur > 0 AND models > 0) AS peak_model_responses,
  (SELECT (MAX(ts + MAX(dur, 0)) - MIN(ts)) / 1e6 FROM dev_agentprof_slices) AS wall_window_ms;

-- Trace-wide activity split and tool concurrency summary.
CREATE PERFETTO VIEW dev_agentprof_activity_summary AS
SELECT
  SUM(CASE WHEN tools > 0 AND models = 0 THEN dur ELSE 0 END) / 1e6 AS tools_only_ms,
  SUM(CASE WHEN models > 0 AND tools = 0 THEN dur ELSE 0 END) / 1e6 AS models_only_ms,
  SUM(CASE WHEN models > 0 AND tools > 0 THEN dur ELSE 0 END) / 1e6 AS overlap_ms,
  SUM(CASE WHEN scripts > 0 AND tools = 0 AND models = 0 THEN dur ELSE 0 END)
  / 1e6 AS scripts_only_ms,
  MAX(tools) AS peak_tools,
  SUM(CASE WHEN tools > 1 THEN dur ELSE 0 END) / 1e6 AS parallel_ms,
  SUM(CASE WHEN tools > 0 THEN dur ELSE 0 END) / 1e6 AS tool_active_ms
FROM dev_agentprof_activity
WHERE
  dur > 0;

-- Peak concurrent completed tools across 40 equal windows of measured activity.
CREATE PERFETTO VIEW dev_agentprof_tool_concurrency_bins AS
WITH RECURSIVE
  bins(n) AS (
    SELECT 0
    UNION ALL
    SELECT n + 1 FROM bins WHERE n < 39
  ),
  bounds AS (
    SELECT MIN(ts) AS start_ts, MAX(ts + dur) AS end_ts
    FROM dev_agentprof_activity
    WHERE
      dur > 0
  ),
  windows AS (
    SELECT
      n,
      start_ts + (end_ts - start_ts) * n / 40 AS ts,
      start_ts + (end_ts - start_ts) * (n + 1) / 40 AS end_ts,
      start_ts
    FROM bins
    CROSS JOIN bounds
  )
SELECT
  w.n,
  (w.ts - w.start_ts) / 1e6 AS offset_ms,
  COALESCE(MAX(a.tools), 0) AS tools
FROM windows AS w
LEFT JOIN dev_agentprof_activity AS a
  ON a.ts < w.end_ts
  AND a.ts + a.dur > w.ts
WHERE
  w.ts IS NOT NULL
GROUP BY
  w.n
ORDER BY
  w.n;

-- Per-capture interval-union occupancy, unattributed gap time, tool concurrency,
-- and counter peaks for investigation and run-comparison workflows.
CREATE PERFETTO VIEW dev_agentprof_capture_occupancy AS
WITH
  intervals AS (
    SELECT
      capture_id,
      message_start_ts AS ts,
      message_start_ts + message_ns AS end_ts,
      1 AS models,
      0 AS tools,
      0 AS scripts
    FROM dev_agentprof_messages
    WHERE
      NOT incomplete
      AND message_ns > 0
    UNION ALL
    SELECT
      capture_id,
      ts,
      ts + dur,
      0,
      kind = 'tool-execution',
      kind IN ('script', 'model-call')
    FROM dev_agentprof_slices
    WHERE
      NOT incomplete
      AND dur > 0
      AND kind IN ('tool-execution', 'script', 'model-call')
  ),
  bounds AS (
    SELECT capture_id, MIN(ts) AS start_ts, MAX(end_ts) AS end_ts
    FROM (
      SELECT capture_id, start_ts AS ts, end_ts FROM dev_agentprof_capture_runs
      UNION ALL
      SELECT capture_id, ts, end_ts FROM intervals
    )
    GROUP BY
      capture_id
  ),
  boundaries AS (
    SELECT capture_id, ts, models, tools, scripts FROM intervals
    UNION ALL
    SELECT capture_id, end_ts, -models, -tools, -scripts FROM intervals
  ),
  deltas AS (
    SELECT
      capture_id,
      ts,
      SUM(models) AS models,
      SUM(tools) AS tools,
      SUM(scripts) AS scripts
    FROM boundaries
    GROUP BY
      capture_id,
      ts
  ),
  activity AS (
    SELECT
      capture_id,
      ts,
      LEAD(ts) OVER (PARTITION BY capture_id ORDER BY ts) - ts AS dur,
      SUM(models) OVER (PARTITION BY capture_id ORDER BY ts) AS models,
      SUM(tools) OVER (PARTITION BY capture_id ORDER BY ts) AS tools,
      SUM(scripts) OVER (PARTITION BY capture_id ORDER BY ts) AS scripts
    FROM deltas
  ),
  totals AS (
    SELECT
      capture_id,
      SUM(CASE WHEN models > 0 AND tools = 0 THEN dur ELSE 0 END) AS model_only_ns,
      SUM(CASE WHEN tools > 0 AND models = 0 THEN dur ELSE 0 END) AS tool_only_ns,
      SUM(CASE WHEN models > 0 AND tools > 0 THEN dur ELSE 0 END) AS overlap_ns,
      SUM(
        CASE WHEN scripts > 0 AND models = 0 AND tools = 0 THEN dur ELSE 0 END
      ) AS script_only_ns,
      SUM(CASE WHEN tools > 1 THEN dur ELSE 0 END) AS parallel_tool_ns,
      MAX(tools) AS peak_tools
    FROM activity
    WHERE
      dur > 0
    GROUP BY
      capture_id
  )
SELECT
  r.capture_id,
  r.session,
  r.harness,
  r.provider,
  r.model,
  r.effort,
  r.turns AS prompts,
  r.responses,
  r.tools,
  r.incomplete,
  (b.end_ts - b.start_ts) / 1e6 AS observed_extent_ms,
  COALESCE(t.model_only_ns, 0) / 1e6 AS model_only_ms,
  COALESCE(t.tool_only_ns, 0) / 1e6 AS tool_only_ms,
  COALESCE(t.overlap_ns, 0) / 1e6 AS overlap_ms,
  COALESCE(t.script_only_ns, 0) / 1e6 AS script_only_ms,
  MAX(
    0,
    b.end_ts - b.start_ts - COALESCE(t.model_only_ns, 0)
    - COALESCE(t.tool_only_ns, 0)
    - COALESCE(t.overlap_ns, 0)
    - COALESCE(t.script_only_ns, 0)
  )
  / 1e6 AS unattributed_ms,
  COALESCE(t.parallel_tool_ns, 0) / 1e6 AS parallel_tool_ms,
  COALESCE(t.peak_tools, 0) AS peak_tools,
  r.input_tokens AS reported_input_counter_peak,
  r.output_tokens AS reported_output_counter_peak,
  r.peak_context,
  r.context_window_tokens,
  r.context_share,
  (
    SELECT COUNT(*)
    FROM dev_agentprof_messages AS m
    WHERE
      m.capture_id = r.capture_id
      AND NOT m.incomplete
      AND m.message_ns >= 0
  ) AS measured_responses,
  (
    SELECT COUNT(m.output_tokens)
    FROM dev_agentprof_messages AS m
    WHERE
      m.capture_id = r.capture_id
  ) AS output_usage_samples
FROM dev_agentprof_capture_runs AS r
JOIN bounds AS b USING (capture_id)
LEFT JOIN totals AS t USING (capture_id)
ORDER BY
  r.start_ts,
  r.capture_id;

-- 48-bin busy fraction per root session (including subagent captures).
CREATE PERFETTO VIEW dev_agentprof_session_activity_bins AS
WITH RECURSIVE
  bins(n) AS (
    SELECT 0
    UNION ALL
    SELECT n + 1 FROM bins WHERE n < 47
  ),
  bounds AS (
    SELECT
      h.root_capture_id AS capture_id,
      MIN(r.start_ts) AS start_ts,
      MAX(r.end_ts) AS end_ts
    FROM dev_agentprof_capture_runs AS r
    JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
    GROUP BY
      h.root_capture_id
  ),
  intervals AS (
    SELECT
      h.root_capture_id AS capture_id,
      m.message_start_ts AS ts,
      m.message_start_ts + m.message_ns AS end_ts
    FROM dev_agentprof_messages AS m
    JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
    WHERE
      m.message_ns > 0
      AND NOT m.incomplete
    UNION ALL
    SELECT h.root_capture_id, s.ts, s.ts + s.dur
    FROM dev_agentprof_slices AS s
    JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
    WHERE
      s.kind IN ('tool-execution', 'script', 'model-call')
      AND s.dur > 0
      AND NOT s.incomplete
  ),
  measured AS (SELECT DISTINCT capture_id FROM intervals),
  boundaries AS (
    SELECT capture_id, ts, 1 AS delta FROM intervals
    UNION ALL
    SELECT capture_id, end_ts, -1 FROM intervals
  ),
  deltas AS (
    SELECT capture_id, ts, SUM(delta) AS delta
    FROM boundaries
    GROUP BY
      capture_id,
      ts
  ),
  segments AS (
    SELECT
      capture_id,
      ts,
      LEAD(ts) OVER (PARTITION BY capture_id ORDER BY ts) AS end_ts,
      SUM(delta) OVER (PARTITION BY capture_id ORDER BY ts) AS active
    FROM deltas
  ),
  ranges AS (
    SELECT
      b.capture_id,
      bins.n AS bin,
      b.start_ts + (b.end_ts - b.start_ts) * bins.n / 48 AS ts,
      b.start_ts + (b.end_ts - b.start_ts) * (bins.n + 1) / 48 AS end_ts
    FROM bounds AS b
    CROSS JOIN bins
  )
SELECT
  r.capture_id,
  r.bin,
  CASE
    WHEN m.capture_id IS NULL
    OR r.end_ts <= r.ts THEN NULL
    ELSE MIN(
      1.0,
      COALESCE(SUM(MAX(0, MIN(s.end_ts, r.end_ts) - MAX(s.ts, r.ts))), 0) * 1.0
      / (r.end_ts - r.ts)
    )
  END AS busy_fraction
FROM ranges AS r
LEFT JOIN measured AS m USING (capture_id)
LEFT JOIN segments AS s
  ON s.capture_id = r.capture_id
  AND s.active > 0
  AND s.end_ts > r.ts
  AND s.ts < r.end_ts
GROUP BY
  r.capture_id,
  r.bin
ORDER BY
  r.capture_id,
  r.bin;

-- 48-bin busy fraction per individual capture.
CREATE PERFETTO VIEW dev_agentprof_capture_activity_bins AS
WITH RECURSIVE
  bins(n) AS (
    SELECT 0
    UNION ALL
    SELECT n + 1 FROM bins WHERE n < 47
  ),
  bounds AS (
    SELECT r.capture_id, MIN(r.start_ts) AS start_ts, MAX(r.end_ts) AS end_ts
    FROM dev_agentprof_capture_runs AS r
    GROUP BY
      r.capture_id
  ),
  intervals AS (
    SELECT
      m.capture_id,
      m.message_start_ts AS ts,
      m.message_start_ts + m.message_ns AS end_ts
    FROM dev_agentprof_messages AS m
    WHERE
      m.message_ns > 0
      AND NOT m.incomplete
    UNION ALL
    SELECT s.capture_id, s.ts, s.ts + s.dur
    FROM dev_agentprof_slices AS s
    WHERE
      s.kind IN ('tool-execution', 'script', 'model-call')
      AND s.dur > 0
      AND NOT s.incomplete
  ),
  measured AS (SELECT DISTINCT capture_id FROM intervals),
  boundaries AS (
    SELECT capture_id, ts, 1 AS delta FROM intervals
    UNION ALL
    SELECT capture_id, end_ts, -1 FROM intervals
  ),
  deltas AS (
    SELECT capture_id, ts, SUM(delta) AS delta
    FROM boundaries
    GROUP BY
      capture_id,
      ts
  ),
  segments AS (
    SELECT
      capture_id,
      ts,
      LEAD(ts) OVER (PARTITION BY capture_id ORDER BY ts) AS end_ts,
      SUM(delta) OVER (PARTITION BY capture_id ORDER BY ts) AS active
    FROM deltas
  ),
  ranges AS (
    SELECT
      b.capture_id,
      bins.n AS bin,
      b.start_ts + (b.end_ts - b.start_ts) * bins.n / 48 AS ts,
      b.start_ts + (b.end_ts - b.start_ts) * (bins.n + 1) / 48 AS end_ts
    FROM bounds AS b
    CROSS JOIN bins
  )
SELECT
  r.capture_id,
  r.bin,
  CASE
    WHEN m.capture_id IS NULL
    OR r.end_ts <= r.ts THEN NULL
    ELSE MIN(
      1.0,
      COALESCE(SUM(MAX(0, MIN(s.end_ts, r.end_ts) - MAX(s.ts, r.ts))), 0) * 1.0
      / (r.end_ts - r.ts)
    )
  END AS busy_fraction
FROM ranges AS r
LEFT JOIN measured AS m USING (capture_id)
LEFT JOIN segments AS s
  ON s.capture_id = r.capture_id
  AND s.active > 0
  AND s.end_ts > r.ts
  AND s.ts < r.end_ts
GROUP BY
  r.capture_id,
  r.bin
ORDER BY
  r.capture_id,
  r.bin;
