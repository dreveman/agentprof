# Codex capture

Record a Codex `exec` task into a Perfetto trace that opens directly in Agent
Profiler's Overview. This preview has been tested with Codex CLI 0.160.0.

## Record a task

Install the repository dependencies once, with an authenticated Codex CLI already
available on `PATH`:

```sh
git clone https://github.com/dreveman/agentprof.git ~/agentprof
npm ci --prefix ~/agentprof
```

From your project directory:

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
- Child-session relationships when Codex records source metadata, and flows
  from prompts through model/tool work and into observed child prompts.

Scripts are recognized from native code-mode spans, with JavaScript and line
count descriptions. Startup prewarming appears under Tracing and is excluded
from normal response counts and session token totals.

Input usage preserves Codex's reported semantics: it includes cached input.
Cache counts are informational subsets and are not added to context size.
Context size is sampled request input, not a continuously measured gauge. The
context limit comes from Codex's own session metadata, not the observed peak.

## Replay and limitations

Each capture also creates `agent.pftrace.capture/observations.jsonl`, with raw
native telemetry and narrowly selected session metadata. It is flushed
periodically and can be converted again without running a model:

```sh
~/agentprof/node_modules/.bin/bun ~/agentprof/tools/convert-codex.ts \
  agent.pftrace.capture/observations.jsonl recovered.pftrace
```

Recordings contain prompts and tool arguments; the raw journal can also contain
tool output. Both the trace and journal are private files when created.

The first version supports `codex exec`. Interactive daemon sessions, explicit
start/stop tools, compaction summaries and CPU/heap sampling are not included.
`--ephemeral` is unsupported because context limits use the captured sessions'
persisted metadata. If metadata is unavailable, limits remain unknown. The
transcript reader is intentionally narrow and version-sensitive; it reads only
sessions identified by this capture.

Completion events in this Codex version lack span IDs. The converter associates
usage only with a unique native model stream ending between 1 ms before and
5 ms after the completion log in the same session. Unmatched usage remains recorded with an
incomplete measurement and is excluded from measured response speed.

The journal is bounded to 128 MiB; discarded observations mark the capture
incomplete. Force-killing Codex can lose its unflushed native telemetry. Replay
preserves measurements received before shutdown; it cannot reconstruct missing
native spans.

## Development

```sh
npm run check
npm test
npm run check:example
```

Fixtures cover deferred/repeated telemetry, prewarming, missing usage/timing,
scripts, logical children, command errors, context-limit changes and native
Perfetto import. Browser tests exercise the Codex overview and tool drill-down.
