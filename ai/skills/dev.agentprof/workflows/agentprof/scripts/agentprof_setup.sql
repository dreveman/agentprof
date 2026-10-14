-- SPDX-License-Identifier: Apache-2.0
-- Exported from AgentProf reader SQL. Standalone: no UI or build dependency.
DROP TABLE IF EXISTS agentprof_skill_turns;
DROP TABLE IF EXISTS agentprof_skill_turn_events;
DROP TABLE IF EXISTS agentprof_skill_turn_prompts;
DROP TABLE IF EXISTS agentprof_skill_turn_activity_totals;
DROP TABLE IF EXISTS agentprof_skill_turn_bounds;
DROP TABLE IF EXISTS agentprof_skill_turn_linked_requests;
DROP TABLE IF EXISTS agentprof_skill_turn_request_matches;
DROP TABLE IF EXISTS agentprof_skill_turn_explicit_requests;
DROP TABLE IF EXISTS agentprof_skill_turn_owners;
DROP TABLE IF EXISTS agentprof_skill_turn_prompt_ancestry;
DROP TABLE IF EXISTS agentprof_skill_turn_parent_lookup;
DROP TABLE IF EXISTS agentprof_skill_turn_native_prompts;
DROP TABLE IF EXISTS agentprof_skill_turn_flows;
DROP TABLE IF EXISTS agentprof_skill_turn_flow_ids;
DROP TABLE IF EXISTS agentprof_skill_turn_work;
DROP TABLE IF EXISTS agentprof_skill_turn_clusters;
DROP TABLE IF EXISTS agentprof_skill_turn_prompt_lookup;

DROP TABLE IF EXISTS agentprof_skill_track_process;
DROP TABLE IF EXISTS agentprof_skill_counter_tracks;
DROP TABLE IF EXISTS agentprof_skill_capture_markers;
DROP TABLE IF EXISTS agentprof_skill_captures;
DROP TABLE IF EXISTS agentprof_skill_slice_parent_lookup;
DROP TABLE IF EXISTS agentprof_skill_slice_capture;
DROP TABLE IF EXISTS agentprof_skill_slices;
DROP TABLE IF EXISTS agentprof_skill_tool_arguments;
DROP TABLE IF EXISTS agentprof_skill_tool_preflights;
DROP TABLE IF EXISTS agentprof_skill_tool_calls;
DROP TABLE IF EXISTS agentprof_skill_script_children;
DROP TABLE IF EXISTS agentprof_skill_session_captures;
DROP TABLE IF EXISTS agentprof_skill_capture_parents;
DROP TABLE IF EXISTS agentprof_skill_capture_hierarchy;
DROP TABLE IF EXISTS agentprof_skill_configuration;
DROP TABLE IF EXISTS agentprof_skill_session_labels;
DROP TABLE IF EXISTS agentprof_skill_capture_runs;
DROP TABLE IF EXISTS agentprof_skill_messages;
DROP TABLE IF EXISTS agentprof_skill_activity;
DROP TABLE IF EXISTS agentprof_skill_context_snapshots;
DROP TABLE IF EXISTS agentprof_skill_context_changes;

CREATE PERFETTO TABLE agentprof_skill_track_process AS
WITH RECURSIVE ancestry(track_id, ancestor_id) AS (
  SELECT id, id FROM track
  UNION
  SELECT a.track_id, t.parent_id FROM ancestry a
  JOIN track t ON t.id = a.ancestor_id WHERE t.parent_id IS NOT NULL
)
SELECT a.track_id, MAX(COALESCE(p.upid, c.upid, th.upid)) AS upid,
  COALESCE(MAX(CASE WHEN t.name = 'agentprof.capture' THEN t.id END),
    -1 - MAX(COALESCE(p.upid, c.upid, th.upid)), -1 - a.track_id) AS capture_id
FROM ancestry a JOIN track t ON t.id = a.ancestor_id
LEFT JOIN process_track p ON p.id = a.ancestor_id
LEFT JOIN process_counter_track c ON c.id = a.ancestor_id
LEFT JOIN thread_track tt ON tt.id = a.ancestor_id
LEFT JOIN thread th ON th.utid = tt.utid
GROUP BY a.track_id;


