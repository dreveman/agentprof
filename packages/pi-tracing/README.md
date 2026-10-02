# pi-tracing

Self-controlled Perfetto capture for Pi. Records agent/LLM/tool/session activity to
canonical `.pftrace` protobuf files you open in the Perfetto UI or query with
`trace_processor`. No daemon, no socket, no sidecar in v1.

This package contains the recording side of Agent Profiler: POSIX only,
`PATH`-resolved tooling, and no runtime packages beyond Pi's own. It was imported from
the supplied Pi extension and retains the original MIT license declaration.

From the repository root, load it with `pi -e ./packages/pi-tracing --tracing`.
The workspace lockfile records the tested Pi and TypeScript versions.
See [the data contract](../../docs/trace-data.md) for structured annotations and
the next collection priorities.

## Status: internal v1 (OFF + RECORDING)

Implements runtime probing and local recording. Deferred to follow-ups:

- ARMED flight recorder (`arm`/`disarm` return a clear "reserved" message).
- Live `SYSTEM`-backend producer for external `traced` (no transport yet).
- Recording rollover without stopping the current capture.
- Interning / delta timestamps.

## Usage

```text
/tracing start [name]        start recording (creates <name>.pftrace.part)
/tracing stop                 stop, finalize, and publish .pftrace
/tracing status               show state, counts, config errors, and last trace
/tracing categories [cat on|off | save]   list or mutate live category filter
/tracing probe                run the Phase-0 runtime probe inside Pi
/tracing arm|disarm           reserved (P3) — explains and stays OFF/RECORDING
```

Agents can control the same recorder with Pi tools:

```text
tracing_start({"name":"benchmark", "output_path":"recordings/benchmark.pftrace"})
tracing_stop({})
```

Both `tracing_start` arguments are optional. Relative output paths resolve from
Pi's working directory; without one, traces go to the default directory below.
Start returns the expected absolute path. Stop returns the actual published path
and any finalization warning. An existing `.pftrace` or `.pftrace.part` at the
requested path is never overwritten. Child sessions contribute to the owner's
recording and cannot choose a separate output path.

Shortcuts (TUI only, headless uses the commands/flags above):

- `ctrl+shift+t` — optional manual toggle (start if off, stop if recording)

Flags / env:

- `pi --tracing` (registered boolean flag) or `PI_TRACING=1` — autostart recording.
  Normal Pi exit finalizes it and prints the trace path to stderr; no manual
  stop is required.
- `PI_TRACING_STARTUP=off|armed|recording`, `PI_TRACING_CATEGORIES=agent,llm,-tools`,
  `PI_TRACING_MAX_FILE_MB`, `PI_TRACING_CAPTURE_CONTENTS=0` (omit tool arguments).
- `PI_TRACING_CHILD_TOOLS=rig_launch,subagent,my_tool` — override the
  child-agent spawner allowlist (default `rig_launch,subagent`).
- `PI_SUBAGENT_EXTENSIONS=<paths>` — extra `--extension` flags for
  spawned workers (honored by the braid and subagent launchers); pair with
  `PI_TRACING=1` so workers join the recording.

Config files (schema-validated, never crash startup on malformed input):

1. `<agentDir>/pi-tracing.json` (global, via `getAgentDir()`)
2. `<cwd>/<CONFIG_DIR_NAME>/pi-tracing.json` (project override, only when trusted)
3. env beats files; CLI flags beat env; live `/tracing categories` beats all for
   the current process. `system: true` is rejected with a "reserved" error.

## Codemode

Pi's codemode needs no extra tracing flag. For example:

```bash
pi --tracing --tools read,bash,edit,write,codemode
```

The recorder captures scripts and nested tool calls on **Tools**, with flow
arrows from the script to each call and `parent_call_id` on children. The
**Tools → Scripted tool use** table expands to show those calls. Script wall
time is separate from tool totals and concurrency. Pi records
`session_labels: ["codemode"]` when the tool is enabled and omits the annotation when the list is
empty. The UI displays the recorded labels without deriving a tool-mode name.
The default supports 64 simultaneous calls, including
scripts; exhausted lanes increment **Lane overflows** and produce a UI warning.

Pi 1.0.0's `models.classify` and `models.generateImages` bypass tool hooks.
Their streamed lifecycle snapshots provide separate `model-call` spans linked
to the script. These intervals can include queue time, so they do not contribute
to model-response speed or busy metrics. Tool-reported model usage contributes
once to session token counters, without assigning aggregate usage to individual
model calls. Older Pi versions without these snapshots cannot expose those spans.
Script source is included with tool arguments by default. Set
`PI_TRACING_CAPTURE_CONTENTS=0` to omit it.

See [the recorded comparison](../../examples/pi-codemode/README.md) for a verified
classic/codemode pair and a reproducible recording command.

## Output

