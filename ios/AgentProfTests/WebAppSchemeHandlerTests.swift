// SPDX-License-Identifier: Apache-2.0

@testable import AgentProf
import Foundation
import Testing

@MainActor
@Suite
struct WebAppSchemeHandlerTests {
  private let root: TemporaryDirectory
  private let handler: WebAppSchemeHandler
  private let traceID = UUID()

  init() throws {
    root = try TemporaryDirectory()
    try root.file("web/index.html", text: "<!doctype html>")
    try root.file("web/v1/trace_processor.wasm", count: 100)
    try root.file("traces/\(traceID.uuidString)/big.pftrace", count: 3 * WebAppSchemeHandler.chunkSize + 17)
    handler = WebAppSchemeHandler(
      resources: WebAppResources(
        webUI: root.url.appendingPathComponent("web"),
        diagnostics: nil,
        traces: root.url.appendingPathComponent("traces")
      )
    )
  }

  @Test
  func aFileIsAnsweredWithItsTypeAndLength() async throws {
    let task = RecordingSchemeTask(WebApp.home)
    handler.start(task)
    try await task.done()
    #expect(task.finished)
    #expect(task.status == 200)
    #expect(task.header("Content-Type") == "text/html; charset=utf-8")
    #expect(task.header("Content-Length") == "15")
    #expect(task.header("Cache-Control") == "no-cache")
    #expect(String(data: task.body, encoding: .utf8) == "<!doctype html>")
  }

  @Test
  func webAssemblyIsServedAsWebAssembly() async throws {
    let task = RecordingSchemeTask(WebApp.url(path: "/v1/trace_processor.wasm"))
    handler.start(task)
    try await task.done()
    #expect(task.header("Content-Type") == "application/wasm")
    #expect(task.body.count == 100)
  }

  @Test
  func aRecordingIsStreamedInChunksAndNotCached() async throws {
    let url = WebApp.url(path: "/_traces/\(traceID.uuidString)/big.pftrace")
    let task = RecordingSchemeTask(url)
    handler.start(task)
    try await task.done()
    let expected = try Data(contentsOf: root.url.appendingPathComponent("traces/\(traceID.uuidString)/big.pftrace"))
    #expect(task.finished)
    #expect(task.header("Content-Length") == String(expected.count))
    #expect(task.header("Cache-Control") == "no-store")
    #expect(task.chunks == 4)
    #expect(task.body == expected)
  }

  @Test
  func headAnswersWithoutABody() async throws {
    let task = RecordingSchemeTask(WebApp.home, method: "HEAD")
    handler.start(task)
    try await task.done()
    #expect(task.status == 200)
    #expect(task.header("Content-Length") == "15")
    #expect(task.body.isEmpty)
  }

  @Test
  func unknownPathsAre404() async throws {
    for path in ["/missing.js", "/v1", "/_traces/\(UUID().uuidString)/big.pftrace"] {
      let task = RecordingSchemeTask(WebApp.url(path: path))
      handler.start(task)
      try await task.done()
      #expect(task.status == 404, "\(path)")
      #expect(task.finished)
    }
  }

  @Test
  func otherOriginsAre404() async throws {
    let task = RecordingSchemeTask(URL(string: "agentprof://elsewhere/index.html")!)
    handler.start(task)
    try await task.done()
    #expect(task.status == 404)
  }

  @Test
  func onlyReadsAreAllowed() async throws {
    let task = RecordingSchemeTask(WebApp.home, method: "POST")
    handler.start(task)
    try await task.done()
    #expect(task.status == 405)
  }

  @Test
  func aStoppedTaskIsNotAnsweredAgain() async throws {
    let url = WebApp.url(path: "/_traces/\(traceID.uuidString)/big.pftrace")
    let task = RecordingSchemeTask(url)
    handler.start(task)
    handler.stop(task)
    try await Task.sleep(for: .milliseconds(200))
    #expect(task.response == nil)
    #expect(task.body.isEmpty)
    #expect(!task.isDone)
  }
}
