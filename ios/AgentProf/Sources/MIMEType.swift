// SPDX-License-Identifier: Apache-2.0

import Foundation

/// The `Content-Type` a file is served with. WebKit needs the right one for some loads:
/// `WebAssembly.compileStreaming` rejects a `.wasm` that isn't `application/wasm`.
enum MIMEType {
  static func of(_ file: URL) -> String {
    byExtension[file.pathExtension.lowercased()] ?? "application/octet-stream"
  }

  static let byExtension: [String: String] = [
    "css": "text/css; charset=utf-8",
    "gif": "image/gif",
    "htm": "text/html; charset=utf-8",
    "html": "text/html; charset=utf-8",
    "ico": "image/x-icon",
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "js": "text/javascript; charset=utf-8",
    "json": "application/json",
    "map": "application/json",
    "md": "text/markdown; charset=utf-8",
    "mjs": "text/javascript; charset=utf-8",
    "otf": "font/otf",
    "png": "image/png",
    "svg": "image/svg+xml",
    "ttf": "font/ttf",
    "txt": "text/plain; charset=utf-8",
    "wasm": "application/wasm",
    "webp": "image/webp",
    "woff": "font/woff",
    "woff2": "font/woff2",
  ]
}
