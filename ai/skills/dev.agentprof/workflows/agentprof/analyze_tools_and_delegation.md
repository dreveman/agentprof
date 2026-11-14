# Analyze AgentProf tools and delegation

Use for slow tools, scripted calls, parallel work and child-agent relationships.
First start the warm session and inspect capture scope using
[investigate an agent run]($SKILL_ROOT/workflows/agentprof/investigate_agent_run.md).
Filter with `WHERE capture_id IN (...)` when narrowing to specific captures.

## 1. Find the expensive measured operations

Load `dev.agentprof.tools` to inspect aggregated operation work and the slowest /
incomplete calls (mirrors the **Tools** tab and **Summary — Which tools took the
most time?**):

```bash
trace_processor query --remote SESSION "
  INCLUDE PERFETTO MODULE dev.agentprof.tools;
  SELECT * FROM dev_agentprof_tool_summary LIMIT 100;
  SELECT
    s.id,
    s.capture_id,
    s.ts,
    s.kind,
    s.name,
    CASE WHEN NOT s.incomplete AND s.dur >= 0 THEN s.dur / 1e6 END AS duration_ms,
    s.incomplete,
    s.is_error,
    s.timing,
    s.parent_call_id,
    (
      SELECT COUNT(DISTINCT c.id)
      FROM dev_agentprof_script_children AS c
      WHERE c.script_id = s.id
    ) AS script_descendants
  FROM dev_agentprof_tool_calls AS s
  ORDER BY s.incomplete DESC, s.dur DESC, s.id
  LIMIT 50;
"
```

`dev_agentprof_tool_summary` groups capture, operation kind/name and timing
semantics. It reports calls, incomplete and duration sample counts, summed
completed work, longest completed call, error and outcome counts. NULL outcomes
are not success. `summed_work_ms` is work volume, **not elapsed occupancy** —
use `dev_agentprof_capture_occupancy` (`dev.agentprof.activity`) for
interval-union occupancy, parallel-tool time and peak concurrency.

`dev_agentprof_tool_calls` omits prompts, tool arguments, code and outputs by
default. Separate actual execution from hook/dispatch timing. An incomplete call
has no measured completed duration. Scripts enclose their nested work: do not add
script duration and descendant tool durations as elapsed time. `model-call`
containers may include queueing and wrapper lifecycle work; they are not native
model-response durations.

## 2. Inspect delegation without inventing dependencies

Load `dev.agentprof.sessions` to inspect resolved parent/subagent hierarchy
bounds and recorded child-agent launch spans (mirrors the **Sessions** tab):

```bash
trace_processor query --remote SESSION "
  INCLUDE PERFETTO MODULE dev.agentprof.sessions;
  SELECT * FROM dev_agentprof_delegation LIMIT 100;
  SELECT
    id,
    capture_id,
    ts,
    name,
    incomplete,
    launch_lifecycle_ms,
    child_session,
    child_role
  FROM dev_agentprof_child_launches
  LIMIT 100;
"
```

`dev_agentprof_delegation` returns capture/root/parent IDs, subagent status,
harness, retained bounds and `parent_child_extent_overlap_ms`. That is overlap of
capture **extents**, not proof of simultaneous productive work or a causal
critical path. Parent links use capture-scoped flows and unambiguous session/time
evidence; unresolved or cyclic evidence is kept as independent roots rather than
forced into a tree. When filtering a parent capture, walk
`dev_agentprof_capture_hierarchy` recursively if you want its descendants too.

`dev_agentprof_child_launches` reports launch event IDs, timestamps, measured
launch lifecycle duration, incomplete flags and child session/role metadata.
Launch duration is not child execution duration. Cross-check
`unavailable_children` in `dev_agentprof_inventory`; a missing child recording is
not evidence that no child ran.

## 3. Report

Name the slow operations and timing semantics, failed/incomplete coverage, serial
versus overlapping measured execution, and resolved/unresolved worker relationships.
Identify a critical path only if recorded dependency edges actually establish it;
overlap or gaps alone do not. Suggestions such as batching or parallelizing are
hypotheses to test on equivalent work, not demonstrated speedups. Follow the
shared report/privacy rules; never dump tool content by default.
