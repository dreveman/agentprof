# Compare AgentProf runs

Use for before/after changes and comparisons across harnesses, models or workers.
Initialize each trace once using
[investigate an agent run]($SKILL_ROOT/workflows/agentprof/investigate_agent_run.md),
then retain one warm session per trace. Capture IDs are local to each trace.

## 1. Define an honest cohort

Before ranking, establish equivalent tasks, correctness criteria, model/provider,
effort, tool availability, initial context, cache/warm-up state, harness versions,
hardware and capture boundaries. Use recorded metadata and user-supplied labels;
when content is absent, do not infer task equivalence from session IDs or invent
it from timing. A successful tool call is not task correctness.

Keep selected capture IDs and trace aliases explicit. Compare complete matching
windows where possible; partial captures, missing child recordings, dropped events
or incompatible timing semantics require a restricted comparison or no ranking.
Do not silently roll child token totals or context into the parent.

## 2. Collect identical scorecards

Run these for each selected session/scope:

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/inventory.sql
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/run_summary.sql
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/model_summary.sql
```

Compare observed extent, prompt/response/tool counts, measured occupancy and
concurrency, reported token-counter peaks, response usage and measurement sample
counts, and peak context/window. Preserve counter peaks versus response usage and
per-provider timing groups. Codex plugin-only captures cannot enter a measured
model-latency ranking. Missing metrics stay “unavailable”, not zero.

For repeated equivalent runs, report sample count, median and range per condition;
show per-run values before aggregation. For a single run, report an observed delta,
not a statistically established improvement. Do not combine percentiles from
separate cohorts or present throughput as task quality.

## 3. Check cross-session time alignment only if needed

Duration-only comparisons need no shared timeline. For simultaneous recordings,
clock snapshots map BOOTTIME/monotonic event domains to system CLOCK_REALTIME;
they do not correct machine realtime skew. Verify machine identity/clock coverage
and synchronization assumptions before asserting cross-machine ordering or overlap.
Inventory clock errors are trace-wide; zero errors is not proof of synchronized
hosts. Never join unrelated processes by raw PID/TID alone.

## 4. Report

Provide a comparison table with trace/capture scope, task-equivalence evidence,
configuration differences, coverage and comparable measured metrics. State which
conclusions are supported, which remain confounded and what controlled recording
would discriminate them. Do not automatically launch that recording or call a
model. Follow the shared report/privacy rules.
