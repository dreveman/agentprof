# Pi–Opus-5 recordings

The default example is one real delegated coding task recorded through this
repository's tracing extension on 2026-09-27, with Pi 0.87.1 and
`anthropic/claude-opus-5` at high thinking effort.

These archived captures predate the extension's context-window counter. The
example backfills the 1,000,000-token limit reported for `claude-opus-5` by
Pi 0.87.1's model catalog as a typed `context_window_tokens` capture annotation
and a **Context window** counter
from capture start to end. It also renames the existing gauge track to
**Context size** and gives both tracks the same Y-axis key. The activity
packets, observed context samples, and timestamps remain unchanged; the limit
is catalog metadata, not a measurement made by the original capture.

The parent asks two workers to fix an interval-summary function and extend its
tests. It launches both before waiting, so their activity overlaps. Once both
finish, it launches a reviewer, incorporates a test-quality suggestion, and runs
final verification. All 39 tests pass.

| Session | File | Responses | Tool calls | Output tokens |
| --- | --- | --- | --- | --- |
| parent | `workflow-parent.pftrace` | 12 | 12 | 6,719 |
| implementation | `workflow-implementation.pftrace` | 5 | 4 | 1,388 |
| tests | `workflow-tests.pftrace` | 6 | 5 | 9,537 |
| reviewer | `workflow-reviewer.pftrace` | 8 | 9 | 10,360 |

The archived recordings were adapted to the current trace schema while retaining
original activity timings, usage, context peaks, and clock snapshots. Metadata
from instant markers was moved onto its corresponding spans; names and annotation
keys were normalized. Track groups and sibling merging organize tools, runtime
counters, and tracing diagnostics. The `pi` main-thread track uses the real
process ID as its thread ID. Counters reset at capture end, extending that boundary
by one nanosecond to preserve the original final samples.

Prompts were recovered from saved user messages, checked against the recorded
lengths, and added under `pi.prompt-data`. Child prompts replace the local scratch
directory with an equal-length example path. The text files referenced by
`promptFile` in `recording.json` preserve the reviewed prompts and worker tasks.

Delegation flows use recorded child session IDs to connect each `subagent` tool
to its child's first `prompt-input`. Duplicate delegate spans were removed and
their metadata retained on the tool spans. Three older middleware markers lack
call IDs and remain instants because their tool matches are ambiguous. Each child
records its launching session and role. Expand a session in **Sessions** to see
its children, or use the **Child launches** query to inspect the recorded links.

`run-1.pftrace` and `run-2.pftrace` preserve the earlier independent runs of the
same task. They remain available for separate comparisons and are not part of
the default workflow bundle. `recording.json` maps files to roles, session IDs,
checksums, and expected counts checked against Pi's JSON events.

Input counts preserve Anthropic's reported `usage.input`; cache-read and
cache-write tokens are separate annotations. Small input totals therefore do not
describe the full prompt context. Context estimates are recorded separately.
These captures exercise the recorder; they are not controlled benchmarks of
harness configurations.

Tool-argument content capture was disabled. The traces contain prompt text,
timing, IDs, tool names/outcomes,
model configuration, usage, context estimates, and runtime counters. They do not
contain model output, tool arguments/results, credentials, or machine
hostnames. Raw conversations and completed scratch workspaces stay local under
`artifacts/live-pi` and are not bundled.

## Reproduce the workflow

The initial source is in `task/`; it is intentionally incorrect.
`workflow-prompt.txt` contains the parent's instruction. `subagents.ts` is a small
example-only launcher: its `subagent` tool starts a real Pi child and returns the
session UUID immediately, and `wait_subagents` collects the result after exit.
It forwards the tracing extension, sets `DEVMATE_PARENT_SESSION_ID` and
`PI_SUBAGENT_TYPE`, and permits one implementation, tests, and reviewer worker.
Children share the scratch directory with separate context windows. The parent
assigns disjoint files to the concurrent workers; the reviewer has read/bash tools.
Other extension discovery, skills, context files, and prompt templates are disabled.

From the repository root:

```bash
# Calls Opus 5 for a parent and three subagents using your configured Pi auth.
npm run trace:record -- --name opus-5-workflow --workflow

# A single-agent run remains available.
npm run trace:record -- --name opus-5-solo

# Offline: rebuild the UI example from the reviewed recordings.
npm run trace:example

# Validate usage, health, parent/child links, worker overlap, and clock alignment.
npm run check:example
```

The bundled example is one `agentprof-example.pftrace`, assembled by the same
merge helper used when a live session recording stops. It keeps all four Pi
sessions and their individual usage counters, while connecting the parent tools
to the children's first prompts with native flows. Packet timestamps use the
parent's clock calibration; per-process measurement values are unchanged.

The historical `workflow-*.pftrace` files remain as source/provenance fixtures.
Context categories were reconstructed at each recorded request from the original
saved messages, system sections and tool definitions. They are marked as partial
transcript observations, since outgoing provider transformations are unavailable.
Each worker has its own breakdown; original timings and usage are unchanged.
Opening those individually tests comparison between separate recordings; their
cross-file flow IDs are not joined by Perfetto. Native and browser checks verify
the unified recording's three flows, concurrent workers, and later reviewer stage.
