# Investigate an AgentProf run

Use this workflow for “why was the agent slow?” or an unfamiliar AgentProf trace.
It analyzes existing recordings from Pi, Claude Code, Codex and Muse. It does not
launch a harness, call a model, record a session or upload a trace.

If the trace is not already loaded, follow
[querying.md]($SKILL_ROOT/infra-references/querying.md) first. Keep that session warm.
For every workflow here, read Perfetto's environment setup before invoking its
commands; use the trace session identifier in place of SESSION below.

## 1. Inventory before interpreting

Initialize the namespaced reader and run the inventory:

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/agentprof_setup.sql
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/inventory.sql
```

Setup is self-contained SQL. No AgentProf checkout, UI or TypeScript is needed.
Run it once per trace session; rerunning resets only the workflow's
`agentprof_skill_*` objects and clears its capture selection. It does not replace
UI-owned `agentprof_*` tables. No prompt text or tool payloads are materialized.

No inventory rows means this reader found no supported AgentProf events. Stop
rather than invent agent metrics; generic Perfetto analysis may still apply.
The inventory returns at most 100 captures; if necessary inspect
`SELECT COUNT(*) FROM agentprof_skill_capture_runs` and narrow the scope.

Inspect:

- `capture_id` identifies a capture in this trace, not a globally stable ID.
  Keep captures separate even when session IDs, native IDs or PIDs repeat.
- `harness/provider/model/effort` are recorded configuration. A capture may
  contain multiple models; model-response rows give their actual identities.
- `measured_responses`, `first_content_samples`, `output_usage_samples`,
  `context_snapshots` and `runtime_metrics` describe observed coverage.
  Missing is not zero; do not infer capabilities solely from the harness name.
- Dropped events, lane overflows, incomplete work and unavailable children reduce
  confidence. NULL diagnostic counters mean not recorded, not “healthy”.
- `trace_clock_errors` is trace-wide, repeated for convenience. Zero reported
  errors does not establish cross-machine clock synchronization.

For a focused investigation, substitute numeric capture IDs from the inventory:

```sql
DELETE FROM agentprof_skill_scope;
INSERT INTO agentprof_skill_scope VALUES (CAPTURE_ID);
```

Execute that SQL with `trace_processor query --remote SESSION '...'`.
The query files do not substitute variables. An empty scope selects all captures;
multiple inserted IDs select several. Do not interpolate prompt text into SQL.

## 2. Locate the measured time

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/run_summary.sql
```

One row per capture reports `observed_extent_ms`, model-only and tool-only
occupancy, their overlap, script-only occupancy, unattributed time, tool
concurrency, reported token-counter peaks and context. The window covers retained
capture events plus measured response intervals, not the entire session or trace.
Script/model-call containers are not extra model responses or nested tool work.
Counter token peaks are not interchangeable with response-usage sums.

Occupancy uses interval unions, not summed durations. A large model-only share
means recorded responses dominate the measured activity—not proof of provider
compute time. Gaps are **unattributed**, not inferred thinking, queueing, approval
or waiting. Never extend an incomplete operation to the next prompt or trace end
and call that a measured duration.

If prompt boundaries are recorded, run the optional turn attribution:

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/agentprof_turns.sql
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/slow_turns.sql
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/unassigned_work.sql
```

A turn is one user-prompt interaction, not a native model/tool iteration. The top
20 rows retain recorded completed bounds; incomplete turns show only observed
extent. Unknown durations remain unknown. Attribution uses unique native identity,
explicit capture-scoped flows, ancestry, then unambiguous containment. Ambiguous
work stays unassigned; provider-request rows linked to responses are not counted
twice. Report unknown models/tools and unassigned counts alongside occupancy.

Without prompts, do not manufacture turns from iterations. Analyze recorded
responses and tools instead.

## 3. Drill into the strongest evidence

- Response latency/usage: [model performance]($SKILL_ROOT/workflows/agentprof/analyze_model_performance.md).
- Tool serialization, scripts or workers: [tools and delegation]($SKILL_ROOT/workflows/agentprof/analyze_tools_and_delegation.md).
- Context growth or compaction: [context pressure]($SKILL_ROOT/workflows/agentprof/analyze_context_pressure.md).
- Before/after or harness comparisons: [compare runs]($SKILL_ROOT/workflows/agentprof/compare_agent_runs.md).
- Recorded CPU/memory samples: [runtime resources]($SKILL_ROOT/workflows/agentprof/correlate_runtime_resources.md).

## Reporting and privacy

Save the evidence report following the shared Perfetto router. Include trace and
capture scope, measured numbers, coverage, event IDs/timestamp ranges, validated
SQL and remaining hypotheses. Separate observations from causal claims.

Default reports should contain counts and operational categories, not raw prompts,
commands, arguments or outputs. Metadata-only capture is not anonymization:
identifiers, names and paths may remain. Prefer capture-local numeric IDs in a
shareable report. Do not recover omitted content from transcripts or journals,
and do not upload artifacts without the user's authorization.
