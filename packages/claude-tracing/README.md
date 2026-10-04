# Claude Code capture prototype

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
output, and reads final usage metadata. It currently requires `-p`; interactive
installation and agent-controlled start/stop tools are follow-up work.

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

The UI recognizes the shared `agentprof.metadata` / `agentprof.activity`
categories and existing Pi traces. Event kinds and annotations follow the
[trace data contract](../../docs/trace-data.md).

## Measurement limits

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