Successful `tracing_stop`, `/tracing stop`, and normal session shutdown publish
`<agentDir>/pi-tracing/<session>-<ts>[-name].pftrace` plus its `.json`
sidecar manifest (awaited within the finalize deadline — short-lived workers
no longer lose it on exit). If the configured
finalization deadline expires or a write/publish operation fails, the recorder
retains a repaired, directly parseable `<name>.pftrace.part` instead of claiming
success. Abandoned parts are owner/PID validated before recovery or quarantine
and are never silently deleted.

Open in `ui.perfetto.dev`, or query standalone:

```bash
trace_processor trace.pftrace -Q "SELECT name FROM track ORDER BY name LIMIT 20"
# or: PERFETTO_TRACE_PROCESSOR=/path/to/trace_processor
```

## Mergeable clocks and machines

Every trace starts with a `ClockSnapshot` that relates its high-resolution
event clock, `CLOCK_BOOTTIME`, and `CLOCK_REALTIME`, and declares REALTIME as
the primary trace clock. The mapping is refreshed every 60 seconds. Linux reads
fractional boot time from `/proc/uptime` to avoid runtime uptime rounding. Separately
recorded Pi traces can be opened together with Agent Profiler's **Open trace file** in the top bar or packaged as a multi-trace TAR. Cross-machine alignment uses
wall time and depends on the hosts' clock synchronization.

Each recording has a unique capture ID and parent track, plus the full Pi session
ID in metadata. Captures stay separate in the overview table even when they
share a process or session. `/tracing start <name>` records an optional capture
label, useful for comparing variants such as `code-mode` and `classic`. Model,
effort, harness, token totals, and context usage are shown per session.

Every packet also carries one boot-scoped Perfetto `machine_id`, derived with
the same 64-bit FNV-1a scheme as Perfetto/Kineto: Linux hashes
`/proc/sys/kernel/random/boot_id`; macOS hashes `kern.bootsessionuuid`. All Pi
processes from one boot receive the same ID, while traces from different
machines remain distinct. Neither the raw boot identifier nor hostname enters
the `.pftrace`; only the derived integer ID does. If boot identity is
unavailable, field 98 is omitted and Perfetto's
host-default machine ID zero is used; `/tracing status` makes that fallback
visible.

## Tracks, flows, and child agents

The repository includes a [recorded subagent workflow](../../examples/pi-opus-5/README.md)
and an example launcher that forwards `PI_SUBAGENT_EXTENSIONS`, enables tracing
in children, and sets `DEVMATE_PARENT_SESSION_ID` and `PI_SUBAGENT_TYPE`. Each
launch returns the child session UUID for the parent recorder to capture.

- Pi's main OS thread carries the `profile (N)` capture span, prompt, attempt,
  turn, and input events. `Requests` and `Responses` retain their own
  tracks for request and assistant-message intervals. Metadata belongs to
  these spans rather than duplicate summary instants.
  The main thread uses Pi's real OS thread ID on Linux;
  `Session` remains the fallback when an OS thread ID is unavailable.
- `Compaction` — spans from Pi's before/complete/failure hooks, including the
  trigger and outcome. The profile span stores the highest observed context
  estimate; an unknown post-compaction context ends the previous gauge plateau.
- `Tools` — one visual track per capture. Concurrent calls still get separate
  track UUIDs internally; identical names and Perfetto's sibling merge behavior
  combine them into a compact row with overlapping calls laid out separately.
- `Workflow` — delegation metadata on the existing tool execution span for
  `rig_launch`, `subagent`, and configured `childTools`: `delegation = true`,
  launch identifiers, and the returned `child_session`. There is one interval on
  `Tools`, measuring the launch call. The child records its own lifetime.
  With the `tools` category disabled, `workflow` still records these calls on tool lanes.
  Rig slash-command launches (`/rig:launch`, `/rig:advance`-driven spawns)
  bypass Pi tool hooks, so workflow-rig announces them on the shared
  extension event bus (`workflow-rig:worker-launched`); pi-tracing subscribes
  when the event exists and records separate launch events on the workflow track.
- **Run lifecycle** (same bus, same `workflow` category, no rig dependency
  when absent): `workflow-rig:run-started` opens a long `run` slice
  on the `Workflow` track; `workflow-rig:reconcile` renders each reconcile
  pass as a backfilled `reconcile` slice, with `root_id`, `outcome`, and measured
  `duration_ms` in typed debug annotations; `workflow-rig:run-terminal` closes the run slice with the
  durable outcome (or an instant when the start was missed);
  `workflow-rig:spawn-confirm` marks human confirmation gates. Together they
  show run start, orchestration overhead, confirm waits, launches, and final
  result on one timeline.
- **Flows:** every tool call emits one Perfetto flow from the `tool-preflight`
  instant on the agent track to the execution BEGIN on the tool lane, drawn
  as an arrow in the UI (`flow` table in SQL). Flows ride on existing packets
  (~10 bytes each) and need no category of their own. Child launches also emit
  a deterministic flow ID derived from the child session UUID on the tool BEGIN
  and the child's first `prompt-input`. The BEGIN is written when the result
  supplies that UUID, using the saved start timestamp. Later inputs and repeated
  results for the same child do not reuse the link. See
  [prompt flows](../../docs/prompt-flows.md) for the encoding and import limits.
