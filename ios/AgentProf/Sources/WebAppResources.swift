// SPDX-License-Identifier: Apache-2.0

import Foundation

/// The folders `WebAppSchemeHandler` answers from.
public struct WebAppResources: Sendable {
  /// The UI build: `AgentProfWeb` in the app bundle.
  public var webUI: URL?
  /// The diagnostics page: `Diagnostics` in the app bundle.
  public var diagnostics: URL?
  /// Imported recordings, one folder per recording (`TraceInbox`).
  public var traces: URL

  public init(webUI: URL?, diagnostics: URL?, traces: URL) {
    self.webUI = webUI
    self.diagnostics = diagnostics
    self.traces = traces
  }

  /// The folders as the app ships them in `bundle`, with recordings in `traces`.
  public static func bundled(in bundle: Bundle = .main, traces: URL = TraceInbox.defaultDirectory) -> WebAppResources {
    WebAppResources(
      webUI: bundle.url(forResource: "AgentProfWeb", withExtension: nil),
      diagnostics: bundle.url(forResource: "Diagnostics", withExtension: nil),
      traces: traces
    )
  }

  /// The regular file `route` names, if it exists inside its folder.
  public func file(for route: WebAppRoute) -> URL? {
    switch route {
    case .webUI(let path):
      return Self.file(path, in: webUI)
    case .diagnostics(let path):
      return Self.file(path, in: diagnostics)
    case .trace(let id, let name):
      return Self.file(name, in: traces.appendingPathComponent(id.uuidString, isDirectory: true))
    case .notFound:
      return nil
    }
  }

  /// `relativePath` below `root`, if it is a regular file that stays inside `root` once symbolic
  /// links are resolved.
  static func file(_ relativePath: String, in root: URL?) -> URL? {
    guard let root else { return nil }
    let base = root.standardizedFileURL.resolvingSymlinksInPath()
    let candidate = base.appendingPathComponent(relativePath, isDirectory: false).standardizedFileURL.resolvingSymlinksInPath()
    guard candidate.path.hasPrefix(base.path + "/") else { return nil }
    guard (try? candidate.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { return nil }
    return candidate
  }
}
