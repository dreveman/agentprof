# Pi–Opus-5 recordings

The default example is one real delegated coding task recorded through this
repository's tracing extension on 2026-09-27, with Pi 0.87.1 and
`anthropic/claude-opus-5` at high thinking effort.

These archived captures predate the extension's context-window counter. The
example backfills the 1,000,000-token limit reported for `claude-opus-5` by
Pi 0.87.1's model catalog. `tools/backfill-example-context.ts` adds a typed
`context_window_tokens` capture annotation and a **Context window** counter
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

The recordings retain their original activity timings and clock snapshots. The recorder
version was moved from process labels into `recorder_version` capture
metadata. Capture-start markers were converted into `tracing` spans ending at
the recorded finalization counters' timestamps. The former `Session`
tracks now describe each recorded Linux process's actual main thread (TID = PID),
using the recorder's shared `pi` name for both process and thread.
Assistant summaries were converted to `Model responses` spans using their measured
start/end interval. Prompt, context, child identity, and tool-result metadata were
moved onto their corresponding spans, and duplicate status markers removed.
Input markers are named `prompt-input`, with source in a debug argument and flows
to their corresponding `prompt` spans. Prompt length and text belong
only to the operation. The prompts were recovered from each session's saved
user message, checked against the recorded lengths, and added under
`pi.prompt-data`. The child prompts and traces replace the local scratch
directory prefix with an equal-length example path; their remaining text and
recorded lengths are unchanged. The text files referenced by `promptFile` in
`recording.json` preserve the reviewed prompts and worker tasks.
Preflight and remaining middleware events now have stable `tool-preflight` and
`tool-middleware` names. Their original tool names, argument key lists, byte
counts, and error flags were moved into typed annotations without changing
timestamps or flows.
Annotation names are now local to each event: for example `source` on
`prompt-input`, `text` and `length` on `prompt`, and `name`, `bytes`,
and `keys` on `tool-preflight`. Workflow annotation names were normalized to
`snake_case`, including `parent_session`, `child_session`, and `subagent_type`.
Existing values and protobuf types are preserved.
Sampled counters now end with a zero, and the capture boundary is extended by
one nanosecond to retain the original final diagnostic samples separately.
Original activity timings, token totals, and context peaks remain unchanged.
Tool descriptors now share the name `Tools` and enable Perfetto sibling merging
under their capture root. UUIDs and event timestamps are unchanged, while the UI
presents one compact tool row per capture without lane indices.
Track descriptors use readable labels, with runtime and recorder diagnostics
parented under Runtime and Tracing. The earlier changes preserve existing track UUIDs,
samples, event timestamps, and flow IDs; grouping tracks and the backfilled
context-window counter add UUIDs.
The three duplicate `delegate` intervals were removed. Their metadata now lives
on the corresponding `subagent` tool spans, matched using the original tool-call
IDs and returned child-session IDs. The tool spans retain their original timings
and incoming flows. Each tool BEGIN and its child's first `prompt-input` now
also carry a matching flow ID derived from the recorded child session UUID.
The bundle merges the process streams into one trace using the parent clock
calibration. All three delegation links are native Perfetto flow arrows.
Three older middleware markers lack call IDs and have ambiguous tool matches;
they remain as instants rather than attributing their data to the wrong call.
Each child
records the launching session ID and its role; that session's subagent tool slices
record the matching child IDs. The **Child launches** query in the command
palette shows these links and roles. Sessions have separate configuration, usage,
context, and timeline tracks; the UI does not yet construct a delegation tree.

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
Opening those individually tests comparison between separate recordings; their
cross-file flow IDs are not joined by Perfetto. Native and browser checks verify
the unified recording's three flows, concurrent workers, and later reviewer stage.
