# Perfetto integration

Agentprof will maintain its Perfetto customization as a pinned checkout,
patch series, and overlay tree.
The pin is present now; the checkout manager, patches, and overlays are pending.

| Path | Ownership and workflow |
| --- | --- |
| `perfetto.toml` | Commit the upstream URL and exact revision here. |
| `src/perfetto/` | Generated, ignored checkout; do not vendor the upstream tree. |
| `patches/perfetto/*.patch` | Ordered patches for changes to upstream files. |
| `overlays/perfetto/` | Agentprof-owned files with paths relative to the Perfetto root. |

The planned manager will link overlays into the checkout and capture committed
upstream-file changes as patches. Overlay files must not also appear in the
patch series. Setup and revision updates must preserve local work or refuse
to proceed when it would be lost.

The initial upstream Perfetto pin is a reproducible starting point, not a
claim that the Agentprof UI has been built
or that Pi compatibility has been tested.

When adapting upstream code, retain its copyright and license headers and include any applicable
upstream notices.
