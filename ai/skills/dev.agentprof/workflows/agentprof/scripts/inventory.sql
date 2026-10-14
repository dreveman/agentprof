-- SPDX-License-Identifier: Apache-2.0
SELECT
  r.capture_id,
  r.session,
  r.capture,
  r.harness,
  r.provider,
  r.model,
  r.effort,
  r.context_window_tokens,
  r.duration_ms AS retained_extent_ms,
  r.turns AS prompts,
  r.responses,
  r.tools,
  r.incomplete,
  (
    SELECT COUNT(*)
    FROM agentprof_skill_messages AS m
    WHERE
      m.capture_id = r.capture_id
      AND NOT incomplete
      AND message_ns >= 0
  ) AS measured_responses,
  (
    SELECT COUNT(*)
    FROM agentprof_skill_messages AS m
    WHERE
      m.capture_id = r.capture_id
      AND NOT incomplete
      AND first_ns >= 0
  ) AS first_content_samples,
  (
    SELECT COUNT(output_tokens)
    FROM agentprof_skill_messages AS m
    WHERE
      m.capture_id = r.capture_id
  ) AS output_usage_samples,
  (
    SELECT COUNT(*)
    FROM agentprof_skill_context_snapshots AS c
    WHERE
      c.capture_id = r.capture_id
  ) AS context_snapshots,
  (
    SELECT COUNT(DISTINCT t.name)
    FROM agentprof_skill_counter_tracks AS t
    WHERE
      t.capture_id = r.capture_id
      AND t.name IN ('runtime.rss', 'runtime.heap', 'runtime.cpu')
  ) AS runtime_metrics,
  (
    SELECT MAX(c.value)
    FROM counter AS c
    JOIN agentprof_skill_counter_tracks AS t
      ON t.id = c.track_id
    WHERE
      t.capture_id = r.capture_id
      AND t.name = 'tracing.droppedEvents'
  ) AS dropped_events,
  (
    SELECT MAX(c.value)
    FROM counter AS c
    JOIN agentprof_skill_counter_tracks AS t
      ON t.id = c.track_id
    WHERE
      t.capture_id = r.capture_id
      AND t.name = 'tracing.laneOverflows'
  ) AS lane_overflows,
  (
    SELECT MAX(c.value)
    FROM counter AS c
    JOIN agentprof_skill_counter_tracks AS t
      ON t.id = c.track_id
    WHERE
      t.capture_id = r.capture_id
      AND t.name = 'tracing.queueDepth'
  ) AS queue_depth_peak,
  (
    SELECT SUM(EXTRACT_ARG(s.arg_set_id, 'debug.unavailable_child_sessions'))
    FROM agentprof_skill_slices AS s
    WHERE
      s.capture_id = r.capture_id
      AND s.kind = 'capture'
  ) AS unavailable_children,
  (
    SELECT COUNT(DISTINCT COALESCE(t.machine_id, 0))
    FROM agentprof_skill_slices AS s
    JOIN track AS t
      ON t.id = s.track_id
    WHERE
      s.capture_id = r.capture_id
  ) AS machines,
  (
    SELECT COALESCE(SUM(value), 0)
    FROM stats
    WHERE
      name IN (
        'clock_sync_failure_no_path',
        'clock_sync_failure_undeferrable_packet_loss',
        'clock_sync_unrelatable_clock_domains',
        'trace_sorter_negative_timestamp_dropped',
        'invalid_clock_snapshots'
      )
  ) AS trace_clock_errors
FROM agentprof_skill_selected_captures AS r
ORDER BY
  r.start_ts,
  r.capture_id
LIMIT 100;
