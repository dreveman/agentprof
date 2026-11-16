// SPDX-License-Identifier: Apache-2.0

@testable import AgentProf
import Foundation
import SwiftUI
import Testing
import UIKit
import WebKit

/// End-to-end tests against a real `WKWebView`, custom scheme handler, host bridge, and content rule list.
@MainActor
@Suite(.serialized)
struct WebViewTests {
  private static let postMessagePage = """
    <!doctype html>
    <meta charset="utf-8">
    <script>
      window.received = null;
      window.addEventListener('message', (e) => {
        if (document.readyState !== 'complete') return;
        if (e.source === null || e.source !== window.parent) return;
        if (e.data === 'PING') {
          e.source.postMessage('PONG', e.origin);
          return;
        }
        if (e.data && e.data.perfetto) {
          const trace = e.data.perfetto;
          window.received = {
            title: trace.title,
            bytes: trace.buffer.byteLength,
            keepApiOpen: trace.keepApiOpen === true,
            origin: e.origin,
            trusted: e.origin === window.origin,
          };
        }
      });
    </script>
    """

  private static let handlerPage = """
    <!doctype html>
    <meta charset="utf-8">
    <script>
      window.handled = null;
      window.openedNames = [];
      window.agentprofHost.onOpenTrace = async ({url, name}) => {
        window.openedNames.push(name);
        const response = await fetch(url);
        const reader = response.body.getReader();
        let bytes = 0;
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          bytes += value.byteLength;
        }
        window.handled = {url, name, bytes, status: response.status};
      };
    </script>
    """

  private struct ProbeResult: Decodable {
    let ok: Bool
    let error: String?
  }

  private struct Received: Decodable {
    let title: String
    let bytes: Int64
    let keepApiOpen: Bool
    let origin: String
    let trusted: Bool
  }

  private struct Handled: Decodable {
    let url: String
    let name: String
    let bytes: Int64
    let status: Int
  }

  private final class OpenedLinks {
    var urls: [URL] = []
  }

  private struct Host: Decodable {
    let platform: String
    let idiom: String
    let appVersion: String
    let replaced: Bool
    let cacheAPI: Bool
  }

  private struct RecentItem: Decodable, Equatable {
    let id: String
    let title: String
    let sizeBytes: Int64
  }

  // MARK: - Web platform self-check

  @Test(.timeLimit(.minutes(5)))
  func theWebViewHasWhatTheUINeeds() async throws {
    let root = try TemporaryDirectory()
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("traces"))
    let trace = try await inbox.importFile(at: root.file("session0.pftrace", count: 5 * WebAppSchemeHandler.chunkSize + 123))
    let webView = ProfilerWebViewFactory.makeWebView(resources: .bundled(in: .main, traces: inbox.directory), appVersion: "test")
    try await ProfilerWebViewFactory.blockNetwork(webView)
    webView.showInHostWindow()
    defer { webView.removeFromSuperview() }
    try await PageLoader().load(WebApp.url(path: "/_diagnostics/index.html", query: [URLQueryItem(name: "autorun", value: "0")]), in: webView)

