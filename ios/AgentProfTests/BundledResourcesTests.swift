// SPDX-License-Identifier: Apache-2.0

@testable import AgentProf
import Foundation
import Testing

@Suite
struct BundledResourcesTests {
  private let resources = WebAppResources.bundled(in: .main)

  @Test
  func theUIAndTheDiagnosticsPageAreServed() {
    #expect(resources.file(for: WebAppRoute(WebApp.home)) != nil)
    #expect(resources.file(for: WebAppRoute(WebApp.diagnostics)) != nil)
    for file in ["probe.js", "worker.js", "add.wasm"] {
      #expect(resources.file(for: .diagnostics(file)) != nil, "\(file) is missing")
    }
  }
}
