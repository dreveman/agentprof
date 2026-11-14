-- SPDX-License-Identifier: Apache-2.0

-- AgentProf prompt-based user-turn attribution, per-turn interval occupancy,
-- unassigned-work accounting, and expandable per-turn event waterfalls.

INCLUDE PERFETTO MODULE dev.agentprof.captures;

INCLUDE PERFETTO MODULE dev.agentprof.models;

INCLUDE PERFETTO MODULE dev.agentprof.tools;

DROP TABLE IF EXISTS dev_agentprof_turns;

DROP TABLE IF EXISTS dev_agentprof_turn_events;

DROP TABLE IF EXISTS dev_agentprof_turn_prompts;

DROP TABLE IF EXISTS _dev_agentprof_turn_activity_totals;

DROP TABLE IF EXISTS _dev_agentprof_turn_bounds;

DROP TABLE IF EXISTS _dev_agentprof_turn_linked_requests;

DROP TABLE IF EXISTS _dev_agentprof_turn_request_matches;

DROP TABLE IF EXISTS _dev_agentprof_turn_explicit_requests;

DROP TABLE IF EXISTS _dev_agentprof_turn_owners;

DROP TABLE IF EXISTS _dev_agentprof_turn_prompt_ancestry;

DROP TABLE IF EXISTS _dev_agentprof_turn_parent_lookup;

DROP TABLE IF EXISTS _dev_agentprof_turn_native_prompts;

DROP TABLE IF EXISTS _dev_agentprof_turn_flows;

DROP TABLE IF EXISTS _dev_agentprof_turn_flow_ids;

DROP TABLE IF EXISTS _dev_agentprof_turn_work;

DROP TABLE IF EXISTS _dev_agentprof_turn_clusters;

DROP TABLE IF EXISTS _dev_agentprof_turn_prompt_lookup;

-- User-prompt interaction boundaries per capture (no raw prompt text).
CREATE PERFETTO TABLE dev_agentprof_turn_prompts AS
WITH
  prompts AS (
    SELECT
      s.id AS prompt_id,
      s.capture_id,
      s.session,
      s.capture,
      s.ts AS start_ts,
      r.start_ts AS capture_start_ts,
      s.incomplete,
      CASE WHEN s.dur >= 0 THEN s.ts + s.dur ELSE r.end_ts END AS recorded_end_ts,
      LEAD(s.ts) OVER (PARTITION BY s.capture_id ORDER BY s.ts, s.id) AS next_start_ts,
      ROW_NUMBER() OVER (PARTITION BY s.capture_id ORDER BY s.ts, s.id) AS turn_number,
      EXTRACT_ARG(s.arg_set_id, 'debug.turn_id') AS native_turn_id
    FROM dev_agentprof_slices AS s
    LEFT JOIN dev_agentprof_capture_runs AS r USING (capture_id)
    WHERE
      s.kind = 'prompt'
  )
SELECT
  *,
  CASE
    WHEN incomplete THEN MIN(
      COALESCE(recorded_end_ts, start_ts),
      COALESCE(next_start_ts, recorded_end_ts, start_ts)
    )
    ELSE COALESCE(recorded_end_ts, start_ts)
  END AS attribution_end_ts
FROM prompts;

