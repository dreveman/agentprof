# Perfetto integration

Agent Profiler maintains its Perfetto customization as a pinned checkout,
patch series, and overlay tree.
`python3 tools/perfetto setup` prepares it; see
[CONTRIBUTING.md](../CONTRIBUTING.md) for build and validation commands.

| Path | Ownership and workflow |
| --- | --- |
| `perfetto.toml` | Commit the upstream URL and exact revision here. |
| `src/perfetto/` | Generated, ignored checkout; do not vendor the upstream tree. |
| `patches/perfetto/*.patch` | Ordered patches for changes to upstream files. |
| `overlays/perfetto/` | Agent Profiler-owned files with paths relative to the Perfetto root. |

The manager links overlays into the checkout and captures committed
upstream-file changes as patches. Overlay files must not also appear in the
patch series. Setup checks the existing series, preserves local work, and
refuses overlay collisions.

The patches enable the Agent Profiler plugin, isolate UI TypeScript declarations
from the recorder's Bun types, and resolve linked plugin imports in Vite.
The plugin adds a session workspace and trace-analysis queries. Embedder hooks
provide the home page, branding, and responsive top-bar navigation while keeping
the upstream omnibox and trace-health controls.

When adapting upstream code, retain its copyright and license headers and include any applicable
upstream notices.