CREATE PERFETTO TABLE agentprof_skill_counter_tracks AS
WITH names(metric, display_name, group_name) AS (VALUES
  ('context.system', 'System instructions', 'Context'),
  ('context.rules', 'Rules and memory', 'Context'),
  ('context.skills', 'Skills', 'Context'),
  ('context.tools', 'Tool definitions', 'Context'),
  ('context.environment', 'Environment', 'Context'),
  ('context.prompts', 'User prompts', 'Context'),
  ('context.assistant', 'Assistant history', 'Context'),
  ('context.results', 'Tool results', 'Context'),
  ('context.summaries', 'Compaction summaries', 'Context'),
  ('context.overhead', 'Harness overhead', 'Context'),
  ('context.messages', 'Conversation', 'Context'),
  ('context.unattributed', 'Unattributed', 'Context'),
  ('llm.tokens.input', 'Input tokens', NULL),
  ('llm.tokens.output', 'Output tokens', NULL),
  ('llm.context.estimated_tokens', 'Context size', NULL),
  ('llm.context.window_tokens', 'Context window', NULL),
  ('runtime.rss', 'Resident memory', 'Runtime'),
  ('runtime.heap', 'JS heap', 'Runtime'),
  ('runtime.cpu', 'CPU time (interval)', 'Runtime'),
  ('tracing.droppedEvents', 'Dropped events', 'Tracing'),
  ('tracing.queueDepth', 'Queue depth', 'Tracing'),
  ('tracing.laneOverflows', 'Lane overflows', 'Tracing')
)
SELECT t.id, n.metric AS name, n.display_name, n.group_name, m.capture_id
FROM counter_track t JOIN names n ON t.name IN (n.metric, n.display_name, 'Context: ' || n.display_name)
  OR (n.metric = 'llm.context.estimated_tokens' AND t.name = 'Context size (est.)')
JOIN agentprof_skill_track_process m ON m.track_id = t.id;


-- OS thread tracks are shared by captures and have no capture parent. Join
-- their capture spans to the generic capture track using its recorded UUID.
CREATE PERFETTO TABLE agentprof_skill_capture_markers AS
SELECT s.id AS slice_id, COALESCE(root.id, m.capture_id) AS capture_id,
  COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.capture_id'), EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_capture_id')) AS recorded_id,
  COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.session_id'), EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_session_id')) AS session_id,
  COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.label'), EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_capture_label')) AS label
FROM slice s JOIN agentprof_skill_track_process m ON m.track_id = s.track_id
LEFT JOIN track root ON root.name = 'agentprof.capture'
  AND printf('%x', EXTRACT_ARG(root.source_arg_set_id, 'trace_id')) =
    COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.capture_id'), EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_capture_id'))
WHERE s.category IN ('pi.metadata', 'claude.metadata', 'codex.metadata', 'muse.metadata', 'agentprof.metadata') AND (s.name IN ('tracing', 'tracing-start')
  OR s.name GLOB 'profile ([0-9]*)');

CREATE PERFETTO TABLE agentprof_skill_captures AS
SELECT capture_id, MAX(recorded_id) AS recorded_id, MAX(session_id) AS session_id,
  MAX(label) AS label FROM agentprof_skill_capture_markers GROUP BY capture_id;


CREATE TABLE agentprof_skill_slice_parent_lookup AS
SELECT s.id, s.parent_id FROM slice s WHERE s.parent_id IS NOT NULL
  AND s.track_id IN (SELECT DISTINCT marker.track_id FROM slice marker
    JOIN agentprof_skill_capture_markers m ON m.slice_id = marker.id);
CREATE INDEX agentprof_skill_slice_parent_idx ON agentprof_skill_slice_parent_lookup(parent_id);
CREATE PERFETTO TABLE agentprof_skill_slice_capture AS
WITH RECURSIVE captured(id, capture_id) AS (
  SELECT slice_id, capture_id FROM agentprof_skill_capture_markers
  UNION ALL
  SELECT s.id, c.capture_id FROM agentprof_skill_slice_parent_lookup s
    JOIN captured c ON s.parent_id = c.id
    WHERE s.id NOT IN (SELECT slice_id FROM agentprof_skill_capture_markers)
)
SELECT c.id, c.capture_id FROM captured c JOIN slice s ON s.id = c.id
WHERE s.category GLOB 'pi.*' OR s.category GLOB 'claude.*' OR s.category GLOB 'codex.*'
  OR s.category GLOB 'muse.*' OR s.category GLOB 'agentprof.*';
