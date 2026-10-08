# Pi workflow recordings

The **Open workflow example**, named `pi-workflow`, is a live delegated coding
task recorded on 2026-10-08 (UTC) with Pi 1.0.3, `anthropic/claude-opus-5` at high
thinking effort, using the Pi tracing extension.

The primary agent asks two workers to fix an interval-summary function and add
regression tests. It launches both before waiting, so their activity overlaps.
After they finish, it launches a reviewer and runs final verification. All 47
tests pass.

| Session | File | Responses | Tool calls | Output tokens |
| --- | --- | ---: | ---: | ---: |
| Primary | `workflow-parent.pftrace` | 7 | 7 | 3,159 |
| Implementation | `workflow-implementation.pftrace` | 6 | 5 | 1,786 |
| Tests | `workflow-tests.pftrace` | 5 | 4 | 7,488 |
| Reviewer | `workflow-reviewer.pftrace` | 8 | 9 | 7,846 |

The extension saved the primary and all three subprocess sessions as one trace.
The source files above preserve its individual packet sequences, including the
shared clock calibration and global delegation flows. Bundling merges them with
the same helper used by the live recorder. All activity times, usage and process
identities are preserved. The primary's tools connect to each child's first
prompt; subagent sessions roll up into the primary in Overview.

Context composition and the 1,000,000-token model limit were captured directly
by the current extension. No context data was backfilled. Input counters retain
Anthropic's uncached input usage; cache reads and writes are separate response
annotations. Context composition estimates remain independent of reported usage.

Prompt text is included for all four sessions. Tool arguments are included for
the primary; the example's worker launcher disables them for children. Local
workspace and home paths were replaced in text and arguments before bundling.
Recorded lengths and byte counts describe the original content, so they may
differ from the sanitized text. No credentials or machine hostnames are included.
Raw session logs and scratch workspaces remain outside the repository.

`run-1.pftrace` and `run-2.pftrace` are two freshly recorded standalone runs of
the same starting task. They are available for file-import comparisons and are
not part of the workflow bundle. The first run's completed process spool was
recovered after its publication deadline expired; its measurement boundaries
and usage are unchanged. Both standalone implementations pass their tests and
500 independent frozen-input cases.

[recording.json](recording.json) records the source checksums, session IDs,
expected counts and capture settings. The prompt text files preserve the
sanitized instructions received by each worker.

## Record another workflow

The intentionally incorrect starting files are in `task/`.
`workflow-prompt.txt` asks for concurrent workers followed by a reviewer.
`subagents.ts` launches real Pi children with isolated context and a shared
scratch directory, forwarding the extension and recording identity. Other
extensions, skills, context files and prompt templates are disabled.

```sh
npm run trace:record -- --name pi-workflow --workflow
npm run trace:record -- --name pi-solo
```

These commands call Opus 5 using your configured Pi credentials. A new recording
does not replace the checked-in example. To rebuild and validate the reviewed
recordings without calling a model:

```sh
npm run trace:example
npm run check:example
```

Checks cover import health, clocks, token counters, context composition, worker
overlap, later review, child flows and session rollup. Opening the source files
separately tests multi-recording import; Perfetto does not join their flows
across independent trace files.
