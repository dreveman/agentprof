// SPDX-License-Identifier: Apache-2.0

@testable import AgentProf
import Foundation
import Testing

@Suite
struct WebAppResourcesTests {
  @Test
  func eachRouteReadsFromItsOwnFolder() throws {
    let root = try TemporaryDirectory()
    try root.file("web/index.html", text: "ui")
    try root.file("web/v1/frontend_bundle.js", text: "js")
    try root.file("diagnostics/index.html", text: "probe")
    let id = UUID()
    try root.file("traces/\(id.uuidString)/session.pftrace", count: 10)
    let resources = WebAppResources(
      webUI: root.url.appendingPathComponent("web"),
      diagnostics: root.url.appendingPathComponent("diagnostics"),
      traces: root.url.appendingPathComponent("traces")
    )
    #expect(resources.file(for: .webUI("index.html"))?.lastPathComponent == "index.html")
    #expect(resources.file(for: .webUI("v1/frontend_bundle.js")) != nil)
    #expect(resources.file(for: .diagnostics("index.html")) != nil)
    #expect(resources.file(for: .trace(id: id, name: "session.pftrace")) != nil)
    #expect(resources.file(for: .trace(id: UUID(), name: "session.pftrace")) == nil)
    #expect(resources.file(for: .notFound) == nil)
  }

  @Test
  func folderAndMissingFilesAreNotFound() throws {
    let root = try TemporaryDirectory()
    try root.file("web/v1/frontend_bundle.js", text: "js")
    let resources = WebAppResources(webUI: root.url.appendingPathComponent("web"), diagnostics: nil, traces: root.url)
    #expect(resources.file(for: .webUI("v1")) == nil)
    #expect(resources.file(for: .webUI("v1/missing.js")) == nil)
    #expect(resources.file(for: .diagnostics("index.html")) == nil)
  }

  @Test
  func aLinkOutOfTheFolderIsNotFollowed() throws {
    let root = try TemporaryDirectory()
    let secret = try root.file("secret.txt", text: "secret")
    let web = try root.directory("web")
    try FileManager.default.createSymbolicLink(at: web.appendingPathComponent("link.txt"), withDestinationURL: secret)
    try FileManager.default.createSymbolicLink(at: web.appendingPathComponent("up"), withDestinationURL: root.url)
    let resources = WebAppResources(webUI: web, diagnostics: nil, traces: root.url)
    #expect(resources.file(for: .webUI("link.txt")) == nil)
    #expect(resources.file(for: .webUI("up/secret.txt")) == nil)
  }
}
