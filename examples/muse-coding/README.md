# Muse Code coding example

A live Muse Code 1.4.1-R4503.1 run recorded on 2026-10-08 (UTC) using
`muse-spark-1.3-contributor` with low effort and the native recording plugin.
The prompt is the same bounded interval task as the Claude Code and Codex examples.
The implementation passes all 12 tests and 500 independent frozen-input cases.

The recording includes the main session. Ten background reminder sessions
have no retained logs in this Muse build; their
usage is unknown and the UI reports that gap. Do not use this trace as a complete
cost comparison between harnesses.

The plugin captured process identity, clocks, start time and model settings during
the run. The native journal was exported by the plugin when the process exited,
retaining the recorded boundaries and measured durations.
Only workspace and home path strings were sanitized. The recording manifest
pins the trace, prompt and resulting source files by SHA-256.

Context composition was captured from native request-lane byte
counts, with partial item attribution from the journal. The estimates use
bytes/4; reported model usage is independent. The breakdown preserves measured timings and usage; unavailable reminder
sessions are not assigned estimated usage.
