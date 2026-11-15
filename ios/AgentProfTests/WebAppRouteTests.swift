// SPDX-License-Identifier: Apache-2.0

@testable import AgentProf
import Foundation
import Testing

@Suite
struct WebAppRouteTests {
  private static func route(_ string: String) -> WebAppRoute {
    WebAppRoute(URL(string: string)!)
  }

  @Test
  func theRootAndIndexAreTheUIsEntryPoint() {
    #expect(Self.route("agentprof://app") == .webUI("index.html"))
    #expect(Self.route("agentprof://app/") == .webUI("index.html"))
    #expect(Self.route("agentprof://app/index.html") == .webUI("index.html"))
    #expect(Self.route("agentprof://app/index.html#!/viewer?local_cache_key=1") == .webUI("index.html"))
    #expect(WebAppRoute(WebApp.home) == .webUI("index.html"))
  }

  @Test
  func uiAssetsKeepTheirPath() {
    #expect(Self.route("agentprof://app/v59.1-0123abcde/frontend_bundle.js") == .webUI("v59.1-0123abcde/frontend_bundle.js"))
    #expect(Self.route("agentprof://app/v1/assets/My%20Font.woff2?x=1") == .webUI("v1/assets/My Font.woff2"))
  }

  @Test
  func diagnosticsDefaultsToItsIndex() {
    #expect(WebAppRoute(WebApp.diagnostics) == .diagnostics("index.html"))
    #expect(Self.route("agentprof://app/_diagnostics/") == .diagnostics("index.html"))
    #expect(Self.route("agentprof://app/_diagnostics/add.wasm") == .diagnostics("add.wasm"))
  }

  @Test
  func aRecordingIsAnIDAndAName() throws {
    let id = UUID()
    #expect(Self.route("agentprof://app/_traces/\(id.uuidString)/session%200.pftrace") == .trace(id: id, name: "session 0.pftrace"))
    #expect(Self.route("agentprof://app/_traces/not-a-uuid/a.pftrace") == .notFound)
    #expect(Self.route("agentprof://app/_traces/\(id.uuidString)") == .notFound)
    #expect(Self.route("agentprof://app/_traces/\(id.uuidString)/a/b") == .notFound)
    #expect(Self.route("agentprof://app/_traces/\(id.uuidString)/a").isTrace)
    #expect(!Self.route("agentprof://app/index.html").isTrace)
  }

  @Test(arguments: [
    "agentprof://app/../secret",
    "agentprof://app/v1/../../secret",
    "agentprof://app/%2e%2e/secret",
    "agentprof://app/v1/%2E%2E/%2E%2E/secret",
    "agentprof://app/a%2Fb",
    "agentprof://app/a%5Cb",
    "agentprof://app/.hidden",
    "agentprof://app/a//b",
    "agentprof://app/a%00b",
    "agentprof://app/_traces/00000000-0000-0000-0000-000000000000/..",
  ])
  func pathsThatCouldLeaveTheirFolderAreNotFound(_ url: String) {
    #expect(Self.route(url) == .notFound)
  }

  @Test(arguments: [
    "https://app/index.html",
    "agentprof://other/index.html",
    "agentprof://app:8080/index.html",
    "agentprof://user@app/index.html",
    "file:///index.html",
  ])
  func otherOriginsAreNotFound(_ url: String) {
    #expect(Self.route(url) == .notFound)
  }
}
