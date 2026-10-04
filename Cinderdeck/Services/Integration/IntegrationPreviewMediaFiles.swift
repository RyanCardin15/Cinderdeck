import CryptoKit
import Darwin
import Foundation

nonisolated struct IntegrationPreviewMediaIdentity: Codable, Equatable, Sendable {
  let sourceSHA256: String
  let sourceSize: Int
  let videoSHA256: String
  let videoSize: Int
}

/// One native-derived direct child of the private import directory, streamed within its byte budget.
nonisolated enum IntegrationPreviewMediaFiles {
  static let maximumBytes = 268_435_456
  static func integrity(_ url: URL?, root: URL, expected: IntegrationPreviewMediaIdentity?) -> String {
    guard let url, let expected, let current = try? identity(url, root: root) else { return "unknown" }
    return current.sha256 == expected.videoSHA256 && current.size == expected.videoSize ? "matched" : "changed"
  }
  static func identity(_ url: URL, root: URL) throws -> (sha256: String, size: Int) {
    let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath()
    guard url.deletingLastPathComponent().standardizedFileURL.resolvingSymlinksInPath() == canonicalRoot,
      WorkspaceBuildArtifactFiles.validRelative(url.lastPathComponent) else {
      throw StackControlError.invalid("Preview bytes must belong to the private import directory")
    }
    let parent = open(canonicalRoot.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard parent >= 0 else { throw StackControlError.invalid("Preview directory is unavailable") }
    defer { close(parent) }
    let fd = openat(parent, url.lastPathComponent, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw StackControlError.invalid("Preview source is unavailable or symlinked") }
    defer { close(fd) }
    var before = stat(), after = stat(), named = stat()
    guard fstat(fd, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1,
      before.st_uid == getuid(), before.st_size > 0, before.st_size <= maximumBytes else {
      throw StackControlError.invalid("Preview bytes must be an owned regular file with one link and at most 256 MiB")
    }
    var hash = SHA256(), size = 0, buffer = [UInt8](repeating: 0, count: 262_144)
    while true {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if count == 0 { break }
      guard count > 0, size + count <= maximumBytes else {
        throw StackControlError.invalid("Preview source changed or exceeded its byte bound")
      }
      hash.update(data: Data(buffer.prefix(count))); size += count
    }
    guard fstat(fd, &after) == 0, before.st_dev == after.st_dev, before.st_ino == after.st_ino,
      before.st_size == after.st_size, before.st_mode == after.st_mode, before.st_nlink == after.st_nlink,
      before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
      before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
      size == before.st_size,
      fstatat(parent, url.lastPathComponent, &named, AT_SYMLINK_NOFOLLOW) == 0,
      named.st_dev == after.st_dev, named.st_ino == after.st_ino, named.st_size == after.st_size,
      named.st_mode == after.st_mode, named.st_nlink == after.st_nlink,
      named.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, named.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
      named.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, named.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else {
      throw StackControlError.invalid("Preview bytes changed or were replaced while being hashed")
    }
    return (hash.finalize().map { String(format: "%02x", $0) }.joined(), size)
  }
}

@MainActor enum IntegrationPreviewImportGate {
  static var active: Set<String> = []
}
