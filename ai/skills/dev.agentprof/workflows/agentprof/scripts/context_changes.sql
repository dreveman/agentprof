-- SPDX-License-Identifier: Apache-2.0
SELECT snapshot_id, event_id, capture_id, ts, stage, basis, baseline,
  category, change, tokens, delta_tokens, previous_estimated_tokens, estimated_tokens,
  source_kind, tool
FROM agentprof_skill_context_changes
WHERE capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
ORDER BY ABS(delta_tokens) DESC, ts, event_id LIMIT 50;
