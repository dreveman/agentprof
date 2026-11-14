-- SPDX-License-Identifier: Apache-2.0

-- AgentProf process runtime resource counters (RSS, JS heap, and interval CPU).

INCLUDE PERFETTO MODULE dev.agentprof.captures;

-- Per-capture, per-track summary of recorded runtime resource counters.
CREATE PERFETTO VIEW dev_agentprof_runtime_summary AS
SELECT
  t.capture_id,
  t.id AS track_id,
  t.display_name AS metric,
  CASE
    WHEN t.name = 'runtime.cpu' THEN 'us consumed since previous sample'
    ELSE 'bytes'
  END AS unit,
  COUNT(*) AS samples,
  MIN(c.ts) AS first_sample_ts,
  MAX(c.ts) AS last_sample_ts,
  MIN(CASE WHEN t.name = 'runtime.cpu' OR c.value > 0 THEN c.value END) AS minimum,
  MAX(CASE WHEN t.name = 'runtime.cpu' OR c.value > 0 THEN c.value END) AS maximum,
  CASE WHEN t.name = 'runtime.cpu' THEN SUM(c.value) END AS sampled_cpu_us
FROM counter AS c
JOIN dev_agentprof_counter_tracks AS t
  ON t.id = c.track_id
WHERE
  t.name IN ('runtime.rss', 'runtime.heap', 'runtime.cpu')
GROUP BY
  t.capture_id,
  t.id,
  t.display_name,
  t.name
ORDER BY
  t.capture_id,
  t.id;

-- Timestamped runtime resource counter samples with explicit units.
CREATE PERFETTO VIEW dev_agentprof_runtime_samples AS
SELECT
  t.capture_id,
  t.id AS track_id,
  c.ts,
  t.display_name AS metric,
  c.value,
  CASE
    WHEN t.name = 'runtime.cpu' THEN 'us consumed since previous sample'
    ELSE 'bytes'
  END AS unit
FROM counter AS c
JOIN dev_agentprof_counter_tracks AS t
  ON t.id = c.track_id
WHERE
  t.name IN ('runtime.rss', 'runtime.heap', 'runtime.cpu');
