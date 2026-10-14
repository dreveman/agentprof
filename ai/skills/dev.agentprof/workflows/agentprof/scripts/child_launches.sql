-- SPDX-License-Identifier: Apache-2.0
SELECT
  id,
  capture_id,
  ts,
  name,
  incomplete,
  CASE WHEN NOT incomplete AND dur >= 0 THEN dur / 1e6 END AS launch_lifecycle_ms,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.child_session'),
    EXTRACT_ARG(arg_set_id, 'debug.childSession')
  ) AS child_session,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.subagent_type'),
    EXTRACT_ARG(arg_set_id, 'debug.subagentType'),
    EXTRACT_ARG(arg_set_id, 'debug.child_role'),
    EXTRACT_ARG(arg_set_id, 'debug.childRole'),
    EXTRACT_ARG(arg_set_id, 'debug.role')
  ) AS child_role
FROM agentprof_skill_slices
WHERE
  capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
  AND (category = 'pi.workflow'
  OR EXTRACT_ARG(arg_set_id, 'debug.delegation') = 1
  OR EXTRACT_ARG(arg_set_id, 'debug.child_session') IS NOT NULL
  OR EXTRACT_ARG(arg_set_id, 'debug.childSession') IS NOT NULL)
ORDER BY
  ts,
  id
LIMIT 100;
