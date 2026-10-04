# CI audit results — 2026-10-02

Codemode was **11.8× faster by median wall time** in three paired runs of the
CI replay, with all six answers exactly correct. Each run retrieved the same
192 histories through 196 CI requests. The dataset is synthetic; the model
sessions, tool executions, timing, usage, and traces are real.

Both variants used Pi 1.0.0, `anthropic/claude-opus-5`, high effort, the same
prompt and snapshot (seed 62813), the same CI tools, and bash for local
calculations. The prompt allowed up to 16 concurrent requests. No delays or
failures were injected. The [runner and methodology](README.md) describe the
workload and reproduction commands.

| Measurement (median) | Direct tools | Codemode |
| --- | ---: | ---: |
| Wall time, including process startup/exit | 216.4 s | 18.3 s |
| Wall-time range | 179.1–238.3 s | 17.8–19.2 s |
| Recorded window | 215.8 s | 17.8 s |
| Model responses / turns | 30 | 4 |
| Output tokens | 23,140 | 1,250 |
| Total input, including cache read/write | 1,475,050 | 14,009 |
| Peak context estimated in trace | 95,395 | 4,170 |
| Largest input request, including cache | 95,553 | 4,317 |
| Measured model-response time | 175.5 s | 10.4 s |
| Reported cost estimate | $1.866 | $0.057 |
| CI requests | 196 | 196 |
| Correct answers | 3/3 | 3/3 |

| Round | Direct wall | Codemode wall | Paired speedup | Direct turns | Codemode turns | Direct bash calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 216.4 s | 19.2 s | 11.27× | 30 | 4 | 13 |
| 2 | 179.1 s | 17.8 s | 10.05× | 19 | 4 | 2 |
| 3 | 238.3 s | 18.3 s | 13.02× | 31 | 4 | 14 |

Each codemode run used three scripts: paginate the failures, retrieve histories,
and aggregate the report. Script state retained the data between those steps.
Direct runs issued batches of calls through the model and serialized selected
data into shell commands for aggregation. Generated output fell by 94.6%; the
measured model-response time accounts for most of the wall-time difference.

This is a strong example of structured API orchestration. It does not establish
the same speedup for repository edits, semantic debugging, or services with a
bulk endpoint that already answers the query. Provider latency and cache state
were not controlled; both processes in a pair ran concurrently. Cost is Pi's
reported estimate. The input total includes repeated cached context; the trace's
Input tokens counter separately preserves the provider's uncached input usage.

An initial API-only screening pair, without bash, took 187.2 s versus 17.2 s;
both answers were correct. It is retained separately and excluded from the
three-pair statistics above. No failed or incorrect model runs were discarded.

All six repeated traces passed checks for matching usage and counts, zero
incomplete operations, zero import errors, zero dropped events, zero lane
overflows, and all 196 script → preflight → tool flow chains per codemode run.
The API logs confirm identical requests in each pair. Shell commands used
returned data and scratch files; they did not read the fixture or expected
answer. Both the screening comparison and selected repeated comparison were
also loaded in the local UI.

Local artifacts are retained under
`artifacts/experiments/codemode-ci-be9fc03e/`. This includes the original runner
and tool source, fixture, oracle, prompt, sessions, API logs, trace metrics,
per-run usage, checksums, and a `summary.json`. The screening pair is under
`artifacts/experiments/codemode-ci-035aeb48/`.

The candidate `pi-ci-audit.pftrace` in the repeated-run directory contains
**round 1**, selected for its middle paired speedup. Its SHA-256 is
`61dab4bc04cc17f6c2d95169e9ceff9cd2f66ca09ee584f3ac51b0a3091d0386`.
This pair is retained as the [CI audit fixture](../../../examples/pi-codemode/README.md).
The UI now features the [Pi and Claude Code comparison](../../../examples/harness-comparison/README.md). The
previous source-inventory example is archived locally under
`artifacts/experiments/pi-source-inventory-example/`; its runner is in
`tools/experiments/codemode-inventory/`. In that smaller workload, direct tools
could already combine the work into a few searches.
