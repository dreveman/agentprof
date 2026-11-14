-- SPDX-License-Identifier: Apache-2.0

-- AgentProf tool executions, agent-written scripts (codemode), nested calls,
-- and lazy payload projections.

INCLUDE PERFETTO MODULE dev.agentprof.captures;

-- Older recordings kept tool metadata on preflight rather than execution spans.
CREATE PERFETTO TABLE _dev_agentprof_tool_preflights AS
SELECT
  capture_id,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.call_id'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_tool_call_id')
  ) AS call_id,
  MAX(id) AS id
FROM dev_agentprof_slices
WHERE
  name = 'tool-preflight'
GROUP BY
  capture_id,
  call_id;

-- Core tool, script, and scripted model-call spans (no raw argument payloads).
CREATE PERFETTO TABLE dev_agentprof_tool_calls AS
SELECT
  s.*,
  p.arg_set_id AS preflight_arg_set_id,
  COALESCE(
    EXTRACT_ARG(s.arg_set_id, 'debug.call_id'),
    EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_tool_call_id')
  ) AS call_id,
  EXTRACT_ARG(s.arg_set_id, 'debug.parent_call_id') AS parent_call_id,
  COALESCE(
    EXTRACT_ARG(s.arg_set_id, 'debug.is_error'),
    EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_tool_is_error')
  ) AS is_error,
  COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.timing'), 'recorded-span') AS timing,
  COALESCE(
    NULLIF(EXTRACT_ARG(s.arg_set_id, 'debug.language'), ''),
    CASE
      WHEN s.kind = 'script'
      AND s.name = 'codemode'
      AND s.category = 'pi.tools' THEN 'JavaScript'
    END
  ) AS language,
  EXTRACT_ARG(s.arg_set_id, 'debug.line_count') AS line_count,
  COALESCE(
    EXTRACT_ARG(s.arg_set_id, 'debug.args_truncated'),
    EXTRACT_ARG(p.arg_set_id, 'debug.truncated'),
    0
  ) AS args_truncated
FROM dev_agentprof_slices AS s
LEFT JOIN _dev_agentprof_tool_preflights AS pf
  ON pf.capture_id = s.capture_id
  AND pf.call_id
  = COALESCE(
    EXTRACT_ARG(s.arg_set_id, 'debug.call_id'),
    EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_tool_call_id')
  )
LEFT JOIN dev_agentprof_slices AS p
  ON p.id = pf.id
WHERE
  s.kind IN ('tool-execution', 'script', 'model-call');

-- Transitive nested calls executed inside agent-written scripts (depth <= 32).
CREATE PERFETTO TABLE dev_agentprof_script_children AS
WITH RECURSIVE
  children(script_id, id, depth) AS (
    SELECT p.id, c.id, 1
    FROM dev_agentprof_tool_calls AS p
    JOIN dev_agentprof_tool_calls AS c
      ON c.capture_id = p.capture_id
      AND c.parent_call_id = p.call_id
    WHERE
      p.kind = 'script'
      AND c.id != p.id
    UNION ALL
    SELECT c.script_id, next.id, c.depth + 1
    FROM children AS c
    JOIN dev_agentprof_tool_calls AS p
      ON p.id = c.id
    JOIN dev_agentprof_tool_calls AS next
      ON next.capture_id = p.capture_id
      AND next.parent_call_id = p.call_id
    WHERE
      next.id != p.id
      AND c.depth < 32
  )
SELECT * FROM children;

