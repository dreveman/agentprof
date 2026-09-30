# Contributing to Agent Profiler

Agent Profiler includes a Pi recorder and a Perfetto UI plugin. Use the bundled
real recording to iterate without calling a model; the checks also generate
synthetic fixtures for edge cases.

## Repository layout

| Path | Purpose |
| --- | --- |
| `docs/` | Investigation workflow and Pi integration notes |
| `packages/pi-tracing/` | Pi extension, recorder, encoder, and tests |
| `tools/` | Checkout manager and synthetic trace/browser validation |
| `third_party/perfetto.toml` | Upstream Perfetto URL and initial revision pin |
| `third_party/patches/perfetto/` | Patches to upstream-owned files |
| `third_party/overlays/perfetto/` | Agent Profiler-owned files, mirroring upstream paths |
| `third_party/src/perfetto/` | Ignored local Perfetto checkout and build output |

Generated traces, browser downloads, and screenshots live under ignored
`artifacts/`. Keep integration documentation outside the overlay tree.

## Development loop

Install Node.js 22+, npm, Python 3.11+, Git, and a C/C++ build environment.
Perfetto downloads its pinned UI toolchain. The first build includes the WASM
Trace Processor and takes longer than subsequent builds.

```bash
npm ci
python3 tools/perfetto build-ui
npm run trace:example
python3 tools/perfetto dev-server --skip-deps
```

Open `http://localhost:10000` and choose **Open Pi-Opus-5 example**. Edit the plugin under
`third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/`.
Overlays are linked into the checkout for UI development. Reload to reopen the
bundled example with your UI changes. To change its data, update the reviewed
recordings in `examples/pi-opus-5` and run `npm run trace:example`; commit the
generated `example_trace.ts` overlay alongside the recording changes.

## Validation

```bash
npm run check
PERFETTO_TRACE_PROCESSOR="$PWD/third_party/src/perfetto/tools/trace_processor" npm test
npm run check:example
python3 tools/perfetto check-ui --skip-deps
python3 tools/perfetto build-ui --skip-deps
python3 tools/perfetto smoke-ui
```

The Trace Processor launcher downloads its versioned binary on first use.
Without the environment variable or a binary on PATH, `npm test` skips two
import tests; CI requires a binary. `check:example` validates the plugin's actual
SQL against protobuf output, including incomplete work, flows, and usage.

Run `check-ui` after a full build has generated the protobuf/WASM bindings.
`smoke-ui` requires the built UI and free port 10000 (or pass `--existing-server`
to test the running development server). It downloads Chromium into
`artifacts/browsers/`, opens and reloads the bundled example in the browser's
WASM engine, verifies Overview and timeline drill-downs, and saves screenshots
under `artifacts/screenshots/`. Synthetic fixtures exercise missing usage,
model/tool overlap, parallel tools, errors, and incomplete work.

To check extension loading without calling a model:

```bash
pi --no-extensions -e ./packages/pi-tracing -p '/tracing probe'
```

## Maintaining the Perfetto integration

The Agent Profiler embedder lives in
`third_party/overlays/perfetto/ui/src/core/embedder/`. It owns the branding,
home page, top-bar navigation, and minimal default plugin list for local and hosted builds. Plugin
dependencies are enabled automatically. The analysis plugin keeps advanced
queries in the command palette; the top bar exposes Open, Overview, Timeline,
and a menu for secondary actions. Existing explicit
plugin overrides in browser storage still take precedence over defaults.

Overview uses Perfetto's Tabs, Button, Card, Callout, and menu widgets. Keep
custom styles scoped to layout and analysis visuals so shared control typography,
themes, and interaction states stay consistent. The navigation wordmark uses SVG
outlines to avoid font fallback; regenerate the tracked module with
`python3 tools/generate-wordmark.py` (requires Python fontTools and the checkout's
bundled Roboto font).

Keep Agent Profiler-owned files in overlays and changes to upstream-owned files
in small, ordered patches. Preserve upstream notices in adapted files and
record their origin. Keep the integration focused on agent profiling and
reuse the existing Pi recorder.

Commit upstream-file edits inside `third_party/src/perfetto`, then run
`python3 tools/perfetto capture` to regenerate the ordered patch series. Do not
commit overlay symlinks there. Setup preserves local work and stops on a
mismatched pin, patch series, or overlay destination.

For revision updates, capture your work, preserve and move the old checkout
aside, change the pin, and run setup. Resolve conflicts with `git am --continue`
inside the new checkout, then capture the resulting series. Rebuild and run
trace/browser checks before landing the update.

## Useful bug reports

Include the harness revision, UI revision, recording settings, expected
behavior, and observed behavior. A small sanitized trace is especially useful.
Review trace contents before attaching them: harness events may include
prompts, tool arguments, output, or local paths.
