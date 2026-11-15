// SPDX-License-Identifier: Apache-2.0

import Foundation
import Observation
import WebKit

/// User-facing alerts presented by `ProfilerScreen`.
public enum ProfilerAlert: Equatable, Sendable {
  /// WebKit terminated the web content process, typically when a recording exceeded WebKit's memory limit.
  case pageStopped
  /// The UI could not start because WebKit failed to compile the offline content rule list.
  case startFailed(message: String)
  case openFailed(name: String, message: String)
  case downloadFailed(message: String)

  public var title: String {
    switch self {
    case .pageStopped:
      return "AgentProf stopped"
    case .startFailed:
      return "AgentProf couldn't start"
    case .openFailed(let name, _):
      return "Couldn't open \(name)"
    case .downloadFailed:
      return "Couldn't save the file"
    }
  }

  public var message: String {
    switch self {
    case .pageStopped:
      return "The recording may be too large for this device's memory. Try opening a smaller recording."
    case .startFailed(let message), .openFailed(_, let message), .downloadFailed(let message):
      return message
    }
  }
}

/// Owns the profiler page: boots the bundled UI offline, reloads it if WebKit terminates its
/// process, synchronizes cached recent recordings, and delivers recordings opened from Files,
/// Share Sheet, AirDrop, or other apps.
@MainActor
@Observable
public final class ProfilerController {
  /// Whether the main frame has finished loading (the UI scripts may still be initializing).
  public private(set) var isPageLoaded = false
  /// Name of the recording currently being copied into `TraceInbox`.
  public private(set) var importing: String?
  public var alert: ProfilerAlert?
  /// Top-bar actions reported by the UI (`PageActionsHandler`).
  var pageActions: [PageAction] = []

  let resources: WebAppResources
  let inbox: TraceInbox
  @ObservationIgnored private weak var webView: WKWebView?
  @ObservationIgnored private var pending: [ImportedTrace] = []
  @ObservationIgnored private var queue: Task<Void, Never>?
  @ObservationIgnored private var importsLeft = 0
  @ObservationIgnored private var nativeBar = NativeBar.hidden

  public init(inbox: TraceInbox = TraceInbox(), resources: WebAppResources? = nil) {
    self.inbox = inbox
    self.resources = resources ?? .bundled(traces: inbox.directory)
  }

  /// Imports and opens a recording URL handed to the app by the system.
  public func open(_ url: URL) {
    guard url.isFileURL else { return }
    let name = url.lastPathComponent
    importsLeft += 1
    importing = name
    enqueue { [self] in
      importing = name
      do {
        pending.append(try await inbox.importFile(at: url))
      } catch {
        reportFailure(.openFailed(name: name, message: error.localizedDescription))
      }
      importsLeft -= 1
      if importsLeft == 0 {
        importing = nil
      }
      await syncRecentTraces()
      await deliverPending()
    }
  }

  /// Reopens a cached recording selected on the Home page.
  func openRecentTrace(_ id: UUID) {
    enqueue { [self] in
      if let trace = await inbox.trace(id: id) {
        pending.append(trace)
        await deliverPending()
      } else {
        await syncRecentTraces()
        reportFailure(.openFailed(name: id.uuidString, message: "This cached recording is no longer available."))
      }
    }
  }

  /// Removes a cached recording deleted from the Home page.
  func removeRecentTrace(_ id: UUID) {
    enqueue { [self] in
      await inbox.removeTrace(id: id)
      await syncRecentTraces()
    }
  }

  /// Purges recordings imported more than 3 days ago.
  public func removeOldTraces() async {
    await inbox.removeTraces(olderThan: 3 * 24 * 60 * 60)
    await syncRecentTraces()
  }

  func reportFailure(_ failure: ProfilerAlert) {
    if alert == nil {
      alert = failure
    }
  }
}

// MARK: - Page lifecycle

extension ProfilerController {
  /// Installs message handlers and offline network rules on `webView` before loading the UI.
  func attach(_ webView: WKWebView) {
    self.webView = webView
    let contentController = webView.configuration.userContentController
    contentController.removeScriptMessageHandler(forName: HostBridge.actionsHandlerName, contentWorld: .page)
    contentController.add(PageActionsHandler(controller: self), contentWorld: .page, name: HostBridge.actionsHandlerName)
    contentController.removeScriptMessageHandler(forName: HostBridge.recentTracesHandlerName, contentWorld: .page)
    contentController.add(RecentTracesHandler(controller: self), contentWorld: .page, name: HostBridge.recentTracesHandlerName)
    Task {
      do {
        try await ProfilerWebViewFactory.blockNetwork(webView)
        webView.load(URLRequest(url: WebApp.home))
      } catch {
        alert = .startFailed(message: error.localizedDescription)
      }
    }
  }

  func pageStarted() {
    isPageLoaded = false
    pageActions = []
    nativeBar = .hidden
  }

  func pageFinished() {
    isPageLoaded = true
    enqueue { [self] in
      await syncRecentTraces()
      await deliverPending()
    }
  }

  /// WebKit's content process terminated: reload the home page without reopening the recording.
  func pageStopped() {
    isPageLoaded = false
    pending.removeAll()
    alert = .pageStopped
    webView?.load(URLRequest(url: WebApp.home))
  }

  private func enqueue(_ work: @escaping @MainActor () async -> Void) {
    let previous = queue
    queue = Task {
      await previous?.value
      await work()
    }
  }

  private func syncRecentTraces() async {
    guard isPageLoaded, let webView else { return }
    let items = await inbox.listTraces().map(\.hostPayload)
    _ = try? await webView.callAsyncJavaScript(
      HostBridge.setRecentTracesCall,
      arguments: ["items": items],
      in: nil,
      contentWorld: .page
    )
  }

  private func deliverPending() async {
    while isPageLoaded, let webView, !pending.isEmpty {
      let trace = pending.removeFirst()
      do {
        _ = try await webView.callAsyncJavaScript(
          HostBridge.openTraceCall,
          arguments: ["url": trace.webURL.absoluteString, "name": trace.name],
          in: nil,
          contentWorld: .page
        )
      } catch {
        reportFailure(.openFailed(name: trace.name, message: error.localizedDescription))
      }
    }
  }
}

// MARK: - Native bar actions

extension ProfilerController {
  /// Invokes one of the UI's top-bar actions by identifier.
  func runPageAction(_ id: String) {
    guard let webView, pageActions.contains(where: { $0.id == id }) else { return }
    Task {
      do {
        _ = try await webView.callAsyncJavaScript(HostBridge.runActionCall, arguments: ["id": id], in: nil, contentWorld: .page)
      } catch {
        // The page reloaded or terminated; it will re-register its actions once ready.
      }
    }
  }

  /// Updates whether the host renders the UI's top-bar buttons natively and the width of the bar.
  func setNativeBar(_ on: Bool, width: Double = 0) {
    let shown = on ? NativeBar(on: true, width: max(0, width)) : .hidden
    guard shown != nativeBar, let webView else { return }
    nativeBar = shown
    Task {
      do {
        _ = try await webView.callAsyncJavaScript(
          HostBridge.setNativeBarCall,
          arguments: ["on": shown.on, "width": shown.width],
          in: nil,
          contentWorld: .page
        )
      } catch {
        nativeBar = .hidden
      }
    }
  }
}

private struct NativeBar: Equatable {
  static let hidden = NativeBar(on: false, width: 0)

  let on: Bool
  let width: Double
}
