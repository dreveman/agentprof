# CI failure audit experiment

This explores when scripting tools can reduce model turns and output, using
real Pi sessions against a **synthetic, deterministic CI API replay**. It is not
a measurement of a production CI service or a general coding benchmark.

The task audits 192 failed test cases. Four paginated list requests identify
the cases; one history request per case returns its four preceding results.
The agent classifies new, persistent, and intermittent failures by owner and
reports the five slowest new failures. An independent Python oracle checks the
complete answer and an API log checks that every history was retrieved.

Both variants receive the same prompt, model, effort, dataset, two read-only
tools, bash for local calculations, and limit of 16 concurrent requests.
Codemode exposes those tools through scripts. No artificial delays or failures
are injected. Both variants receive complete CI results, without truncation or
output-size penalties. The replay returns the same JSON that codemode
receives as structured data. Tool results contain normal per-execution fields;
there is no bulk history endpoint. The prompt requires CI tools for CI data
access; bash can calculate results from data already returned by those tools.
The absence of that bulk endpoint is central to the workload: a service that
already supports server-side aggregation may largely remove the advantage.

Run with the installed Pi and its existing provider credentials:

```sh
python3 tools/experiments/codemode-ci/run.py --cases 192 --rounds 3
node_modules/.bin/bun tools/experiments/codemode-ci/analyse.ts artifacts/experiments/codemode-ci-<id>
```

The runner defaults to `anthropic/claude-opus-5`, high effort. Each pair runs
concurrently; rounds run sequentially, alternating launch order. Provider
latency and cache state are not controlled. Other extensions, context files,
skills, and built-in tools other than bash are disabled. Codemode uses `mode: only` and the
explicit built-in extension. The installed harness and current tracing
extension record both variants, including nested tool calls and flows.

Each batch retains the snapshot, prompt, independent expected result, API logs,
JSON event streams, answers, traces, usage, elapsed process time, and checksums.
Failures are retained and stop further rounds. The analysis merges each pair
into one trace and checks import errors, dropped events, lane overflows,
incomplete spans, script flows, tool counts, response counts, and usage against
the original JSON events. Nothing replaces the built-in UI example.

`totalInputTokens` includes fresh input, cache reads, and cache writes across
requests. `peakRequestTokens` is the largest such request; it differs from the
UI's context estimate. Cost is Pi's reported estimate, not an invoice.

For a real service, use its existing batching and filtering before assuming
hundreds of requests are necessary. For example, GitHub's
[`get_job_logs`](https://github.com/github/github-mcp-server/blob/main/pkg/github/actions.go)
can collect failed-job logs for a whole workflow run, and Buildkite's
[`list_tests`](https://buildkite.com/docs/apis/mcp-server/tools)
returns suite-wide execution aggregates. Auditing many runs or joining records
across services is a better candidate for a real follow-up than reproducing an
aggregate the service already provides. This replay deliberately models a
per-record API; its speedup should be interpreted in that scope.
