-- SPDX-License-Identifier: Apache-2.0
WITH
  responses AS (
    SELECT
      *,
      COALESCE(EXTRACT_ARG(arg_set_id, 'debug.timing'), 'recorded-span') AS timing
    FROM agentprof_skill_messages
    WHERE
      capture_id IN (SELECT capture_id FROM agentprof_skill_selected_captures)
  ),
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
    FROM responses
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
FROM responses AS r
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
  responses DESC
LIMIT 100;
