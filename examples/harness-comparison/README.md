# Pi and Claude Code: bounded coding task

The UI's **Open Pi vs Claude Code example**, named `pi-vs-claude-code`, contains
two sessions recorded on 2026-10-08 (UTC): one with Pi codemode only and one
with Claude Code.
Both use the same [prompt](prompt.txt), starting files and
`anthropic/claude-haiku-4-5-20251001` model, with thinking off.

The task fixes an interval-summary function and adds four regression tests.
Both sessions passed all 12 tests and an independent 500-case oracle
for union duration, concurrency and input non-mutation.

| Measurement | Pi codemode only | Claude Code |
| --- | ---: | ---: |
| Elapsed time | 16.9 s | 23.3 s |
| Recorded window | 16.4 s | 22.2 s |
| Responses | 6 | 9 |
| Output tokens | 1,637 | 2,023 |
| Scripts | 5 | 0 |
| Underlying tool calls | 6 | 9 |

Elapsed time includes CLI startup and shutdown; Claude trace publication may
finish after CLI exit.

Original clocks and timestamps are retained, including the gap between the two
sessions. The aggregate wall window therefore includes that gap;
compare the session rows' recorded windows for each task's elapsed work.

The Pi session has the `codemode` label. In **Tools → Scripted tool use**, expand
one of its five scripts to follow six nested calls into the timeline. Both
sessions include context composition captured during their runs. Local
workspace and home paths were sanitized; measurements, usage and session IDs
are unchanged. Packet sequence IDs were made unique when combining the traces.

## Measurement boundaries

Pi response spans begin after response headers; Claude Code's native LLM hooks
record whole requests. Response-only tokens/s and model-busy values use different
boundaries. Include Pi's request spans when comparing full model exchange time.
Context composition uses Pi's outgoing messages and Claude's native breakdown,
with partial item attribution. Reported totals are independent of these estimates.
Input counters retain uncached usage; cache reads and writes are separate
response annotations.

## Record another batch

Recorded with Pi 1.0.3 and Claude Code 2.1.289. Use authenticated CLIs to run:

```sh
python3 tools/experiments/harness-comparison/run.py --cases coding --rounds 3 \
  --variants pi-codemode claude-code --output artifacts/experiments/my-comparison
node_modules/.bin/bun tools/experiments/harness-comparison/analyse.ts artifacts/experiments/my-comparison
```

See the [experiment documentation](../../tools/experiments/harness-comparison/README.md)
for validation. A new batch does not replace this reviewed example. Raw
conversations, credentials and scratch workspaces are excluded from the repo.

`npm run trace:example` rebuilds the UI bundle without calling a model.
`npm run check:example` validates source checksums, session identity, usage,
context composition, nested tools, flows and import health.
