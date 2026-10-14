-- SPDX-License-Identifier: Apache-2.0
SELECT
  id,
  capture_id,
  ts,
  name,
  CASE WHEN NOT incomplete AND dur >= 0 THEN dur / 1e6 END AS request_span_ms,
  EXTRACT_ARG(arg_set_id, 'debug.phase') AS phase,
  incomplete,
  EXTRACT_ARG(arg_set_id, 'debug.timing') AS timing
FROM agentprof_skill_slices
WHERE
  kind = 'provider-request'
  AND capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
ORDER BY
  dur DESC,
  id
LIMIT 50;
