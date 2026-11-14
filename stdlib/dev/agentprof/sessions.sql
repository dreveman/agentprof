-- SPDX-License-Identifier: Apache-2.0

-- AgentProf parent/subagent capture hierarchy, workspace track layout,
-- delegation overlap, child launches, and session rollup views.

INCLUDE PERFETTO MODULE dev.agentprof.captures;

INCLUDE PERFETTO MODULE dev.agentprof.models;

CREATE PERFETTO TABLE _dev_agentprof_session_captures AS
SELECT
  capture_id,
  session,
  MIN(ts) AS start_ts,
  MAX(ts + MAX(dur, 0)) AS end_ts,
  MAX(
    COALESCE(
      EXTRACT_ARG(arg_set_id, 'debug.parent_session'),
      EXTRACT_ARG(arg_set_id, 'debug.parentSession')
    )
  ) AS parent_session,
  MAX(
    COALESCE(
      EXTRACT_ARG(arg_set_id, 'debug.parent_session'),
      EXTRACT_ARG(arg_set_id, 'debug.parentSession')
    ) IS NOT NULL
    OR COALESCE(
      EXTRACT_ARG(arg_set_id, 'debug.child_role'),
      EXTRACT_ARG(arg_set_id, 'debug.childRole')
    ) IS NOT NULL
  ) AS is_subagent
FROM dev_agentprof_slices
GROUP BY
  capture_id,
  session;

CREATE PERFETTO TABLE _dev_agentprof_capture_parents AS
WITH
  candidates AS (
    SELECT DISTINCT
      c.capture_id,
      p.capture_id AS parent_capture_id,
      0 AS priority
    FROM flow AS f
    JOIN dev_agentprof_slices AS p ON p.id = f.slice_out
    JOIN dev_agentprof_slices AS c ON c.id = f.slice_in
    WHERE
      p.kind = 'tool-execution'
      AND c.name = 'prompt-input'
      AND p.capture_id != c.capture_id
    UNION
    SELECT c.capture_id, p.capture_id, 1
    FROM _dev_agentprof_session_captures AS c
    JOIN dev_agentprof_slices AS launch
      ON COALESCE(
        EXTRACT_ARG(launch.arg_set_id, 'debug.child_session'),
        EXTRACT_ARG(launch.arg_set_id, 'debug.childSession')
      )
      = c.session
    JOIN _dev_agentprof_session_captures AS p
      ON p.capture_id = launch.capture_id
    WHERE
      c.capture_id != p.capture_id
      AND (c.parent_session IS NULL OR c.parent_session = p.session)
      AND c.start_ts BETWEEN p.start_ts AND p.end_ts
    UNION
    SELECT c.capture_id, p.capture_id, 2
    FROM _dev_agentprof_session_captures AS c
    JOIN _dev_agentprof_session_captures AS p ON p.session = c.parent_session
    WHERE
      c.capture_id != p.capture_id
      AND c.start_ts BETWEEN p.start_ts AND p.end_ts
  ),
  preferred AS (
    SELECT *, MIN(priority) OVER (PARTITION BY capture_id) AS best
    FROM candidates
  )
SELECT capture_id, MIN(parent_capture_id) AS parent_capture_id
FROM preferred
WHERE
  priority = best
GROUP BY
  capture_id
HAVING
  COUNT(DISTINCT parent_capture_id) = 1;

-- Resolved parent and root capture hierarchy (cycles and ambiguity stay roots).
CREATE PERFETTO TABLE dev_agentprof_capture_hierarchy AS
WITH RECURSIVE
  ancestors(capture_id, ancestor_id) AS (
    SELECT capture_id, capture_id FROM _dev_agentprof_session_captures
    UNION
    SELECT a.capture_id, p.parent_capture_id
    FROM ancestors AS a
    JOIN _dev_agentprof_capture_parents AS p
      ON p.capture_id = a.ancestor_id
  ),
  roots AS (
    SELECT a.capture_id, MIN(a.ancestor_id) AS root_capture_id
    FROM ancestors AS a
    LEFT JOIN _dev_agentprof_capture_parents AS p
      ON p.capture_id = a.ancestor_id
    WHERE
      p.capture_id IS NULL
    GROUP BY
      a.capture_id
  )
SELECT
  c.capture_id,
  COALESCE(r.root_capture_id, c.capture_id) AS root_capture_id,
  p.parent_capture_id,
  COALESCE(c.is_subagent, 0)
  OR p.parent_capture_id IS NOT NULL AS is_subagent
