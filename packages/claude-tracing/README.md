# Claude Code tracing

The interactive plugin records Claude Code's session events directly. Start and
stop recordings with a button, slash commands or agent tools while using Claude normally.
Recording does not require a separate launcher or telemetry collector.

## Install

Requires Claude Code **2.1.289 or later**, with mods enabled, and **Node.js 22 or
later** on `PATH`. Tested with 2.1.289. After this version is published to GitHub:

```sh
claude plugin marketplace add dreveman/agentprof
claude plugin install agentprof@agentprof
```

Then start `claude` normally in your project. No checkout, npm install or
telemetry setup is required. Restart existing Claude sessions after installing
or updating the plugin.

To install unpublished changes from a checkout, replace `dreveman/agentprof` in
the marketplace command with the checkout's absolute path. For a single-session
development test, use:

```sh
claude --plugin-dir ~/agentprof/packages/claude-tracing
```

If `/tracing` is missing, check `/plugin` for loading errors. Mods must be enabled
for your account and workspace; safe mode and managed policy can disable them.
Update Claude and open a normal online session to refresh feature availability.

## Record

The strip above the prompt shows recording state, the file path and a start/stop
button. Click the button, or press **Ctrl+X**, then **Tab**, then **R** while the
strip has focus. **Esc** returns focus to the prompt. This uses Claude's focused
button hotkey; it does not replace a global keyboard binding. The same controls
are available as immediate commands:

```text
/tracing start
/tracing status
/tracing stop
```

`start` prints the absolute output path. With no path, each recording gets a
unique file under `agentprof-traces/` in the project directory. To choose a path,
use `/tracing start recordings/task.pftrace`; quote paths containing spaces.
`stop` saves the file and prints its path. These commands run immediately,
including while Claude is working, without a model request. `/tracing` alone
shows status. You can start another recording after stopping the first.
Existing files are never overwritten.

The agent can use these tools, exposed by Claude with its plugin namespace:

| Tool | Arguments | Result |
| --- | --- | --- |
| `mcp__agentprof__tracing_start` | Optional `output_path` | Recording state, absolute path and capture ID |
| `mcp__agentprof__tracing_stop` | None | Saved path, publication status and capture summary |
| `mcp__agentprof__tracing_status` | None | Current state and current or last recording path |

For example: “Start tracing, investigate the slow test, then stop tracing and
tell me where the trace was saved.” The tools share the commands' recording
state. Duplicate starts and stops without a recording return an error. A failed
save reports the retained capture directory with `published: false`. Recording
control calls are excluded from the trace's tool activity. Tool results are JSON
text; stop also reports incomplete operations when present.

A start during a prompt retains its excerpt and marks the prompt as partial.
Responses already streaming at start are excluded; unfinished operations at stop
are marked incomplete and their usage is not invented. Start before submitting a
task and stop after it finishes when you want complete model timings and usage.

To record automatically on each launch, enable **Record automatically** in
`/plugin configure agentprof@agentprof` (the `auto_start` option). Turn off
**Show recording controls** (`show_controls`) to hide the strip; commands and
tools remain available. Both options also appear in `/config` and take effect
on the next load. Automatic capture is off by default; controls are on.

For one launch with an explicit filename, set `AGENTPROF_TRACE_FILE` to an unused
`.pftrace` path. It overrides automatic filename selection:

```sh
AGENTPROF_TRACE_FILE="$PWD/agent.pftrace" \
  claude
```

`/exit` finishes an active recording automatically. It prints the destination;
a one-shot Node process publishes the file after flushing, so large recordings
can finish outside Claude's short shutdown deadline. `/tracing stop` waits for
publication before reporting success.

`/clear`, `/resume` and `/branch` keep recording into the same file, with separate
capture windows for the conversations. Reloading the plugin retains recording
state and buffered events. Work whose callbacks were interrupted by a reload is
marked incomplete. Starting midway through a subagent adopts its prompt as
partial; stopped recordings never receive late events from a later recording.

## Captured data

Direct capture records:

- Prompts, streamed response intervals, first content/text latency and per-response
  input/output/cache usage. Response timing includes request retries.
