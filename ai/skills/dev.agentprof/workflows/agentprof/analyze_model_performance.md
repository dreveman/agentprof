# Analyze AgentProf model performance

Use for response latency, first-content latency, token throughput and model/provider
comparisons. First start the warm session and inspect capture scope using
[investigate an agent run]($SKILL_ROOT/workflows/agentprof/investigate_agent_run.md).
Filter with `WHERE capture_id IN (...)` when narrowing to specific captures.

## 1. Compare like measurements

Load `dev.agentprof.models` and query `dev_agentprof_model_cohorts` (mirrors the
**Summary — How responsive were model responses?** card and **Turns — Model
responses by provider and model**):

```bash
trace_processor query --remote SESSION "
  INCLUDE PERFETTO MODULE dev.agentprof.models;
  SELECT * FROM dev_agentprof_model_cohorts LIMIT 100;
"
```

Rows are grouped by capture, provider, raw model identity and recorded timing
semantics. Columns include response/incomplete counts, duration sample count,
mean/median/p95 duration, first-content mean/sample count, reported usage/sample
counts, and output-token throughput/sample count. Median is the middle value
(or mean of two middle values); p95 is nearest-rank. Small samples are descriptive,
not a reliable estimate of a population tail.

Only completed measured responses contribute to latency and throughput. Known
zero tokens are retained; unknown tokens are NULL. Throughput is reported output
tokens divided by the sum of eligible response durations, **not wall-clock output
rate** or streaming-only decode speed. Show its denominator and sample count.

Do not collapse timing groups:

- Pi generally records native response spans and first content.
- Claude can record request durations including retries; request placement may
  come from journal observations or native modifications.
- Codex plugin-only transcript completions report usage without measured model
  duration or first content. A timestamped completion is not a latency sample.
- Muse native durations do not imply first-content timestamps.

First content can include reasoning or tool-call data. It is not necessarily the
first visible text token. Provider input/cache accounting also differs: preserve
reported fields; do not assume a universal cache-hit denominator or sum cached
input into input totals twice. Pricing requires a separately verified rate table.

## 2. Inspect the slow responses and request phase

Query individual response spans in `dev_agentprof_messages` and recorded request
spans in `dev_agentprof_provider_requests`:

```bash
trace_processor query --remote SESSION "
  INCLUDE PERFETTO MODULE dev.agentprof.models;
  SELECT
    id,
    capture_id,
    provider,
    model,
    timing,
    message_start_ts AS ts,
    CASE WHEN NOT incomplete AND message_ns >= 0 THEN message_ns / 1e6 END AS duration_ms,
    CASE WHEN NOT incomplete AND first_ns >= 0 THEN first_ns / 1e6 END AS first_content_ms,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    incomplete
  FROM dev_agentprof_messages
  ORDER BY incomplete, message_ns DESC, id
  LIMIT 50;
  SELECT
    id,
    capture_id,
    ts,
    name,
    request_span_ms,
    phase,
    incomplete,
    timing
  FROM dev_agentprof_provider_requests
  ORDER BY dur DESC, id
  LIMIT 50;
"
```

Interpret a provider-request span as request-to-headers only when its `phase`
establishes that boundary; otherwise report the recorded request span without
inventing its end semantics. Request-to-headers is neither first content nor full
response duration. No rows means no such spans were recorded. Do not add request
spans to response duration or infer retry counts from a retries-inclusive label.

`model-call` script lifecycles are not native assistant responses; queueing and
wrapper work may be included. Their durations belong in
[tools and delegation]($SKILL_ROOT/workflows/agentprof/analyze_tools_and_delegation.md),
not this throughput denominator.

## 3. Report

State which provider/model/timing cohort dominates measured latency, the sample
counts and missing coverage, and specific response IDs to investigate. Distinguish
high first-content latency from a long overall response only where both are
recorded. Token volume and context may correlate with latency; these recordings
alone do not prove a provider bottleneck or task quality improvement. Follow the
shared report/privacy rules in the entry workflow.
