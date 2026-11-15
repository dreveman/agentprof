// SPDX-License-Identifier: Apache-2.0

import Foundation
import UIKit
import WebKit

/// Navigation, UI, and download delegate for the profiler web view: enforces `NavigationPolicy`,
/// confirms before opening external links in Safari, presents JavaScript dialogs natively, and
/// shares downloaded files via `UIActivityViewController`.
@MainActor
final class WebViewCoordinator: NSObject {
  private weak var controller: ProfilerController?
  private let openExternally: @MainActor (URL) -> Void
  private var downloads: [ObjectIdentifier: URL] = [:]

  init(controller: ProfilerController, openExternally: @escaping @MainActor (URL) -> Void = WebViewCoordinator.openInSafari) {
    self.controller = controller
    self.openExternally = openExternally
  }

  static func openInSafari(_ url: URL) {
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
    UIApplication.shared.open(url)
  }

  private func apply(_ decision: NavigationDecision, from webView: WKWebView) -> WKNavigationActionPolicy {
    switch decision {
    case .allow:
      return .allow
    case .download:
      return .download
    case .openExternally(let url):
      askToOpen(url, from: webView)
      return .cancel
    case .cancel:
      return .cancel
    }
  }

  private func askToOpen(_ url: URL, from webView: WKWebView) {
    guard webView.window?.rootViewController?.presentedViewController == nil else { return }
    let alert = UIAlertController(title: DialogText.openLink, message: url.host ?? url.absoluteString, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: DialogText.cancel, style: .cancel))
    alert.addAction(UIAlertAction(title: DialogText.open, style: .default) { [openExternally] _ in openExternally(url) })
    _ = present(alert, from: webView)
  }

  private func present(_ viewController: UIViewController, from webView: WKWebView) -> Bool {
    guard var presenter = webView.window?.rootViewController else { return false }
    while let presented = presenter.presentedViewController {
      presenter = presented
    }
    if let popover = viewController.popoverPresentationController {
      popover.sourceView = webView
      popover.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 0, height: 0)
      popover.permittedArrowDirections = []
    }
    presenter.present(viewController, animated: true)
    return true
  }
}

// MARK: - WKNavigationDelegate

extension WebViewCoordinator: WKNavigationDelegate {
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    preferences: WKWebpagePreferences,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
  ) {
    let decision = NavigationPolicy.decide(
      url: navigationAction.request.url,
      targetIsMainFrame: navigationAction.targetFrame?.isMainFrame,
      navigationType: navigationAction.navigationType,
      shouldPerformDownload: navigationAction.shouldPerformDownload
    )
    decisionHandler(apply(decision, from: webView), preferences)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
  ) {
    decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
    controller?.pageStarted()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
    controller?.pageFinished()
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    controller?.pageStopped()
  }
}

// MARK: - WKUIDelegate

private enum DialogText {
  static let ok = "OK"
  static let cancel = "Cancel"
  static let open = "Open"
  static let openLink = "Open this link outside AgentProf?"
}

extension WebViewCoordinator: WKUIDelegate {
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    _ = apply(
      NavigationPolicy.decide(
        url: navigationAction.request.url,
        targetIsMainFrame: nil,
        navigationType: navigationAction.navigationType,
        shouldPerformDownload: false
      ),
      from: webView
    )
    return nil
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor () -> Void
  ) {
    let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: DialogText.ok, style: .default) { _ in completionHandler() })
    if !present(alert, from: webView) { completionHandler() }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor (Bool) -> Void
  ) {
    let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: DialogText.cancel, style: .cancel) { _ in completionHandler(false) })
    alert.addAction(UIAlertAction(title: DialogText.ok, style: .default) { _ in completionHandler(true) })
    if !present(alert, from: webView) { completionHandler(false) }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor (String?) -> Void
  ) {
    let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
    alert.addTextField { $0.text = defaultText }
    alert.addAction(UIAlertAction(title: DialogText.cancel, style: .cancel) { _ in completionHandler(nil) })
    alert.addAction(
      UIAlertAction(title: DialogText.ok, style: .default) { [weak alert] _ in completionHandler(alert?.textFields?.first?.text) }
    )
    if !present(alert, from: webView) { completionHandler(nil) }
  }
}

// MARK: - WKDownloadDelegate

extension WebViewCoordinator: WKDownloadDelegate {
  func download(
    _ download: WKDownload,
    decideDestinationUsing response: URLResponse,
    suggestedFilename: String,
    completionHandler: @escaping @MainActor (URL?) -> Void
  ) {
    let folder = FileManager.default.temporaryDirectory
      .appendingPathComponent("Downloads", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    } catch {
      completionHandler(nil)
      return
    }
    let destination = folder.appendingPathComponent(TraceInbox.sanitizedName(suggestedFilename), isDirectory: false)
    downloads[ObjectIdentifier(download)] = destination
    completionHandler(destination)
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)), let webView = download.webView else { return }
    let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
    share.completionWithItemsHandler = { _, _, _, _ in
      try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
    if !present(share, from: webView) {
      try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
  }

  func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
    if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) {
      try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
    }
    controller?.reportFailure(.downloadFailed(message: error.localizedDescription))
  }
}
