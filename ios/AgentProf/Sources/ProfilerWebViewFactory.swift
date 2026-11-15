// SPDX-License-Identifier: Apache-2.0

import Foundation
import UIKit
import WebKit

/// Creates and configures the `WKWebView` that hosts the AgentProf UI.
@MainActor
enum ProfilerWebViewFactory {
  /// Blocks every network load from the page and its frames (`http`, `https`, `ws`, `wss`).
  /// Everything the UI needs is served from `agentprof://app`, ensuring recordings never leave
  /// the device.
  static let offlineRules = """
    [
      {"trigger": {"url-filter": "^https?://"}, "action": {"type": "block"}},
      {"trigger": {"url-filter": "^wss?://"}, "action": {"type": "block"}}
    ]
    """

  private static var offlineRuleList: WKContentRuleList?

  static func makeWebView(resources: WebAppResources, appVersion: String = Self.appVersion) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.setURLSchemeHandler(WebAppSchemeHandler(resources: resources), forURLScheme: WebApp.scheme)
    configuration.websiteDataStore = .default()
    configuration.applicationNameForUserAgent = "AgentProf/\(appVersion)"
    configuration.dataDetectorTypes = []
    configuration.userContentController.addUserScript(
      WKUserScript(
        source: HostBridge.bootstrapScript(appVersion: appVersion),
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true,
        in: .page
      )
    )
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.allowsBackForwardNavigationGestures = false
    webView.allowsLinkPreview = false
    webView.isOpaque = false
    webView.backgroundColor = .systemBackground
    webView.scrollView.backgroundColor = .systemBackground
    webView.scrollView.bounces = false
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    #if DEBUG
    webView.isInspectable = true
    #endif
    return webView
  }

  /// Compiles and installs `offlineRules` on `webView`. Throws if WebKit fails to compile the
  /// rules so the UI never loads without network isolation.
  static func blockNetwork(_ webView: WKWebView) async throws {
    let rules: WKContentRuleList
    if let offlineRuleList {
      rules = offlineRuleList
    } else {
      let compiled = try await WKContentRuleListStore.default().compileContentRuleList(
        forIdentifier: "agentprof-offline",
        encodedContentRuleList: offlineRules
      )
      guard let compiled else { throw CocoaError(.featureUnsupported) }
      offlineRuleList = compiled
      rules = compiled
    }
    webView.configuration.userContentController.add(rules)
  }

  static var appVersion: String {
    let info = Bundle.main.infoDictionary ?? [:]
    let version = info["CFBundleShortVersionString"] as? String ?? "0"
    let build = info["CFBundleVersion"] as? String ?? "0"
    return "\(version) (\(build))"
  }
}
