# Claude Code coding example

Selecting Claude Code on the front page offers **Open Claude Code example**,
named `claude-code-coding`. This is the standalone Claude Code session from the
existing [Pi codemode comparison](../harness-comparison/README.md), recorded on
2026-10-08 (UTC) with Claude Code 2.1.289 and Haiku 4.5, with thinking disabled.

The [prompt](prompt.txt) asks the agent to fix interval union duration and peak
concurrency, add four regression tests, and run the tests. The trace shows the
initial failing tests, file edits, and successful verification: nine measured
responses and nine tool calls. The completed files are in [result](result/).
All 12 tests and 500 independent cases passed. The original tests are unchanged.

`coding.pftrace` was converted from the original captured observations. Only
scratch workspace paths were replaced with `/workspace/intervals`; timestamps,
session identity and reported usage are preserved. This recording uses the
native Claude Code plugin. Context composition comes from native breakdowns,
with partial item attribution from session messages. Model request durations
use the native LLM hooks; input
tokens are uncached input, with cache usage recorded separately. The launch
configuration disabled thinking, but the trace does not report an effort value.

Distributed result files have Apache-2.0 headers; original captured source hashes
are retained in the manifest.

[recording.json](recording.json) contains checksums and validated measurements.
`npm run trace:example` rebuilds the UI bundle without running a model.
`npm run check:example` verifies trace import, identity, usage, context counters,
tool arguments and the completed task's tests. Refreshing the example reloads
the bundled recording.