- Tool arguments, reported execution duration, errors and the full dispatch
  interval. Dispatch includes permission and hook delays; execution excludes
  them. Execution is positioned at the observed post-tool hook using its reported
  duration, so its absolute placement is approximate.
- Subagent prompts, responses and tools as logical sessions in the actual Claude
  process, with a flow from the launching tool to the child prompt.
- Compaction duration, trigger, outcome, reported token usage and before/after
  context size. Compaction usage contributes to token counters without adding
  assistant turns. Precomputed summaries do not reset context size.
- Main-session context readings and the window reported by Claude's session API.
  A child's context size comes from its own input usage; its model limit remains
  unknown because the session API describes the main conversation.

The plugin forwards events and results unchanged and does not record response
text or tool output. It batches observations once per second into private
`agent.pftrace.capture/` files, with no per-tool helper process or telemetry
collector. Prompts and tool arguments are bounded and contain potentially
sensitive task content. The journal is bounded to 64 MiB;
omitted content is marked, and dropped events mark the recording incomplete.
An abrupt process kill can lose up to the latest unflushed batch. The journal
survives; a failed background conversion writes `error.txt` beside it. Recover
with the bundled writer (find the installed plugin path with
`claude plugin list --json`):

```sh
node /path/to/installed/agentprof/runtime/direct-writer.mjs finish \
  /absolute/path/to/agent.pftrace.capture
```

This publishes the recording's original destination, refusing to overwrite an
unrelated file. With a development checkout, you can instead replay to a new path:

```sh
~/agentprof/node_modules/.bin/bun ~/agentprof/tools/convert-claude.ts \
  agent.pftrace.capture recovered.pftrace
```

