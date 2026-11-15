// SPDX-License-Identifier: Apache-2.0

@testable import AgentProf
import Foundation
import Testing
import UIKit
import WebKit

private let bundlesTheUI: Bool = {
  guard let index = WebAppResources.bundled(in: .main).file(for: .webUI("index.html")),
    let html = try? String(contentsOf: index, encoding: .utf8)
  else { return false }
  return html.contains("data-perfetto_version")
}()

/// Integration tests exercising the staged AgentProf UI build inside a real offline `WKWebView`.
/// Automatically skipped when building with `Resources/WebUIPlaceholder`.
@MainActor
@Suite(.serialized, .enabled(if: bundlesTheUI, "the app bundles the placeholder page"))
struct BundledUITests {
  private static let recording = """
    {"traceEvents": [
      {"name": "prompt-input", "cat": "agent", "ph": "X", "ts": 0, "dur": 100, "pid": 1, "tid": 1},
      {"name": "model-request", "cat": "agent", "ph": "X", "ts": 10, "dur": 80, "pid": 1, "tid": 1},
      {"name": "tool-call", "cat": "agent", "ph": "X", "ts": 120, "dur": 30, "pid": 1, "tid": 1}
    ]}
    """

  private struct Opened: Decodable {
    let title: String
    let slices: Int
  }

  private struct Session {
    let root: TemporaryDirectory
    let webView: WKWebView
    let trace: ImportedTrace
  }

  private func openRecording(once ready: String = "true", state: String = "''") async throws -> Session {
    let root = try TemporaryDirectory()
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("traces"))
    let trace = try await inbox.importFile(at: root.file("session0.trace.json", text: Self.recording))
    let webView = ProfilerWebViewFactory.makeWebView(resources: .bundled(in: .main, traces: inbox.directory), appVersion: "test")
    try await ProfilerWebViewFactory.blockNetwork(webView)
    webView.showInHostWindow()
    try await PageLoader().load(WebApp.home, in: webView)

