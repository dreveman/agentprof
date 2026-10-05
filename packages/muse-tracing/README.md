# Muse Code tracing

Record your normal Muse Code session into one `.pftrace` file for Agent Profiler.
Requires Muse Code 1.4.1 or later with native plugins available, and Node.js 22+.

```sh
npm install -g github:dreveman/agentprof
agentprof-muse install
muse plugins approve agentprof
muse
```

The approval enables the plugin's local recording hooks and tools. If Muse
reports that plugins are unavailable, this integration requires a Muse build
and account configuration that enables native plugins.

From a checkout, use `node packages/muse-tracing/runtime/muse-tracing.mjs install`.
The committed runtime needs no build step. `install --project` limits activation
to the current Muse project. Installation preserves your existing Muse settings.

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

To record automatically in new sessions where the plugin is enabled:

```sh
agentprof-muse configure --auto-start
```

Restore manual recording with `agentprof-muse configure --manual`. Muse's native
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

Prompts and bounded tool arguments are included, so review a trace before sharing.
Provider credentials, model system instructions and encrypted reasoning are not
copied into the trace or recorder state. Native exports use temporary private
directories, removed after conversion. Only sessions
explicitly linked to the recording are exported, with bounded size and time.

## Recovery and development

The plugin stores private capture metadata under Muse's
`plugins/data/agentprof/sessions` directory. Muse's own journal holds the events;
the process watcher exits when recording ends. If shutdown or export fails, keep that
journal and retry:

```sh
agentprof-muse stop --session SESSION_ID
```

After an abnormal process exit, `agentprof-muse recover --session SESSION_ID`
marks the recording incomplete. An interrupted export retains its original stop
boundary and status reports `pending` until it is saved. The process watcher can
recover after Muse is killed, but cannot save during a host shutdown or if the
watcher itself is killed. Automatic start applies to primary sessions; forked
sessions can be recorded manually.

```sh
npm run build:muse
npm run check:muse-plugin
npm test
```

Native installation and an end-to-end coding recording were tested with Muse
Code 1.4.1-R4503.1. Converter and control tests run without a Muse account.
The [native plugin manifest](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/reference/manifest/)
and [hook reference](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/reference/hook-events/)
describe the host APIs. Export parsing is version-checked and rejects unknown
export schemas instead of guessing.
