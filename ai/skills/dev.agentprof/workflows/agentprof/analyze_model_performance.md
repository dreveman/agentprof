# Analyze AgentProf model performance

Use for response latency, first-content latency, token throughput and model/provider
comparisons. First initialize and select captures using
[investigate an agent run]($SKILL_ROOT/workflows/agentprof/investigate_agent_run.md).
Reuse that warm session and its scope; do not rerun setup unnecessarily.

## 1. Compare like measurements

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/model_summary.sql
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

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/slow_responses.sql
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/request_headers.sql
```

The first query returns at most 50 response IDs, start timestamps, timing labels,
measured duration/first content, reported tokens and incomplete flags. The second
returns up to 50 provider-request spans with recorded phase and timing labels.
Interpret a span as request-to-headers only when its phase establishes that
boundary; otherwise report the recorded request span without inventing its end
semantics. Request-to-headers is neither first content nor full response duration. No rows
means no such spans were recorded. Do not add request spans to response duration
or infer retry counts from a retries-inclusive label.

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
