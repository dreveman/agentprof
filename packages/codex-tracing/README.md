# Codex tracing

Record interactive Codex sessions into a Perfetto trace that opens directly in
Agent Profiler's Overview. The plugin provides agent tools, typed recording
controls, automatic recording and save on exit. Tested with Codex CLI 0.160.0
on Linux; requires Node.js 22 or later.

## Install and record

With Codex already installed and signed in:

```sh
npm install -g github:dreveman/agentprof
agentprof-codex install
codex --no-daemon -p agentprof
```

In Codex, open `/hooks` once to review and trust the recording hooks. Then type:

```text
tracing start
```

Run your task normally. Type `tracing stop` to begin saving, or exit Codex.
Stop returns **saving** immediately; use `tracing status` later to confirm
**saved** or inspect an **error** and its retained journal. A start can also
specify a new path: `tracing start recordings/my-task.pftrace`. Relative paths
are resolved against that session's working directory. Existing traces and
capture journals are never overwritten.

These are plain typed controls, without a slash. They are handled before a
model request. Codex currently labels the intercepted turn **Blocked by hook**;
the message below it reports whether recording started or saving began.
Codex 0.160.0 does not expose plugin toolbar buttons or custom recording
keybindings.

The agent can use `tracing_start` (optional `output_path`), `tracing_stop` and
`tracing_status`. The host supplies the current session identity, so tools do
not guess between concurrent conversations. A recording includes its subagents
in the same file; unrelated sessions remain separate.

To record automatically on startup instead:

```sh
agentprof-codex install --auto-start
codex --no-daemon -p agentprof
```

Re-run `agentprof-codex install` without that option to return to manual start.
The installer updates only an unedited profile it generated. Starting and
stopping repeatedly creates separate recordings. Resuming a session can start
a new recording with the same native session ID; capture IDs distinguish them.

For a local checkout, installation needs no global npm package:

```sh
node packages/codex-tracing/runtime/codex-tracing.mjs install
codex --no-daemon -p agentprof
```

## How the profile works

The installer registers the repository's Codex plugin marketplace and writes
`$CODEX_HOME/agentprof.config.toml` (normally under `~/.codex`). Your model,
authentication and permission settings still apply. The profile opts that
runtime into native telemetry directed to an authenticated loopback receiver.
`--no-daemon` gives it its own runtime so it does not inherit another daemon's
telemetry configuration.

Codex 0.160.0 loads the plugin's MCP tools but does not discover its bundled
hooks in our native installation test. The generated profile therefore declares
the hooks explicitly, pointing to the installed plugin. Hooks remain subject to
Codex's normal trust review.

Installation starts an authenticated local receiver and keeps it listening
between sessions so the profile's fixed OTLP port cannot be reused while the
receiver is healthy. The first cold hook also starts it if needed; concurrent
launches share a fenced startup lock. A warm hook sends one request rather than
a separate health probe. Private journals flush every second. Only recorded
sessions are written; unrecorded native telemetry is discarded. Saving
continues for approximately seven seconds to collect batched exports while
the end timestamp stays fixed; `tracing status` reports the terminal result.

If a crashed receiver's configured port is subsequently occupied, hooks fail
open with an explicit diagnostic rather than connecting to an unrelated server.
Re-running `agentprof-codex install` rebinds an **owned** profile to a new port
and starts its receiver. Restart Codex afterward: already-running Codex
processes still export native telemetry to the old port and cannot be silently
repaired. Plugin updates restart an idle receiver when its build differs; an
active recording must finish before the receiver can be replaced; stop/status
and SessionEnd remain usable against the older receiver during that interval.
A crashed startup lease is reclaimed after its grace period under a kernel
lock (`flock` on Linux, `lockf` on macOS, a named mutex on Windows). If the
platform helper is unavailable, stale recovery fails safely instead of
risking concurrent receiver starts.
Session PID/start-time checks detect process reuse on Linux; platforms
without that marker retain the PID fallback. See the [hook latency benchmark](../../docs/hook-latency.md)
for the remaining per-event Node process cost. Exit also initiates asynchronous
saving. Recording controls are excluded from tool activity.

## Optional exec launcher

Install the repository dependencies once, with an authenticated Codex CLI already
available on `PATH`:

```sh
git clone https://github.com/dreveman/agentprof.git ~/agentprof
npm ci --prefix ~/agentprof
```

The original launcher remains available for a one-off task from your project:

```sh
~/agentprof/node_modules/.bin/bun \
  ~/agentprof/tools/record-codex.ts \
  agent.pftrace -- --sandbox workspace-write "Your task"
```

Arguments after `--` are Codex exec options and the prompt. For example, add
`-m MODEL -c 'model_reasoning_effort="high"'`, or `-C /path/to/project`.
Codex's permissions, models, authentication and existing configuration still
apply. The recorder supplies its own telemetry configuration and uses a fresh
runtime with `--no-daemon`; it does not edit your configuration files.

