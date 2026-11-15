// SPDX-License-Identifier: Apache-2.0

import Foundation
import WebKit

/// What the web view does with a navigation.
public enum NavigationDecision: Equatable, Sendable {
  case allow
  /// Save what the page offers (an `<a download>`, or a response it can't display), then share it.
  case download
  /// Open in Safari outside the web view once the user confirms.
  case openExternally(URL)
  case cancel
}

/// Keeps the web view on the app's own origin: the UI and its frames load from
/// `agentprof://app`, external web links prompt to open in Safari, and nothing else loads.
public enum NavigationPolicy {
  /// - Parameters:
  ///   - targetIsMainFrame: Whether the navigation is in the main frame; nil for a new window
  ///     (`target="_blank"`, `window.open`).
  public static func decide(
    url: URL?,
    targetIsMainFrame: Bool?,
    navigationType: WKNavigationType,
    shouldPerformDownload: Bool
  ) -> NavigationDecision {
    guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
    let newWindow = targetIsMainFrame == nil
    let mainFrame = targetIsMainFrame ?? false
    switch scheme {
    case WebApp.scheme:
      guard WebApp.isAppURL(url) else { return .cancel }
      if shouldPerformDownload { return .download }
      return newWindow ? .cancel : .allow
    case "blob", "data":
      if shouldPerformDownload { return .download }
      return !newWindow && !mainFrame ? .allow : .cancel
    case "about":
      return newWindow ? .cancel : .allow
    case "http", "https":
      let leaves = newWindow || (mainFrame && (navigationType == .linkActivated || navigationType == .other))
      return leaves ? .openExternally(url) : .cancel
    default:
      return .cancel
    }
  }
}
