# Codex coding example

Selecting Codex on the front page offers **Open Codex example**, named
`codex-coding`. This is one live run recorded on 2026-10-05 with Codex 0.160.0,
GPT-6-Luna and low reasoning effort, using the interactive recording plugin
with automatic start and save on exit.

The [prompt](prompt.txt) asks the agent to fix interval union duration and peak
concurrency, add four regression tests, and run the tests. The trace includes
five measured model responses, four scripts and six nested tool calls. Expand
**Tools → Scripted tool use** to follow file inspection, edits and test runs.
The completed files are in [result](result/). All 12 tests and 500 independent
cases passed. The original tests are unchanged.

`coding.pftrace` retains the captured timestamps, session identity and reported
usage. Scratch workspace paths were replaced with `/workspace/intervals`.
Input tokens include cached input; the context limit comes from Codex session
metadata. This is a workflow example, not a speed comparison with the other
harness examples, which use different models and timing boundaries.

[recording.json](recording.json) contains checksums and validated measurements.
`npm run trace:example` rebuilds the UI bundle without running a model.
`npm run check:example` verifies trace import, identity, usage, context counters,
script relationships and the completed task's tests. Refreshing the example
reloads the bundled recording.

To record the task again, copy the starting files from
[`../pi-opus-5/task`](../pi-opus-5/task/) into a scratch directory, install the
[Codex recording plugin](../../packages/codex-tracing/README.md), and run the
prompt with the recording profile. A new recording does not replace this example.
