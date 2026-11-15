// SPDX-License-Identifier: Apache-2.0

import Foundation

/// A recording the user opened, copied into the app so the UI can read it at `webURL`.
public struct ImportedTrace: Equatable, Sendable {
  public let id: UUID
  /// The file name shown to the user, also the last path component of `webURL`.
  public let name: String
  public let file: URL
  public let byteCount: Int64

  /// Where the UI reads it: `agentprof://app/_traces/<id>/<name>`.
  public var webURL: URL {
    WebApp.url(path: "/\(WebAppRoute.tracesPrefix)/\(id.uuidString)/\(name)")
  }
}

/// Summary of a cached recording exposed to the UI's Home page (`window.agentprofHost.recentTraces`).
public struct RecentTrace: Equatable, Sendable {
  public let id: UUID
  public let name: String
  public let byteCount: Int64
  public let importedAt: Date

  var hostPayload: [String: Any] {
    [
      "id": id.uuidString,
      "title": name,
      "sizeBytes": byteCount,
      "updatedAt": Int64((importedAt.timeIntervalSince1970 * 1000).rounded()),
    ]
  }
}

/// Copies recordings opened from Files, the Share Sheet, AirDrop, or another app into the app's
/// caches directory, where `WebAppSchemeHandler` streams them to the UI. Recordings never leave the
/// device.
public struct TraceInbox: Sendable {
  /// `Library/Caches/Traces`: the system may purge it when storage runs low.
  public static var defaultDirectory: URL {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Traces", isDirectory: true)
  }

  public let directory: URL

  public init(directory: URL = TraceInbox.defaultDirectory) {
    self.directory = directory
  }

  /// Copies the file at `url` into the inbox. `url` may be security-scoped and may name an iCloud
  /// file that has not been downloaded yet; `NSFileCoordinator` fetches it before copying.
  public func importFile(at url: URL) async throws -> ImportedTrace {
    let target = directory
    return try await Task.detached {
      try Self.copy(url, into: target)
    }.value
  }

  /// Lists cached recordings in reverse chronological order.
  public func listTraces() async -> [RecentTrace] {
    let target = directory
    return await Task.detached {
      Self.list(in: target)
    }.value
  }

  /// Looks up a previously imported recording by its identifier, if still on disk.
  public func trace(id: UUID) async -> ImportedTrace? {
    let target = directory
    return await Task.detached {
      Self.lookup(id: id, in: target)
    }.value
  }

  /// Deletes a single cached recording.
  public func removeTrace(id: UUID) async {
    let folder = directory.appendingPathComponent(id.uuidString, isDirectory: true)
    await Task.detached {
      try? FileManager.default.removeItem(at: folder)
    }.value
  }

  /// Deletes recordings imported more than `age` seconds before `now`.
  public func removeTraces(olderThan age: TimeInterval, now: Date = Date()) async {
    let target = directory
    await Task.detached {
      let manager = FileManager.default
      let keys: [URLResourceKey] = [.creationDateKey, .isDirectoryKey]
      guard let folders = try? manager.contentsOfDirectory(at: target, includingPropertiesForKeys: keys) else { return }
      for folder in folders {
        guard let values = try? folder.resourceValues(forKeys: Set(keys)), values.isDirectory == true,
          let created = values.creationDate, now.timeIntervalSince(created) > age
        else { continue }
        try? manager.removeItem(at: folder)
      }
    }.value
  }
}

// MARK: - File operations

extension TraceInbox {
  static func copy(_ source: URL, into directory: URL) throws -> ImportedTrace {
    let scoped = source.startAccessingSecurityScopedResource()
    defer {
      if scoped { source.stopAccessingSecurityScopedResource() }
    }
    let id = UUID()
    let name = sanitizedName(source.lastPathComponent)
    let folder = directory.appendingPathComponent(id.uuidString, isDirectory: true)
    let destination = folder.appendingPathComponent(name, isDirectory: false)
    let manager = FileManager.default
    try manager.createDirectory(at: folder, withIntermediateDirectories: true)
    do {
      try coordinatedCopy(from: source, to: destination)
    } catch {
      try? manager.removeItem(at: folder)
      throw error
    }
    let size = (try? destination.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
    return ImportedTrace(id: id, name: name, file: destination, byteCount: Int64(size))
  }

  private static func list(in directory: URL) -> [RecentTrace] {
    let manager = FileManager.default
    let folderKeys: [URLResourceKey] = [.creationDateKey, .isDirectoryKey]
    let fileKeys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .creationDateKey]
    guard let folders = try? manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: folderKeys) else {
      return []
    }
    var items: [RecentTrace] = []
    for folder in folders {
      guard let id = UUID(uuidString: folder.lastPathComponent),
        let folderValues = try? folder.resourceValues(forKeys: Set(folderKeys)),
        folderValues.isDirectory == true,
        let files = try? manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: fileKeys),
        let file = files.first(where: { (try? $0.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true })
      else { continue }
      let fileValues = try? file.resourceValues(forKeys: Set(fileKeys))
      let importedAt = fileValues?.creationDate ?? folderValues.creationDate ?? .distantPast
      let size = Int64(fileValues?.fileSize ?? 0)
      items.append(RecentTrace(id: id, name: file.lastPathComponent, byteCount: size, importedAt: importedAt))
    }
    return items.sorted { lhs, rhs in
      if lhs.importedAt != rhs.importedAt { return lhs.importedAt > rhs.importedAt }
      return lhs.id.uuidString < rhs.id.uuidString
    }
  }

  private static func lookup(id: UUID, in directory: URL) -> ImportedTrace? {
    let folder = directory.appendingPathComponent(id.uuidString, isDirectory: true)
    let fileKeys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
    guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: fileKeys),
      let candidate = files.first(where: { (try? $0.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true }),
      let verified = WebAppResources.file(candidate.lastPathComponent, in: folder)
    else { return nil }
    let size = (try? verified.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
    return ImportedTrace(id: id, name: verified.lastPathComponent, file: verified, byteCount: Int64(size))
  }

  /// Copies `source` under file coordination (APFS clones it when on the same volume).
  private static func coordinatedCopy(from source: URL, to destination: URL) throws {
    var coordinationError: NSError?
    var copyError: (any Error)?
    NSFileCoordinator().coordinate(readingItemAt: source, options: .withoutChanges, error: &coordinationError) { readable in
      do {
        try FileManager.default.copyItem(at: readable, to: destination)
      } catch {
        copyError = error
      }
    }
    if let error = coordinationError ?? copyError {
      throw error
    }
  }

  /// A file name safe to use as a path segment and to display: no separators, URL delimiters,
  /// control characters, or leading dots, and at most 128 characters (keeping the extension).
  static func sanitizedName(_ name: String) -> String {
    let disallowed = CharacterSet(charactersIn: "/\\:?#%\"<>|*").union(.controlCharacters).union(.newlines)
    var cleaned = String(String.UnicodeScalarView(name.unicodeScalars.filter { !disallowed.contains($0) }))
      .trimmingCharacters(in: .whitespaces)
    while cleaned.hasPrefix(".") { cleaned.removeFirst() }
    let limit = 128
    if cleaned.count > limit {
      let ext = (cleaned as NSString).pathExtension
      let keep = ext.isEmpty || ext.count >= limit / 2 ? "" : "." + ext
      cleaned = String(cleaned.prefix(limit - keep.count)) + keep
    }
    return cleaned.isEmpty ? "recording" : cleaned
  }
}
