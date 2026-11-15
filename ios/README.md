# AgentProf for iPhone and iPad

Offline native iPhone and iPad shell for the AgentProf web UI (`iOS 18.0+`, Swift 6).

Recordings opened from the **Files** app, **Share Sheet**, **AirDrop**, or another app stay entirely on-device: the app bundles the AgentProf UI and its 32-bit WebAssembly Trace Processor, serves everything from a custom URL scheme (`agentprof://app`), and installs a `WKContentRuleList` blocking all `http`, `https`, `ws`, and `wss` requests from the web view before loading the page.

---

## Architecture

- **Custom scheme origin (`agentprof://app`)**: `WebAppSchemeHandler` serves the staged `AgentProfWeb` bundle (`/` and `/v<version>/…`), web-platform diagnostics (`/_diagnostics/…`), and imported recordings (`/_traces/<uuid>/<name>`) off the main thread in 1 MiB chunks (`Cache-Control: no-store` for recordings).
- **Host bridge (`window.agentprofHost`)**: Injected at document start (`HostBridge.swift`) and paired with `third_party/overlays/perfetto/ui/src/core/embedder/`:
  - Streams recordings directly into Perfetto's `openTraceFromStream` via `onOpenTrace` without holding duplicate buffers in JavaScript memory (falling back to `postMessage` when `onOpenTrace` is absent).
  - Synchronizes imported recordings in `Library/Caches/Traces` (kept for 3 days) with the Home page's **Recent traces** list while hiding `window.caches`.
  - Synchronizes top-bar actions (`PageActionsHandler`) and renders Material Symbols glyphs natively via CoreText (`MaterialSymbols.swift`) when a system vertical navigation bar is active.
- **Offline isolation**: `ProfilerWebViewFactory.blockNetwork` compiles and attaches `WKContentRuleList` rules blocking `^https?://` and `^wss?://`; `NavigationPolicy` restricts main-frame loads to `agentprof://app` and prompts before opening external `http`/`https` links in Safari.

---

## Stage the Web UI Bundle

The Xcode project builds out of a fresh clone using `AgentProf/Resources/WebUIPlaceholder` until `ios/build/AgentProfWeb` is staged.

### Option A: Stage from a local UI build (offline, from source)

From the repository root:

```bash
python3 tools/perfetto build-ui --no-source-maps
python3 ios/scripts/prepare_web_ui.py
```

*(Note: iOS WebKit requires the 32-bit `trace_processor.wasm` module; do not pass `--only-wasm-memory64` when building for iOS.)*

### Option B: Download and verify the published UI (no C++/WASM build needed)

On a Mac where you only want to work on the Swift shell in Xcode:

```bash
python3 ios/scripts/prepare_web_ui.py --fetch
```

`prepare_web_ui.py` verifies every asset against `<version>/manifest.json`'s SHA-256 digests, checks that 32-bit `trace_processor.wasm` and `MaterialSymbolsOutlined.woff2` are present, excludes source maps and service workers, and writes `ios/build/AgentProfWeb/`.

---

## Build and Run in Simulator

Open `ios/AgentProf.xcodeproj` in Xcode 16 or newer and run the **AgentProf** scheme (`Cmd+R` to launch, `Cmd+U` to run `AgentProfTests`), or from the command line:

```bash
xcodebuild test \
  -project ios/AgentProf.xcodeproj \
  -scheme AgentProf \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  CODE_SIGNING_ALLOWED=NO
```

- `AgentProfTests` runs unit tests, real `WKWebView` scheme/bridge tests, a live `127.0.0.1` loopback test verifying `WKContentRuleList` network blocking, and `BundledUITests` (which boots the staged AgentProf UI offline in `WKWebView`, verifies all `dev.agentprof.*` PerfettoSQL modules in WASM Trace Processor, streams a recording, and checks native bar layout and glyph rendering).

---

## Install on a Physical iPhone or iPad

1. Stage `ios/build/AgentProfWeb` (`python3 ios/scripts/prepare_web_ui.py` or `--fetch`).
2. Open `ios/AgentProf.xcodeproj` in Xcode.
3. Select the **AgentProf** target → **Signing & Capabilities**, pick your **Team** (an Apple Developer team or Personal Team with your Apple ID), and adjust **Bundle Identifier** if needed (default: `dev.agentprof.app`).
4. Connect your iPhone or iPad, select it as the run destination, and press **Run** (`Cmd+R`).
5. Airdrop, Share, or open any `.pftrace`, `.perfetto-trace`, `.json`, `.gz`, or `.tar` recording from the **Files** app into **AgentProf**.
