-- SPDX-License-Identifier: Apache-2.0
WITH RECURSIVE
  selected(capture_id) AS (
    SELECT capture_id FROM agentprof_skill_selected_captures
    UNION
    SELECT h.capture_id
    FROM agentprof_skill_capture_hierarchy AS h
    JOIN selected AS s
      ON h.parent_capture_id = s.capture_id
  )
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
FROM agentprof_skill_capture_runs AS c
JOIN agentprof_skill_capture_hierarchy AS h USING (capture_id)
LEFT JOIN agentprof_skill_capture_runs AS p
  ON p.capture_id = h.parent_capture_id
WHERE
  c.capture_id IN (SELECT capture_id FROM selected)
ORDER BY
  c.start_ts,
  c.capture_id
LIMIT 100;