-- Lazy detail projection adding intent and JSON-grouped arguments only for
-- queried rows (used by bounded UI tables without materializing payloads in CLI
-- workflows).
CREATE PERFETTO VIEW dev_agentprof_tool_call_details AS
SELECT
  t.*,
  COALESCE(
    NULLIF(TRIM(EXTRACT_ARG(t.arg_set_id, 'debug.intent')), ''),
    NULLIF(TRIM(EXTRACT_ARG(t.preflight_arg_set_id, 'debug.intent')), '')
  ) AS intent,
  COALESCE(
    (
      SELECT
        JSON_GROUP_OBJECT(
          CASE
            WHEN a.key = 'debug.args' THEN 'value'
            WHEN a.key GLOB 'debug.args[[]*' THEN SUBSTR(a.key, 11)
            ELSE SUBSTR(a.key, 12)
          END,
          a.display_value
        )
      FROM args AS a
      WHERE
        a.arg_set_id = t.arg_set_id
        AND (a.key = 'debug.args'
        OR a.key GLOB 'debug.args.*'
        OR a.key GLOB 'debug.args[[]*')
      GROUP BY
        a.arg_set_id
    ),
    (
      SELECT
        JSON_GROUP_OBJECT(
          CASE
            WHEN a.key = 'debug.args' THEN 'value'
            WHEN a.key GLOB 'debug.args[[]*' THEN SUBSTR(a.key, 11)
            ELSE SUBSTR(a.key, 12)
          END,
          a.display_value
        )
      FROM args AS a
      WHERE
        a.arg_set_id = t.preflight_arg_set_id
        AND (a.key = 'debug.args'
        OR a.key GLOB 'debug.args.*'
        OR a.key GLOB 'debug.args[[]*')
      GROUP BY
        a.arg_set_id
    )
  ) AS arguments
FROM dev_agentprof_tool_calls AS t;

-- Trace-wide tool execution summary for the Overview UI.
CREATE PERFETTO VIEW dev_agentprof_tools_overview AS
SELECT
  name AS tool,
  COUNT(*) AS calls,
  SUM(CASE WHEN NOT incomplete THEN dur END) / 1e6 AS work_ms,
  MAX(CASE WHEN NOT incomplete THEN dur END) / 1e6 AS longest_ms,
  SUM(is_error = 1) AS errors,
  COUNT(is_error) AS outcomes,
  SUM(incomplete) AS incomplete
FROM dev_agentprof_tool_calls
WHERE
  kind = 'tool-execution'
GROUP BY
  name
ORDER BY
  work_ms DESC;

-- Per-capture, kind, operation, and timing summary for analysis workflows.
CREATE PERFETTO VIEW dev_agentprof_tool_summary AS
SELECT
  capture_id,
  kind,
  name AS operation,
  timing,
  COUNT(*) AS calls,
  SUM(incomplete) AS incomplete,
  SUM(NOT incomplete AND dur >= 0) AS duration_samples,
  SUM(CASE WHEN NOT incomplete AND dur >= 0 THEN dur END) / 1e6 AS summed_work_ms,
  MAX(CASE WHEN NOT incomplete AND dur >= 0 THEN dur END) / 1e6 AS longest_ms,
  COUNT(is_error) AS outcome_samples,
  SUM(is_error = 1) AS errors
FROM dev_agentprof_tool_calls
GROUP BY
  capture_id,
  kind,
  name,
  timing
ORDER BY
  longest_ms DESC;

-- Agent-written scripts with nested-call counts (up to 100 scripts in UI).
CREATE PERFETTO VIEW dev_agentprof_scripts AS
SELECT
  p.id,
  p.capture_id,
  p.ts,
  p.name AS script,
  CASE WHEN p.dur >= 0 THEN p.dur / 1e6 END AS duration_ms,
  p.is_error,
  p.incomplete,
  p.intent,
  p.arguments,
  p.args_truncated,
  p.kind,
  p.language,
  p.line_count,
  COUNT(c.id) AS calls
FROM dev_agentprof_tool_call_details AS p
LEFT JOIN dev_agentprof_script_children AS c
  ON c.script_id = p.id
WHERE
  p.kind = 'script'
GROUP BY
  p.id
ORDER BY
  p.ts;

-- Nested calls executed within agent-written scripts.
CREATE PERFETTO VIEW dev_agentprof_script_calls AS
SELECT
  c.script_id,
  t.id,
  t.ts,
  t.name AS tool,
  c.depth,
  t.kind,
  CASE WHEN t.dur >= 0 THEN t.dur / 1e6 END AS duration_ms,
  t.is_error,
  t.incomplete,
  t.intent,
  t.arguments,
  t.args_truncated,
  t.language,
  t.line_count
FROM dev_agentprof_script_children AS c
JOIN dev_agentprof_tool_call_details AS t
  ON t.id = c.id
ORDER BY
  c.script_id,
  t.ts,
  t.id;