DROP INDEX agentprof_skill_slice_parent_idx;
DROP TABLE agentprof_skill_slice_parent_lookup;


CREATE PERFETTO TABLE agentprof_skill_slices AS
SELECT s.*, COALESCE(t.name, th.name || ' ' || th.tid, 'Thread ' || th.tid) AS track_name,
  m.upid, tt.utid, COALESCE(sc.capture_id, m.capture_id) AS capture_id,
  COALESCE(cap.label, SUBSTR(cap.recorded_id, 1, 8), 'Legacy capture') AS capture,
  COALESCE(cap.session_id, (SELECT SUBSTR(a.string_value, 9) FROM args a
    WHERE a.arg_set_id = p.arg_set_id AND a.key GLOB 'chrome.process_label*'
      AND a.string_value GLOB 'session:*' LIMIT 1),
    'process ' || COALESCE(CAST(m.upid AS TEXT), 'unknown')) AS session,
  COALESCE(CASE WHEN s.name = 'codemode' AND s.category = 'pi.tools' THEN 'script' END,
    COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.kind'), EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_event_kind')),
    CASE
      WHEN (',' || s.category || ',') GLOB '*,pi.agent,*' AND s.name = 'prompt' THEN 'prompt'
      WHEN s.category = 'pi.agent' AND s.name = 'turn' THEN 'turn'
      WHEN s.category = 'pi.llm' AND s.name IN ('request', 'provider-request') THEN 'provider-request'
      WHEN s.category = 'pi.tools' AND (t.name IN ('tools', 'Tools') OR t.name GLOB 'tools.lane.*') THEN 'tool-execution'
      WHEN s.category = 'pi.llm' AND s.name GLOB 'assistant ttft=*' THEN 'assistant-message'
      ELSE 'other'
    END) AS kind,
  (s.dur < 0 OR COALESCE(COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.incomplete'), EXTRACT_ARG(s.arg_set_id, 'debug.pi_tracing_incomplete')), 0)
    OR COALESCE(COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.incomplete'), EXTRACT_ARG(s.arg_set_id, 'debug.pi_tracing_providerIncomplete')), 0)) AS incomplete
FROM slice s JOIN track t ON t.id = s.track_id
LEFT JOIN agentprof_skill_track_process m ON m.track_id = t.id
LEFT JOIN thread_track tt ON tt.id = t.id
LEFT JOIN thread th ON th.utid = tt.utid
LEFT JOIN agentprof_skill_slice_capture sc ON sc.id = s.id
LEFT JOIN process p ON p.upid = m.upid
LEFT JOIN agentprof_skill_captures cap ON cap.capture_id = COALESCE(sc.capture_id, m.capture_id)
WHERE s.category GLOB 'pi.*' OR s.category GLOB 'claude.*' OR s.category GLOB 'codex.*' OR s.category GLOB 'muse.*' OR s.category GLOB 'agentprof.*';

CREATE PERFETTO TABLE agentprof_skill_tool_arguments AS
SELECT CAST(NULL AS INTEGER) AS arg_set_id, CAST(NULL AS STRING) AS arguments WHERE 0;

-- Older recordings kept arguments on preflight rather than execution spans.
CREATE PERFETTO TABLE agentprof_skill_tool_preflights AS
SELECT capture_id, COALESCE(EXTRACT_ARG(arg_set_id, 'debug.call_id'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_tool_call_id')) AS call_id, MAX(id) AS id
FROM agentprof_skill_slices WHERE name = 'tool-preflight' GROUP BY capture_id, call_id;

CREATE PERFETTO TABLE agentprof_skill_tool_calls AS
SELECT s.*, COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.call_id'),
    EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_tool_call_id')) AS call_id,
  EXTRACT_ARG(s.arg_set_id, 'debug.parent_call_id') AS parent_call_id,
  COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.is_error'),
    EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_tool_is_error')) AS is_error,
  NULL AS intent,
  COALESCE(a.arguments, legacy.arguments) AS arguments,
  COALESCE(NULLIF(EXTRACT_ARG(s.arg_set_id, 'debug.language'), ''),
    CASE WHEN s.kind = 'script' AND s.name = 'codemode' AND s.category = 'pi.tools' THEN 'JavaScript' END) AS language,
  EXTRACT_ARG(s.arg_set_id, 'debug.line_count') AS line_count,
  COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.args_truncated'),
    EXTRACT_ARG(p.arg_set_id, 'debug.truncated'), 0) AS args_truncated
FROM agentprof_skill_slices s LEFT JOIN agentprof_skill_tool_preflights pf
  ON pf.capture_id = s.capture_id AND pf.call_id = COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.call_id'),
    EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_tool_call_id'))
LEFT JOIN agentprof_skill_slices p ON p.id = pf.id
LEFT JOIN agentprof_skill_tool_arguments a ON a.arg_set_id = s.arg_set_id
LEFT JOIN agentprof_skill_tool_arguments legacy ON legacy.arg_set_id = p.arg_set_id
WHERE s.kind IN ('tool-execution', 'script', 'model-call');

CREATE PERFETTO TABLE agentprof_skill_script_children AS
WITH RECURSIVE children(script_id, id, depth) AS (
  SELECT p.id, c.id, 1 FROM agentprof_skill_tool_calls p JOIN agentprof_skill_tool_calls c
    ON c.capture_id = p.capture_id AND c.parent_call_id = p.call_id
  WHERE p.kind = 'script' AND c.id != p.id
  UNION ALL
  SELECT c.script_id, next.id, c.depth + 1 FROM children c
  JOIN agentprof_skill_tool_calls p ON p.id = c.id
  JOIN agentprof_skill_tool_calls next ON next.capture_id = p.capture_id AND next.parent_call_id = p.call_id
  WHERE next.id != p.id AND c.depth < 32
) SELECT * FROM children;


CREATE PERFETTO TABLE agentprof_skill_session_captures AS
SELECT capture_id, session, MIN(ts) AS start_ts, MAX(ts + MAX(dur, 0)) AS end_ts,
  MAX(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.parent_session'), EXTRACT_ARG(arg_set_id, 'debug.parentSession'))) AS parent_session,
  MAX(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.parent_session'), EXTRACT_ARG(arg_set_id, 'debug.parentSession')) IS NOT NULL OR
    COALESCE(EXTRACT_ARG(arg_set_id, 'debug.child_role'), EXTRACT_ARG(arg_set_id, 'debug.childRole')) IS NOT NULL) AS is_subagent
FROM agentprof_skill_slices GROUP BY capture_id, session;

CREATE PERFETTO TABLE agentprof_skill_capture_parents AS
WITH candidates AS (
  SELECT DISTINCT c.capture_id, p.capture_id AS parent_capture_id, 0 AS priority
  FROM flow f JOIN agentprof_skill_slices p ON p.id = f.slice_out
  JOIN agentprof_skill_slices c ON c.id = f.slice_in
  WHERE p.kind = 'tool-execution' AND c.name = 'prompt-input'
    AND p.capture_id != c.capture_id
  UNION
  SELECT c.capture_id, p.capture_id, 1 FROM agentprof_skill_session_captures c
  JOIN agentprof_skill_slices launch ON COALESCE(EXTRACT_ARG(launch.arg_set_id, 'debug.child_session'), EXTRACT_ARG(launch.arg_set_id, 'debug.childSession')) = c.session
  JOIN agentprof_skill_session_captures p ON p.capture_id = launch.capture_id
  WHERE c.capture_id != p.capture_id
    AND (c.parent_session IS NULL OR c.parent_session = p.session)
    AND c.start_ts BETWEEN p.start_ts AND p.end_ts
  UNION
  SELECT c.capture_id, p.capture_id, 2 FROM agentprof_skill_session_captures c
  JOIN agentprof_skill_session_captures p ON p.session = c.parent_session
  WHERE c.capture_id != p.capture_id AND c.start_ts BETWEEN p.start_ts AND p.end_ts
), preferred AS (
  SELECT *, MIN(priority) OVER (PARTITION BY capture_id) AS best FROM candidates
)
SELECT capture_id, MIN(parent_capture_id) AS parent_capture_id
FROM preferred WHERE priority = best GROUP BY capture_id
HAVING COUNT(DISTINCT parent_capture_id) = 1;

CREATE PERFETTO TABLE agentprof_skill_capture_hierarchy AS
WITH RECURSIVE ancestors(capture_id, ancestor_id) AS (
  SELECT capture_id, capture_id FROM agentprof_skill_session_captures
  UNION
  SELECT a.capture_id, p.parent_capture_id FROM ancestors a
  JOIN agentprof_skill_capture_parents p ON p.capture_id = a.ancestor_id
), roots AS (
  SELECT a.capture_id, MIN(a.ancestor_id) AS root_capture_id FROM ancestors a
  LEFT JOIN agentprof_skill_capture_parents p ON p.capture_id = a.ancestor_id
  WHERE p.capture_id IS NULL GROUP BY a.capture_id
)
SELECT c.capture_id, COALESCE(r.root_capture_id, c.capture_id) AS root_capture_id,
  p.parent_capture_id,
  COALESCE(c.is_subagent, 0) OR p.parent_capture_id IS NOT NULL AS is_subagent
FROM agentprof_skill_session_captures c LEFT JOIN roots r USING(capture_id)
LEFT JOIN agentprof_skill_capture_parents p USING(capture_id);

CREATE PERFETTO TABLE agentprof_skill_configuration AS
    SELECT capture_id, arg_set_id,
      COALESCE(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.harness'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_harness')), 'Not recorded') AS harness,
      COALESCE(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.provider'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_provider')), 'Not recorded') AS provider,
      COALESCE(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.model'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_model')), 'Not recorded') AS model,
      COALESCE(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.effort'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_effort')), 'Not recorded') AS effort,
      EXTRACT_ARG(arg_set_id, 'debug.context_window_tokens') AS context_window_tokens
    FROM agentprof_skill_slices
    WHERE category IN ('pi.metadata', 'claude.metadata', 'codex.metadata', 'muse.metadata', 'agentprof.metadata') AND (name IN ('tracing', 'tracing-start', 'run-configuration')
      OR name GLOB 'profile ([0-9]*)');