    do {
      _ = try await webView.value(Bool.self, of: "typeof window.waitForPerfettoIdle === 'function' ? true : null", timeout: .seconds(60))
    } catch {
      let page = try? await webView.run("return document.body.innerText.slice(0, 1000);")
      Issue.record("The UI didn't start: \(page ?? "")")
      webView.removeFromSuperview()
      throw error
    }
    do {
      _ = try await webView.value(Bool.self, of: "(\(ready)) ? true : null", timeout: .seconds(30))
    } catch {
      let value = try? await webView.run("return JSON.stringify(\(state));")
      Issue.record("Not ready: \(ready) (\(state): \(value ?? "unknown"))")
      webView.removeFromSuperview()
      throw error
    }
    let route = try await webView.run(HostBridge.openTraceCall, ["url": trace.webURL.absoluteString, "name": trace.name])
    #expect(route == "handler")
    return Session(root: root, webView: webView, trace: trace)
  }

  @Test(.timeLimit(.minutes(3)))
  func theUIStartsOfflineAndStreamsARecording() async throws {
    let session = try await openRecording()
    defer { session.webView.removeFromSuperview() }

    let opened = try await session.webView.value(
      Opened.self,
      of: """
        await (async () => {
          const app = window.app;
          if (!app || app.isLoadingTrace || !app.trace) return null;
          const result = await app.trace.engine.query('select * from slice');
          return {title: app.trace.traceInfo.traceTitle, slices: result.numRows()};
        })()
        """,
      timeout: .seconds(90)
    )
    #expect(opened.title.contains("session0.trace.json"))
    #expect(opened.slices == 3)
  }

  @Test(.timeLimit(.minutes(3)))
  func theUIRegistersTheAgentProfSQLModules() async throws {
    let packages = "(await window.app.sqlPackages()).map((p) => p.name)"
    let session = try await openRecording(
      once: "await (async () => { const names = \(packages); return names.includes('dev.agentprof'); })()",
      state: packages
    )
    defer { session.webView.removeFromSuperview() }

    let modules = [
      "dev.agentprof.captures",
      "dev.agentprof.models",
      "dev.agentprof.sessions",
      "dev.agentprof.tools",
      "dev.agentprof.context",
      "dev.agentprof.activity",
      "dev.agentprof.turns",
      "dev.agentprof.runtime",
    ]
    let included = try await session.webView.value(
      [String: String].self,
      of: """
        await (async () => {
          const app = window.app;
          if (!app || app.isLoadingTrace || !app.trace) return null;
          const included = {};
          for (const module of \(try String(data: JSONEncoder().encode(modules), encoding: .utf8)!)) {
            try {
              await app.trace.engine.query(`INCLUDE PERFETTO MODULE ${module};`);
              included[module] = 'ok';
            } catch (e) {
              included[module] = String(e).slice(0, 300);
            }
          }
          return included;
        })()
        """,
      timeout: .seconds(90)
    )
    let expected = Dictionary(uniqueKeysWithValues: modules.map { ($0, "ok") })
    #expect(included == expected)
  }

  @Test(.timeLimit(.minutes(2)))
  func theUIsTextKeepsItsSizeInLandscape() async throws {
    let root = try TemporaryDirectory()
    let webView = ProfilerWebViewFactory.makeWebView(resources: .bundled(in: .main, traces: root.url), appVersion: "test")
    try await ProfilerWebViewFactory.blockNetwork(webView)
    webView.showInHostWindow()
    webView.frame = CGRect(x: 0, y: 0, width: 932, height: 430)
    defer { webView.removeFromSuperview() }
    try await PageLoader().load(WebApp.home, in: webView)
    _ = try await webView.value(Bool.self, of: "typeof window.waitForPerfettoIdle === 'function' ? true : null", timeout: .seconds(60))

    let sizes = """
      [...document.querySelectorAll('body *')]
        .filter((e) => [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()))
        .map((e) => `${e.textContent.trim().slice(0, 40)}: ${getComputedStyle(e).fontSize}`)
      """
    var shown: [String] = []
    while true {
      try await Task.sleep(for: .milliseconds(500))
      let now = try await webView.value([String].self, of: sizes)
      if now.count > 5, now == shown { break }
      shown = now
    }
    _ = try await webView.run("document.documentElement.style.webkitTextSizeAdjust = '100%'; return '';")
    try await Task.sleep(for: .milliseconds(500))
    let optedOut = try await webView.value([String].self, of: sizes)
    #expect(shown == optedOut)
  }

  private struct TopBar: Decodable {
    let shown: Bool
    let searching: Bool
  }

  @Test(.timeLimit(.minutes(2)))
  func theUIHandsTheAppItsButtons() async throws {
    let root = try TemporaryDirectory()
    let controller = ProfilerController(inbox: TraceInbox(directory: root.url), resources: .bundled(in: .main, traces: root.url))
    let webView = ProfilerWebViewFactory.makeWebView(resources: controller.resources, appVersion: "test")
    webView.showInHostWindow()
    defer { webView.removeFromSuperview() }
    controller.attach(webView)

    let deadline = ContinuousClock.now + .seconds(60)
    while !controller.pageActions.contains(where: { $0.id == "settings" }), ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(100))
    }
    let ids = controller.pageActions.map(\.id)
    #expect(Array(ids.prefix(2)) == ["home", "search"])
    #expect(ids.contains("open") && ids.contains("settings"))

    let topBar = """
      (() => {
        const topbar = document.querySelector('.pf-ui-main > .pf-topbar');
        if (!topbar) return null;
        return {
          shown: getComputedStyle(topbar).display !== 'none',
          searching: Boolean(document.activeElement?.closest('.pf-omnibox')),
        };
      })()
      """
    #expect(try await webView.value(TopBar.self, of: topBar).shown)

    controller.setNativeBar(true)
    _ = try await webView.value(Bool.self, of: "(\(topBar))?.shown === false ? true : null")

    controller.runPageAction("search")
    let searching = try await webView.value(TopBar.self, of: "(() => { const s = \(topBar); return s?.searching ? s : null; })()")
    #expect(searching.shown)
  }

  @Test(arguments: ["search", "dashboard", "line_style", "terminal", "folder_open", "download", "info", "dark_mode", "settings", "close", "more_horiz"])
  func theAppDrawsTheUIsIcons(_ name: String) throws {
    let symbols = try #require(MaterialSymbols(webUI: WebAppResources.bundled(in: .main).webUI))
    let outlined = try #require(symbols.image(name, filled: false))
    let filled = try #require(symbols.image(name, filled: true))
    #expect(outlined.size == CGSize(width: MaterialSymbols.pointSize, height: MaterialSymbols.pointSize))
    #expect(outlined.renderingMode == .alwaysTemplate)
    #expect(Self.ink(outlined) > 20)
    #expect(Self.ink(filled) >= Self.ink(outlined))
  }

  @Test
  func whatsShowingHasItsIconFilled() throws {
    let symbols = try #require(MaterialSymbols(webUI: WebAppResources.bundled(in: .main).webUI))
    for name in ["info", "settings", "folder_open"] {
      let outlined = try #require(symbols.image(name, filled: false))
      let filled = try #require(symbols.image(name, filled: true))
      #expect(Self.ink(filled) > Self.ink(outlined) * 11 / 10, "\(name)")
    }
    #expect(symbols.image("no_such_icon", filled: false) == nil)
  }

  private static func ink(_ image: UIImage) -> Int {
    guard let cgImage = image.cgImage else { return 0 }
    let width = cgImage.width
    let height = cgImage.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard
        let context = CGContext(
          data: buffer.baseAddress,
          width: width,
          height: height,
          bitsPerComponent: 8,
          bytesPerRow: width * 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
      else { return false }
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
      return true
    }
    guard drawn else { return 0 }
    return stride(from: 3, to: pixels.count, by: 4).filter { pixels[$0] > 0 }.count
  }

  @Test(.timeLimit(.minutes(3)))
  func theCollapsedOverviewIsAsWideAsTheAppsBar() async throws {
    let root = try TemporaryDirectory()
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("traces"))
    let controller = ProfilerController(inbox: inbox, resources: .bundled(in: .main, traces: inbox.directory))
    let webView = ProfilerWebViewFactory.makeWebView(resources: controller.resources, appVersion: "test")
    let host = ProfilerHostViewController(controller: controller, webView: webView)
    host.hasVerticalBarOverride = true
    host.additionalSafeAreaInsets = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 62)
    let scene = try #require(UIApplication.shared.connectedScenes.first { $0 is UIWindowScene } as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 932, height: 430)
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    controller.attach(webView)

    let deadline = ContinuousClock.now + .seconds(60)
    while controller.pageActions.isEmpty, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(100))
    }
    host.updateBar()
    #expect(host.barWidth == 62)

    _ = try await webView.run("await window.app.commands.runCommand('dev.agentprof.Agentprof.OpenClaudeExample'); return 'opened';")
    _ = try await webView.value(Bool.self, of: "document.querySelector('.ap-page') ? true : null", timeout: .seconds(90))

    _ = try await webView.value(
      Bool.self,
      of: "(() => { const b = document.querySelector('[aria-label=\"Collapse overview\"]'); if (!b) return null; b.click(); return true; })()"
    )
    let width = try await webView.value(
      Double.self,
      of: "(() => { if (!document.querySelector('.ap-page--collapsed')) return null; const p = document.querySelector('.pf-page-split__primary'); return p ? p.getBoundingClientRect().width : null; })()"
    )
    #expect(abs(width - 62) <= 2)
  }

  @Test(.timeLimit(.minutes(2)))
  func openingTraceFilesGoesStraightToFiles() async throws {
    let root = try TemporaryDirectory()
    let controller = ProfilerController(inbox: TraceInbox(directory: root.url), resources: .bundled(in: .main, traces: root.url))
    let webView = ProfilerWebViewFactory.makeWebView(resources: controller.resources, appVersion: "test")
    let host = ProfilerHostViewController(controller: controller, webView: webView)
    let scene = try #require(UIApplication.shared.connectedScenes.first { $0 is UIWindowScene } as? UIWindowScene)
    let window = UIWindow(windowScene: scene)
    window.frame = CGRect(x: 0, y: 0, width: 932, height: 430)
    window.rootViewController = host
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    controller.attach(webView)

    var deadline = ContinuousClock.now + .seconds(60)
    while !controller.pageActions.contains(where: { $0.id == "open" }), ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(100))
    }
    controller.runPageAction("open")

    deadline = ContinuousClock.now + .seconds(10)
    while host.presentedViewController == nil, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(100))
    }
    let presented = host.presentedViewController
    #expect(presented is UIDocumentPickerViewController, "presented \(presented.map { String(describing: type(of: $0)) } ?? "nothing")")
    presented?.dismiss(animated: false)
  }
}
