# Investigate an AgentProf run

Use this workflow for “why was the agent slow?” or an unfamiliar AgentProf trace.
It analyzes existing recordings from Pi, Claude Code, Codex and Muse. It does not
launch a harness, call a model, record a session or upload a trace. If there is
no recording yet, first use
[capture a run]($SKILL_ROOT/workflows/agentprof/capture_an_agent_run.md) and
return here once it verifies the artifact.

If the trace is not already loaded, follow
[querying.md]($SKILL_ROOT/infra-references/querying.md) first and start the warm
session with the `dev.agentprof` PerfettoSQL package registered:

```bash
trace_processor server unix --name SESSION --daemonize \
  --add-sql-package $SKILL_ROOT/workflows/agentprof/stdlib/dev/agentprof@dev.agentprof \
  TRACE_FILE
```

*(If your `trace_processor` build already embeds `dev.agentprof.*`, omit
`--add-sql-package`; to test local module edits on an embedded binary, pass
`--dev --override-sql-package`.)* Use the trace session identifier in place of
`SESSION` below.

## 1. Inventory before interpreting

Load `dev.agentprof.captures` and inspect the per-capture coverage and health
inventory (mirrors the **Summary — Is the recording complete?** card in the
Agent Profiler UI):

```bash
trace_processor query --remote SESSION "
  INCLUDE PERFETTO MODULE dev.agentprof.captures;
  SELECT * FROM dev_agentprof_inventory LIMIT 100;
"
```

No inventory rows means `dev.agentprof.captures` found no supported AgentProf
events. Stop rather than invent agent metrics; generic Perfetto analysis may
still apply. If more than 100 captures exist, inspect
`SELECT COUNT(*) FROM dev_agentprof_capture_runs` and filter subsequent queries
with `WHERE capture_id IN (...)` using numeric IDs from the inventory (do not
interpolate prompt text into SQL). No prompt text or tool payloads are
materialized by the inventory or summary views.

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

## 2. Locate the measured time

Load `dev.agentprof.activity` to inspect interval-union occupancy per capture
(mirrors **Summary — What happened in this recording?**, **Where was time
spent?**, and **Was work happening in parallel?**):

```bash
trace_processor query --remote SESSION "
  INCLUDE PERFETTO MODULE dev.agentprof.activity;
  SELECT * FROM dev_agentprof_capture_occupancy LIMIT 100;
"
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

If prompt boundaries (`prompts > 0`) are recorded, load `dev.agentprof.turns` for
user-turn attribution (mirrors the **Turns** tab):

```bash
trace_processor query --remote SESSION "
  INCLUDE PERFETTO MODULE dev.agentprof.turns;
  SELECT
    prompt_id,
    capture_id,
    turn_number,
    incomplete,
    (display_end_ts - start_ts) / 1e6 AS observed_extent_ms,
    models_only_ns / 1e6 AS model_only_ms,
    tools_only_ns / 1e6 AS tool_only_ms,
    overlap_ns / 1e6 AS overlap_ms,
    unattributed_ns / 1e6 AS unattributed_ms,
    model_calls AS responses,
    unmatched_requests,
    tools,
    unknown_models,
    unknown_tools,
    input_tokens,
    output_tokens
  FROM dev_agentprof_turns
  ORDER BY display_end_ts - start_ts DESC, prompt_id
  LIMIT 20;
  SELECT * FROM dev_agentprof_turn_unassigned LIMIT 100;
"
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
