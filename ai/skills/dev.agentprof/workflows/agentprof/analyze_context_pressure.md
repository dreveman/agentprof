# Analyze AgentProf context pressure

Use for context growth, model-window pressure, composition changes and compaction.
First start the warm session and inspect capture scope using
[investigate an agent run]($SKILL_ROOT/workflows/agentprof/investigate_agent_run.md).
Filter with `WHERE capture_id IN (...)` when narrowing to specific captures.

## 1. Establish measurement basis and coverage

Load `dev.agentprof.context` and query `dev_agentprof_context_summary` (mirrors
**Summary — What filled the context?** and the **Context** tab):

```bash
trace_processor query --remote SESSION "
  INCLUDE PERFETTO MODULE dev.agentprof.context;
  SELECT * FROM dev_agentprof_context_summary LIMIT 100;
"
```

One row per capture reports its recorded peak/window/share plus the latest
snapshot's ID, timestamp, stage, model, basis, coverage, estimated/reported totals,
configured/effective window, compaction threshold, omitted changes and category
composition. Show the snapshot timestamp: it may be stale relative to the peak.
Do not present latest composition as the composition at peak pressure.

No snapshots (`snapshots = 0`) means detailed context composition is unavailable.
A recorded context counter peak can still be useful; NULL is not an empty context.
Estimated tokens may be character-based and are not tokenizer-exact.
Provider-reported input usage, estimated retained context and cumulative input
counters are different quantities. Model window/share is usable only when its
window is unambiguous and positive. Do not sum independent child-agent context
windows.

## 2. Explain changes and compaction

Query the largest item-level context deltas in `dev_agentprof_context_changes` and
compaction spans in `dev_agentprof_compactions`:

```bash
trace_processor query --remote SESSION "
  INCLUDE PERFETTO MODULE dev.agentprof.context;
  SELECT
    snapshot_id,
    event_id,
    capture_id,
    ts,
    stage,
    basis,
    baseline,
    category,
    change,
    tokens,
    delta_tokens,
    previous_estimated_tokens,
    estimated_tokens,
    source_kind,
    tool
  FROM dev_agentprof_context_changes
  ORDER BY ABS(delta_tokens) DESC, ts, event_id
  LIMIT 50;
  SELECT
    event_id,
    capture_id,
    ts,
    incomplete,
    duration_ms,
    before_tokens,
    after_tokens
  FROM dev_agentprof_compactions
  ORDER BY ts, event_id
  LIMIT 100;
"
```

The top 50 retained changes report signed deltas, category/change type, basis,
baseline, previous/current estimates and source operation where recorded. Preserve
negative changes and baseline resets. Do not subtract estimates across basis
changes; omitted changes prevent a complete item-level reconciliation. Item labels
and content are excluded from `dev_agentprof_context_changes`.

Compactions report event IDs/timestamps, incomplete status, measured completed
duration and before/after tokens. NULL or incomplete duration is not zero. Where
both totals use comparable recorded semantics, compute reduction and report the
compaction's time cost. A smaller context does not by itself prove faster inference
or preserved task quality.

## 3. Report

State peak pressure and the window definition, snapshot coverage/basis, largest
supported growth/removal categories, and compaction trade-offs. For latency
correlation, inspect model-response IDs in the same capture; sparse snapshots do
not establish the exact context submitted with every request. Follow shared
report/privacy rules. Do not recover omitted content from harness journals.
