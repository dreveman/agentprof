// SPDX-License-Identifier: Apache-2.0

import Foundation
import Network
import Synchronization
import UIKit
import WebKit

/// Temporary directory removed automatically on `deinit`.
final class TemporaryDirectory {
  let url: URL

  init() throws {
    url = FileManager.default.temporaryDirectory.appendingPathComponent("AgentProfTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  }

  deinit {
    try? FileManager.default.removeItem(at: url)
  }

  @discardableResult
  func file(_ name: String, count: Int) throws -> URL {
    let bytes = (0..<count).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ 7) }
    return try file(name, contents: Data(bytes))
  }

  @discardableResult
  func file(_ name: String, contents: Data) throws -> URL {
    let file = url.appendingPathComponent(name, isDirectory: false)
    try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try contents.write(to: file)
    return file
  }

  @discardableResult
  func file(_ name: String, text: String) throws -> URL {
    try file(name, contents: Data(text.utf8))
  }

  func directory(_ name: String) throws -> URL {
    let directory = url.appendingPathComponent(name, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }
}

/// Thread-safe `WKURLSchemeTask` recorder for unit testing `WebAppSchemeHandler`.
final class RecordingSchemeTask: NSObject, WKURLSchemeTask, Sendable {
  private struct Record: Sendable {
    var response: URLResponse?
    var body = Data()
    var chunks = 0
    var finished = false
    var error: (any Error)?
  }

  let request: URLRequest
  private let record = Mutex(Record())

  init(_ url: URL, method: String = "GET") {
    var request = URLRequest(url: url)
    request.httpMethod = method
    self.request = request
  }

  var response: URLResponse? { record.withLock { $0.response } }
  var body: Data { record.withLock { $0.body } }
  var chunks: Int { record.withLock { $0.chunks } }
  var finished: Bool { record.withLock { $0.finished } }
  var isDone: Bool { record.withLock { $0.finished || $0.error != nil } }

  var status: Int? { (response as? HTTPURLResponse)?.statusCode }

  func header(_ name: String) -> String? {
    (response as? HTTPURLResponse)?.value(forHTTPHeaderField: name)
  }

  func didReceive(_ response: URLResponse) {
    record.withLock { $0.response = response }
  }

  func didReceive(_ data: Data) {
    record.withLock {
      $0.body.append(data)
      $0.chunks += 1
    }
  }

  func didFinish() {
    record.withLock { $0.finished = true }
  }

  func didFailWithError(_ error: any Error) {
    record.withLock { $0.error = error }
  }

  func done() async throws {
    while !isDone {
      try await Task.sleep(for: .milliseconds(5))
    }
  }
}

/// Loads a page in a `WKWebView` and awaits completion.
@MainActor
final class PageLoader: NSObject, WKNavigationDelegate {
  private var continuation: CheckedContinuation<Void, any Error>?

  func load(_ url: URL, in webView: WKWebView) async throws {
    webView.navigationDelegate = self
    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      webView.load(URLRequest(url: url))
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
    continuation?.resume()
    continuation = nil
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: any Error) {
    continuation?.resume(throwing: error)
    continuation = nil
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation?, withError error: any Error) {
    continuation?.resume(throwing: error)
    continuation = nil
  }
}

struct TimedOut: Error, CustomStringConvertible {
  let description: String
}

extension WKWebView {
  /// Attaches the web view to the active host window so WebKit does not throttle background timers.
  func showInHostWindow() {
    frame = CGRect(x: 0, y: 0, width: 390, height: 844)
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    windows.first?.addSubview(self)
  }

  func run(_ body: String, _ arguments: [String: Any] = [:]) async throws -> String? {
    try await callAsyncJavaScript(body, arguments: arguments, in: nil, contentWorld: .page) as? String
  }

  func value<T: Decodable>(_ type: T.Type, of expression: String, timeout: Duration = .seconds(30)) async throws -> T {
    let deadline = ContinuousClock.now + timeout
    while true {
      let body = "const value = \(expression); return value == null ? null : JSON.stringify(value);"
      if let json = try? await run(body) {
        return try JSONDecoder().decode(T.self, from: Data(json.utf8))
      }
      guard ContinuousClock.now < deadline else { throw TimedOut(description: "\(expression) stayed null") }
      try await Task.sleep(for: .milliseconds(20))
    }
  }
}

/// Ephemeral HTTP server on `127.0.0.1` used to verify that `ProfilerWebViewFactory.offlineRules`
/// blocks all outbound network requests from the page.
final class LoopbackServer: @unchecked Sendable {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "AgentProfTests.LoopbackServer")
  private let paths = Mutex<[String]>([])

  init() throws {
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
    listener = try NWListener(using: parameters)
  }

  deinit {
    listener.cancel()
  }

  var requestedPaths: [String] {
    paths.withLock { $0 }
  }

  func start() async throws -> URL {
    listener.newConnectionHandler = { [weak self] connection in
      self?.serve(connection)
    }
    listener.start(queue: queue)
    let deadline = ContinuousClock.now + .seconds(10)
    while true {
      switch listener.state {
      case .ready:
        if let port = listener.port {
          return URL(string: "http://127.0.0.1:\(port.rawValue)")!
        }
      case .failed(let error):
        throw error
      case .setup, .waiting, .cancelled:
        break
      @unknown default:
        break
      }
      guard ContinuousClock.now < deadline else { throw TimedOut(description: "the loopback server did not start") }
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  private func serve(_ connection: NWConnection) {
    connection.start(queue: queue)
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, _ in
      let request = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
      let path = request.split(separator: " ", maxSplits: 2).dropFirst().first.map(String.init) ?? ""
      self?.paths.withLock { $0.append(path) }
      let response = [
        "HTTP/1.1 200 OK",
        "Content-Type: text/plain",
        "Content-Length: 2",
        "Access-Control-Allow-Origin: *",
        "Connection: close",
        "",
        "ok",
      ].joined(separator: "\r\n")
      connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
    }
  }
}
