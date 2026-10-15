-- SPDX-License-Identifier: Apache-2.0
WITH
  intervals AS (
    SELECT
      capture_id,
      message_start_ts AS ts,
      message_start_ts + message_ns AS end_ts,
      1 AS models,
      0 AS tools,
      0 AS scripts
    FROM agentprof_skill_messages
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
    FROM agentprof_skill_slices
    WHERE
      NOT incomplete
      AND dur > 0
      AND kind IN ('tool-execution', 'script', 'model-call')
  ),
  bounds AS (
    SELECT capture_id, MIN(ts) AS start_ts, MAX(end_ts) AS end_ts
    FROM (
      SELECT capture_id, start_ts AS ts, end_ts
      FROM agentprof_skill_selected_captures
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
    FROM agentprof_skill_messages AS m
    WHERE
      m.capture_id = r.capture_id
      AND NOT incomplete
      AND message_ns >= 0
  ) AS measured_responses,
  (
    SELECT COUNT(output_tokens)
    FROM agentprof_skill_messages AS m
    WHERE
      m.capture_id = r.capture_id
  ) AS output_usage_samples
FROM agentprof_skill_selected_captures AS r
JOIN bounds AS b USING (capture_id)
LEFT JOIN totals AS t USING (capture_id)
ORDER BY
  r.start_ts,
  r.capture_id
LIMIT 100;
