-- SPDX-License-Identifier: Apache-2.0
SELECT id, capture_id, provider, model,
  EXTRACT_ARG(arg_set_id, 'debug.timing') AS timing,
  message_start_ts AS ts, CASE WHEN NOT incomplete AND message_ns >= 0 THEN message_ns / 1e6 END AS duration_ms,
  CASE WHEN NOT incomplete AND first_ns >= 0 THEN first_ns / 1e6 END AS first_content_ms,
  input_tokens, output_tokens, cache_read_tokens, incomplete
FROM agentprof_skill_messages
WHERE capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
ORDER BY incomplete, message_ns DESC, id LIMIT 50;
