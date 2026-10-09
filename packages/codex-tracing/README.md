# Codex tracing

Record interactive Codex sessions into a Perfetto trace that opens directly in
Agent Profiler's Overview. The plugin provides agent tools, typed recording
controls, automatic recording and save on exit. Requires Codex CLI 0.160.0 or
compatible hooks and Node.js 16.20.2 or later. Native hook/MCP discovery was
validated without model credentials on Linux with Codex CLI 0.159.3; a real
0.160.0 run remains to be checked on the user's Codex host. The Unix-socket
implementation is expected to work on macOS but is not yet validated there;
Windows fails closed.

## Install and record

With Codex already installed and signed in:

```sh
codex plugin marketplace add dreveman/agentprof
codex plugin add agentprof@agentprof
codex
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

To record automatically on startup instead, set
`AGENTPROF_CODEX_AUTO_START=1` in the environment before launching the normal
`codex` command. Clear it to return to manual start. Starting and stopping
repeatedly creates separate recordings. Resuming a session can start
a new recording with the same native session ID; capture IDs distinguish them.

For a local checkout, install its marketplace from the repository root:

```sh
codex plugin marketplace add "$PWD"
codex plugin add agentprof@agentprof
codex
```

## How the plugin works

The Codex-native plugin packages its hook declarations in `hooks/hooks.json`
and its MCP server in `mcp.json`. Marketplace installation makes both
available without a generated profile, wrapper, or change to your existing
model, authentication and permission settings. Hooks remain subject to Codex's
normal trust review. **Do not** configure a persistent native OTLP exporter for
the plugin: it has no static TCP port.

The first hook starts a short-lived local recorder on a Unix socket in a
private `0700` temporary directory. Hook processes and MCP tools connect only
after checking
the recorder's process identity. There is **no TCP port in the profile** and
Codex never exports native telemetry to an endpoint that might be unbound.
The recorder closes the socket and exits shortly after the last session and
recording finish. An interrupted or failed publication retains the private
journal for recovery with the installed plugin runtime.

**Upgrading an older fixed-port profile:** First finish recordings and close
*all* Codex processes started with the old profile. Shut down the old receiver
only after no such process can export to it; inspect the specific
`codex-tracing.mjs serve` process rather than killing unrelated receivers.
Before installing the native plugin, update the old npm package (if needed to
obtain the migration command), then run `agentprof-codex migrate
--confirm-closed`. Migration checks ownership and refuses to remove the old
profile while its port or receiver is still active. It deletes only an
unedited generated profile; if it was edited, remove its OTLP settings and
hook declarations manually after closing old Codex processes. Installing the
native plugin without removing the old profile would run hooks twice. Remove
the old installed plugin if present, upgrade its marketplace, and then install
the new native plugin (version 0.3.0) using Codex's plugin commands. Restart
Codex afterward and launch ordinary `codex`.
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

The native plugin install does not add a global `agentprof-codex` executable.
Use the `installedPath` returned by `codex plugin add agentprof@agentprof
--json` (or locate the installed plugin in your Codex plugin cache):

```sh
INSTALLED_PLUGIN=/path/from/installedPath
node "$INSTALLED_PLUGIN/runtime/codex-tracing.mjs" recover \
  agent.pftrace.capture recovered.pftrace
```

An older global npm installation can still use `agentprof-codex recover`.
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

To remove the integration, finish active sessions and run
`codex plugin remove agentprof@agentprof`. New installations have no generated
profile to remove. The short-lived recorder exits automatically, and other
Codex settings remain unaffected.

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