    let json = try #require(
      try await webView.run(
        "return JSON.stringify(await window.runProbe(options));",
        ["options": ["traceURL": trace.webURL.absoluteString, "traceBytes": trace.byteCount, "memoryMB": 1024]]
      )
    )
    let results = try JSONDecoder().decode([String: ProbeResult].self, from: Data(json.utf8))
    let required = [
      "host", "localStorage", "indexedDB", "corsFetch", "blobURL", "wasmStreaming",
      "wasmCompile", "worker", "wasmModuleToWorker", "wasmMemory", "traceStream",
    ]
    for name in required {
      let result = try #require(results[name], "\(name) did not run")
      #expect(result.ok, "\(name): \(result.error ?? "")")
    }
  }

  // MARK: - Opening recordings

  @Test(.timeLimit(.minutes(2)))
  func aUIWithoutAHandlerGetsTheRecordingThroughPostMessage() async throws {
    let root = try TemporaryDirectory()
    try root.file("web/index.html", text: Self.postMessagePage)
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("traces"))
    let trace = try await inbox.importFile(at: root.file("session 0.pftrace", count: 2 * WebAppSchemeHandler.chunkSize + 5))
    let resources = WebAppResources(webUI: root.url.appendingPathComponent("web"), diagnostics: nil, traces: inbox.directory)
    let webView = ProfilerWebViewFactory.makeWebView(resources: resources, appVersion: "test")
    webView.showInHostWindow()
    defer { webView.removeFromSuperview() }
    try await PageLoader().load(WebApp.home, in: webView)

    let route = try await webView.run(HostBridge.openTraceCall, ["url": trace.webURL.absoluteString, "name": trace.name])
    #expect(route == "postMessage")
    let received = try await webView.value(Received.self, of: "window.received")
    #expect(received.title == "session 0.pftrace")
    #expect(received.bytes == trace.byteCount)
    #expect(received.keepApiOpen)
    #expect(received.origin == WebApp.origin)
    #expect(received.trusted)
  }

  @Test(.timeLimit(.minutes(2)))
  func aUIWithAHandlerStreamsTheRecording() async throws {
    let root = try TemporaryDirectory()
    try root.file("web/index.html", text: Self.handlerPage)
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("traces"))
    let trace = try await inbox.importFile(at: root.file("session 1.pftrace", count: 3 * WebAppSchemeHandler.chunkSize + 9))
    let resources = WebAppResources(webUI: root.url.appendingPathComponent("web"), diagnostics: nil, traces: inbox.directory)
    let webView = ProfilerWebViewFactory.makeWebView(resources: resources, appVersion: "test")
    webView.showInHostWindow()
    defer { webView.removeFromSuperview() }
    try await PageLoader().load(WebApp.home, in: webView)

    let route = try await webView.run(HostBridge.openTraceCall, ["url": trace.webURL.absoluteString, "name": trace.name])
    #expect(route == "handler")
    let handled = try await webView.value(Handled.self, of: "window.handled")
    #expect(handled.url == trace.webURL.absoluteString)
    #expect(handled.name == "session 1.pftrace")
    #expect(handled.status == 200)
    #expect(handled.bytes == trace.byteCount)
  }

  @Test(.timeLimit(.minutes(2)))
  func thePageGetsTheHostAsTheAppDescribesIt() async throws {
    let root = try TemporaryDirectory()
    try root.file("web/index.html", text: "<!doctype html><title>host</title>")
    let resources = WebAppResources(webUI: root.url.appendingPathComponent("web"), diagnostics: nil, traces: root.url)
    let version = #"1.0 (7) "double" 'single' \back </script> ${x} `tick` "# + "\u{2028}"
    let webView = ProfilerWebViewFactory.makeWebView(resources: resources, appVersion: version)
    try await PageLoader().load(WebApp.home, in: webView)

    let host = try await webView.value(
      Host.self,
      of: """
        (() => {
          const host = window.agentprofHost;
          try { window.agentprofHost = {platform: 'web'}; } catch (e) {}
          try { delete window.agentprofHost; } catch (e) {}
          return {
            platform: host.platform,
            idiom: host.idiom,
            appVersion: host.appVersion,
            replaced: window.agentprofHost !== host,
            cacheAPI: typeof caches !== 'undefined',
          };
        })()
        """
    )
    #expect(host.platform == "ios")
    #expect(host.idiom == "phone" || host.idiom == "pad")
    #expect(host.appVersion == version)
    #expect(!host.replaced)
    #expect(!host.cacheAPI)
  }

  // MARK: - App controller & recent traces

  @Test(.timeLimit(.minutes(2)))
  func aRecordingOpenedWhileTheUIStartsReachesItOnce() async throws {
    let root = try TemporaryDirectory()
    try root.file("web/index.html", text: Self.handlerPage)
    let source = try root.file("Inbox/session 2.pftrace", count: WebAppSchemeHandler.chunkSize + 1)
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("traces"))
    let resources = WebAppResources(webUI: root.url.appendingPathComponent("web"), diagnostics: nil, traces: inbox.directory)
    let controller = ProfilerController(inbox: inbox, resources: resources)
    let webView = ProfilerWebViewFactory.makeWebView(resources: resources, appVersion: "test")
    let opened = OpenedLinks()
    let coordinator = WebViewCoordinator(controller: controller, openExternally: { opened.urls.append($0) })
    webView.navigationDelegate = coordinator
    webView.uiDelegate = coordinator
    webView.showInHostWindow()
    defer { webView.removeFromSuperview() }

    controller.open(source)
    controller.attach(webView)
    let handled = try await webView.value(Handled.self, of: "window.handled")
    #expect(handled.name == "session 2.pftrace")
    #expect(handled.bytes == Int64(WebAppSchemeHandler.chunkSize + 1))
    #expect(controller.alert == nil)
    #expect(controller.importing == nil)

    coordinator.webViewWebContentProcessDidTerminate(webView)
    #expect(controller.alert == .pageStopped)
    _ = try await webView.value(Bool.self, of: "window.handled === null ? true : null")
    try await Task.sleep(for: .milliseconds(500))
    #expect(try await webView.run("return JSON.stringify(window.handled);") == "null")
    #expect(opened.urls.isEmpty)
  }

  @Test(.timeLimit(.minutes(2)))
  func recordingsReachTheUIInOrderAndPopulateRecentTraces() async throws {
    let root = try TemporaryDirectory()
    try root.file("web/index.html", text: Self.handlerPage)
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("traces"))
    let resources = WebAppResources(webUI: root.url.appendingPathComponent("web"), diagnostics: nil, traces: inbox.directory)
    let controller = ProfilerController(inbox: inbox, resources: resources)
    let webView = ProfilerWebViewFactory.makeWebView(resources: resources, appVersion: "test")
    let coordinator = WebViewCoordinator(controller: controller, openExternally: { _ in })
    webView.navigationDelegate = coordinator
    webView.showInHostWindow()
    defer { webView.removeFromSuperview() }
    controller.attach(webView)
    _ = try await webView.value(Bool.self, of: "window.handled === null ? true : null")

    for (name, count) in [("a.pftrace", 8 * WebAppSchemeHandler.chunkSize), ("b.pftrace", 1), ("c.pftrace", 1024)] {
      controller.open(try root.file("Inbox/\(name)", count: count))
    }
    let names = try await webView.value([String].self, of: "window.openedNames.length === 3 ? window.openedNames : null")
    #expect(names == ["a.pftrace", "b.pftrace", "c.pftrace"])
    #expect(controller.importing == nil)
    #expect(controller.alert == nil)

    let recents = try await webView.value([RecentItem].self, of: "window.agentprofHost.recentTraces.length === 3 ? window.agentprofHost.recentTraces : null")
    #expect(Set(recents.map(\.title)) == Set(["a.pftrace", "b.pftrace", "c.pftrace"]))

    let firstB = try #require(recents.first { $0.title == "b.pftrace" })
    _ = try await webView.run("window.agentprofHost.onOpenRecentTrace(id); return '';", ["id": firstB.id])
    let reopened = try await webView.value([String].self, of: "window.openedNames.length === 4 ? window.openedNames : null")
    #expect(reopened.last == "b.pftrace")

    _ = try await webView.run("window.agentprofHost.onRemoveRecentTrace(id); return '';", ["id": firstB.id])
    let afterRemove = try await webView.value([RecentItem].self, of: "window.agentprofHost.recentTraces.length === 2 ? window.agentprofHost.recentTraces : null")
    #expect(!afterRemove.contains(where: { $0.id == firstB.id }))
  }

  @Test(.timeLimit(.minutes(2)))
  func aLinkToTheWebAsksBeforeLeavingTheApp() async throws {
    let root = try TemporaryDirectory()
    try root.file("web/index.html", text: #"<!doctype html><a id="docs" href="https://github.com/dreveman/agentprof">GitHub</a>"#)
    let resources = WebAppResources(webUI: root.url.appendingPathComponent("web"), diagnostics: nil, traces: root.url)
    let controller = ProfilerController(inbox: TraceInbox(directory: root.url), resources: resources)
    let webView = ProfilerWebViewFactory.makeWebView(resources: resources, appVersion: "test")
    let opened = OpenedLinks()
    let coordinator = WebViewCoordinator(controller: controller, openExternally: { opened.urls.append($0) })
    try await ProfilerWebViewFactory.blockNetwork(webView)
    webView.showInHostWindow()
    defer { webView.removeFromSuperview() }
    try await PageLoader().load(WebApp.home, in: webView)
    webView.navigationDelegate = coordinator

    _ = try await webView.run("document.getElementById('docs').click(); return 'clicked';")
    let alert = try await Self.alert(over: webView)
    #expect(alert.message == "github.com")
    #expect(alert.actions.map(\.title) == ["Cancel", "Open"])
    #expect(opened.urls.isEmpty)
    #expect(webView.url == WebApp.home)
    await alert.dismiss(animated: false)
  }

  private static func alert(over webView: WKWebView) async throws -> UIAlertController {
    let deadline = ContinuousClock.now + .seconds(10)
    while ContinuousClock.now < deadline {
      if let alert = webView.window?.rootViewController?.presentedViewController as? UIAlertController {
        return alert
      }
      try await Task.sleep(for: .milliseconds(20))
    }
    throw TimedOut(description: "no alert over the web view")
  }

  @Test(.timeLimit(.minutes(1)))
  func theUIRunsToTheBottomEdgeBelowTheStatusBar() async throws {
    let root = try TemporaryDirectory()
    try root.file("web/index.html", text: "<!doctype html><title>layout</title>")
    let resources = WebAppResources(webUI: root.url.appendingPathComponent("web"), diagnostics: nil, traces: root.url)
    let controller = ProfilerController(inbox: TraceInbox(directory: root.url.appendingPathComponent("traces")), resources: resources)
    let screen = UIHostingController(rootView: ProfilerScreen(controller: controller))
    screen.additionalSafeAreaInsets = UIEdgeInsets(top: 47, left: 0, bottom: 34, right: 0)
    screen.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    windows.first?.addSubview(screen.view)
    defer { screen.view.removeFromSuperview() }

    var webView: WKWebView?
    let deadline = ContinuousClock.now + .seconds(10)
    while webView == nil, ContinuousClock.now < deadline {
      screen.view.layoutIfNeeded()
      webView = Self.firstWebView(in: screen.view)
      if webView == nil { try await Task.sleep(for: .milliseconds(50)) }
    }
    let shown = try #require(webView)
    let frame = shown.convert(shown.bounds, to: screen.view)
    let insets = screen.view.safeAreaInsets
    #expect(insets.top >= 47 && insets.bottom >= 34)
    #expect(frame.minY == insets.top)
    #expect(frame.maxY == screen.view.bounds.maxY)
  }

  private static let buttonsPage = """
    <!doctype html>
    <meta charset="utf-8">
    <script>
      window.ran = [];
      window.hostChanges = 0;
      window.addEventListener('agentprofhostchange', () => window.hostChanges++);
      const host = window.agentprofHost;
      host.onRunAction = (id) => window.ran.push(id);
      host.setActions('not a list');
      host.setActions([
        {id: 'home', label: 'Home', icon: 'home', checked: false, disabled: false, group: 'main'},
        {id: 'settings', label: 'Settings', icon: 'settings', checked: true, disabled: false, group: 'more'},
      ]);
    </script>
    """

  private struct ButtonsState: Decodable {
    let ran: [String]
    let nativeBar: Bool
    let nativeBarWidth: Double
    let hostChanges: Int
  }

  @Test(.timeLimit(.minutes(1)))
  func thePageReportsItsButtonsAndRunsTheOnesTheAppTaps() async throws {
    let root = try TemporaryDirectory()
    try root.file("web/index.html", text: Self.buttonsPage)
    let resources = WebAppResources(webUI: root.url.appendingPathComponent("web"), diagnostics: nil, traces: root.url)
    let controller = ProfilerController(inbox: TraceInbox(directory: root.url.appendingPathComponent("traces")), resources: resources)
    let webView = ProfilerWebViewFactory.makeWebView(resources: resources, appVersion: "test")
    webView.showInHostWindow()
    defer { webView.removeFromSuperview() }

    controller.attach(webView)
    let deadline = ContinuousClock.now + .seconds(20)
    while controller.pageActions.isEmpty, ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(50))
    }
    #expect(controller.pageActions.map(\.id) == ["home", "settings"])
    #expect(controller.pageActions.map(\.group) == [.main, .more])

    controller.runPageAction("nope")
    controller.runPageAction("settings")
    controller.setNativeBar(true, width: 62)
    controller.setNativeBar(true, width: 62)
    let state = try await webView.value(
      ButtonsState.self,
      of: """
        window.ran.length && window.hostChanges
          ? {ran: window.ran, nativeBar: window.agentprofHost.nativeBar, nativeBarWidth: window.agentprofHost.nativeBarWidth, hostChanges: window.hostChanges}
          : null
        """
    )
    #expect(state.ran == ["settings"])
    #expect(state.nativeBar)
    #expect(state.nativeBarWidth == 62)
    #expect(state.hostChanges == 1)
  }

  @Test
  func theBarShowsThePagesButtonsOnlyWithTheVerticalBar() throws {
    let root = try TemporaryDirectory()
    let resources = WebAppResources(webUI: root.url, diagnostics: nil, traces: root.url)
    let controller = ProfilerController(inbox: TraceInbox(directory: root.url), resources: resources)
    let host = ProfilerHostViewController(controller: controller, webView: ProfilerWebViewFactory.makeWebView(resources: resources, appVersion: "test"))
    host.loadViewIfNeeded()
    controller.pageActions = try #require(
      PageAction.parse([
        ["id": "home", "label": "Home", "icon": "home", "checked": false, "disabled": false, "group": "main"],
        ["id": "search", "label": "Search", "icon": "search", "checked": false, "disabled": false, "group": "main"],
        ["id": "timeline", "label": "Timeline", "icon": "line_style", "checked": true, "disabled": false, "group": "main"],
        ["id": "open", "label": "Open trace files", "icon": "folder_open", "checked": false, "disabled": true, "group": "more"],
        ["id": "settings", "label": "Settings", "icon": "settings", "checked": true, "disabled": false, "group": "more"],
      ])
    )

    host.hasVerticalBarOverride = false
    host.updateBar()
    #expect(!host.showsButtons)
    #expect(!host.isBottomAligned)
    #expect(host.topItems.isEmpty && host.bottomItems.isEmpty)

    host.hasVerticalBarOverride = true
    host.updateBar()
    #expect(host.showsButtons)
    #expect(host.isBottomAligned)
    #expect(host.topItems.map(\.accessibilityLabel) == ["Home", ProfilerHostViewController.moreLabel])
    #expect(host.topItems.first?.image?.renderingMode == .alwaysOriginal)
    #expect(host.bottomItems.map(\.accessibilityLabel) == ["Search", "Timeline"])
    #expect(host.bottomItems.map { $0.accessibilityTraits.contains(.selected) } == [false, true])
    let allItems = host.topItems + host.bottomItems
    #expect(allItems.allSatisfy { !$0.isSelected && $0.image != nil })
    #expect(host.bottomItems.map(\.isEnabled) == [true, true])

    let menu = try #require(host.topItems.last?.menu)
    let entries = menu.children.compactMap { $0 as? UIAction }
    #expect(entries.map(\.title) == ["Open trace files", "Settings"])
    #expect(entries.map(\.state) == [.off, .on])
    #expect(entries.map { $0.attributes.contains(.disabled) } == [true, false])

    controller.pageActions = []
    host.updateBar()
    #expect(!host.showsButtons)
    #expect(!host.isBottomAligned)
  }

  private static func firstWebView(in view: UIView) -> WKWebView? {
    if let webView = view as? WKWebView { return webView }
    for subview in view.subviews {
      if let webView = firstWebView(in: subview) { return webView }
    }
    return nil
  }

  // MARK: - Offline enforcement

  @Test
  func webKitCompilesTheOfflineRules() async throws {
    let store: WKContentRuleListStore = WKContentRuleListStore.default()
    let rules = try await store.compileContentRuleList(
      forIdentifier: "agentprof-offline-test",
      encodedContentRuleList: ProfilerWebViewFactory.offlineRules
    )
    #expect(rules?.identifier == "agentprof-offline-test")
    try await store.removeContentRuleList(forIdentifier: "agentprof-offline-test")
  }

  @Test(.timeLimit(.minutes(2)))
  func thePageCantReachTheNetwork() async throws {
    let server = try LoopbackServer()
    let base = try await server.start()
    let root = try TemporaryDirectory()
    try root.file("web/index.html", text: "<!doctype html><title>offline</title>")
    let resources = WebAppResources(webUI: root.url.appendingPathComponent("web"), diagnostics: nil, traces: root.url)
    let attempts = """
      const results = {};
      const attempt = async (name, load) => {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 5000));
        try { results[name] = await Promise.race([load(), timeout]); } catch (e) { results[name] = 'failed: ' + e; }
      };
      const element = (tag, attributes) => new Promise((resolve, reject) => {
        const node = Object.assign(document.createElement(tag), attributes);
        node.onload = () => resolve('loaded');
        node.onerror = () => reject(new Error('error'));
        document.head.appendChild(node);
      });
      await attempt('fetch', async () => (await fetch(base + '/fetch')).text());
      await attempt('xhr', () => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onload = () => resolve(xhr.responseText);
        xhr.onerror = () => reject(new Error('error'));
        xhr.open('GET', base + '/xhr');
        xhr.send();
      }));
      await attempt('script', () => element('script', {src: base + '/script.js'}));
      await attempt('stylesheet', () => element('link', {rel: 'stylesheet', href: base + '/style.css'}));
      await attempt('image', () => element('img', {src: base + '/image.png'}));
      await attempt('beacon', () => String(navigator.sendBeacon(base + '/beacon', 'trace')));
      await attempt('webSocket', () => new Promise((resolve, reject) => {
        const socket = new WebSocket(base.replace('http:', 'ws:') + '/socket');
        socket.onopen = () => resolve('open');
        socket.onerror = () => reject(new Error('error'));
      }));
      return JSON.stringify(results);
      """

    let online = ProfilerWebViewFactory.makeWebView(resources: resources, appVersion: "test")
    try await PageLoader().load(WebApp.home, in: online)
    let reached = try await online.run("return await (await fetch(base + '/online')).text();", ["base": base.absoluteString])
    try #require(reached == "ok", "the loopback server is unreachable, so this test can't distinguish blocked from offline")

    let offline = ProfilerWebViewFactory.makeWebView(resources: resources, appVersion: "test")
    try await ProfilerWebViewFactory.blockNetwork(offline)
    try await PageLoader().load(WebApp.home, in: offline)
    let json = try #require(try await offline.run(attempts, ["base": base.absoluteString]))
    let results = try JSONDecoder().decode([String: String].self, from: Data(json.utf8))
    #expect(results["fetch"]?.hasPrefix("failed") == true, "\(results)")
    #expect(results["xhr"]?.hasPrefix("failed") == true, "\(results)")
    try await Task.sleep(for: .seconds(1))
    #expect(server.requestedPaths == ["/online"])
  }
}
