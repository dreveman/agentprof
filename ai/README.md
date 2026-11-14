# AgentProf AI workflow overlay

`skills/dev.agentprof/` is a source overlay, not an independently installed skill.
It adds the `agentprof` workflow domain to Perfetto's existing `perfetto` skill.
There is no copied router, bootstrap, binary wrapper or package manifest here.

`python3 tools/perfetto setup` links `skills/dev.agentprof/workflows/` into the
pinned checkout's `ai/skills/perfetto/workflows/` and links `stdlib/` into
`ai/skills/perfetto/workflows/agentprof/stdlib/`. The small router edit is kept
in the normal Perfetto patch series. The upstream bundler packages the resulting
single skill unchanged; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Both the Agent Profiler UI and the Markdown workflows share one set of
PerfettoSQL modules under `stdlib/dev/agentprof/` (`dev.agentprof.captures`,
`models`, `sessions`, `tools`, `context`, `activity`, `turns`, and `runtime`).
Workflows register the packaged directory with
`--add-sql-package $SKILL_ROOT/workflows/agentprof/stdlib/dev/agentprof@dev.agentprof`
when starting a warm `trace_processor` session (or omit the flag when running a
`trace_processor` build that embeds `dev.agentprof.*`) and execute inline
`INCLUDE PERFETTO MODULE dev.agentprof.<module>; SELECT ...;` queries. Base
tables and summary views omit raw prompt, argument, and context-label payloads;
lazy UI detail views project bounded payloads only when queried by the UI. All
SQL modules are formatted with Perfetto's pinned `syntaqlite` formatter and
checked by `python3 tools/perfetto check-skills-format`.

For an upstream Perfetto contribution, move `stdlib/dev/agentprof/` into
`src/trace_processor/perfetto_sql/stdlib/`, copy `skills/dev.agentprof/workflows/`
to `ai/skills/perfetto/workflows/`, and apply only the skill-router patch.

An environment with its own Perfetto bootstrap can import `stdlib/dev/agentprof/`
into its embedded `trace_processor` stdlib and `skills/dev.agentprof/` as a
workflow-only overlay. Remove the backport once the pinned upstream source
includes these modules and workflows rather than silently replacing imported
upstream files.