FROM _dev_agentprof_session_captures AS c
LEFT JOIN roots AS r USING (capture_id)
LEFT JOIN _dev_agentprof_capture_parents AS p USING (capture_id);

-- Track grouping and process-sharing metadata for the Agent Profiler workspace.
CREATE PERFETTO VIEW dev_agentprof_tracks AS
WITH
  captures AS (
    SELECT
      capture_id,
      session,
      MIN(upid) AS upid,
      MAX(h.is_subagent) AS is_subagent
    FROM dev_agentprof_slices
    JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
    GROUP BY
      capture_id,
      session
  ),
  processes AS (
    SELECT
      upid,
      COUNT(DISTINCT capture_id) AS captures,
      COUNT(DISTINCT session) AS sessions,
      MIN(is_subagent) AS all_subagents
    FROM captures
    GROUP BY
      upid
  ),
  sessions AS (
    SELECT session, COUNT(DISTINCT upid) AS processes
    FROM captures
    GROUP BY
      session
  )
SELECT
  s.track_id,
  s.capture_id,
  s.upid,
  s.utid,
  s.session,
  s.capture,
  c.label AS capture_label,
  s.track_name,
  COALESCE(p.captures, 0) AS process_captures,
  h.is_subagent,
  COALESCE(p.all_subagents, 0) AS all_subagents,
  (p.sessions = 1 AND a.processes = 1) AS single_agent
FROM dev_agentprof_slices AS s
JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
LEFT JOIN processes AS p USING (upid)
LEFT JOIN sessions AS a USING (session)
LEFT JOIN dev_agentprof_captures AS c
  ON c.capture_id = s.capture_id
GROUP BY
  s.track_id,
  s.capture_id
ORDER BY
  s.upid,
  s.capture_id,
  s.track_id;

-- Capture hierarchy with retained bounds and parent-child extent overlap.
CREATE PERFETTO VIEW dev_agentprof_delegation AS
SELECT
  c.capture_id,
  h.root_capture_id,
  h.parent_capture_id,
  h.is_subagent,
  c.harness,
  c.start_ts,
  c.end_ts,
  c.duration_ms AS retained_extent_ms,
  p.start_ts AS parent_start_ts,
  p.end_ts AS parent_end_ts,
  CASE
    WHEN h.parent_capture_id IS NOT NULL THEN MAX(
      0,
      MIN(c.end_ts, p.end_ts) - MAX(c.start_ts, p.start_ts)
    )
    / 1e6
  END AS parent_child_extent_overlap_ms
FROM dev_agentprof_capture_runs AS c
JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
LEFT JOIN dev_agentprof_capture_runs AS p
  ON p.capture_id = h.parent_capture_id
ORDER BY
  c.start_ts,
  c.capture_id;

-- Recorded child-agent / delegation launch spans.
CREATE PERFETTO VIEW dev_agentprof_child_launches AS
SELECT
  id,
  capture_id,
  session,
  ts,
  dur,
  name,
  incomplete,
  dur / 1e6 AS launch_duration_ms,
  CASE WHEN NOT incomplete AND dur >= 0 THEN dur / 1e6 END AS launch_lifecycle_ms,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.child_session'),
    EXTRACT_ARG(arg_set_id, 'debug.childSession')
  ) AS child_session,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.subagent_type'),
    EXTRACT_ARG(arg_set_id, 'debug.subagentType'),
    EXTRACT_ARG(arg_set_id, 'debug.child_role'),
    EXTRACT_ARG(arg_set_id, 'debug.childRole'),
    EXTRACT_ARG(arg_set_id, 'debug.role')
  ) AS child_role,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.parent_session'),
    EXTRACT_ARG(arg_set_id, 'debug.parentSession')
  ) AS parent_session,
  EXTRACT_ARG(arg_set_id, 'debug.correlation') AS correlation
FROM dev_agentprof_slices
WHERE
  category = 'pi.workflow'
  OR EXTRACT_ARG(arg_set_id, 'debug.delegation') = 1
  OR EXTRACT_ARG(arg_set_id, 'debug.child_session') IS NOT NULL
  OR EXTRACT_ARG(arg_set_id, 'debug.childSession') IS NOT NULL
ORDER BY
  ts,
  id;

