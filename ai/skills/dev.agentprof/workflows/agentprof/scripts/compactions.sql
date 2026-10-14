-- SPDX-License-Identifier: Apache-2.0
SELECT id AS event_id, capture_id, ts, incomplete,
  CASE WHEN NOT incomplete AND dur >= 0 THEN dur / 1e6 END AS duration_ms,
  COALESCE(EXTRACT_ARG(arg_set_id, 'debug.pre_tokens'), EXTRACT_ARG(arg_set_id, 'debug.tokens_before')) AS before_tokens,
  COALESCE(EXTRACT_ARG(arg_set_id, 'debug.post_tokens'), EXTRACT_ARG(arg_set_id, 'debug.tokens_after')) AS after_tokens
FROM agentprof_skill_slices WHERE kind = 'compaction'
  AND capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
ORDER BY ts, id LIMIT 100;
