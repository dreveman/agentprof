// SPDX-License-Identifier: Apache-2.0

@testable import AgentProf
import Foundation
import Testing
import WebKit

@Suite
struct NavigationPolicyTests {
  private static func decide(
    _ url: String?,
    mainFrame: Bool? = true,
    type: WKNavigationType = .other,
    download: Bool = false
  ) -> NavigationDecision {
    NavigationPolicy.decide(
      url: url.flatMap { URL(string: $0) },
      targetIsMainFrame: mainFrame,
      navigationType: type,
      shouldPerformDownload: download
    )
  }

  @Test
  func theUIsOwnPagesLoad() {
    #expect(Self.decide("agentprof://app/index.html") == .allow)
    #expect(Self.decide("agentprof://app/index.html#!/viewer", type: .linkActivated) == .allow)
    #expect(Self.decide("agentprof://app/_diagnostics/index.html", mainFrame: false) == .allow)
    #expect(Self.decide("about:blank", mainFrame: false) == .allow)
    #expect(Self.decide("about:srcdoc", mainFrame: false) == .allow)
  }

  @Test
  func otherAppOriginsAndNewWindowsDont() {
    #expect(Self.decide("agentprof://elsewhere/index.html") == .cancel)
    #expect(Self.decide("agentprof://app/index.html", mainFrame: nil) == .cancel)
    #expect(Self.decide("about:blank", mainFrame: nil) == .cancel)
  }

  @Test
  func webPagesTheUIOpensGoToSafari() {
    let docs = URL(string: "https://github.com/dreveman/agentprof")!
    #expect(Self.decide(docs.absoluteString, type: .linkActivated) == .openExternally(docs))
    #expect(Self.decide(docs.absoluteString, mainFrame: nil) == .openExternally(docs))
    #expect(Self.decide(docs.absoluteString, type: .other) == .openExternally(docs))
  }

  @Test
  func framesCantReachTheWeb() {
    #expect(Self.decide("https://example.com/embed", mainFrame: false) == .cancel)
    #expect(Self.decide("https://example.com", type: .formSubmitted) == .cancel)
    #expect(Self.decide("https://example.com", type: .reload) == .cancel)
  }

  @Test
  func noOtherSchemeLeavesTheApp() {
    for url in ["myapp://profile", "mailto:user@example.com", "tel:123", "file:///etc/hosts", "javascript:alert(1)", "itms-apps://x"] {
      #expect(Self.decide(url, type: .linkActivated) == .cancel, "\(url)")
      #expect(Self.decide(url, mainFrame: nil) == .cancel, "\(url)")
    }
    #expect(Self.decide(nil) == .cancel)
  }

  @Test
  func blobAndDataLoadOnlyInFrames() {
    #expect(Self.decide("blob:agentprof://app/1234", mainFrame: false) == .allow)
    #expect(Self.decide("data:text/html,hi", mainFrame: false) == .allow)
    #expect(Self.decide("blob:agentprof://app/1234") == .cancel)
    #expect(Self.decide("data:text/html,hi") == .cancel)
  }

  @Test
  func whatTheUIMakesIsDownloaded() {
    #expect(Self.decide("blob:agentprof://app/1234", download: true) == .download)
    #expect(Self.decide("data:application/octet-stream;base64,AA==", download: true) == .download)
    #expect(Self.decide("agentprof://app/_traces/x/y", type: .linkActivated, download: true) == .download)
  }

  @Test
  func nothingDownloadsFromTheNetworkOrAnotherOrigin() {
    let file = URL(string: "https://example.com/trace.pftrace")!
    #expect(Self.decide(file.absoluteString, type: .linkActivated, download: true) == .openExternally(file))
    #expect(Self.decide(file.absoluteString, mainFrame: false, download: true) == .cancel)
    #expect(Self.decide("agentprof://elsewhere/trace.pftrace", download: true) == .cancel)
    #expect(Self.decide("myapp://profile", download: true) == .cancel)
  }
}
