-- SPDX-License-Identifier: Apache-2.0
SELECT capture_id, kind, COUNT(*) AS unassigned_events,
  SUM(incomplete OR measured_ns IS NULL) AS unknown_or_incomplete
FROM agentprof_skill_turn_events WHERE prompt_id IS NULL
  AND capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
GROUP BY capture_id, kind ORDER BY capture_id, kind LIMIT 100;
