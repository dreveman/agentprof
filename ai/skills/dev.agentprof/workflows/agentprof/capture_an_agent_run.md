# Capture an AgentProf run

Use when there is no usable recording yet: install the recording integration
for Pi, Claude Code, Codex or Muse, record one task, and verify the
resulting trace before analyzing it. Analysis workflows start from an existing
trace; this workflow produces one.

The analysis skill and the recording integrations are installed separately.
Installing this skill does not instrument any harness, and installing a
recording integration does not install this skill.

## 1. Agree the capture before changing anything

Confirm with the user, and do not proceed silently past any of these:

- **Harness and task.** Which harness will run, and what task will be recorded.
  Installing a plugin changes that harness's configuration; launching the task
  can call a model and incur cost. Never invent a task to record.
- **Content policy.** By default recordings include prompt text and tool
  argument values. If that is not acceptable, set
  `AGENTPROF_CAPTURE_CONTENTS=0` in the environment *before launching the
  harness*; it cannot be applied retroactively and a content-on journal is
  not rewritten. Metadata-only is not anonymization: names, identifiers,
  session IDs and paths remain. Review the trace before sharing it.
- **Output path.** Choose an unused `.pftrace` path and a label describing the
  task or variant. Recorders never overwrite an existing trace or journal.

Set measurement expectations from the harness before recording:

- Pi records native response durations, first content, and process CPU/RSS/heap.
- Claude Code records request durations including retries and first content.
- Codex plugin recordings report usage without measured model duration or
  first content; they cannot support a model-latency ranking.
- Muse records native response durations without first content.

A question the harness cannot measure will not be fixed by a longer capture.

## 2. Install the recording integration

Run only the block for the chosen harness; each needs network access to fetch
the marketplace. Restart harnesses that were already running after installing.

**Pi** (installs into the Pi account):

```bash
pi install git:github.com/dreveman/agentprof
pi --tracing
```

**Claude Code** (2.1.289+, mods enabled, Node.js 16.20.2+):

```bash
claude plugin marketplace add dreveman/agentprof
claude plugin install agentprof@agentprof
claude
```

If `/tracing` is missing, check `/plugin` for load errors; safe mode or managed
policy can disable plugins, and existing sessions must be restarted.

**Codex** (CLI 0.160.0 with hooks, Node.js 16.20.2+; Linux, Windows unsupported):

```bash
codex plugin marketplace add dreveman/agentprof
codex plugin add agentprof@agentprof
codex
```

Open `/hooks` once and review and trust the recording hooks before recording.
Do not also configure a persistent native OTLP exporter for this plugin.

**Muse** (1.4.1+ with native plugins, Node.js 16.20.2+):

```bash
muse plugins marketplace add agentprof dreveman/agentprof
muse plugins install agentprof@agentprof
muse plugins approve agentprof
muse
```

Approval enables the local recording hooks and tools. Keep session logging
enabled; do not launch with `--no-session-log`.

## 3. Record one task

Start recording *before* submitting the task and stop after it finishes.
Starting mid-response excludes or truncates that work, operations still running
at stop are marked incomplete, and their usage is not invented. One recording
per task keeps later attribution unambiguous.

- Pi: `Ctrl+Shift+T`, `/tracing start [name]` and `/tracing stop`, or the
  `tracing_start`/`tracing_stop` tools. `/tracing status` reports state and
  the published path; normal exit also finalizes an active recording.
- Claude Code: the recording strip above the prompt, `/tracing start [path]`,
  `/tracing status`, `/tracing stop`, or the `mcp__agentprof__tracing_*`
  tools. Exit finishes an active recording.
- Codex and Muse: type `tracing start [path]`, `tracing status`, or
  `tracing stop` as a normal prompt, or let the agent use its
  `tracing_start`/`tracing_stop`/`tracing_status` tools. In Codex, stop
  returns `saving` promptly; confirm `saved` with `tracing status` before
  relying on the file. Exit also begins saving.

Child agents spawned normally join the owner's recording in the same file; do
not start separate recordings inside them, and do not stop the owner's
recording while children whose work matters are still running. Automatic
recording on launch exists per harness (`--tracing` for Pi, the plugin's
`auto_start` option for Claude, `AGENTPROF_CODEX_AUTO_START=1`,
`AGENTPROF_MUSE_AUTO_START=1`); prefer explicit start/stop unless repeated
captures of the same setup are the point.

## 4. Verify the artifact before analyzing it

Confirm all of the following, and report the actual saved path:

1. Recording status reports the trace as saved/published, not still saving or
   failed. A retained `.pftrace.part` file or `*.pftrace.capture/` journal
   means publication did not complete: keep it, do not delete or record over
   it, and report the error and its path instead of analyzing a partial file.
2. The published `.pftrace` exists and is non-empty.
3. Load it and run the inventory from
   [investigate an agent run]($SKILL_ROOT/workflows/agentprof/investigate_agent_run.md):

```bash
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/agentprof_setup.sql
trace_processor query --remote SESSION --query-file $SKILL_ROOT/workflows/agentprof/scripts/inventory.sql
```

No inventory rows means the reader found no supported AgentProf capture in
that file: it is the wrong file, an unfinished publication, or not an
AgentProf recording. Stop and fix the capture rather than analyzing unrelated
tracks. Otherwise check that the harness, model and capture window match the
intended task, and note `measured_responses`, dropped events, incomplete work
and unavailable children: missing coverage limits which questions the trace
can answer, and NULL is not zero or healthy.

Then continue in the investigation workflow with the verified capture scope.
Report the harness and version, content policy, output path, capture window,
and any coverage limits alongside the trace.
