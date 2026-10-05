# Pi and Claude Code: bounded coding task

The UI's **Open Pi vs Claude Code example**, named `pi-vs-claude-code`, contains
two real sessions: one with Pi codemode only and one with Claude Code.
Both use the same [prompt](prompt.txt), starting files and
`anthropic/claude-haiku-4-5-20251001` model, with thinking off.

The task fixes an interval-summary function and adds four regression tests.
Both attempts passed the resulting 12 tests and an independent 500-case oracle
for union duration, concurrency and input non-mutation.

This showcase selects the fastest correct Pi codemode run with a complete
recording and a correct Claude Code partner from six trials (trial 5).
Both sessions use the current recording plugins and include context breakdowns.
The selected pair keeps its actual clocks and timestamps.

| Measurement | Pi codemode only | Claude Code |
| --- | ---: | ---: |
| Elapsed time | 16.3 s | 22.2 s |
| Recorded window | 15.8 s | 21.3 s |
| Responses | 7 | 9 |
| Output tokens | 1,673 | 2,090 |
| Scripts | 6 | 0 |
| Underlying tool calls | 8 | 9 |

Elapsed time includes CLI startup and shutdown; Claude's trace publication may
finish after CLI exit. Across the six trials, Pi codemode ranged from 16.3–36.4
seconds and Claude Code from 17.6–22.2 seconds. Trial 6 had an incomplete Pi
publication and an incorrect Claude result; it was excluded from selection.
The example highlights a successful codemode run; it does not describe typical
performance. Provider latency and cache state were uncontrolled.

The recording includes six scripts and all eight nested tool calls. The Pi
session has the `codemode` label. Use **Tools → Scripted tool use** to expand a script
and follow its calls into the timeline. The Agent column distinguishes Pi and
Claude Code; [recording.json](recording.json) maps session IDs to rounds and
retains the selection criteria, native usage, validated counts and original capture checksums.

## Measurement boundaries

Pi response spans begin after response headers; Claude Code records whole
requests through its native LLM hooks. Their response-only tokens/s and model-busy values therefore use
different boundaries. Include Pi's request spans when comparing full model
exchange time. Context composition uses Pi's outgoing messages and Claude's
native breakdown, with partial item attribution; reported totals are independent
of these estimates. Input counters retain uncached usage; cache reads and writes are separate
response annotations.

## Reproduce

Recorded on 2026-10-05 with Pi 1.0.3 and Claude Code 2.1.289. Use the installed
CLIs and credentials to record a new batch:

```sh
python3 tools/experiments/harness-comparison/run.py --cases coding --rounds 3 \
  --variants pi-codemode claude-code --output artifacts/experiments/my-comparison
node_modules/.bin/bun tools/experiments/harness-comparison/analyse.ts artifacts/experiments/my-comparison
```

See the [experiment documentation](../../tools/experiments/harness-comparison/README.md)
for the validation protocol. A new batch does not replace this reviewed example.
Raw conversations and local workspaces are excluded from the repository.

`comparison.pftrace` combines the two selected recordings from that batch. The
Claude Code trace was generated from its native plugin observations with
`claude.*` categories. Local workspace paths in tool arguments were replaced with
`/workspace/intervals`; measurements, session identities, and timestamps are
preserved. The manifest
retains the original and sanitized capture checksums.
Only packet sequence IDs were made unique during the merge. `npm run trace:example` copies
it unchanged to `artifacts/examples/agentprof-comparison-example.pftrace` and
generates the UI bundle. `npm run check:example` validates the checksum, both
sessions, token usage, nested calls, flows and capture health without
calling a model.
