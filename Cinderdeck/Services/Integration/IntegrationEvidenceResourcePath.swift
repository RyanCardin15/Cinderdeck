import Foundation

/// Canonicalize both sides before deriving a durable resource path. Foundation's
/// enumerator may resolve `/tmp` to `/private/tmp` even when the export URL does not.
nonisolated enum IntegrationEvidenceResourcePath {
  static func relativePath(of resource: URL, in folder: URL) -> String? {
    let root = folder.standardizedFileURL.resolvingSymlinksInPath().path
    let path = resource.standardizedFileURL.resolvingSymlinksInPath().path
    let prefix = root + "/"
    guard path.hasPrefix(prefix) else { return nil }
    let relative = String(path.dropFirst(prefix.count))
    return relative.isEmpty ? nil : relative
  }

  static func resource(for relative: String, in folder: URL) -> URL? {
    guard !relative.isEmpty, !relative.hasPrefix("/"),
      !relative.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return nil }
    let root = folder.standardizedFileURL.resolvingSymlinksInPath()
    let candidate = root.appendingPathComponent(relative).standardizedFileURL
    // Foundation does not resolve every symlink ancestor of a missing final path.
    guard FileManager.default.fileExists(atPath: candidate.path) else { return nil }
    let resource = candidate.resolvingSymlinksInPath()
    guard Self.relativePath(of: resource, in: root) == relative else { return nil }
    return resource
  }
}
