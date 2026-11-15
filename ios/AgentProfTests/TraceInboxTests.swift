// SPDX-License-Identifier: Apache-2.0

@testable import AgentProf
import Foundation
import Testing

@Suite
struct TraceInboxTests {
  @Test
  func anImportedRecordingIsServedAtItsWebURL() async throws {
    let root = try TemporaryDirectory()
    let source = try root.file("outside/session 3.pftrace", count: 4096)
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("inbox"))
    let trace = try await inbox.importFile(at: source)
    #expect(trace.name == "session 3.pftrace")
    #expect(trace.byteCount == 4096)
    #expect(try Data(contentsOf: trace.file) == Data(contentsOf: source))
    #expect(trace.webURL.absoluteString == "agentprof://app/_traces/\(trace.id.uuidString)/session%203.pftrace")
    let route = WebAppRoute(trace.webURL)
    #expect(route == .trace(id: trace.id, name: trace.name))
    let resources = WebAppResources(webUI: nil, diagnostics: nil, traces: inbox.directory)
    #expect(resources.file(for: route)?.resolvingSymlinksInPath() == trace.file.resolvingSymlinksInPath())
  }

  @Test
  func eachImportIsItsOwnCopyAndCanBeListedAndRemoved() async throws {
    let root = try TemporaryDirectory()
    let source = try root.file("trace.pftrace", count: 10)
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("inbox"))
    let first = try await inbox.importFile(at: source)
    let second = try await inbox.importFile(at: source)
    #expect(first.id != second.id)
    #expect(first.file != second.file)

    let listed = await inbox.listTraces()
    #expect(Set(listed.map(\.id)) == Set([first.id, second.id]))
    #expect(await inbox.trace(id: first.id)?.name == "trace.pftrace")

    await inbox.removeTrace(id: first.id)
    #expect(await inbox.trace(id: first.id) == nil)
    #expect(await inbox.listTraces().map(\.id) == [second.id])
  }

  @Test
  func aMissingFileFailsWithoutLeavingAFolder() async throws {
    let root = try TemporaryDirectory()
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("inbox"))
    await #expect(throws: (any Error).self) {
      try await inbox.importFile(at: root.url.appendingPathComponent("missing.pftrace"))
    }
    let left = (try? FileManager.default.contentsOfDirectory(atPath: inbox.directory.path)) ?? []
    #expect(left.isEmpty)
  }

  @Test(arguments: [
    ("trace.pftrace", "trace.pftrace"),
    ("run 0 (copy).trace.json.gz", "run 0 (copy).trace.json.gz"),
    ("a/b\\c:d.pftrace", "abcd.pftrace"),
    ("trace #1?%.pftrace", "trace 1.pftrace"),
    ("..hidden.pftrace", "hidden.pftrace"),
    ("  spaced.pftrace  ", "spaced.pftrace"),
    ("line\nbreak\u{0}.pftrace", "linebreak.pftrace"),
    ("", "recording"),
    ("...", "recording"),
  ])
  func namesAreSafePathSegments(_ name: String, _ expected: String) {
    #expect(TraceInbox.sanitizedName(name) == expected)
  }

  @Test
  func longNamesKeepTheirExtension() {
    let name = TraceInbox.sanitizedName(String(repeating: "r", count: 300) + ".pftrace")
    #expect(name.count == 128)
    #expect(name.hasSuffix(".pftrace"))
  }

  @Test
  func oldRecordingsAreRemoved() async throws {
    let root = try TemporaryDirectory()
    let source = try root.file("trace.pftrace", count: 10)
    let inbox = TraceInbox(directory: root.url.appendingPathComponent("inbox"))
    let old = try await inbox.importFile(at: source)
    let recent = try await inbox.importFile(at: source)
    let now = Date()
    try FileManager.default.setAttributes(
      [.creationDate: now.addingTimeInterval(-4 * 24 * 60 * 60)],
      ofItemAtPath: old.file.deletingLastPathComponent().path
    )
    await inbox.removeTraces(olderThan: 3 * 24 * 60 * 60, now: now)
    #expect(!FileManager.default.fileExists(atPath: old.file.path))
    #expect(FileManager.default.fileExists(atPath: recent.file.path))
  }
}
