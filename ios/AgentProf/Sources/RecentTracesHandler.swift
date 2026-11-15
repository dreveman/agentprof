// SPDX-License-Identifier: Apache-2.0

import Foundation
import WebKit

/// Receives recent-trace open and delete requests from the app's main frame.
@MainActor
final class RecentTracesHandler: NSObject, WKScriptMessageHandler {
  enum Command: Equatable, Sendable {
    case open(UUID)
    case remove(UUID)

    static func parse(_ body: Any) -> Command? {
      guard let fields = body as? [String: Any],
        let action = fields["action"] as? String,
        let rawID = fields["id"] as? String,
        let id = UUID(uuidString: rawID)
      else { return nil }
      switch action {
      case "open":
        return .open(id)
      case "remove":
        return .remove(id)
      default:
        return nil
      }
    }
  }

  private weak var controller: ProfilerController?

  init(controller: ProfilerController) {
    self.controller = controller
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    let origin = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame, origin.protocol == WebApp.scheme, origin.host == WebApp.host,
      let command = Command.parse(message.body)
    else { return }
    switch command {
    case .open(let id):
      controller?.openRecentTrace(id)
    case .remove(let id):
      controller?.removeRecentTrace(id)
    }
  }
}
