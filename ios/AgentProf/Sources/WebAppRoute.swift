// SPDX-License-Identifier: Apache-2.0

import Foundation

/// What a request on the app's origin asks for.
public enum WebAppRoute: Equatable, Sendable {
  /// A file of the bundled UI build, e.g. `index.html` or `v59.1-0123abcde/frontend_bundle.js`.
  case webUI(String)
  /// A file of the diagnostics page.
  case diagnostics(String)
  /// A recording the user opened, imported by `TraceInbox`.
  case trace(id: UUID, name: String)
  /// Anything else, answered with a 404.
  case notFound

  static let diagnosticsPrefix = "_diagnostics"
  static let tracesPrefix = "_traces"

  public init(_ url: URL) {
    guard WebApp.isAppURL(url), let segments = Self.segments(of: url) else {
      self = .notFound
      return
    }
    guard let first = segments.first else {
      self = .webUI("index.html")
      return
    }
    let rest = Array(segments.dropFirst())
    switch first {
    case Self.diagnosticsPrefix:
      self = .diagnostics(rest.isEmpty ? "index.html" : rest.joined(separator: "/"))
    case Self.tracesPrefix:
      if rest.count == 2, let id = UUID(uuidString: rest[0]) {
        self = .trace(id: id, name: rest[1])
      } else {
        self = .notFound
      }
    default:
      self = .webUI(segments.joined(separator: "/"))
    }
  }

  /// Whether the route names a recording rather than a file the app ships.
  public var isTrace: Bool {
    switch self {
    case .trace:
      return true
    case .webUI, .diagnostics, .notFound:
      return false
    }
  }

  /// The decoded path segments, or nil when one could step out of its folder or names a hidden
  /// file. One trailing "/" is ignored.
  static func segments(of url: URL) -> [String]? {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    var encoded = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    if encoded.first == "" { encoded.removeFirst() }
    if encoded.last == "" { encoded.removeLast() }
    var segments: [String] = []
    for part in encoded {
      guard let segment = part.removingPercentEncoding, isSafe(segment) else { return nil }
      segments.append(segment)
    }
    return segments
  }

  /// A segment that names something inside its folder: not empty, not "." or "..", no separators
  /// (an encoded "/" decodes into one), not hidden, and no control characters.
  static func isSafe(_ segment: String) -> Bool {
    !segment.isEmpty && !segment.hasPrefix(".") && !segment.contains("/") && !segment.contains("\\")
      && !segment.unicodeScalars.contains { $0.properties.generalCategory == .control }
  }
}
