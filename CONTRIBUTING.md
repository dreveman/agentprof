# Contributing to Agentprof

Agentprof is at the scaffolding stage. The first milestone is to open a real
Pi trace in a locally built Perfetto UI and add a useful agent-specific view.

## Repository layout

| Path | Purpose |
| --- | --- |
| `docs/` | Investigation workflow and Pi integration notes |
| `third_party/perfetto.toml` | Upstream Perfetto URL and initial revision pin |
| `third_party/patches/perfetto/` | Future patches to upstream-owned files |
| `third_party/overlays/perfetto/` | Future Agentprof-owned files, mirroring upstream paths |
| `third_party/src/perfetto/` | Ignored local Perfetto checkout and build output |

The patch and overlay directories will be created when their first files are
added. Keep integration documentation outside the overlay tree so it is not
accidentally installed into Perfetto.

## Initial implementation sequence

1. Bring in the Pi tracing integration or document how to use it from its
   existing repository. Add a sanitized sample recording and identify the
   emitted event names, arguments, relationships, and counters.
2. Add `tools/perfetto` to prepare the pinned checkout, apply patches, and
   link overlays, with protection for local edits
   and uncaptured commits before replacing a checkout.
3. Build the pinned upstream UI and verify that it loads the sample trace.
4. Add an Agentprof plugin under
   `third_party/overlays/perfetto/ui/src/plugins/` using the conventions at the
   pinned revision. Start with agent/turn/tool grouping and slice details.
5. Add trace-based checks for relationships and timing, then document the
   working recording and viewing commands.

There are no project build or test commands yet. The initial Perfetto pin is
a starting point; compatibility with Pi traces and
the local build toolchain still needs to be verified.

## Maintaining the Perfetto integration

Keep Agentprof-owned files in overlays and changes to upstream-owned files
in small, ordered patches. Preserve upstream notices in adapted files and
record their origin. Keep the integration focused on agent profiling and
reuse the existing Pi recorder.

Once the checkout manager exists, document its setup, build, development
server, patch capture, and revision update commands here. A revision update
should rebuild the UI and verify representative Pi traces before landing.

## Useful bug reports

Include the harness revision, UI revision, recording settings, expected
behavior, and observed behavior. A small sanitized trace is especially useful.
Review trace contents before attaching them: harness events may include
prompts, tool arguments, output, or local paths.
