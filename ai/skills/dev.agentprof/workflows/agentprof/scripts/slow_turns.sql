-- SPDX-License-Identifier: Apache-2.0
SELECT
  prompt_id,
  capture_id,
  turn_number,
  incomplete,
  (display_end_ts - start_ts) / 1e6 AS observed_extent_ms,
  models_only_ns / 1e6 AS model_only_ms,
  tools_only_ns / 1e6 AS tool_only_ms,
  overlap_ns / 1e6 AS overlap_ms,
  unattributed_ns / 1e6 AS unattributed_ms,
  model_calls AS responses,
  unmatched_requests,
  tools,
  unknown_models,
  unknown_tools,
  input_tokens,
  output_tokens
FROM agentprof_skill_turns
WHERE
  capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
ORDER BY
  display_end_ts - start_ts DESC,
  prompt_id
LIMIT 20;
