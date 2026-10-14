-- SPDX-License-Identifier: Apache-2.0
SELECT s.id, s.capture_id, s.ts, s.kind, s.name,
  CASE WHEN NOT s.incomplete AND s.dur >= 0 THEN s.dur / 1e6 END AS duration_ms,
  s.incomplete, s.is_error, EXTRACT_ARG(s.arg_set_id, 'debug.timing') AS timing,
  s.parent_call_id,
  (SELECT COUNT(DISTINCT c.id) FROM agentprof_skill_script_children c WHERE c.script_id = s.id) AS script_descendants
FROM agentprof_skill_tool_calls s
WHERE s.capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
ORDER BY s.incomplete DESC, s.dur DESC, s.id LIMIT 50;
