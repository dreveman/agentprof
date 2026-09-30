// SPDX-License-Identifier: Apache-2.0

import {COUNTER_TRACKS_SQL} from './track_names';

// Keep the query model usable by both the UI and Trace Processor validation.
export const SETUP_SQL = `
CREATE PERFETTO TABLE agentprof_track_process AS
WITH RECURSIVE ancestry(track_id, ancestor_id) AS (
  SELECT id, id FROM track
  UNION
  SELECT a.track_id, t.parent_id FROM ancestry a
  JOIN track t ON t.id = a.ancestor_id WHERE t.parent_id IS NOT NULL
)
SELECT a.track_id, MAX(COALESCE(p.upid, c.upid, th.upid)) AS upid,
  COALESCE(MAX(CASE WHEN t.name = 'agentprof.capture' THEN t.id END),
    -1 - MAX(COALESCE(p.upid, c.upid, th.upid)), -1 - a.track_id) AS capture_id
FROM ancestry a JOIN track t ON t.id = a.ancestor_id
LEFT JOIN process_track p ON p.id = a.ancestor_id
LEFT JOIN process_counter_track c ON c.id = a.ancestor_id
LEFT JOIN thread_track tt ON tt.id = a.ancestor_id
LEFT JOIN thread th ON th.utid = tt.utid
GROUP BY a.track_id;

${COUNTER_TRACKS_SQL}

-- OS thread tracks are shared by captures and have no capture parent. Join
-- their capture spans to the generic capture track using its recorded UUID.
CREATE PERFETTO TABLE agentprof_capture_markers AS
SELECT s.id AS slice_id, COALESCE(root.id, m.capture_id) AS capture_id,
  COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.capture_id'), EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_capture_id')) AS recorded_id,
  COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.session_id'), EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_session_id')) AS session_id,
  COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.label'), EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_capture_label')) AS label
FROM slice s JOIN agentprof_track_process m ON m.track_id = s.track_id
LEFT JOIN track root ON root.name = 'agentprof.capture'
  AND printf('%x', EXTRACT_ARG(root.source_arg_set_id, 'trace_id')) =
    COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.capture_id'), EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_capture_id'))
WHERE s.category = 'pi.metadata' AND (s.name IN ('tracing', 'tracing-start')
  OR s.name GLOB 'profile ([0-9]*)');

CREATE PERFETTO TABLE agentprof_captures AS
SELECT capture_id, MAX(recorded_id) AS recorded_id, MAX(session_id) AS session_id,
  MAX(label) AS label FROM agentprof_capture_markers GROUP BY capture_id;

CREATE PERFETTO TABLE agentprof_slice_capture AS
WITH RECURSIVE captured(id, capture_id) AS (
  SELECT slice_id, capture_id FROM agentprof_capture_markers
  UNION ALL
  SELECT s.id, c.capture_id FROM slice s JOIN captured c ON s.parent_id = c.id
)
SELECT * FROM captured;

CREATE PERFETTO TABLE agentprof_slices AS
SELECT s.*, COALESCE(t.name, th.name || ' ' || th.tid, 'Thread ' || th.tid) AS track_name,
  m.upid, tt.utid, COALESCE(sc.capture_id, m.capture_id) AS capture_id,
  COALESCE(cap.label, SUBSTR(cap.recorded_id, 1, 8), 'Legacy capture') AS capture,
  COALESCE(cap.session_id, (SELECT SUBSTR(a.string_value, 9) FROM args a
    WHERE a.arg_set_id = p.arg_set_id AND a.key GLOB 'chrome.process_label*'
      AND a.string_value GLOB 'session:*' LIMIT 1),
    'process ' || COALESCE(CAST(m.upid AS TEXT), 'unknown')) AS session,
  COALESCE(COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.kind'), EXTRACT_ARG(s.arg_set_id, 'debug.agentprof_event_kind')),
    CASE
      WHEN s.category = 'pi.agent' AND s.name = 'turn' THEN 'turn'
      WHEN s.category = 'pi.llm' AND s.name IN ('request', 'provider-request') THEN 'provider-request'
      WHEN s.category = 'pi.tools' AND (t.name IN ('tools', 'Tools') OR t.name GLOB 'tools.lane.*') THEN 'tool-execution'
      WHEN s.category = 'pi.llm' AND s.name GLOB 'assistant ttft=*' THEN 'assistant-message'
      ELSE 'other'
    END) AS kind,
  (s.dur < 0 OR COALESCE(COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.incomplete'), EXTRACT_ARG(s.arg_set_id, 'debug.pi_tracing_incomplete')), 0)
    OR COALESCE(COALESCE(EXTRACT_ARG(s.arg_set_id, 'debug.incomplete'), EXTRACT_ARG(s.arg_set_id, 'debug.pi_tracing_providerIncomplete')), 0)) AS incomplete
FROM slice s JOIN track t ON t.id = s.track_id
LEFT JOIN agentprof_track_process m ON m.track_id = t.id
LEFT JOIN thread_track tt ON tt.id = t.id
LEFT JOIN thread th ON th.utid = tt.utid
LEFT JOIN agentprof_slice_capture sc ON sc.id = s.id
LEFT JOIN process p ON p.upid = m.upid
LEFT JOIN agentprof_captures cap ON cap.capture_id = COALESCE(sc.capture_id, m.capture_id)
WHERE s.category GLOB 'pi.*';
`;

