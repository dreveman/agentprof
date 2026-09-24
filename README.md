# Agentprof

See where the time went in an AI coding agent run.

[Getting started](#getting-started) · [Investigation guide](docs/investigating-agents.md) · [Development](CONTRIBUTING.md)

## What is Agentprof?

Agentprof is a project to build an agent-focused Perfetto UI: every turn,
model request, tool call, and subagent on one interactive timeline. The first
integration will use the existing Perfetto tracing in the Pi harness.

The goal is to make it easy to:

- See how a run divides its time between model requests, tools, and other work.
- Follow parent and child agents and understand which work overlaps.
- Inspect slow turns and tool calls in the context of the whole run.
- Explore token usage and other counters when the harness records them.

**Status:** initial project scaffolding. The Pi tracing code has not been
imported into this repository, and the agent-specific UI is not implemented
yet. There is no Agentprof installer, CLI, hosted UI, or demo trace yet.

## Getting started

The intended workflow is to record a run with Pi's existing tracing, then open
the resulting trace in Agentprof. Recording commands and supported trace fields
will be documented after the Pi integration is available here.

For now, existing Perfetto-compatible traces can be opened in the
[upstream Perfetto UI](https://ui.perfetto.dev/) using **Open trace file**.
This provides the generic timeline; Agentprof's planned views are described in
the [investigation guide](docs/investigating-agents.md).

## Why Agentprof?

A conversation transcript describes what an agent said and did. A timeline
helps explain how long it took, which operations overlapped, and what delayed
the next step. Agentprof aims to connect those timing questions to the agent's
turns, tools, and delegated work.

## How it will work

```text
Pi harness              Perfetto trace               Agentprof UI
existing tracing   ->   recorded run on disk    ->   timeline and analysis
```

Pi remains responsible for recording events. Perfetto supplies the trace
format, query engine, and timeline foundation. Agentprof will add agent-specific
tracks, details, and queries. Available analysis will depend on what the harness
actually records; the initial integration will establish that contract from
real traces.

The repository maintains a specialized Perfetto UI with an upstream revision pin,
a small patch series, and permanent overlay files. See the
[Perfetto integration layout](third_party/README.md).

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for the repository layout and initial
implementation steps, and [the Pi integration notes](docs/pi-integration.md)
for what is needed from the existing recorder.

## License and acknowledgments

Agentprof is licensed under [Apache 2.0](LICENSE) and built around
[Perfetto](https://github.com/google/perfetto). Upstream code retains its own
copyright and license notices.
