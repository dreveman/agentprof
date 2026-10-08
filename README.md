# Agent Profiler

Agent Profiler uses `agentprof` as its code name and repository identifier.

See where the time went in an AI coding agent run.

[Getting started](#getting-started) · [Investigation guide](docs/investigating-agents.md) · [Development](CONTRIBUTING.md)

## What is Agent Profiler?

Agent Profiler is an agent-focused Perfetto UI with Pi, Claude Code, Codex and Muse Code recording
integrations. Explore turns, provider requests, tool calls, and child-agent
launches on a timeline.

The integrations let you:

- Group timeline tracks by agent session and inspect overlapping tool calls.
- Query slow tools, recorded failures, and incomplete operations.
- Follow agent-written scripts into their nested tool calls.
- Inspect model response timing and token usage when the harness reports it.
- Explore context composition over time and follow large additions to tool calls.
- Inspect child-launch identifiers and recording health.

[Open the hosted UI](https://ui.agentprof.dev/) to explore the harness examples
or load your recordings. Captured subagent sessions appear within their primary
session. Multiple files can be opened together with clock alignment from the
recorded snapshots.

## Getting started

Install the tracing extension for your Pi account from the published Git repository:

```bash
pi install git:github.com/dreveman/agentprof
pi --tracing
```

Run a task, then exit Pi to finalize the trace and print its path. Use
`Ctrl+Shift+T` to start or stop manually, or use `/tracing start`,
`/tracing stop`, `/tracing status`, and `/tracing categories` for finer control.
To try the extension from a local checkout without installing it, run
`pi -e ./packages/pi-tracing --tracing`. See the
[extension guide](packages/pi-tracing/README.md) for options.
Recordings include prompt text and tool arguments by default. Set
`AGENTPROF_CAPTURE_CONTENTS=0` before launching any supported harness to keep
content out of new recordings; timing, usage, IDs and metadata remain. Pi's
legacy `PI_TRACING_CAPTURE_CONTENTS=0` continues to omit tool arguments only.
See each harness guide for raw-journal and native-export limitations.

For Claude Code (2.1.289+ with mods enabled, Node.js 22+), install the
[interactive plugin](packages/claude-tracing/README.md):

```sh
claude plugin marketplace add dreveman/agentprof
claude plugin install agentprof@agentprof
claude
```

Use the recording button above the prompt, `/tracing start` and `/tracing stop`,
or let the agent use `tracing_start`, `tracing_stop` and `tracing_status` tools.
Exit also saves an active recording. Subagents share one trace; reload and
clear/resume preserve recording. The guide covers keyboard controls, automatic
recording, recovery and the optional print-mode OpenTelemetry launcher.

For Codex, install the [recording plugin](packages/codex-tracing/README.md):

```sh
codex plugin marketplace add dreveman/agentprof
codex plugin add agentprof@agentprof
codex
```

The native Codex plugin bundles its hooks and MCP tools; it needs no Agent
Profiler installer, profile, wrapper, native telemetry exporter or fixed TCP
port. Plugin recording is tested on Linux and uses a private Unix socket;
Windows is not supported yet. Review the recording hooks in `/hooks`, then type `tracing start`. Type
`tracing stop` to begin saving, or exit Codex. Stop returns `saving` promptly;
use `tracing status` to confirm publication or see an error. Agent tools can also
start, stop and report recording status. Subagents share the same trace,
with transcript-reported token usage/context and hook-observed tools. Native
model duration, TTFT and nested script spans are unavailable in this mode.

For Muse Code, install the [native recording plugin](packages/muse-tracing/README.md):

```sh
muse plugins marketplace add agentprof dreveman/agentprof
muse plugins install agentprof@agentprof
muse plugins approve agentprof
muse
```

Type `tracing start`, run your task, then type `tracing stop` or exit Muse to
save the file. The agent can also use recording tools. Native session logs
provide response timing, token usage, tool calls and recorded subagent work.

Build and serve the UI (Python 3.11+, Git, and a C/C++ build environment;
Perfetto downloads its pinned build dependencies):

```bash
python3 tools/perfetto build-ui
python3 tools/perfetto dev-server --skip-deps
```

Open `http://localhost:10000` and choose **Open recordings**. Pi, Claude Code, Codex and Muse Code recordings
automatically open **Overview**, with activity, model, tool, concurrency, and
capture-health summaries. The top bar provides **Overview** and **Timeline** navigation.
The **Context** tab breaks down observed context and its largest additions by
session. Estimates and unavailable categories are identified explicitly; see
[context measurements](docs/context-data.md). The bundled examples include
context breakdowns for each harness.
Use the overview tabs for details or **Open timeline** to explore
the **Agent Profiler** workspace. Use **More options → Query (SQL)** for custom analysis or use the
command palette (`Ctrl+Shift+P`) to run the built-in `Agent Profiler:` queries.

Choose **More options → Open workflow example** to explore a real delegated
coding task using Anthropic's `claude-opus-5` with high effort. A primary agent launches
implementation and test workers concurrently, then a reviewer. All four sessions
are included, with parent/child identifiers and individual usage counters. Reloading reopens the bundled
recordings, so you can iterate on the UI without uploading files each time.

The front page offers an example for the selected harness: **Open Claude Code
example** shows a [recorded coding task](examples/claude-coding/README.md), and
**Open Codex example** shows a [coding task with scripted tools](examples/codex-coding/README.md).
Each fixes interval calculations and adds regression tests. All examples remain
available from the top bar's **More options** menu.

Select Pi and choose **Open Pi vs Claude Code example** to compare the same coding task with
Pi codemode and Claude Code. This showcase pairs the fastest correct Pi codemode
run from three trials with Claude Code from the same round. Both use Haiku 4.5
with thinking off and passed independent correctness checks.
The Pi session has a `codemode` label; **Tools → Scripted tool use** expands
each script into its nested calls. See the
[comparison notes](examples/harness-comparison/README.md) for results,
measurement boundaries and reproduction.

To rebuild the bundle from the checked-in recordings without calling a model:

```bash
npm ci
npm run trace:example
```

This updates `artifacts/examples/agentprof-example.pftrace`,
`artifacts/examples/agentprof-comparison-example.pftrace`,
`artifacts/examples/agentprof-claude-example.pftrace`,
`artifacts/examples/agentprof-codex-example.pftrace`, and their UI bundles.
The earlier CI audit is retained as an offline fixture at
`artifacts/examples/agentprof-codemode-example.pftrace`.
The original recordings, task, prompt, and provenance are in
[examples/pi-opus-5](examples/pi-opus-5/README.md). Open its `workflow-*.pftrace` files
with **Open trace file** to compare independent file import with the unified example.

To record another real run with your configured Pi credentials:

```bash
npm run trace:record -- --name opus-5-workflow --workflow
```

This invokes Opus 5, creates a scratch workspace under `artifacts/live-pi`, and
copies the single finalized recording (including subagents) there after verifying the task's tests. It does not
replace the reviewed bundled recordings automatically.

`npm run check:example` validates the real recordings and their merged forms,
and also generates a separate synthetic fixture for deterministic edge-case tests.
The real example includes reported token counters, context estimates, runtime
counters, and model/effort metadata. Anthropic reports cached input separately;
input counters preserve its reported input values without adding cache counts.

Recordings can also be opened in the
[upstream Perfetto UI](https://ui.perfetto.dev/) using **Open trace file**.
This provides the generic timeline; Agent Profiler's views are described in
the [investigation guide](docs/investigating-agents.md).

## Why Agent Profiler?

A conversation transcript describes what an agent said and did. A timeline
helps explain how long it took, which operations overlapped, and what delayed
the next step. Agent Profiler aims to connect those timing questions to the agent's
turns, tools, and delegated work.

## How it works

```text
Pi harness              Perfetto trace               Agent Profiler UI
existing tracing   ->   recorded run on disk    ->   timeline and analysis
```

Pi remains responsible for recording events. Perfetto supplies the trace
format, query engine, and timeline foundation. Agent Profiler adds session grouping
and queries. The [trace data contract](docs/trace-data.md) documents available
fields, timing semantics, and the next instrumentation priorities.

The repository maintains a specialized Perfetto UI with an upstream revision pin,
a small patch series, and permanent overlay files. See the
[Perfetto integration layout](third_party/README.md).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and validation commands,
and [the Pi integration notes](docs/pi-integration.md) for recorder details.

## License and acknowledgments

Agent Profiler is licensed under [Apache 2.0](LICENSE) and built around
[Perfetto](https://github.com/google/perfetto). Upstream code retains its own
copyright and license notices.
The imported [Pi extension](packages/pi-tracing/package.json) retains its MIT
license declaration.
