# AgentProf AI workflow overlay

`skills/dev.agentprof/` is a source overlay, not an independently installed skill.
It adds the `agentprof` workflow domain to Perfetto's existing `perfetto` skill.
There is no copied router, bootstrap, binary wrapper or package manifest here.

`python3 tools/perfetto setup` links `skills/dev.agentprof/workflows/` into the
pinned checkout's `ai/skills/perfetto/workflows/`. The small router edit is kept
in the normal Perfetto patch series. The upstream bundler packages the resulting
single skill unchanged; see [CONTRIBUTING.md](../CONTRIBUTING.md).

The workflows ship standalone SQL. `tools/generate-skills-sql.ts` exports the
shared reader and turn-attribution SQL from AgentProf's tested UI queries, with
an isolated `agentprof_skill_*` namespace and without prompt/tool payloads. This
is an AgentProf maintenance step, not a runtime or upstream packaging dependency.
The two reader exports are marked generated and retain the reader's explicit
index hints; do not independently format them. Authored query resources use the
pinned Perfetto SQL formatter, checked by `tools/perfetto check-skills-format`.
`npm run build:skills-sql` refreshes the two exports; `npm run check` verifies them.

For an upstream Perfetto contribution, copy `skills/dev.agentprof/workflows/`
to `ai/skills/perfetto/workflows/` and apply only the skill-router patch. No
AgentProf checkout manager or generated build dependency belongs in that change.

An environment with its own Perfetto bootstrap can import the same
`skills/dev.agentprof/` namespace as a workflow-only overlay. Keep its environment
override separate. Remove the backport once the pinned upstream source includes
these workflows rather than silently replacing imported upstream files.