CREATE TABLE _dev_agentprof_turn_prompt_lookup AS
WITH
  previous AS (
    SELECT
      *,
      MAX(attribution_end_ts) OVER (
        PARTITION BY
          capture_id
        ORDER BY start_ts, prompt_id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS previous_end
    FROM dev_agentprof_turn_prompts
  )
SELECT
  *,
  SUM(previous_end IS NULL OR start_ts >= previous_end) OVER (
    PARTITION BY
      capture_id
    ORDER BY start_ts, prompt_id
    ROWS UNBOUNDED PRECEDING
  ) AS cluster_id
FROM previous;

CREATE INDEX _dev_agentprof_turn_prompt_id ON _dev_agentprof_turn_prompt_lookup (
  prompt_id
);

CREATE INDEX _dev_agentprof_turn_prompt_identity ON _dev_agentprof_turn_prompt_lookup (
  capture_id,
  native_turn_id
);

CREATE INDEX _dev_agentprof_turn_prompt_cluster ON _dev_agentprof_turn_prompt_lookup (
  capture_id,
  cluster_id
);

CREATE TABLE _dev_agentprof_turn_clusters AS
SELECT
  capture_id,
  cluster_id,
  MIN(start_ts) AS start_ts,
  MAX(attribution_end_ts) AS end_ts,
  COUNT(*) AS prompts
FROM _dev_agentprof_turn_prompt_lookup
GROUP BY
  capture_id,
  cluster_id;

CREATE INDEX _dev_agentprof_turn_cluster_start ON _dev_agentprof_turn_clusters (
  capture_id,
  start_ts DESC,
  cluster_id DESC
);

CREATE TABLE _dev_agentprof_turn_work AS
SELECT
  s.id,
  s.capture_id,
  s.kind,
  s.incomplete,
  COALESCE(m.message_start_ts, s.ts) AS start_ts,
  CASE
    WHEN NOT s.incomplete THEN CASE
      WHEN s.kind = 'assistant-message' THEN m.message_ns
      WHEN s.dur >= 0 THEN s.dur
    END
  END AS measured_ns,
  m.provider,
  m.model,
  m.input_tokens,
  m.output_tokens,
  EXTRACT_ARG(s.arg_set_id, 'debug.turn_id') AS native_turn_id,
  EXTRACT_ARG(s.arg_set_id, 'debug.request_id') AS request_id,
  COALESCE(
    EXTRACT_ARG(s.arg_set_id, 'debug.child_session'),
    EXTRACT_ARG(s.arg_set_id, 'debug.childSession')
  ) AS child_session
FROM dev_agentprof_slices AS s
LEFT JOIN dev_agentprof_messages AS m USING (id)
WHERE
  s.kind IN (
    'assistant-message',
    'provider-request',
    'tool-execution',
    'script',
    'model-call'
  )
  OR COALESCE(
    EXTRACT_ARG(s.arg_set_id, 'debug.child_session'),
    EXTRACT_ARG(s.arg_set_id, 'debug.childSession')
  ) IS NOT NULL;

CREATE INDEX _dev_agentprof_turn_cluster_id ON _dev_agentprof_turn_clusters (
  capture_id,
  cluster_id
);

CREATE INDEX _dev_agentprof_turn_work_id ON _dev_agentprof_turn_work (id);

CREATE INDEX _dev_agentprof_turn_work_identity ON _dev_agentprof_turn_work (
  capture_id,
  native_turn_id
);

CREATE TABLE _dev_agentprof_turn_flow_ids AS
SELECT id FROM _dev_agentprof_turn_work
UNION
SELECT prompt_id FROM dev_agentprof_turn_prompts;

CREATE INDEX _dev_agentprof_turn_flow_id ON _dev_agentprof_turn_flow_ids (id);

CREATE TABLE _dev_agentprof_turn_flows AS
SELECT f.slice_out, f.slice_in
FROM _dev_agentprof_turn_flow_ids AS ids
CROSS JOIN flow AS f ON f.slice_out = ids.id
UNION
SELECT f.slice_out, f.slice_in
FROM _dev_agentprof_turn_flow_ids AS ids
CROSS JOIN flow AS f ON f.slice_in = ids.id;

CREATE INDEX _dev_agentprof_turn_flow_out ON _dev_agentprof_turn_flows (
  slice_out
);

CREATE INDEX _dev_agentprof_turn_flow_in ON _dev_agentprof_turn_flows (slice_in);

CREATE TABLE _dev_agentprof_turn_native_prompts AS
SELECT capture_id, native_turn_id, MIN(prompt_id) AS prompt_id
FROM _dev_agentprof_turn_prompt_lookup
WHERE
  native_turn_id IS NOT NULL
GROUP BY
  capture_id,
  native_turn_id
HAVING
  COUNT(*) = 1;

CREATE INDEX _dev_agentprof_turn_native_id ON _dev_agentprof_turn_native_prompts (
  capture_id,
  native_turn_id
);

CREATE TABLE _dev_agentprof_turn_parent_lookup AS
SELECT
  CAST(s.id AS INTEGER) AS id,
  CAST(s.parent_id AS INTEGER) AS parent_id,
  CAST(agent.capture_id AS INTEGER) AS capture_id,
  CAST(marker.capture_id AS INTEGER) AS marker_capture_id
FROM slice AS s
LEFT JOIN dev_agentprof_slices AS agent USING (id)
LEFT JOIN dev_agentprof_capture_markers AS marker ON marker.slice_id = s.id
WHERE
  s.parent_id IS NOT NULL
  AND s.track_id IN (
    SELECT DISTINCT track_id FROM dev_agentprof_slices WHERE kind = 'prompt'
  );

CREATE INDEX _dev_agentprof_turn_parent_id ON _dev_agentprof_turn_parent_lookup (
  parent_id
);

CREATE TABLE _dev_agentprof_turn_prompt_ancestry AS
WITH RECURSIVE
  inherited(id, prompt_id, capture_id) AS (
    SELECT
      CAST(prompt_id AS INTEGER),
      CAST(prompt_id AS INTEGER),
      CAST(capture_id AS INTEGER)
    FROM dev_agentprof_turn_prompts
    UNION ALL
    SELECT child.id, parent.prompt_id, parent.capture_id
    FROM inherited AS parent
    CROSS JOIN _dev_agentprof_turn_parent_lookup AS child INDEXED BY _dev_agentprof_turn_parent_id
      ON child.parent_id = parent.id
    WHERE
      child.id NOT IN (SELECT prompt_id FROM dev_agentprof_turn_prompts)
      AND (child.capture_id IS NULL OR child.capture_id = parent.capture_id)
      AND (child.marker_capture_id IS NULL
      OR child.marker_capture_id = parent.capture_id)
  )
SELECT
  CAST(id AS INTEGER) AS id,
  CAST(prompt_id AS INTEGER) AS prompt_id,
  CAST(capture_id AS INTEGER) AS capture_id
FROM inherited;

CREATE INDEX _dev_agentprof_turn_ancestry_id ON _dev_agentprof_turn_prompt_ancestry (
  id
);

CREATE TABLE _dev_agentprof_turn_owners AS
WITH
  nearby AS MATERIALIZED (
    SELECT
      w.*,
      (
        SELECT c.cluster_id
        FROM _dev_agentprof_turn_clusters AS c
        WHERE
          c.capture_id = w.capture_id
          AND c.start_ts <= w.start_ts
        ORDER BY
          c.start_ts DESC,
          c.cluster_id DESC
        LIMIT 1
      ) AS cluster_id
    FROM _dev_agentprof_turn_work AS w
  ),
  containment AS (
    SELECT
      w.id,
      p.prompt_id,
      p.start_ts,
      p.attribution_end_ts,
      MAX(p.start_ts) OVER (PARTITION BY w.id) AS innermost_start,
      MIN(p.attribution_end_ts) OVER (PARTITION BY w.id) AS innermost_end
    FROM nearby AS w
    JOIN _dev_agentprof_turn_clusters AS c USING (capture_id, cluster_id)
    JOIN _dev_agentprof_turn_prompt_lookup AS p USING (capture_id, cluster_id)
    WHERE
      c.prompts <= 64
      AND w.start_ts >= p.start_ts
      AND (w.start_ts < p.attribution_end_ts
      OR (p.attribution_end_ts = p.start_ts AND w.start_ts = p.start_ts))
  ),
  direct_flows AS MATERIALIZED (
    SELECT w.id, p.prompt_id, p.capture_id
    FROM dev_agentprof_turn_prompts AS p
    CROSS JOIN _dev_agentprof_turn_flows AS f ON f.slice_out = p.prompt_id
    CROSS JOIN _dev_agentprof_turn_work AS w
      ON w.id = f.slice_in
      AND w.capture_id = p.capture_id
  ),
  candidates AS (
    SELECT w.id, p.prompt_id, 0 AS priority
    FROM _dev_agentprof_turn_work AS w
    JOIN _dev_agentprof_turn_native_prompts AS p USING (
      capture_id,
      native_turn_id
    )
    UNION ALL
    SELECT id, prompt_id, 10 FROM direct_flows
    UNION ALL
    SELECT w.id, p.prompt_id, 20
    FROM direct_flows AS p
    CROSS JOIN _dev_agentprof_turn_flows AS f ON f.slice_out = p.id
    CROSS JOIN _dev_agentprof_turn_work AS w
      ON w.id = f.slice_in
      AND w.capture_id = p.capture_id
    UNION ALL
    SELECT w.id, p.prompt_id, 100
    FROM _dev_agentprof_turn_prompt_ancestry AS p
    CROSS JOIN _dev_agentprof_turn_work AS w INDEXED BY _dev_agentprof_turn_work_id
      ON w.id = p.id
      AND w.capture_id = p.capture_id
    UNION ALL
    SELECT id, prompt_id, 1000
    FROM containment
    WHERE
      start_ts = innermost_start
      AND attribution_end_ts = innermost_end
  ),
  unique_candidates AS (SELECT DISTINCT id, prompt_id, priority FROM candidates),
  ranked AS (
    SELECT *, MIN(priority) OVER (PARTITION BY id) AS best
    FROM unique_candidates
  )
SELECT id, MIN(prompt_id) AS prompt_id
FROM ranked
WHERE
  priority = best
GROUP BY
  id
HAVING
  COUNT(*) = 1;

CREATE INDEX _dev_agentprof_turn_owner_id ON _dev_agentprof_turn_owners (id);

CREATE INDEX _dev_agentprof_turn_work_request ON _dev_agentprof_turn_work (
  capture_id,
  kind,
  request_id,
  start_ts
);

CREATE TABLE _dev_agentprof_turn_explicit_requests AS
SELECT r.id AS request_slice_id, m.id AS message_slice_id
FROM _dev_agentprof_turn_work AS r
CROSS JOIN _dev_agentprof_turn_flows AS f ON f.slice_out = r.id
CROSS JOIN _dev_agentprof_turn_work AS m INDEXED BY _dev_agentprof_turn_work_id
  ON m.id = f.slice_in
WHERE
  r.kind = 'provider-request'
  AND m.kind = 'assistant-message'
  AND r.capture_id = m.capture_id
UNION
SELECT r.id, m.id
FROM _dev_agentprof_turn_work AS r
CROSS JOIN _dev_agentprof_turn_flows AS f ON f.slice_in = r.id
CROSS JOIN _dev_agentprof_turn_work AS m INDEXED BY _dev_agentprof_turn_work_id
  ON m.id = f.slice_out
WHERE
  r.kind = 'provider-request'
  AND m.kind = 'assistant-message'
  AND r.capture_id = m.capture_id;

CREATE INDEX _dev_agentprof_turn_explicit_request ON _dev_agentprof_turn_explicit_requests (
  request_slice_id
);

CREATE INDEX _dev_agentprof_turn_explicit_message ON _dev_agentprof_turn_explicit_requests (
  message_slice_id
);

CREATE TABLE _dev_agentprof_turn_request_matches AS
WITH
  identified AS MATERIALIZED (
    SELECT *
    FROM _dev_agentprof_turn_work
    WHERE
      kind = 'provider-request'
      AND request_id IS NOT NULL
      AND id NOT IN (
        SELECT request_slice_id FROM _dev_agentprof_turn_explicit_requests
      )
  )
SELECT r.id AS request_slice_id, m.id AS message_slice_id
FROM identified AS r
CROSS JOIN _dev_agentprof_turn_work AS m
  ON m.capture_id = r.capture_id
  AND m.kind = 'assistant-message'
  AND m.request_id = r.request_id
WHERE
  m.id NOT IN (
    SELECT message_slice_id FROM _dev_agentprof_turn_explicit_requests
  )
  AND ((r.measured_ns > 0
  AND m.measured_ns > 0
  AND r.start_ts < m.start_ts + m.measured_ns
  AND m.start_ts < r.start_ts + r.measured_ns)
  OR (r.measured_ns = 0
  AND m.measured_ns > 0
  AND r.start_ts >= m.start_ts
  AND r.start_ts < m.start_ts + m.measured_ns)
  OR (m.measured_ns = 0
  AND r.measured_ns > 0
  AND m.start_ts >= r.start_ts
  AND m.start_ts < r.start_ts + r.measured_ns)
  OR (r.measured_ns = 0 AND m.measured_ns = 0 AND r.start_ts = m.start_ts));

CREATE TABLE _dev_agentprof_turn_linked_requests AS
SELECT request_slice_id AS id FROM _dev_agentprof_turn_explicit_requests
UNION
SELECT request_slice_id
FROM (
  SELECT
    *,
    COUNT(*) OVER (PARTITION BY request_slice_id) AS messages,
    COUNT(*) OVER (PARTITION BY message_slice_id) AS requests
  FROM _dev_agentprof_turn_request_matches
)
WHERE
  messages = 1
  AND requests = 1;

CREATE INDEX _dev_agentprof_turn_linked_request_id ON _dev_agentprof_turn_linked_requests (
  id
);

-- Operations attributed to prompts (or prompt_id IS NULL when ambiguous),
-- with linked provider-request spans deduplicated against their responses.
CREATE TABLE dev_agentprof_turn_events AS
SELECT
  w.*,
  CAST(o.prompt_id AS INTEGER) AS prompt_id,
  w.start_ts + MAX(COALESCE(w.measured_ns, 0), 0) AS observed_end_ts
FROM _dev_agentprof_turn_work AS w
LEFT JOIN _dev_agentprof_turn_owners AS o USING (id)
LEFT JOIN _dev_agentprof_turn_linked_requests AS linked
  ON linked.id = w.id
WHERE
  linked.id IS NULL;

CREATE INDEX _dev_agentprof_turn_event_prompt ON dev_agentprof_turn_events (
  prompt_id,
  start_ts,
  id
);

CREATE TABLE _dev_agentprof_turn_bounds AS
SELECT
  p.*,
  CASE
    WHEN p.incomplete THEN MAX(
      p.start_ts,
      MIN(p.attribution_end_ts, COALESCE(MAX(e.observed_end_ts), p.start_ts))
    )
    ELSE p.recorded_end_ts
  END AS display_end_ts,
  COUNT(e.id) AS events,
  SUM(e.kind = 'assistant-message') AS model_calls,
  SUM(e.kind = 'provider-request') AS unmatched_requests,
  SUM(e.kind = 'tool-execution') AS tools,
  SUM(e.kind = 'assistant-message' AND (e.measured_ns IS NULL OR e.incomplete)) AS unknown_models,
  SUM(e.kind = 'tool-execution' AND (e.measured_ns IS NULL OR e.incomplete)) AS unknown_tools,
  SUM(e.input_tokens) AS input_tokens,
  SUM(e.output_tokens) AS output_tokens,
  JSON_GROUP_ARRAY(DISTINCT
    JSON_OBJECT(
      'provider',
      NULLIF(TRIM(e.provider), ''),
      'model',
      NULLIF(TRIM(e.model), '')
    )
  ) FILTER (WHERE e.kind = 'assistant-message') AS model_identities
FROM dev_agentprof_turn_prompts AS p
LEFT JOIN dev_agentprof_turn_events AS e USING (prompt_id)
GROUP BY
  p.prompt_id;

CREATE INDEX _dev_agentprof_turn_bounds_id ON _dev_agentprof_turn_bounds (
  prompt_id
);

CREATE TABLE _dev_agentprof_turn_activity_totals AS
WITH
  intervals AS (
    SELECT
      b.prompt_id,
      MAX(b.start_ts, e.start_ts) AS ts,
      MIN(b.display_end_ts, e.observed_end_ts) AS end_ts,
      e.kind = 'assistant-message' AS models,
      e.kind = 'tool-execution' AS tools
    FROM _dev_agentprof_turn_bounds AS b
    JOIN dev_agentprof_turn_events AS e USING (prompt_id)
    WHERE
      e.kind IN ('assistant-message', 'tool-execution')
      AND e.measured_ns > 0
      AND NOT e.incomplete
  ),
  boundaries AS (
    SELECT prompt_id, ts, models, tools FROM intervals WHERE end_ts > ts
    UNION ALL
    SELECT prompt_id, end_ts, -models, -tools FROM intervals WHERE end_ts > ts
  ),
  deltas AS (
    SELECT prompt_id, ts, SUM(models) AS models, SUM(tools) AS tools
    FROM boundaries
    GROUP BY
      prompt_id,
      ts
  ),
  activity AS (
    SELECT
      prompt_id,
      ts,
      LEAD(ts) OVER (PARTITION BY prompt_id ORDER BY ts) - ts AS dur,
      SUM(models) OVER (PARTITION BY prompt_id ORDER BY ts) AS models,
      SUM(tools) OVER (PARTITION BY prompt_id ORDER BY ts) AS tools
    FROM deltas
  )
SELECT
  prompt_id,
  SUM(CASE WHEN models > 0 AND tools = 0 THEN dur ELSE 0 END) AS models_only_ns,
  SUM(CASE WHEN tools > 0 AND models = 0 THEN dur ELSE 0 END) AS tools_only_ns,
  SUM(CASE WHEN models > 0 AND tools > 0 THEN dur ELSE 0 END) AS overlap_ns
FROM activity
WHERE
  dur > 0
GROUP BY
  prompt_id;

CREATE INDEX _dev_agentprof_turn_totals_id ON _dev_agentprof_turn_activity_totals (
  prompt_id
);

-- Attributed user-prompt turns with interval-union occupancy and token sums.
CREATE PERFETTO TABLE dev_agentprof_turns AS
SELECT
  b.*,
  COALESCE(t.models_only_ns, 0) AS models_only_ns,
  COALESCE(t.tools_only_ns, 0) AS tools_only_ns,
  COALESCE(t.overlap_ns, 0) AS overlap_ns,
  MAX(
    0,
    b.display_end_ts - b.start_ts - COALESCE(t.models_only_ns, 0)
    - COALESCE(t.tools_only_ns, 0)
    - COALESCE(t.overlap_ns, 0)
  ) AS unattributed_ns
FROM _dev_agentprof_turn_bounds AS b
LEFT JOIN _dev_agentprof_turn_activity_totals AS t USING (prompt_id);

DROP TABLE _dev_agentprof_turn_activity_totals;

DROP TABLE _dev_agentprof_turn_bounds;

DROP TABLE _dev_agentprof_turn_linked_requests;

DROP TABLE _dev_agentprof_turn_request_matches;

DROP TABLE _dev_agentprof_turn_explicit_requests;

DROP TABLE _dev_agentprof_turn_owners;

DROP TABLE _dev_agentprof_turn_prompt_ancestry;

DROP TABLE _dev_agentprof_turn_parent_lookup;

DROP TABLE _dev_agentprof_turn_native_prompts;

DROP TABLE _dev_agentprof_turn_flows;

DROP TABLE _dev_agentprof_turn_flow_ids;

DROP TABLE _dev_agentprof_turn_work;

DROP TABLE _dev_agentprof_turn_clusters;

DROP TABLE _dev_agentprof_turn_prompt_lookup;

-- Lazy UI projection adding bounded prompt_text excerpts on demand.
CREATE PERFETTO VIEW dev_agentprof_turns_with_prompts AS
SELECT
  t.*,
  SUBSTR(EXTRACT_ARG(s.arg_set_id, 'debug.text'), 1, 2048) AS prompt_text
FROM dev_agentprof_turns AS t
LEFT JOIN slice AS s
  ON s.id = t.prompt_id;

-- Unassigned operations grouped by capture and kind.
CREATE PERFETTO VIEW dev_agentprof_turn_unassigned AS
SELECT
  capture_id,
  kind,
  COUNT(*) AS unassigned_events,
  SUM(incomplete OR measured_ns IS NULL) AS unknown_or_incomplete
FROM dev_agentprof_turn_events
WHERE
  prompt_id IS NULL
GROUP BY
  capture_id,
  kind
ORDER BY
  capture_id,
  kind;

-- Trace-wide unassigned operation counts for the Turns UI banner.
CREATE PERFETTO VIEW dev_agentprof_turn_unassigned_totals AS
SELECT
  COUNT(*) AS events,
  SUM(kind = 'assistant-message') AS responses,
  SUM(kind = 'tool-execution') AS tools
FROM dev_agentprof_turn_events
WHERE
  prompt_id IS NULL;

-- Detailed operation rows for one expanded turn in the Turns UI waterfall.
CREATE PERFETTO FUNCTION dev_agentprof_turn_waterfall(
  -- Slice ID of the prompt turn to expand.
  target_prompt_id LONG,
  -- Maximum number of events to return.
  max_rows LONG
)
RETURNS TABLE(
  id LONG,
  capture_id LONG,
  kind STRING,
  incomplete LONG,
  start_ts LONG,
  measured_ns LONG,
  provider STRING,
  model STRING,
  input_tokens LONG,
  output_tokens LONG,
  native_turn_id STRING,
  request_id STRING,
  child_session STRING,
  prompt_id LONG,
  observed_end_ts LONG,
  total_events LONG,
  name STRING,
  intent STRING,
  arguments STRING,
  args_truncated LONG,
  language STRING,
  line_count LONG,
  call_id STRING,
  parent_call_id STRING,
  is_error LONG,
  first_content_ms DOUBLE,
  child_prompt_id LONG,
  depth LONG
)
AS
SELECT
  e.id,
  e.capture_id,
  e.kind,
  e.incomplete,
  e.start_ts,
  e.measured_ns,
  e.provider,
  e.model,
  e.input_tokens,
  e.output_tokens,
  e.native_turn_id,
  e.request_id,
  e.child_session,
  e.prompt_id,
  e.observed_end_ts,
  e.total_events,
  s.name,
  t.intent,
  t.arguments,
  t.args_truncated,
  t.language,
  t.line_count,
  t.call_id,
  t.parent_call_id,
  t.is_error,
  m.first_ns / 1e6 AS first_content_ms,
  (
    SELECT MIN(p.prompt_id)
    FROM dev_agentprof_turn_prompts AS p
    WHERE
      p.session = e.child_session
      AND (
        SELECT COUNT(DISTINCT capture_id)
        FROM dev_agentprof_turn_prompts
        WHERE
          session = p.session
      )
      = 1
  ) AS child_prompt_id,
  (
    SELECT COUNT(*)
    FROM dev_agentprof_script_children AS c
    WHERE
      c.id = e.id
      AND c.script_id IN (
        SELECT id
        FROM dev_agentprof_turn_events
        WHERE
          prompt_id = $target_prompt_id
      )
  ) AS depth
FROM (
  SELECT *, COUNT(*) OVER () AS total_events
  FROM dev_agentprof_turn_events
  WHERE
    prompt_id = $target_prompt_id
  ORDER BY
    start_ts,
    id
  LIMIT $max_rows
) AS e
JOIN dev_agentprof_slices AS s USING (id)
LEFT JOIN dev_agentprof_tool_call_details AS t USING (id)
LEFT JOIN dev_agentprof_messages AS m USING (id)
ORDER BY
  e.start_ts,
  e.id;
