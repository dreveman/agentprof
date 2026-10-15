# Contributing to Agent Profiler

Agent Profiler includes recording integrations for Claude Code, Codex, Muse Code,
and Pi, plus a Perfetto UI plugin. Use the bundled recordings to iterate without
calling a model; the checks also generate synthetic fixtures for edge cases.

First-party source files use `SPDX-License-Identifier: Apache-2.0` in a comment
at the top, after any shebang. Bundle generators retain that header, and
distributable plugins include the Apache license text. `npm run check` verifies
the headers and package metadata. Preserve third-party copyright and license notices.

## Repository layout

| Path | Purpose |
| --- | --- |
| `docs/` | Investigation workflow and Pi integration notes |
| `packages/pi-tracing/` | Pi extension, recorder, encoder, and tests |
| `packages/claude-tracing/`, `packages/codex-tracing/`, `packages/muse-tracing/` | Harness recording plugins and tests |
| `packages/agent-tracing/` | Shared trace serialization |
| `tools/` | Checkout manager and synthetic trace/browser validation |
| `ai/skills/dev.agentprof/` | Portable workflows overlaid onto the upstream Perfetto skill |
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

The packaged recording runtimes are tested with Node.js 16.20.2 and 22.
Run `npm run test:node-runtime` with the desired `node` on `PATH`; Bun runs the
TypeScript tests while recording subprocesses use that Node version. Harnesses
have their own runtime requirements.

```bash
npm ci
python3 tools/perfetto build-ui
npm run trace:example
python3 tools/perfetto dev-server --skip-deps
```

Open `http://localhost:10000`, select a harness, and open its example. Edit the plugin under
`third_party/overlays/perfetto/ui/src/plugins/dev.agentprof.Agentprof/`.
Overlays are linked into the checkout for UI development. Reload to reopen the
bundled example with your UI changes. To change its data, update the reviewed
recordings in `examples/` and run `npm run trace:example`; commit the
generated `*example_trace.ts` overlays alongside the recording changes.

Review all prompt text, tool inputs, and embedded content before publishing a
recording. Replace private paths with generic paths such as `/workspace/intervals`
and document redactions in its manifest. `npm run check:example` checks source
traces, decoded UI bundles, and example files for common private paths and
credential patterns. This catches regressions; it does not replace manual review.

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
under `artifacts/screenshots/`. The smoke command also runs the focused Turns
suite against all four harness examples, verifies setup retry after partial failure,
and exercises 100,000 operations with 1,000,000 unrelated indexed flow rows in
the browser WASM engine. Synthetic fixtures cover missing usage, model/tool
overlap, parallel tools, errors, and incomplete work.

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
commit overlay symlinks there. Patch exports use a generic author header; Git
commits retain the configured author identity. Setup preserves local work and
stops on a mismatched pin, patch series, or overlay destination.

For revision updates, capture your work, preserve and move the old checkout
aside, change the pin, and run setup. Resolve conflicts with `git am --continue`
inside the new checkout, then capture the resulting series. Rebuild and run
trace/browser checks before landing the update.

## AgentProf AI workflows

Keep portable workflow pages and SQL under
`ai/skills/dev.agentprof/workflows/agentprof/`. This namespace is an overlay source,
not another installed skill. Setup links it into the pinned Perfetto skill;
changes to the upstream router remain a small ordered patch. Reuse shared
Perfetto references and packaging instead of copying them.

The two reader exports are generated from UI SQL and preserve its explicit
`INDEXED BY` hints. Do not independently format these generated files: the pinned
formatter drops those hints. Format authored query resources with Perfetto's
formatter; CI checks them after the UI build prepares its toolchain.

```bash
python3 tools/perfetto setup
npm run build:skills-sql
python3 tools/perfetto check-skills-format
PERFETTO_TRACE_PROCESSOR=/path/to/local/trace_processor npm run test:skills
cd third_party/src/perfetto
python3 tools/release/build_ai_agents.py --output ../../../artifacts/ai-agents
```

The upstream command only assembles local output without a commit/push option.
The installed skill is `artifacts/ai-agents/plugins/perfetto/skills/perfetto/`.
The SQL exports are checked against the UI reader, but run with only a trace
and Trace Processor. Tests cover packaging, overlay collisions, all four harness
recordings, missing measurements, prompt-level turns, capture scoping and overlap.
No model calls are needed. Run model-based Perfetto evals separately only with
explicit approval; do not attach private traces to eval artifacts.

### Build the AI release artifact

After `python3 tools/perfetto setup`, run:

```bash
python3 -m unittest discover -s tools/release -p 'test_*.py'
python3 tools/release/build-ai-skill.py \
  --revision FULL_AGENTPROF_COMMIT_SHA \
  --epoch SOURCE_COMMIT_UNIX_SECONDS \
  --verify
```

Replace the two provenance placeholders with the source commit's full SHA and
Unix timestamp. The builder invokes Perfetto's existing packager and writes
`artifacts/ai-release/agentprof-ai-skill.zip`, its SHA-256, provenance and a runtime
verification report. The ZIP contains only the assembled `perfetto/` skill,
including licenses and the exact upstream wrapper, not Google's marketplace
metadata. ZIP paths, timestamps and permissions are deterministic for identical
inputs.

`--verify` extracts the ZIP, verifies its contents and executable permissions,
independently hashes the native prebuilt selected by its wrapper, runs the SQL
suite against the extracted resources and reviewed recordings, and exercises a
warm Unix-socket session with the packaged launcher. It does not substitute a
Meta or locally built Trace Processor. The initial native download needs network
access; a missing/incompatible runtime is a failure, not a skipped release check.

The **Build and verify AI release artifact** PR check in
`.github/workflows/ai-skill.yml` runs this path and retains the ZIP/checksums/report
as an Actions artifact for review before landing. Existing recorder/UI checks
remain unchanged. Only a `release.published` event enables the separate upload
job; it attaches assets to that existing release without creating a release or
overwriting existing assets. A rerun compares existing assets byte-for-byte,
accepts matching ones and uploads only missing files; a mismatch fails without
replacement. No model calls or new captures are required.

See [ai/README.md](ai/README.md) for upstream contribution and overlay import.

## Useful bug reports

Include the harness revision, UI revision, recording settings, expected
behavior, and observed behavior. A small sanitized trace is especially useful.
Review trace contents before attaching them: harness events may include
prompts, tool arguments, output, or local paths.