CREATE PERFETTO TABLE agentprof_skill_session_labels AS
SELECT capture_id, JSON_GROUP_ARRAY(label) AS session_labels FROM (
  SELECT DISTINCT c.capture_id, TRIM(a.string_value) AS label
  FROM agentprof_skill_configuration c JOIN args a USING(arg_set_id)
  WHERE a.flat_key = 'debug.session_labels' AND a.key GLOB 'debug.session_labels[[]*'
    AND TRIM(a.string_value) != ''
  ORDER BY c.capture_id, label
) GROUP BY capture_id;
CREATE PERFETTO TABLE agentprof_skill_capture_runs AS
WITH configuration AS (
    SELECT capture_id, GROUP_CONCAT(DISTINCT harness) AS harness,
      GROUP_CONCAT(DISTINCT provider) AS provider, GROUP_CONCAT(DISTINCT model) AS model,
      GROUP_CONCAT(DISTINCT effort) AS effort,
      MAX(context_window_tokens) AS context_window_tokens,
      COUNT(DISTINCT context_window_tokens) AS context_window_count
    FROM agentprof_skill_configuration GROUP BY capture_id
  ), per_track AS (
    SELECT p.capture_id, t.id, t.name, MAX(c.value) AS maximum FROM counter c
    JOIN agentprof_skill_counter_tracks t ON t.id = c.track_id
    JOIN agentprof_skill_track_process p ON p.track_id = t.id
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
    FROM agentprof_skill_capture_markers m JOIN slice s ON s.id = m.slice_id
    GROUP BY m.capture_id
  ), captures AS (
    SELECT capture_id, session, MIN(ts) AS start_ts, MAX(ts + MAX(dur, 0)) AS end_ts,
      SUM(kind = 'prompt') AS turns, SUM(kind = 'assistant-message') AS responses,
      SUM(kind = 'tool-execution') AS tools, SUM(incomplete) AS incomplete,
      (MAX(ts + MAX(dur, 0)) - MIN(ts)) / 1e6 AS duration_ms
    FROM agentprof_skill_slices GROUP BY capture_id, session
  ) SELECT s.*, COALESCE(c.label, SUBSTR(c.recorded_id, 1, 8), 'Legacy capture') AS capture,
    c.recorded_id, configuration.harness, configuration.provider, configuration.model, labels.session_labels,
    configuration.effort, configuration.context_window_tokens,
    tokens.input_tokens, tokens.output_tokens,
    COALESCE(capture_peak.peak_context, tokens.peak_context) AS peak_context,
    CASE WHEN configuration.context_window_count = 1 AND configuration.context_window_tokens > 0
      THEN CAST(COALESCE(capture_peak.peak_context, tokens.peak_context) AS DOUBLE)
        / configuration.context_window_tokens END AS context_share
    FROM captures s LEFT JOIN agentprof_skill_captures c USING(capture_id)
    LEFT JOIN agentprof_skill_session_labels labels USING(capture_id)
    LEFT JOIN configuration USING(capture_id) LEFT JOIN tokens USING(capture_id)
    LEFT JOIN capture_peak USING(capture_id)
    ORDER BY s.start_ts, s.capture_id;