The bundled Node writer ships inside the plugin. After changing its TypeScript
sources, run `npm run build:claude`; `npm run check` verifies the bundle is current.
The mod API is documented in Claude's
[mods reference](https://code.claude.com/docs/en/plugins/mods/reference).

## Updates and development

```sh
claude plugin marketplace update agentprof
claude plugin update agentprof@agentprof
```

Restart Claude to load the update. Release changes bump the version in
`.claude-plugin/plugin.json` and regenerate `runtime/direct-writer.mjs` with
`npm run build:claude`. The marketplace reads that version from the plugin;
there is no second version to synchronize. The distributable contains the mod,
its state contract and a self-contained Node writer; it has no runtime npm
dependencies. Local recordings are not shipped.

`npm run check:claude-plugin` validates the marketplace and plugin, installs a
staged copy using an isolated Claude configuration, and tests controls in Claude's
native mod host. CI pins the tested Claude version and requires no credentials.
`npm test` covers reloads, clear/resume, interrupted writes, capture boundaries,
subagents, stream cancellation, publication failures and Perfetto import.

## Print-mode OpenTelemetry launcher

Records one local Claude Code print-mode process and its subagents into a single
Perfetto file. A temporary loopback HTTP listener receives Claude's native
OpenTelemetry spans and logs. An observational plugin supplies lifecycle events
and tool arguments. The launcher configures only its child process; it does not
install plugins globally or change Claude settings.

From the repository root, after `npm ci` and `claude auth login`:

```sh
npm run trace:record-claude -- artifacts/claude-task.pftrace -- \
  -p --model haiku --max-budget-usd 2 -- 'Investigate the task in this directory.'
```

Claude arguments after the first `--` are passed through. Use a second `--`
before a positional prompt when preceding options accept multiple values.
The launcher chooses `--output-format stream-json --verbose`, forwards that
output, and reads final usage metadata. It requires `-p` and loads the separate
`legacy/` plugin. Direct capture stays off when the legacy launcher is active.

To record work in another project, install the checkout once (requires Git and
Node.js/npm):

```sh
git clone https://github.com/dreveman/agentprof.git ~/agentprof
npm ci --prefix ~/agentprof
```

Then run the launcher from your project directory, using the Bun executable
installed with the checkout:

```sh
~/agentprof/node_modules/.bin/bun \
  ~/agentprof/tools/record-claude.ts \
  agent.pftrace -- -p -- "Your task"
```

The launcher preserves your current working directory. It saves `agent.pftrace`
there and prints its absolute path when Claude Code exits.

The output path must be unused. Once session metadata is received, normal exit,
including a failed model request, publishes the trace. Raw observations and a summary are stored beside it in
`<output>.capture/`. The journal is flushed every second and retained if
conversion fails or the launcher is interrupted. Replay a retained journal with:

```sh
npx bun tools/convert-claude.ts \
  artifacts/claude-task.pftrace.capture/observations.jsonl \
  artifacts/claude-task-replayed.pftrace
```

The raw journal is bounded to 128 MiB. Dropped observations appear in the summary.
The receiver accepts only authenticated requests on loopback. Traces and raw
journals contain prompts and tool inputs, including commands and edit arguments;
raw telemetry may also contain account metadata supplied by Claude. The hook
does not copy tool results, and full API bodies and assistant text export are
disabled. Files are local and created with private permissions.

## Recorded data

- Native model-request, tool-execution and permission-wait intervals.
- Input/output counters, reported cache usage, request-context size and the
  model context limit when Claude's final usage metadata supplies it.
- Prompts, bounded typed tool arguments and descriptions supplied by Claude.
- Logical subagent sessions beneath the actual Claude OS process, with causal
  links from native span ancestry. No synthetic process or thread IDs.
- Compaction duration, trigger, outcome and before/after context counts when
  Claude emits its compaction telemetry.

The converter reuses pi-tracing's protobuf encoder and machine identity. It
orders events by their original timestamps, deduplicates native spans, assigns
overlapping work to mergeable sibling tracks, and resets sampled counters at
capture end. Wall-clock timestamps use Perfetto's REALTIME clock and a clock
snapshot, so recordings can be loaded alongside Pi traces.

Claude Code writes `claude.metadata` and `claude.activity` categories; Pi uses
`pi.*`. Event kinds and annotations share the same
[trace data contract](../../docs/trace-data.md). The UI also reads `agentprof.*`
categories from earlier Claude Code prototype recordings.

## OpenTelemetry measurement limits

This is a capture prototype, not full Pi tracing parity:

- Model intervals cover the complete native request, including retries. This
  differs from Pi's message lifecycle boundary. `timing` records the distinction.
- Claude's older `ttft_ms` is stored separately. It is not presented as the UI's
  first-content measurement; that requires a recorded `first_content_ms`.
- Context size is input usage from a measured request, including cache reads
  and writes. It is not a continuously updated estimate. Missing model limits
  remain unavailable; they are never inferred from peak context.
- Input usage preserves Claude's reported uncached-input semantics, matching
  Pi's Anthropic usage fields. Cache counts are separate and never added twice.
- A tool observed by hooks without its native execution span is marked
  incomplete and excluded from measured activity. Abrupt termination can lose
  spans that Claude had not yet exported.
- CPU and heap sampling are omitted: the collector's resource use is not the
  agent's resource use. Command hooks add process-start overhead; the prototype
  is intended to establish capture correctness before minimizing that overhead.

The installed client used during development is Claude Code 2.1.252. Native
span tracing is a beta interface. See Claude's
[monitoring reference](https://code.claude.com/docs/en/monitoring-usage#traces-beta)
and [hook reference](https://code.claude.com/docs/en/hooks) for version-specific fields.

## Validation

```sh
npx bun test packages/claude-tracing
python3 tools/probe-claude.py
```

The live probe uses a disposable fixture under `artifacts/claude-prototype/`,
asks for parallel tools and a subagent, exercises an intentional exit-code-7
failure, then sends `/compact` and a short follow-up in the same process.
It requires working Claude authentication. `--skip-compaction` runs only the
workflow. The expected sum is 50 and the line count is 3.

Offline tests import generated fixtures using Trace Processor and validate
subagent attribution, flows, token accounting, overlapping intervals, missing
measurements and import health. They require the repository's Trace Processor
or `PERFETTO_TRACE_PROCESSOR` pointing to an installed binary.
