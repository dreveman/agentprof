# Muse Code coding example

A live Muse Code 1.4.1-R4503.1 run using `muse-spark-1.3-contributor` with low effort.
The prompt is the same bounded interval task as the Claude Code and Codex examples.
The implementation passes all 12 tests and 500 independent frozen-input cases.

The recording includes the main session and Muse’s retained goal-reminder and
verify-reminder sessions. They execute inside the same Muse process. Seven other
background reminder sessions have no retained logs in this Muse build; their
usage is unknown and the UI reports that gap. Do not use this trace as a complete
cost comparison between harnesses.

The plugin captured process identity, clocks, start time and model settings during
the run. The native journal was re-exported after fixing exit handling and child
path resolution, retaining the original boundaries and measured durations.
Only workspace and home path strings were sanitized. The recording manifest
pins the trace, prompt and resulting source files by SHA-256.

Context composition was re-exported from the original native request-lane byte
counts, with partial item attribution from the journal. The estimates use
bytes/4; reported model usage is independent. Each retained session has its own
breakdown, with the original timings and usage preserved.
