# Pi and Claude Code: bounded coding task

The UI's **Open Pi vs Claude Code example**, named `pi-vs-claude-code`, contains
two real sessions: one with Pi codemode only and one with Claude Code.
Both use the same [prompt](prompt.txt), starting files and
`anthropic/claude-haiku-4-5-20251001` model, with thinking off.

The task fixes an interval-summary function and adds four regression tests.
Both attempts passed the resulting 12 tests and an independent 500-case oracle
for union duration, concurrency and input non-mutation.

This showcase selects the fastest correct Pi codemode run from three trials and
Claude Code from the same round (round 1). The original repeated experiment is
retained separately. The selected pair keeps its actual clocks and timestamps.

| Measurement | Pi codemode only | Claude Code |
| --- | ---: | ---: |
| Elapsed time | 17.1 s | 23.7 s |
| Recorded window | 16.6 s | 23.5 s |
| Responses | 8 | 11 |
| Output tokens | 1,892 | 2,198 |
| Scripts | 7 | 0 |
| Underlying tool calls | 9 | 11 |

Elapsed time includes CLI startup and trace finalization. Across the full batch,
Pi codemode ranged from 17.1–64.5 seconds and Claude Code from 23.5–24.1 seconds.
The example highlights a successful codemode run; it does not describe typical
performance. Provider latency and cache state were uncontrolled.

The recording includes seven scripts and all nine nested tool calls. The Pi
session has the `codemode` label. Use **Tools → Scripted tool use** to expand a script
and follow its calls into the timeline. The Agent column distinguishes Pi and
Claude Code; [recording.json](recording.json) maps session IDs to rounds and
retains the selection criteria, native usage, validated counts and original capture checksums.

## Measurement boundaries

Pi response spans begin after response headers; Claude Code records whole
requests. Their response-only tokens/s and model-busy values therefore use
different boundaries. Include Pi's request spans when comparing full model
exchange time. Context size uses Pi's estimate or Claude's measured request
input. Input counters retain uncached usage; cache reads and writes are separate
response annotations.

## Reproduce

Recorded on 2026-10-04 with Pi 1.0.1 and Claude Code 2.1.252. Use the installed
CLIs and credentials to record a new batch:

```sh
python3 tools/experiments/harness-comparison/run.py --cases coding --rounds 3 \
  --variants pi pi-codemode claude-code --output artifacts/experiments/my-comparison
node_modules/.bin/bun tools/experiments/harness-comparison/analyse.ts artifacts/experiments/my-comparison
```

See the [experiment documentation](../../tools/experiments/harness-comparison/README.md)
for the validation protocol. A new batch does not replace this reviewed example.
Raw conversations and local workspaces are excluded from the repository.

`comparison.pftrace` combines the two selected recordings from that batch. The
Claude Code trace was regenerated from its saved observations with `claude.*`
categories. Local workspace paths in tool arguments were replaced with
`/workspace/intervals`; measurements, session identities, and timestamps are
preserved. The manifest
retains the original capture checksums and the converted Claude trace checksum.
Only packet sequence IDs were made unique during the merge. `npm run trace:example` copies
it unchanged to `artifacts/examples/agentprof-comparison-example.pftrace` and
generates the UI bundle. `npm run check:example` validates the checksum, both
sessions, token usage, nested calls, flows and capture health without
calling a model.
