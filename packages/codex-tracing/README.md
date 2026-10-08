# Codex tracing

Record interactive Codex sessions into a Perfetto trace that opens directly in
Agent Profiler's Overview. The plugin provides agent tools, typed recording
controls, automatic recording and save on exit. Tested with Codex CLI 0.160.0
on Linux; requires Node.js 22 or later. The Unix-socket implementation is
expected to work on macOS but is not yet validated there; Windows fails closed.

## Install and record

With Codex already installed and signed in:

```sh
npm install -g github:dreveman/agentprof
agentprof-codex install
codex -p agentprof
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
codex -p agentprof
```

Re-run `agentprof-codex install` without `--auto-start` to return to manual
start, then launch with the usual Codex command and `-p agentprof` to enable
the plugin. The installer never edits your base configuration and refuses to
replace an edited Agent Profiler profile. Starting and
stopping repeatedly creates separate recordings. Resuming a session can start
a new recording with the same native session ID; capture IDs distinguish them.

For a local checkout, installation needs no global npm package:

```sh
node packages/codex-tracing/runtime/codex-tracing.mjs install
codex -p agentprof
```

## How the profile works

The installer registers the Codex plugin and writes an owned
`$CODEX_HOME/agentprof.config.toml` (normally under `~/.codex`) containing
hooks but **no native telemetry exporter**. Codex layers this profile on top
of the normal model, authentication and permission settings. Launch it with
`codex -p agentprof`; there is no Agent Profiler wrapper or change to the
ordinary Codex executable.

Codex 0.160.0 loads the plugin's MCP tools but does not discover its bundled
hooks in our native installation test. The generated profile therefore declares
the hooks explicitly, pointing to the installed plugin. Hooks remain subject to
Codex's normal trust review.

The first hook starts a short-lived local recorder on a Unix socket in a
private `0700` temporary directory. Hook processes and MCP tools connect only after checking
the recorder's process identity. There is **no TCP port in the profile** and
Codex never exports native telemetry to an endpoint that might be unbound.
The recorder closes the socket and exits shortly after the last session and
recording finish. An interrupted or failed publication retains the private
journal for `agentprof-codex recover`.

**Upgrading an older fixed-port profile:** First finish recordings and close
*all* Codex processes started with the old profile. Shut down the old receiver
only after no such process can export to it; inspect the specific
`codex-tracing.mjs serve` process rather than killing unrelated receivers.
Then run `agentprof-codex install --migrate`. Migration checks ownership of the
old profile and refuses to remove it while its port is still bound. It replaces
only an unedited generated profile, and does not launch another persistent
receiver. If the old profile was edited, remove its OTLP settings manually
after closing old Codex processes. Do not use `codex -p agentprof` to record
after migration without enabling the plugin profile; use `codex -p agentprof`.
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
- Reported input/output/cache/reasoning usage and context limits from the
  captured session transcript. Response completion is observed, but native
  model-stream duration, TTFT and first-content timing are unavailable.
- Tools and arguments, hook-dispatch intervals and command exit status when
  present. Native script spans, precise tool durations and nested code-mode
  calls are unavailable in plugin-only recordings.
- Cumulative input/output counters, sampled context size and the effective
  model context limit. Counters return to zero when the capture ends.
- Partial composition estimates from the captured session's durable transcript,
  with retained tool-result counts and observed compaction replacements. These
  do not expose Codex's complete outgoing request. See
  [context measurements](../../docs/context-data.md) for interpretation and UI.
- Child-session relationships observed in hooks and transcript metadata;
  hook prompt and response events link where their timing is known.

The optional separate exec recorder below can retain native code-mode spans
and startup prewarming; the interactive plugin cannot infer those from hooks.

Input usage preserves Codex's reported semantics: it includes cached input.
Cache counts are informational subsets and are not added to context size.
Context size is sampled request input, not a continuously measured gauge. The
context limit comes from Codex's own session metadata, not the observed peak.

## Recovery and measurement boundaries

Each recording creates `agent.pftrace.capture/observations.jsonl`, with captured
hooks and narrowly selected session metadata. It can be
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

Capture boundaries can cut through prompts and tools; partial spans are
marked incomplete. Hooks record compaction boundaries; transcript usage is
reported at completion without inventing a model-request duration. Tool
intervals use `hook-dispatch`, including hook and permission delays.

Existing shared daemons and CPU/heap sampling are not supported. The exec
launcher rejects `--ephemeral`; the plugin leaves context limits unknown if
session metadata is unavailable. The transcript reader is intentionally narrow
and version-sensitive; it reads only sessions identified by this capture, and
never copies reasoning or base instructions.

Transcript token counts are attributed to observed completions with
unmeasured duration. If session metadata is unavailable, response usage stays
unknown; the plugin does not fabricate duration or token counts. The separate
exec recorder continues to use native stream matching when available.

The journal is bounded to 128 MiB; discarded observations mark the capture
incomplete. Force-killing Codex can lose its final hook or transcript records.
Replay preserves observations received before shutdown.

To remove the integration, finish active sessions, then run
`codex plugin remove agentprof@agentprof` and remove the owned
`agentprof.config.toml` hook-only profile. No receiver remains running between
runs. Other Codex profiles and settings are unaffected.

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