export const QUERIES = {
  'Operation summary': `
    SELECT session, kind, COUNT(*) AS events, SUM(incomplete) AS incomplete,
      ROUND(SUM(CASE WHEN NOT incomplete THEN dur END) / 1e6, 3) AS completed_work_ms,
      ROUND(MAX(CASE WHEN NOT incomplete THEN dur END) / 1e6, 3) AS longest_completed_ms
    FROM agentprof_slices
    WHERE kind IN ('turn', 'provider-request', 'tool-execution')
    GROUP BY capture_id, session, kind ORDER BY session, kind`,
  'Slow tools': `
    SELECT id, ts, session, name AS tool, ROUND(dur / 1e6, 3) AS duration_ms,
      incomplete, COALESCE(EXTRACT_ARG(arg_set_id, 'debug.is_error'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_tool_is_error')) AS is_error,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.call_id'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_tool_call_id')) AS tool_call_id
    FROM agentprof_slices WHERE kind = 'tool-execution' ORDER BY dur DESC`,
  'Responses': `
    SELECT id, ts, session,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.provider'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_provider')) AS provider,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.model'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_model')) AS model,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.first_content_ns'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_stream_first_content_ns')) / 1e6 AS first_content_ms,
      CASE WHEN dur > 0 THEN dur ELSE
        COALESCE(EXTRACT_ARG(arg_set_id, 'debug.duration_ns'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_stream_duration_ns')) END / 1e6 AS message_duration_ms,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.input_tokens'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_input')) AS input_tokens,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.output_tokens'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_output')) AS output_tokens,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.cache_read_tokens'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_cacheRead')) AS cache_read_tokens,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.cache_write_tokens'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_cacheWrite')) AS cache_write_tokens,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.stop_reason'), EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_stopReason')) AS stop_reason
    FROM agentprof_slices WHERE kind = 'assistant-message' ORDER BY ts`,
  'Child launches': `
    SELECT id, ts, session, name, dur / 1e6 AS launch_duration_ms, incomplete,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.child_session'), EXTRACT_ARG(arg_set_id, 'debug.childSession')) AS child_session,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.subagent_type'), EXTRACT_ARG(arg_set_id, 'debug.subagentType')) AS child_role,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.parent_session'), EXTRACT_ARG(arg_set_id, 'debug.parentSession')) AS parent_session,
      EXTRACT_ARG(arg_set_id, 'debug.correlation') AS correlation
    FROM agentprof_slices WHERE category = 'pi.workflow'
      OR EXTRACT_ARG(arg_set_id, 'debug.delegation') = 1 ORDER BY ts`,
  'Capture health': `
    SELECT t.id AS track_id, t.display_name AS name, MAX(c.value) AS maximum_recorded_value
    FROM counter c JOIN agentprof_counter_tracks t ON t.id = c.track_id
    WHERE t.name IN ('tracing.droppedEvents', 'tracing.laneOverflows')
    GROUP BY t.id, t.name
    ORDER BY track_id`,
} as const;
