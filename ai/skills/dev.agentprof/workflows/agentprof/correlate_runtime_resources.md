# Correlate AgentProf runtime resources

Use when recorded process CPU, RSS or JS-heap samples may explain a slow phase.
First initialize and select captures using
[investigate an agent run]($SKILL_ROOT/workflows/agentprof/investigate_agent_run.md).
Reuse the warm trace session.

## 1. Check actual resource coverage

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/runtime_summary.sql
```

Rows identify capture and counter-track IDs, metric, explicit unit, sample count,
first/last sample timestamps, minimum/maximum and sampled CPU time. No rows means
these resources were not recorded. Pi commonly records them; do not claim the
other harnesses do solely because they are supported by AgentProf.

RSS and JS heap are byte gauges, not allocations or memory attribution. A terminal
zero gauge ends a counter lifetime, not evidence memory was freed to zero. The
summary's gauge extrema use positive samples. CPU is **microseconds consumed
since the previous sample**, not a utilization percentage or cumulative counter.
Its sum covers sampled intervals only; it is not automatically full-run CPU time.
Closing/baseline samples and incomplete coverage must be called out.

## 2. Align samples with the measured phase

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/runtime_samples.sql
```

This returns the latest 200 timestamped samples. If the phase is older, narrow a
validated query over `counter` joined to `agentprof_skill_counter_tracks` by
track ID, using its capture ID and numeric timestamp bounds. Do not infer a peak
from an uninspected truncated sample window. Locate response/tool/turn IDs with
`slow_responses.sql`, `slow_tools.sql` or `slow_turns.sql` and report
sample spacing relative to the phase duration.

CPU samples describe the preceding sampling interval; use their previous sample
timestamp for overlap, not the sample instant as an execution span. Process-level
resource pressure can coincide with a tool/response without identifying its cause.
An external tool process may not be included in the harness's process samples.

For OS-thread detail, first discover actual process/thread tracks and available
scheduler or profile tables using
[querying.md]($SKILL_ROOT/infra-references/querying.md). AgentProf OS-thread spans
do not imply `sched`, per-thread CPU, runnable delay, CPU stacks or allocation
profiles were collected. Use existing generic Perfetto analysis only when those
data sources are present; scope by process/thread identity and machine, not PID
alone. Do not launch a new system recording without authorization.

## 3. Report

Name the resource peak or sampled CPU interval and the overlapping agent phase,
with capture/track IDs, timestamp range, units and coverage. Treat correlation as
a lead, not proof of CPU-bound execution, a memory leak or attribution to a model.
Follow the shared report/privacy rules.
