// SPDX-License-Identifier: Apache-2.0

import WebKit

/// Receives top-bar button updates (`agentprofHost.setActions`) from the app's main frame and
/// forwards validated actions to `ProfilerController`.
@MainActor
final class PageActionsHandler: NSObject, WKScriptMessageHandler {
  private weak var controller: ProfilerController?

  init(controller: ProfilerController) {
    self.controller = controller
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    let origin = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame, origin.protocol == WebApp.scheme, origin.host == WebApp.host,
      let actions = PageAction.parse(message.body)
    else { return }
    controller?.pageActions = actions
  }
}
