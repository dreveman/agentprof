// SPDX-License-Identifier: Apache-2.0

import Foundation

/// The origin the bundled AgentProf UI is served from: `agentprof://app/…`.
///
/// Everything the web view loads lives below this origin and is answered by `WebAppSchemeHandler`
/// from the app's own files: the bundled UI build, the diagnostics page, and recordings imported by
/// the user.
public enum WebApp {
  public static let scheme = "agentprof"
  public static let host = "app"

  /// What `location.origin` reads in the page.
  public static let origin = "\(scheme)://\(host)"

  /// The UI's entry point.
  public static let home = url(path: "/index.html")

  /// The app's web platform self-check (`Resources/Diagnostics`).
  public static let diagnostics = url(path: "/\(WebAppRoute.diagnosticsPrefix)/index.html")

  /// A URL on the app's origin. `path` starts with "/" and is not percent-encoded.
  public static func url(path: String, query: [URLQueryItem]? = nil, fragment: String? = nil) -> URL {
    var components = URLComponents()
    components.scheme = scheme
    components.host = host
    components.path = path
    components.queryItems = query
    components.fragment = fragment
    guard let url = components.url else { preconditionFailure("Not a valid app path: \(path)") }
    return url
  }

  /// Whether `url` is on the app's origin.
  public static func isAppURL(_ url: URL) -> Bool {
    url.scheme?.lowercased() == scheme && url.host?.lowercased() == host && url.port == nil && url.user == nil
  }
}
