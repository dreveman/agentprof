-- SPDX-License-Identifier: Apache-2.0
WITH ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY capture_id ORDER BY ts DESC, event_id DESC) AS rank
  FROM agentprof_skill_context_snapshots
)
SELECT r.capture_id, r.peak_context, r.context_window_tokens, r.context_share,
  c.event_id AS latest_snapshot_id, c.ts AS latest_snapshot_ts, c.stage, c.basis, c.coverage,
  c.model AS snapshot_model, c.estimated_tokens, c.reported_tokens, c.window_tokens,
  c.effective_window_tokens, c.compact_threshold_tokens, c.omitted_changes, c.categories,
  (SELECT COUNT(*) FROM agentprof_skill_context_snapshots s WHERE s.capture_id = r.capture_id) AS snapshots,
  (SELECT COUNT(*) FROM agentprof_skill_context_changes s WHERE s.capture_id = r.capture_id) AS retained_changes
FROM agentprof_skill_selected_captures r LEFT JOIN ranked c ON c.capture_id = r.capture_id AND c.rank = 1
ORDER BY r.start_ts, r.capture_id LIMIT 100;