CREATE PERFETTO TABLE agentprof_skill_messages AS
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
FROM agentprof_skill_slices WHERE kind = 'assistant-message';

-- Sweep interval boundaries together so coincident starts/ends do not create
-- artificial concurrency. Only completed, measured intervals contribute.
CREATE PERFETTO TABLE agentprof_skill_activity AS
WITH intervals AS (
  SELECT ts, ts + dur AS end_ts, 1 AS tools, 0 AS models, 0 AS scripts
  FROM agentprof_skill_slices WHERE kind = 'tool-execution' AND NOT incomplete AND dur > 0
  UNION ALL
  SELECT message_start_ts, message_start_ts + message_ns, 0, 1, 0 FROM agentprof_skill_messages
  WHERE message_ns > 0 AND NOT incomplete
  UNION ALL
  SELECT ts, ts + dur, 0, 0, 1 FROM agentprof_skill_slices
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

CREATE PERFETTO TABLE agentprof_skill_context_snapshots AS
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
FROM agentprof_skill_slices s WHERE EXTRACT_ARG(arg_set_id, 'debug.context.version') = 1;

CREATE PERFETTO TABLE agentprof_skill_context_changes AS
WITH measured AS (
  SELECT s.*, CASE WHEN NOT s.baseline AND s.basis = LAG(s.basis) OVER (PARTITION BY s.capture_id ORDER BY s.ts, s.event_id)
    THEN LAG(s.estimated_tokens) OVER (PARTITION BY s.capture_id ORDER BY s.ts, s.event_id) END AS previous_estimated_tokens
  FROM agentprof_skill_context_snapshots s
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
    NULL AS label,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.source_id') AS source_id,
    EXTRACT_ARG(p.arg_set_id, p.prefix || '.source_kind') AS source_kind
  FROM prefixes p JOIN measured s USING(arg_set_id)
)
SELECT c.*, COALESCE((SELECT t.id FROM agentprof_skill_tool_calls t
    WHERE t.capture_id = c.capture_id AND t.call_id = c.source_id
    AND c.source_id != '' ORDER BY t.ts DESC LIMIT 1), c.snapshot_id) AS event_id,
  (SELECT t.name FROM agentprof_skill_tool_calls t WHERE t.capture_id = c.capture_id
    AND t.call_id = c.source_id AND c.source_id != '' ORDER BY t.ts DESC LIMIT 1) AS tool
FROM changes c;

DROP TABLE IF EXISTS agentprof_skill_scope;
CREATE TABLE agentprof_skill_scope(capture_id INTEGER PRIMARY KEY);
DROP VIEW IF EXISTS agentprof_skill_selected_captures;
CREATE VIEW agentprof_skill_selected_captures AS
SELECT * FROM agentprof_skill_capture_runs
WHERE NOT EXISTS (SELECT 1 FROM agentprof_skill_scope)
  OR capture_id IN (SELECT capture_id FROM agentprof_skill_scope);
