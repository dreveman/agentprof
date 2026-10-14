-- SPDX-License-Identifier: Apache-2.0
SELECT capture_id, kind, name AS operation,
  COALESCE(EXTRACT_ARG(arg_set_id, 'debug.timing'), 'recorded-span') AS timing,
  COUNT(*) AS calls, SUM(incomplete) AS incomplete,
  SUM(NOT incomplete AND dur >= 0) AS duration_samples,
  SUM(CASE WHEN NOT incomplete AND dur >= 0 THEN dur END) / 1e6 AS summed_work_ms,
  MAX(CASE WHEN NOT incomplete AND dur >= 0 THEN dur END) / 1e6 AS longest_ms,
  COUNT(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.is_error'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_tool_is_error'))) AS outcome_samples,
  SUM(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.is_error'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_tool_is_error')) = 1) AS errors
FROM agentprof_skill_slices WHERE kind IN ('tool-execution', 'script', 'model-call')
  AND capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
GROUP BY capture_id, kind, name, timing ORDER BY longest_ms DESC LIMIT 100;
