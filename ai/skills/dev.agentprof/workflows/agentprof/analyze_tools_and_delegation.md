# Analyze AgentProf tools and delegation

Use for slow tools, scripted calls, parallel work and child-agent relationships.
First initialize and select captures using
[investigate an agent run]($SKILL_ROOT/workflows/agentprof/investigate_agent_run.md).
Keep that session warm and its selection intact.

## 1. Find the expensive measured operations

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/tool_summary.sql
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/slow_tools.sql
```

The summary groups capture, operation kind/name and timing semantics. It reports
calls, incomplete and duration sample counts, summed completed work, longest
completed call, error and outcome counts. NULL outcomes are not success.
`summed_work_ms` is work volume, **not elapsed occupancy**. Use the shared
`run_summary.sql` for interval-union occupancy, parallel-tool time and peak
concurrency; coincident starts/ends do not inflate concurrency.

The slow-operation query returns at most 50 event IDs, timestamps, kinds, measured
durations, incomplete/error flags, parent-call IDs and script descendant counts.
It omits prompts, tool arguments, code and outputs. Separate actual execution
from hook/dispatch timing. An incomplete call has no measured completed duration.

Scripts enclose their nested work. Do not add script duration and descendant tool
durations as elapsed time. `model-call` containers may include queueing and
wrapper lifecycle work; they are not native model-response durations.

## 2. Inspect delegation without inventing dependencies

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/delegation.sql
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/child_launches.sql
```

The hierarchy query returns capture/root/parent IDs, subagent status, harness,
retained bounds and parent-child extent overlap. That is overlap of capture
**extents**, not proof of simultaneous productive work or a causal critical path.
A selected parent also includes its descendants. Parent links use capture-scoped
flows and unambiguous session/time evidence; unresolved or cyclic evidence must
not be forced into a tree.

The launch query reports recorded launch event IDs, timestamps, measured launch
lifecycle duration, incomplete flags and child session/role metadata. Launch
duration is not child execution duration. Session IDs alone cannot disambiguate
reused captures. Cross-check unavailable-child diagnostics in the inventory; a
missing child recording is not evidence that no child ran.

## 3. Report

Name the slow operations and timing semantics, failed/incomplete coverage, serial
versus overlapping measured execution, and resolved/unresolved worker relationships.
Identify a critical path only if recorded dependency edges actually establish it;
overlap or gaps alone do not. Suggestions such as batching or parallelizing are
hypotheses to test on equivalent work, not demonstrated speedups. Follow the
shared report/privacy rules; never dump tool content by default.
