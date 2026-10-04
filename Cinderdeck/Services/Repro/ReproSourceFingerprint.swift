import CryptoKit
import Darwin
import Foundation

nonisolated struct ReproSourceFingerprintSnapshot: Codable, Equatable, Sendable {
  let schemaVersion: Int
  let hash: String?
  let state: String
  let trackedCount: Int
  let untrackedCount: Int
  let omittedCount: Int
  let detail: String?
}

/// Only paths enumerated by git are inputs. This never traverses ignored files.
nonisolated enum ReproSourceFingerprint {
  struct Limits: Sendable {
    var files = 512
    var bytesPerFile = 1_048_576
    var totalBytes = 8_388_608
  }
  private static let sourceExtensions: Set<String> = ["swift", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "rs", "go", "java", "kt", "kts", "c", "h", "cc", "cpp", "hpp", "cs", "fs", "vue", "svelte", "html", "css", "scss", "sass", "less", "json", "jsonl", "yaml", "yml", "toml", "xml", "sql", "graphql", "gql", "proto", "md", "mdx", "txt", "csv", "tsv", "sh", "bash", "zsh", "fish", "lock", "snap", "test", "fixture", "svg", "png", "jpg", "jpeg", "webp", "gif", "wasm"]
  static func relevantUntracked(_ path: String) -> Bool {
    let components = path.lowercased().split(separator: "/")
    let name = components.last.map(String.init) ?? ""
    // Hashing is not an invitation to inspect credentials, even when not ignored.
    if components.contains(where: { $0 == ".git" || $0 == ".aws" || $0 == ".ssh" || $0 == ".secrets" }) { return false }
    if name == ".env" || name.hasPrefix(".env.") || name == ".npmrc" || name == ".pypirc" || name.contains("credential") || name.contains("secret") || name.contains("private-key") { return false }
    if ["pem", "key", "p12", "pfx", "keystore"].contains(URL(fileURLWithPath: name).pathExtension) { return false }
    if components.contains(where: { ["fixtures", "__fixtures__", "testdata", "test-data"].contains(String($0)) }), ["bin", "dat", "pb"].contains(URL(fileURLWithPath: name).pathExtension) { return true }
    return ["dockerfile", "makefile", "gemfile", "rakefile", "procfile", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"].contains(name) || sourceExtensions.contains(URL(fileURLWithPath: name).pathExtension)
  }
  static func paths(_ value: String) -> [String]? {
    guard value.isEmpty || value.hasSuffix("\0") else { return nil }
    return value.split(separator: "\0").map(String.init)
  }
  static func statusPaths(_ value: String) -> [String]? {
    guard let records = paths(value) else { return nil }
    var result: [String] = [], index = 0
    while index < records.count {
      let record = records[index]
      guard record.count > 3, record.dropFirst(2).first == " " else { return nil }
      result.append(String(record.dropFirst(3)))
      if record.prefix(2).contains("R") || record.prefix(2).contains("C") {
        index += 1; guard index < records.count else { return nil }
        result.append(records[index])
      }
      index += 1
    }
    return result.sorted()
  }
  static func capture(root: URL, tracked: [String], untracked: [String], listingsComplete: Bool = true, indexFingerprint: String? = nil, limits: Limits = Limits()) -> ReproSourceFingerprintSnapshot {
    let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath()
    let rootFD = open(canonicalRoot.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard rootFD >= 0 else { return ReproSourceFingerprintSnapshot(schemaVersion: 1, hash: nil, state: "unknown", trackedCount: 0, untrackedCount: 0, omittedCount: tracked.count + untracked.count, detail: "Repository root could not be opened safely.") }
    defer { close(rootFD) }
    var hash = SHA256(), trackedCount = 0, untrackedCount = 0, omitted = 0, total = 0
    var unknown = !listingsComplete, truncated = false
    hash.update(data: Data("deckhand-source-fingerprint-v1\0".utf8))
    if let indexFingerprint { hash.update(data: Data(("index\0" + indexFingerprint + "\0").utf8)) }
    let trackedSet = Set(tracked)
    let inputs = trackedSet.union(untracked).sorted()
    func safeDescriptor(_ path: String) -> (fd: Int32, missing: Bool) {
      let parts = path.split(separator: "/", omittingEmptySubsequences: false)
      guard !parts.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\0") }), path.utf8.count <= 4096 else { return (-1, false) }
      var parent = dup(rootFD)
      guard parent >= 0 else { return (-1, false) }
      defer { close(parent) }
      for part in parts.dropLast() {
        let next = openat(parent, String(part), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard next >= 0 else { return (-1, errno == ENOENT) }
        close(parent); parent = next
      }
      let fd = openat(parent, String(parts.last!), O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
      return (fd, fd < 0 && errno == ENOENT)
    }
    for path in inputs {
      let isTracked = trackedSet.contains(path)
      if !isTracked, !relevantUntracked(path) { omitted += 1; unknown = true; continue }
      if trackedCount + untrackedCount >= limits.files { omitted += 1; truncated = true; continue }
      let opened = safeDescriptor(path)
      if opened.fd < 0 {
        if opened.missing, isTracked {
          hash.update(data: Data("tracked\0".utf8)); hash.update(data: Data(path.utf8)); hash.update(data: Data("\0deleted\0".utf8)); trackedCount += 1
        } else { omitted += 1; unknown = true }
        continue
      }
      let fd = opened.fd
      defer { close(fd) }
      var before = stat(), after = stat()
      guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size >= 0 else { omitted += 1; unknown = true; continue }
      guard before.st_size <= limits.bytesPerFile, before.st_size <= limits.totalBytes - total else { omitted += 1; truncated = true; continue }
      var fileHash = SHA256(), readBytes = 0, buffer = [UInt8](repeating: 0, count: 65536), readFailed = false
      while readBytes <= Int(before.st_size) {
        let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, min($0.count, Int(before.st_size) - readBytes + 1)) }
        if count < 0 { if errno == EINTR { continue }; readFailed = true; break }
        if count == 0 { break }
        fileHash.update(data: Data(buffer.prefix(count))); readBytes += count
      }
      guard !readFailed, readBytes == Int(before.st_size), fstat(fd, &after) == 0,
        before.st_dev == after.st_dev, before.st_ino == after.st_ino, before.st_size == after.st_size, before.st_mode == after.st_mode,
        before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
        before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else { omitted += 1; unknown = true; continue }
      let digest = fileHash.finalize().map { String(format: "%02x", $0) }.joined()
      let record = (isTracked ? "tracked" : "untracked") + "\0" + path + "\0" + String(before.st_mode & 0o777) + "\0" + String(readBytes) + "\0" + digest + "\0"
      hash.update(data: Data(record.utf8)); total += readBytes
      if isTracked { trackedCount += 1 } else { untrackedCount += 1 }
    }
    let state = unknown ? "unknown" : truncated ? "truncated" : "complete"
    return ReproSourceFingerprintSnapshot(schemaVersion: 1, hash: hash.finalize().map { String(format: "%02x", $0) }.joined(), state: state, trackedCount: trackedCount, untrackedCount: untrackedCount, omittedCount: omitted,
      detail: unknown ? "Some source inputs were unavailable, protected, unsupported, or changed during hashing." : truncated ? "Source fingerprint exceeded bounded file or byte limits." : nil)
  }
}

// Shared projection for RPC and immutable import/export manifests.
extension ReproSourceFingerprintSnapshot {
  var value: JSONValue { .object([
    "schemaVersion": .number(Double(schemaVersion)), "hash": hash.map(JSONValue.string) ?? .null,
    "state": .string(state), "trackedCount": .number(Double(trackedCount)), "untrackedCount": .number(Double(untrackedCount)),
    "omittedCount": .number(Double(omittedCount)), "detail": detail.map(JSONValue.string) ?? .null,
  ]) }
}
