// SPDX-License-Identifier: Apache-2.0

import SwiftUI

@main
struct AgentProfApp: App {
  @State private var controller = ProfilerController()

  var body: some Scene {
    WindowGroup {
      ProfilerScreen(controller: controller)
    }
  }
}
