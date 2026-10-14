-- SPDX-License-Identifier: Apache-2.0
SELECT t.capture_id, t.id AS track_id, c.ts, t.display_name AS metric, c.value,
  CASE WHEN t.name = 'runtime.cpu' THEN 'us consumed since previous sample' ELSE 'bytes' END AS unit
FROM counter c JOIN agentprof_skill_counter_tracks t ON t.id = c.track_id
WHERE t.name IN ('runtime.rss', 'runtime.heap', 'runtime.cpu')
  AND t.capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
ORDER BY c.ts DESC, t.id LIMIT 200;
