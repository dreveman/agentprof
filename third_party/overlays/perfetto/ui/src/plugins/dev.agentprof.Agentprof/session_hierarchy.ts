// SPDX-License-Identifier: Apache-2.0

// Resolve captures rather than just session IDs: the same session may have
// several recordings. Ambiguous links and cycles must not hide any data.
export const SESSION_HIERARCHY_SQL = `
CREATE PERFETTO TABLE agentprof_session_captures AS
SELECT capture_id, session, MIN(ts) AS start_ts, MAX(ts + MAX(dur, 0)) AS end_ts,
  MAX(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.parent_session'), EXTRACT_ARG(arg_set_id, 'debug.parentSession'))) AS parent_session,
  MAX(COALESCE(EXTRACT_ARG(arg_set_id, 'debug.parent_session'), EXTRACT_ARG(arg_set_id, 'debug.parentSession')) IS NOT NULL OR
    COALESCE(EXTRACT_ARG(arg_set_id, 'debug.child_role'), EXTRACT_ARG(arg_set_id, 'debug.childRole')) IS NOT NULL) AS is_subagent
FROM agentprof_slices GROUP BY capture_id, session;

CREATE PERFETTO TABLE agentprof_capture_parents AS
WITH candidates AS (
  SELECT DISTINCT c.capture_id, p.capture_id AS parent_capture_id, 0 AS priority
  FROM flow f JOIN agentprof_slices p ON p.id = f.slice_out
  JOIN agentprof_slices c ON c.id = f.slice_in
  WHERE p.kind = 'tool-execution' AND c.name = 'prompt-input'
    AND p.capture_id != c.capture_id
  UNION
  SELECT c.capture_id, p.capture_id, 1 FROM agentprof_session_captures c
  JOIN agentprof_slices launch ON COALESCE(EXTRACT_ARG(launch.arg_set_id, 'debug.child_session'), EXTRACT_ARG(launch.arg_set_id, 'debug.childSession')) = c.session
  JOIN agentprof_session_captures p ON p.capture_id = launch.capture_id
  WHERE c.capture_id != p.capture_id
    AND (c.parent_session IS NULL OR c.parent_session = p.session)
    AND c.start_ts BETWEEN p.start_ts AND p.end_ts
  UNION
  SELECT c.capture_id, p.capture_id, 2 FROM agentprof_session_captures c
  JOIN agentprof_session_captures p ON p.session = c.parent_session
  WHERE c.capture_id != p.capture_id AND c.start_ts BETWEEN p.start_ts AND p.end_ts
), preferred AS (
  SELECT *, MIN(priority) OVER (PARTITION BY capture_id) AS best FROM candidates
)
SELECT capture_id, MIN(parent_capture_id) AS parent_capture_id
FROM preferred WHERE priority = best GROUP BY capture_id
HAVING COUNT(DISTINCT parent_capture_id) = 1;

CREATE PERFETTO TABLE agentprof_capture_hierarchy AS
WITH RECURSIVE ancestors(capture_id, ancestor_id) AS (
  SELECT capture_id, capture_id FROM agentprof_session_captures
  UNION
  SELECT a.capture_id, p.parent_capture_id FROM ancestors a
  JOIN agentprof_capture_parents p ON p.capture_id = a.ancestor_id
), roots AS (
  SELECT a.capture_id, MIN(a.ancestor_id) AS root_capture_id FROM ancestors a
  LEFT JOIN agentprof_capture_parents p ON p.capture_id = a.ancestor_id
  WHERE p.capture_id IS NULL GROUP BY a.capture_id
)
SELECT c.capture_id, COALESCE(r.root_capture_id, c.capture_id) AS root_capture_id,
  p.parent_capture_id,
  COALESCE(c.is_subagent, 0) OR p.parent_capture_id IS NOT NULL AS is_subagent
FROM agentprof_session_captures c LEFT JOIN roots r USING(capture_id)
LEFT JOIN agentprof_capture_parents p USING(capture_id);
`;
