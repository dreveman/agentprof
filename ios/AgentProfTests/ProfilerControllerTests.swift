// SPDX-License-Identifier: Apache-2.0

@testable import AgentProf
import Foundation
import Testing

@MainActor
@Suite
struct ProfilerControllerTests {
  private let root: TemporaryDirectory
  private let controller: ProfilerController

  init() throws {
    root = try TemporaryDirectory()
    controller = ProfilerController(
      inbox: TraceInbox(directory: root.url.appendingPathComponent("traces")),
      resources: WebAppResources(webUI: nil, diagnostics: nil, traces: root.url)
    )
  }

  private func importsFinish() async throws {
    let deadline = ContinuousClock.now + .seconds(10)
    while controller.importing != nil {
      guard ContinuousClock.now < deadline else { throw TimedOut(description: "the import never finished") }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  @Test
  func aFileThatCantBeReadIsReported() async throws {
    controller.open(root.url.appendingPathComponent("missing.pftrace"))
    #expect(controller.importing == "missing.pftrace")
    try await importsFinish()
    guard case .openFailed(let name, let message) = controller.alert else {
      Issue.record("expected openFailed, got \(String(describing: controller.alert))")
      return
    }
    #expect(name == "missing.pftrace")
    #expect(!message.isEmpty)
  }

  @Test
  func aLaterFailureDoesntHideWhyThePageStopped() async throws {
    controller.pageStopped()
    controller.open(root.url.appendingPathComponent("missing.pftrace"))
    try await importsFinish()
    #expect(controller.alert == .pageStopped)
  }

  @Test
  func filesOpenedTogetherAreImportedInTurn() async throws {
    controller.open(try root.file("a.pftrace", count: 4 * WebAppSchemeHandler.chunkSize))
    controller.open(root.url.appendingPathComponent("missing.pftrace"))
    #expect(controller.importing == "missing.pftrace")
    try await importsFinish()
    if case .openFailed(let name, _) = controller.alert {
      #expect(name == "missing.pftrace")
    } else {
      Issue.record("expected openFailed, got \(String(describing: controller.alert))")
    }
  }

  @Test
  func onlyFilesAreOpened() {
    controller.open(URL(string: "https://example.com/trace.pftrace")!)
    #expect(controller.importing == nil)
    #expect(controller.alert == nil)
  }
}
