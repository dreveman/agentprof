# Muse Code tracing

Record your normal Muse Code session into one `.pftrace` file for Agent Profiler.
Requires Muse Code 1.4.1 or later with native plugins available, and Node.js 16.20.2 or later.

```sh
muse plugins marketplace add agentprof dreveman/agentprof
muse plugins install agentprof@agentprof
muse plugins approve agentprof
muse
```

The approval enables the plugin's local recording hooks and tools. If Muse
reports that plugins are unavailable, this integration requires a Muse build
and account configuration that enables native plugins.

Marketplace installation needs no global npm package or Agent Profiler
installer. From a checkout, `muse plugins install ./packages/muse-tracing
--scope user` installs the same native bundle; `--scope project` limits a
local-path installation to the current Muse project. Approve its capabilities
before recording. Installation preserves your existing Muse settings.

## Recording

Type these into Muse's normal prompt:

```text
tracing start
tracing status
tracing stop
```

These controls are intercepted before the model sees them. Start optionally
takes a new output path: `tracing start /tmp/task.pftrace`. The default directory
is `agentprof-traces` inside the working directory. Start reports the path;
stop saves it without overwriting an existing file. Exiting Muse saves an active
recording. A small process watcher handles builds that omit the session-end hook;
saving can finish a few seconds after exit. The path is available at start and
through `tracing status`; the watcher also logs it in `watcher.log` under the
plugin's data directory. You can start another recording in the same session.

The agent can call `tracing_start`, `tracing_stop`, and `tracing_status` through
the plugin's MCP server. Start accepts an optional `output_path`. Muse supplies
the current session ID to the server; tools cannot select a different session.

To record automatically in new sessions where the plugin is enabled, set
`AGENTPROF_MUSE_AUTO_START=1` before launching ordinary `muse`. Unset it for
manual recording unless you previously saved a persistent auto-start setting;
in that case run `agentprof-muse configure --manual` as well. For metadata-only
new captures set
`AGENTPROF_CAPTURE_CONTENTS=0` before launching Muse. These settings need no
additional installation. The optional global npm CLI (`npm install -g github:dreveman/agentprof`) still
supports `agentprof-muse configure --auto-start|--manual|--no-content|--capture-content`
for persistent choices, but is not required for marketplace installation or
recording. Content policy is stored with each recording for deterministic
recovery. Muse's native
plugin API does not expose custom keybindings; use the typed controls or tools.
Session logging must remain enabled (do not pass `--no-session-log`).

## Measurements

- Prompts, model responses, tool arguments/outcomes and recorded child work use
  Muse's native session export. Streaming `muse exec --json` timestamps are not
  used for performance measurements.
- Response durations use the native `model_completed.duration_ms`, positioned
  backwards from the completion's journal timestamp. Journal persistence can
  delay that timestamp. First-content latency is unavailable.
- Input/output/cache/reasoning usage is per response. Input includes cached
  input; cache counts are not added a second time. Context size samples reported
  input usage. The context roof comes from MSP `model/list`, cached for up to a
  day, rather than the observed peak. Missing limits stay unknown.
- Effort and compaction boundaries come from lightweight hooks. Tool intervals
  use native lifecycle timestamps and include dispatch overhead. A successful
  tool lifecycle does not establish a successful shell exit unless Muse records
  that outcome separately.
- Context composition uses native outgoing-request lane byte counts when
  available, with transcript counts for partial item attribution. Older journals
  fall back to transcript estimates. See
  [context measurements](../../docs/context-data.md) for coverage and the
  Overview card and Context tab.
- Child sessions referenced by the recorded session are included in the same
  trace. Muse can omit retained logs for some background reminder agents. Their
  usage is unavailable; `unavailable_child_sessions` records the missing count.
  Inherited history is excluded and per-session usage is never counted twice.
- Recording boundaries clip operations. Partial model responses do not
  contribute tokens or throughput. Interrupted operations remain incomplete.
  Intentional omitted output deltas are distinct from missing journal records.

Events use `muse.*` categories and the common Agent Profiler capture schema.
Sessions are logical tracks under the actual Muse process, with machine identity,
real-time clock snapshots, token units and counter resets at recording end.

By default, prompts and bounded tool arguments are included, so review a trace
before sharing. In metadata-only mode, main and reminder-session prompts and
tool argument values are dropped during export parsing; prompt lengths, tool
names/IDs, timing, model/provider, usage and outcomes remain. A raw string
argument may retain its UTF-16 length for partial context attribution; object
arguments are not traversed for size or keys. Recording paths, session IDs and
process metadata remain.
Muse's own session journal is unaffected, and its export command temporarily
writes a private full native export that is removed after parsing; this switch
cannot prevent those upstream/transient copies.
Provider credentials, model system instructions and encrypted reasoning are not
copied into the trace or recorder state. Native exports use temporary private
directories, removed after conversion. Only sessions
explicitly linked to the recording are exported, with bounded size and time.

## Recovery and development

The plugin stores private capture metadata under Muse's
`plugins/data/agentprof/sessions` directory. Linux host and watcher process
start markers protect against PID reuse; old state and other platforms fall
back to PID liveness. Ordinary hooks avoid an extra watcher lock/read; start
paths ensure the watcher exists. Each host command hook still launches Node;
see the [synthetic hook latency benchmark](../../docs/hook-latency.md).
Muse's own journal holds the events;
the process watcher exits when recording ends. If shutdown or export fails, keep that
journal and retry. Use `tracing stop` or `tracing_status` inside Muse when
available. Out of process, the optional global CLI supports:

```sh
agentprof-muse stop --session SESSION_ID
```

For a marketplace-only installation, invoke the installed
`runtime/muse-tracing.mjs` with Node instead; `muse plugins inspect agentprof
--json` reports its `installed.cache_path`. After an abnormal process exit,
`agentprof-muse recover --session SESSION_ID` (or that runtime's `recover`
command)
marks the recording incomplete. An interrupted export retains its original stop
boundary and status reports `pending` until it is saved. The process watcher can
recover after Muse is killed, but cannot save during a host shutdown or if the
watcher itself is killed. Automatic start applies to primary sessions; forked
sessions can be recorded manually.

```sh
npm run build:muse
node tools/check-muse-marketplace.mjs --update # after any package change
npm run check
npm run check:muse-plugin
npm test
```

Native installation and an end-to-end coding recording were tested with Muse
Code 1.4.1-R4503.1. Converter and control tests run without a Muse account.
The [native plugin manifest](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/reference/manifest/)
and [hook reference](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/reference/hook-events/)
describe the host APIs. Export parsing is version-checked and rejects unknown
export schemas instead of guessing.
