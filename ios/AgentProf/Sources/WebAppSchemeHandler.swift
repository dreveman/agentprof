// SPDX-License-Identifier: Apache-2.0

import Foundation
import WebKit

/// Answers every request on `agentprof://app/…` from the app's own files (`WebAppResources`):
/// the bundled UI build, the diagnostics page, and imported recordings.
///
/// Files are read off the main thread and handed to WebKit in chunks, so multi-gigabyte recordings
/// are never held in the app's memory at once.
@MainActor
public final class WebAppSchemeHandler: NSObject, WKURLSchemeHandler {
  /// Bytes handed to WebKit at a time (1 MiB).
  static let chunkSize = 1 << 20

  private let resources: WebAppResources
  /// Tasks WebKit still waits on. WebKit raises an exception if a stopped task is answered again.
  private var live: Set<ObjectIdentifier> = []

  public init(resources: WebAppResources) {
    self.resources = resources
  }

  public func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
    start(urlSchemeTask)
  }

  public func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
    stop(urlSchemeTask)
  }
}

// MARK: - Answering

extension WebAppSchemeHandler {
  func start(_ task: any WKURLSchemeTask) {
    let id = ObjectIdentifier(task)
    live.insert(id)
    guard let url = task.request.url else {
      fail(task, id: id, error: URLError(.badURL))
      return
    }
    let method = (task.request.httpMethod ?? "GET").uppercased()
    guard method == "GET" || method == "HEAD" else {
      respond(task, id: id, url: url, status: 405, body: "Method not allowed")
      return
    }
    let route = WebAppRoute(url)
    guard let file = resources.file(for: route) else {
      respond(task, id: id, url: url, status: 404, body: "Not found")
      return
    }
    let head = ResponseHead(
      url: url,
      contentType: MIMEType.of(file),
      cacheControl: route.isTrace ? "no-store" : "no-cache"
    )
    Task {
      await stream(file, to: task, id: id, head: head, includeBody: method == "GET")
    }
  }

  func stop(_ task: any WKURLSchemeTask) {
    live.remove(ObjectIdentifier(task))
  }

  private func stream(_ file: URL, to task: any WKURLSchemeTask, id: ObjectIdentifier, head: ResponseHead, includeBody: Bool) async {
    let reader: FileReader
    do {
      reader = try await FileReader.open(file)
    } catch {
      fail(task, id: id, error: error)
      return
    }
    defer { Task { await reader.close() } }
    guard live.contains(id) else { return }
    task.didReceive(head.response(status: 200, contentLength: reader.size))
    guard includeBody else {
      finish(task, id: id)
      return
    }
    do {
      while let chunk = try await reader.read(upTo: Self.chunkSize) {
        guard live.contains(id) else { return }
        task.didReceive(chunk)
      }
    } catch {
      fail(task, id: id, error: error)
      return
    }
    finish(task, id: id)
  }

  private func respond(_ task: any WKURLSchemeTask, id: ObjectIdentifier, url: URL, status: Int, body: String) {
    guard live.contains(id) else { return }
    let data = Data(body.utf8)
    let head = ResponseHead(url: url, contentType: "text/plain; charset=utf-8", cacheControl: "no-store")
    task.didReceive(head.response(status: status, contentLength: Int64(data.count)))
    task.didReceive(data)
    finish(task, id: id)
  }

  private func finish(_ task: any WKURLSchemeTask, id: ObjectIdentifier) {
    guard live.remove(id) != nil else { return }
    task.didFinish()
  }

  private func fail(_ task: any WKURLSchemeTask, id: ObjectIdentifier, error: any Error) {
    guard live.remove(id) != nil else { return }
    task.didFailWithError(error)
  }
}

// MARK: - ResponseHead

struct ResponseHead: Sendable {
  let url: URL
  let contentType: String
  let cacheControl: String

  func response(status: Int, contentLength: Int64) -> URLResponse {
    let headers = [
      "Cache-Control": cacheControl,
      "Content-Length": String(contentLength),
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
    ]
    return HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
      ?? URLResponse(url: url, mimeType: contentType, expectedContentLength: Int(contentLength), textEncodingName: nil)
  }
}

// MARK: - FileReader

/// Reads a file in chunks off the main thread.
actor FileReader {
  nonisolated let size: Int64
  private let handle: FileHandle

  private init(handle: FileHandle, size: Int64) {
    self.handle = handle
    self.size = size
  }

  static func open(_ url: URL) async throws -> FileReader {
    try await Task.detached {
      let handle = try FileHandle(forReadingFrom: url)
      let size = try handle.seekToEnd()
      try handle.seek(toOffset: 0)
      return FileReader(handle: handle, size: Int64(size))
    }.value
  }

  func read(upTo count: Int) throws -> Data? {
    guard let data = try handle.read(upToCount: count), !data.isEmpty else { return nil }
    return data
  }

  func close() {
    try? handle.close()
  }
}