- **Parent/child correlation:** spawned children (`pi --mode rpc` via rig or
  subagent) inherit the parent environment, so `PI_TRACING=1` traces them too.
  You rarely set this by hand: while this session is recording, pi-tracing
  mirrors `PI_TRACING=1` and its own `--extension` path into the environment
  children inherit (braid and subagent read the latter via `PI_SUBAGENT_EXTENSIONS`).
  Explicit user settings are never overridden and are restored on stop.
  `PI_TRACING=0` blocks inheritance even while recording.
  Each trace carries a random `session:<uuid>` process label; rig workers and
  subagents additionally annotate the `profile (N)` span with the launching session ID
  (`DEVMATE_PARENT_SESSION_ID`) and their role. `rig_launch` results contribute
  the detached child session ID (`child_session` annotation) when present.
- **One file per recording:** the top-level session and local descendants share
  a recording directory inherited through `PI_TRACING_RECORDING_DIR`. Each
  process uses its existing bounded writer and 5 ms flush timer for a private
  spool under `.recordings/`. Stopping the owner or exiting Pi asks children
  to stop tracing, without stopping their tasks, and publishes one `.pftrace`.
  Spawns that preserve the environment join automatically, including nested
  subagents; no tool-name matching or session-file discovery is needed to collect
  their events. Independent top-level recordings remain separate.
- **Finalization:** the owner briefly waits for children to flush, then merges
  complete packets with unique sequence IDs and the owner's clock calibration.
  This preserves timestamp ordering and native cross-process flows. Busy or
  crashed children contribute their available packets, with open spans marked
  incomplete and sampled counters closed at zero. Completed spools are removed;
  incomplete or failed finalization retains them for recovery. The existing
  finalize deadline and `maxFileMB` also bound the combined recording.


## Privacy

Prompt text is recorded by default on `prompt` under `pi.prompt-data`.
Use `/tracing categories prompt-data off` or `PI_TRACING_CATEGORIES=-prompt-data`
to keep only prompt length. This captures the user/task prompt observed by
`before_agent_start`, not the system prompt or accumulated conversation.
Text is capped at 65,536 UTF-16 code units without splitting a surrogate pair;
`truncated` marks a shortened value and length always describes
the complete prompt.

Tool-call arguments are also recorded by default, including bash command lines,
file paths, edit old/new text, and script source. They are stored on the tool's
execution span, capped at 65,536 UTF-16 code units across keys and text, 128 values,
and eight nesting levels. `args_truncated` marks omitted arguments. Set
`PI_TRACING_CAPTURE_CONTENTS=0`, `captureContents: false` in configuration, or
`/tracing categories contents off` to keep only argument sizes and key lists.
Tool results remain excluded. `/tracing status` reports prompt and tool-argument
capture separately.

Interactive user-bash events (distinct from the agent's bash tool) record only a validated
executable token plus command length; environment assignments, quoting,
substitutions, and shell punctuation are redacted.

Exceptions required for the workflow feature (documented, identifiers only):

- `session:<uuid>` process label on every trace (random join key, also in the
  filename tag) plus `role:rig-worker` / `role:subagent` when applicable.
- Workflow spans record rig `task_id` / `root_id` / `namespace` /
  `expected_session_id` and the launched child's session id when the tool
  result carries one. The child's task prompt is recorded on its own operation
  when `prompt-data` is enabled; launch metadata does not duplicate task text.
- Host names never enter `.pftrace` or its final manifest. The temporary owner
  sidecar records one for safe abandoned-capture recovery on shared homes.

## Layout

```text
extensions/pi-tracing/
  index.ts        factory: wiring, commands, shortcuts, flags, widgets
  config.ts       layered config load/validate/precedence
  encoder.ts      zero-dep protobuf writer (varint/fixed64/length-delimited)
  machine.ts      boot-scoped Perfetto machine-id derivation (Linux/macOS)
  tracks.ts       descriptors, 64-bit UUIDs, free-lane tool/workflow allocator
  tracer.ts       OFF/RECORDING state machine, queue, .part finalize
  workflow.ts     child-launch description + child-role detection (pure)
  probe.ts        Phase-0 Bun runtime probe (pure, testable)
  encoder.test.ts bun test for wire vectors
```

## Validation

From the repository root:

```bash
npm ci
npm run check
PERFETTO_TRACE_PROCESSOR="$PWD/third_party/src/perfetto/tools/trace_processor" npm test
npm run check:example
pi --no-extensions -e ./packages/pi-tracing -p "/tracing probe"
```

Prepare the Perfetto checkout with `python3 tools/perfetto setup` before using
its Trace Processor launcher. Import tests skip locally when no processor is
available; CI requires one. See [CONTRIBUTING.md](../../CONTRIBUTING.md) for the
full UI validation workflow.