-- Root-session rollup (including subagent captures) for the Summary Sessions table.
CREATE PERFETTO VIEW dev_agentprof_root_sessions AS
WITH
  totals AS (
    SELECT
      h.root_capture_id AS capture_id,
      MIN(r.start_ts) AS start_ts,
      (MAX(r.end_ts) - MIN(r.start_ts)) / 1e6 AS duration_ms,
      SUM(r.turns) AS turns,
      SUM(r.responses) AS responses,
      SUM(r.tools) AS tools,
      SUM(r.incomplete) AS incomplete,
      SUM(r.input_tokens) AS input_tokens,
      SUM(r.output_tokens) AS output_tokens,
      MAX(r.peak_context) AS peak_context,
      MAX(r.context_window_tokens) AS context_window_tokens,
      MAX(r.context_share) AS context_share,
      COUNT(*) - 1 AS subagents
    FROM dev_agentprof_capture_runs AS r
    JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
    GROUP BY
      h.root_capture_id
  ),
  configuration AS (
    SELECT
      h.root_capture_id AS capture_id,
      GROUP_CONCAT(DISTINCT COALESCE(c.harness, 'Not recorded')) AS harness,
      GROUP_CONCAT(DISTINCT COALESCE(c.provider, 'Not recorded')) AS provider,
      GROUP_CONCAT(DISTINCT COALESCE(c.model, 'Not recorded')) AS model,
      JSON_GROUP_ARRAY(DISTINCT
        JSON_OBJECT('provider', c.provider, 'model', c.model)
      ) AS model_identities,
      GROUP_CONCAT(DISTINCT COALESCE(c.effort, 'Not recorded')) AS effort
    FROM dev_agentprof_capture_hierarchy AS h
    LEFT JOIN dev_agentprof_configuration AS c USING (capture_id)
    WHERE
      h.capture_id = h.root_capture_id
    GROUP BY
      h.root_capture_id
  ),
  prompts AS (
    SELECT
      capture_id,
      id AS prompt_id,
      SUBSTR(EXTRACT_ARG(arg_set_id, 'debug.text'), 1, 2048) AS prompt_text,
      ROW_NUMBER() OVER (PARTITION BY capture_id ORDER BY ts, id) AS prompt_number
    FROM dev_agentprof_slices
    WHERE
      name = 'prompt'
      AND TRIM(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.text'), '')) != ''
  ),
  token_rates AS (
    SELECT
      h.root_capture_id AS capture_id,
      SUM(m.output_tokens) * 1e9 / SUM(m.message_ns) AS tokens_per_s
    FROM dev_agentprof_messages AS m
    JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
    WHERE
      m.output_tokens IS NOT NULL
      AND m.message_ns > 0
      AND NOT m.incomplete
    GROUP BY
      h.root_capture_id
  ),
  model_intervals AS (
    SELECT
      h.root_capture_id AS capture_id,
      m.message_start_ts AS ts,
      m.message_start_ts + m.message_ns AS end_ts
    FROM dev_agentprof_messages AS m
    JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
    WHERE
      m.message_ns > 0
      AND NOT m.incomplete
  ),
  model_boundaries AS (
    SELECT capture_id, ts, 1 AS delta FROM model_intervals
    UNION ALL
    SELECT capture_id, end_ts, -1 FROM model_intervals
  ),
  model_deltas AS (
    SELECT capture_id, ts, SUM(delta) AS delta
    FROM model_boundaries
    GROUP BY
      capture_id,
      ts
  ),
  model_activity AS (
    SELECT
      capture_id,
      LEAD(ts) OVER (PARTITION BY capture_id ORDER BY ts) - ts AS dur,
      SUM(delta) OVER (PARTITION BY capture_id ORDER BY ts) AS active
    FROM model_deltas
  ),
  model_busy AS (
    SELECT
      capture_id,
      SUM(CASE WHEN active > 0 AND dur > 0 THEN dur END) / 1e6 AS model_busy_ms,
      MAX(CASE WHEN active > 0 AND dur > 0 THEN active END) AS peak_model_responses
    FROM model_activity
    GROUP BY
      capture_id
  )
SELECT
  t.*,
  r.session,
  r.capture,
  r.recorded_id,
  p.prompt_id,
  p.prompt_text,
  token_rates.tokens_per_s,
  model_busy.model_busy_ms,
  model_busy.peak_model_responses,
  c.harness,
  c.provider,
  c.model,
  c.model_identities,
  c.effort,
  r.session_labels
FROM totals AS t
JOIN dev_agentprof_capture_runs AS r USING (capture_id)
JOIN configuration AS c USING (capture_id)
LEFT JOIN prompts AS p
  ON p.capture_id = t.capture_id
  AND p.prompt_number = 1
LEFT JOIN token_rates USING (capture_id)
LEFT JOIN model_busy USING (capture_id)
ORDER BY
  t.start_ts,
  t.capture_id;

-- Per-capture session row (roots and subagents) for the Sessions tab.
CREATE PERFETTO VIEW dev_agentprof_session_details AS
WITH
  roles AS (
    SELECT
      capture_id,
      MAX(
        COALESCE(
          EXTRACT_ARG(arg_set_id, 'debug.child_role'),
          EXTRACT_ARG(arg_set_id, 'debug.childRole')
        )
      ) AS child_role,
      MAX(
        COALESCE(
          EXTRACT_ARG(arg_set_id, 'debug.subagent_type'),
          EXTRACT_ARG(arg_set_id, 'debug.subagentType')
        )
      ) AS subagent_type
    FROM dev_agentprof_slices
    GROUP BY
      capture_id
  ),
  configuration AS (
    SELECT
      capture_id,
      JSON_GROUP_ARRAY(DISTINCT
        JSON_OBJECT('provider', provider, 'model', model)
      ) AS model_identities
    FROM dev_agentprof_configuration
    GROUP BY
      capture_id
  ),
  prompts AS (
    SELECT
      capture_id,
      id AS prompt_id,
      SUBSTR(EXTRACT_ARG(arg_set_id, 'debug.text'), 1, 2048) AS prompt_text,
      ROW_NUMBER() OVER (PARTITION BY capture_id ORDER BY ts, id) AS prompt_number
    FROM dev_agentprof_slices
    WHERE
      name = 'prompt'
      AND TRIM(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.text'), '')) != ''
  ),
  token_rates AS (
    SELECT
      capture_id,
      SUM(output_tokens) * 1e9 / SUM(message_ns) AS tokens_per_s
    FROM dev_agentprof_messages
    WHERE
      output_tokens IS NOT NULL
      AND message_ns > 0
      AND NOT incomplete
    GROUP BY
      capture_id
  ),
  model_intervals AS (
    SELECT
      capture_id,
      message_start_ts AS ts,
      message_start_ts + message_ns AS end_ts
    FROM dev_agentprof_messages
    WHERE
      message_ns > 0
      AND NOT incomplete
  ),
  model_boundaries AS (
    SELECT capture_id, ts, 1 AS delta FROM model_intervals
    UNION ALL
    SELECT capture_id, end_ts, -1 FROM model_intervals
  ),
  model_deltas AS (
    SELECT capture_id, ts, SUM(delta) AS delta
    FROM model_boundaries
    GROUP BY
      capture_id,
      ts
  ),
  model_activity AS (
    SELECT
      capture_id,
      LEAD(ts) OVER (PARTITION BY capture_id ORDER BY ts) - ts AS dur,
      SUM(delta) OVER (PARTITION BY capture_id ORDER BY ts) AS active
    FROM model_deltas
  ),
  model_busy AS (
    SELECT
      capture_id,
      SUM(CASE WHEN active > 0 AND dur > 0 THEN dur END) / 1e6 AS model_busy_ms,
      MAX(CASE WHEN active > 0 AND dur > 0 THEN active END) AS peak_model_responses
    FROM model_activity
    GROUP BY
      capture_id
  )
SELECT
  s.capture_id,
  h.root_capture_id,
  h.parent_capture_id,
  s.session,
  s.capture,
  s.recorded_id,
  p.prompt_id,
  p.prompt_text,
  h.is_subagent,
  CASE
    WHEN h.is_subagent = 0 THEN 'Primary'
    WHEN NULLIF(r.subagent_type, '') IS NOT NULL THEN 'Subagent · '
    || r.subagent_type
    ELSE 'Subagent'
  END AS role,
  s.harness,
  s.provider,
  s.model,
  c.model_identities,
  s.effort,
  s.session_labels,
  s.input_tokens,
  s.output_tokens,
  s.peak_context,
  s.context_window_tokens,
  s.context_share,
  token_rates.tokens_per_s,
  model_busy.model_busy_ms,
  model_busy.peak_model_responses,
  s.duration_ms,
  s.turns,
  s.responses,
  s.tools,
  s.incomplete
FROM dev_agentprof_capture_runs AS s
JOIN dev_agentprof_capture_hierarchy AS h USING (capture_id)
LEFT JOIN configuration AS c USING (capture_id)
LEFT JOIN roles AS r USING (capture_id)
LEFT JOIN prompts AS p
  ON p.capture_id = s.capture_id
  AND p.prompt_number = 1
LEFT JOIN token_rates USING (capture_id)
LEFT JOIN model_busy USING (capture_id)
ORDER BY
  s.start_ts,
  s.capture_id;