On exit, the launcher prints the absolute trace path to stderr and preserves
Codex's exit code. Its JSON output continues to stdout. Open the `.pftrace` file
in Agent Profiler. Use a new output path for each run; existing captures are not
overwritten. Interrupt signals are forwarded to Codex so it can flush telemetry.

## Captured data

- Real process identity, logical agent sessions and wall-clock alignment for
  loading recordings together.
- Prompts, model, provider and reasoning effort.
- Measured model stream durations and reported input/output/cache/reasoning
  usage. TTFT is stored separately from first-content timing.
- Tools and arguments, command exit status when present, sandbox denials,
  scripts and their nested tool calls.
- Cumulative input/output counters, sampled context size and the effective
  model context limit. Counters return to zero when the capture ends.
- Partial composition estimates from the captured session's durable transcript,
  with retained tool-result counts and observed compaction replacements. These
  do not expose Codex's complete outgoing request. See
  [context measurements](../../docs/context-data.md) for interpretation and UI.
- Child-session relationships when Codex records source metadata, and flows
  from prompts through model/tool work and into observed child prompts.

Scripts are recognized from native code-mode spans, with JavaScript and line
count descriptions. Startup prewarming appears under Tracing and is excluded
from normal response counts and session token totals.

Input usage preserves Codex's reported semantics: it includes cached input.
Cache counts are informational subsets and are not added to context size.
Context size is sampled request input, not a continuously measured gauge. The
context limit comes from Codex's own session metadata, not the observed peak.

## Recovery and measurement boundaries

Each recording creates `agent.pftrace.capture/observations.jsonl`, with captured
native telemetry, hooks and narrowly selected session metadata. It can be
converted again without running a model. Recovery skips malformed complete
JSONL records and an interrupted final fragment, counts them as
`corruptRecords` in `summary.json`, and marks the trace incomplete while
retaining later valid observations. A missing process identity still prevents
publication:

```sh
agentprof-codex recover agent.pftrace.capture recovered.pftrace
```

The development converter also accepts the journal:

```sh
~/agentprof/node_modules/.bin/bun ~/agentprof/tools/convert-codex.ts \
  agent.pftrace.capture/observations.jsonl recovered.pftrace
```

By default recordings contain bounded prompt text and tool arguments; the raw
journal can also contain tool output. Set `AGENTPROF_CAPTURE_CONTENTS=0` before
launching Codex (or the exec recorder) for a metadata-only new capture. This
strips prompt and argument values and tool output **before** the persistent
journal is written; recovery cannot restore them. Prompt lengths from hooks,
tool names/IDs, timing, model, usage and outcome metadata remain. The recording
path, session IDs and native process metadata remain. Codex's own session logs
are managed by Codex and are not erased by this switch. Both the trace and
journal are private files when created.

Capture boundaries can cut through prompts, requests and tools; partial spans
are marked incomplete. Hooks record compaction boundaries, and compaction
response usage contributes to counters without adding assistant turns. A tool
without native timing uses its observed hook interval, labeled `hook-dispatch`,
which includes hook and permission delays. Native timing takes precedence.

Existing shared daemons and CPU/heap sampling are not supported. The exec
launcher rejects `--ephemeral`; the plugin leaves context limits unknown if
session metadata is unavailable. The transcript reader is intentionally narrow
and version-sensitive; it reads only sessions identified by this capture, and
never copies reasoning or base instructions.

Completion events in this Codex version lack span IDs. The converter associates
usage only with a unique native model stream ending between 1 ms before and
5 ms after the completion log in the same session. Unmatched usage remains recorded with an
incomplete measurement and is excluded from measured response speed.

The journal is bounded to 128 MiB; discarded observations mark the capture
incomplete. Force-killing Codex can lose its unflushed native telemetry. Replay
preserves measurements received before shutdown; it cannot reconstruct missing
native spans.

To remove the integration, finish active recordings and run
`agentprof-codex receiver-stop` to release the reserved port. Then run
`codex plugin remove agentprof@agentprof` and remove the generated
`agentprof.config.toml` profile. Other Codex profiles and settings are
unaffected.

## Development

```sh
npm run check
npm test
npm run check:example
npm run check:codex-plugin
```

Fixtures cover deferred/repeated telemetry, prewarming, missing usage/timing,
scripts, logical children, command errors, context-limit changes and native
Perfetto import. Browser tests exercise the Codex overview and tool drill-down.
The plugin check validates a fresh native installation, the profile's hooks and
tool discovery without model credentials. The bundled Node runtime is checked
for staleness; regenerate it with `npm run build:codex` after recorder edits.
