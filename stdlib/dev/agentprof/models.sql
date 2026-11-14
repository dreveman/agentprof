-- SPDX-License-Identifier: Apache-2.0

-- AgentProf assistant model responses, provider-request spans, and latency /
-- token-throughput aggregations.

INCLUDE PERFETTO MODULE dev.agentprof.captures;

-- Normalized assistant model response spans and token usage.
CREATE PERFETTO TABLE dev_agentprof_messages AS
SELECT
  *,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.provider'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_provider')
  ) AS provider,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.model'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_model')
  ) AS model,
  COALESCE(EXTRACT_ARG(arg_set_id, 'debug.timing'), 'recorded-span') AS timing,
  CASE
    WHEN dur > 0 THEN dur
    ELSE COALESCE(
      EXTRACT_ARG(arg_set_id, 'debug.duration_ns'),
      EXTRACT_ARG(arg_set_id, 'debug.agentprof_stream_duration_ns')
    )
  END AS message_ns,
  CASE
    WHEN dur > 0 THEN ts
    ELSE ts
    - COALESCE(
      EXTRACT_ARG(arg_set_id, 'debug.duration_ns'),
      EXTRACT_ARG(arg_set_id, 'debug.agentprof_stream_duration_ns')
    )
  END AS message_start_ts,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.first_content_ns'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_stream_first_content_ns')
  ) AS first_ns,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.input_tokens'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_input')
  ) AS input_tokens,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.output_tokens'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_output')
  ) AS output_tokens,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.cache_read_tokens'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_cacheRead')
  ) AS cache_read_tokens,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.cache_write_tokens'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_usage_cacheWrite')
  ) AS cache_write_tokens,
  COALESCE(
    EXTRACT_ARG(arg_set_id, 'debug.stop_reason'),
    EXTRACT_ARG(arg_set_id, 'debug.agentprof_llm_stopReason')
  ) AS stop_reason
FROM dev_agentprof_slices
WHERE
  kind = 'assistant-message';

-- Recorded provider-request / request-to-headers spans.
CREATE PERFETTO VIEW dev_agentprof_provider_requests AS
SELECT
  id,
  capture_id,
  session,
  ts,
  dur,
  name,
  CASE WHEN NOT incomplete AND dur >= 0 THEN dur / 1e6 END AS request_span_ms,
  EXTRACT_ARG(arg_set_id, 'debug.phase') AS phase,
  incomplete,
  EXTRACT_ARG(arg_set_id, 'debug.timing') AS timing
FROM dev_agentprof_slices
WHERE
  kind = 'provider-request';

-- Trace-wide response summary grouped by provider and model for the Overview UI.
CREATE PERFETTO VIEW dev_agentprof_models AS
SELECT
  provider,
  model,
  COUNT(*) AS responses,
  AVG(first_ns) / 1e6 AS first_content_ms,
  COUNT(first_ns) AS latency_samples,
  AVG(message_ns) / 1e6 AS duration_ms,
  SUM(input_tokens) AS input_tokens,
  SUM(output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  COUNT(input_tokens) AS input_samples,
  COUNT(output_tokens) AS output_samples
FROM dev_agentprof_messages
GROUP BY
  provider,
  model
ORDER BY
  responses DESC;

-- Per-capture, provider, model, and timing-semantics cohort scorecard with
-- mean/median/p95 duration, first-content mean, usage, and output throughput.
CREATE PERFETTO VIEW dev_agentprof_model_cohorts AS
WITH
  measured AS (
    SELECT
      *,
      ROW_NUMBER() OVER (
        PARTITION BY
          capture_id,
          provider,
          model,
          timing
        ORDER BY message_ns, id
      ) AS rank,
      COUNT(*) OVER (PARTITION BY capture_id, provider, model, timing) AS samples
    FROM dev_agentprof_messages
    WHERE
      NOT incomplete
      AND message_ns >= 0
  ),
  durations AS (
    SELECT
      capture_id,
      provider,
      model,
      timing,
      AVG(
        CASE
          WHEN rank IN ((samples + 1) / 2, (samples + 2) / 2) THEN message_ns
        END
      )
      / 1e6 AS median_ms,
      MAX(CASE WHEN rank = (95 * samples + 99) / 100 THEN message_ns END) / 1e6 AS p95_ms
    FROM measured
    GROUP BY
      capture_id,
      provider,
      model,
      timing
  )
SELECT
  r.capture_id,
  r.provider,
  r.model,
  r.timing,
  COUNT(*) AS responses,
  SUM(r.incomplete) AS incomplete,
  COUNT(CASE WHEN NOT r.incomplete AND r.message_ns >= 0 THEN 1 END) AS duration_samples,
  AVG(CASE WHEN NOT r.incomplete AND r.message_ns >= 0 THEN r.message_ns END)
  / 1e6 AS mean_ms,
  MAX(d.median_ms) AS median_ms,
  MAX(d.p95_ms) AS p95_ms,
  AVG(CASE WHEN NOT r.incomplete AND r.first_ns >= 0 THEN r.first_ns END) / 1e6 AS first_content_mean_ms,
  COUNT(CASE WHEN NOT r.incomplete AND r.first_ns >= 0 THEN 1 END) AS first_content_samples,
  SUM(r.input_tokens) AS reported_input_tokens,
  COUNT(r.input_tokens) AS input_samples,
  SUM(r.output_tokens) AS reported_output_tokens,
  COUNT(r.output_tokens) AS output_samples,
  SUM(r.cache_read_tokens) AS reported_cache_read_tokens,
  COUNT(r.cache_read_tokens) AS cache_read_samples,
  SUM(
    CASE
      WHEN NOT r.incomplete
      AND r.message_ns > 0
      AND r.output_tokens IS NOT NULL THEN r.output_tokens
    END
  )
  * 1e9
  / SUM(
    CASE
      WHEN NOT r.incomplete
      AND r.message_ns > 0
      AND r.output_tokens IS NOT NULL THEN r.message_ns
    END
  ) AS output_tokens_per_s,
  COUNT(
    CASE
      WHEN NOT r.incomplete
      AND r.message_ns > 0
      AND r.output_tokens IS NOT NULL THEN 1
    END
  ) AS throughput_samples
FROM dev_agentprof_messages AS r
LEFT JOIN durations AS d
  ON d.capture_id = r.capture_id
  AND d.provider IS r.provider
  AND d.model IS r.model
  AND d.timing = r.timing
GROUP BY
  r.capture_id,
  r.provider,
  r.model,
  r.timing
ORDER BY
  responses DESC;
