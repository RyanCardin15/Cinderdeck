import CryptoKit
import Darwin
import Foundation

nonisolated enum WorkspaceBuildArtifactFiles {
  static let maximumBytes = 8 * 1024 * 1024
  static func validRelative(_ name: String, maximumLength: Int = 160) -> Bool {
    !name.isEmpty && name.utf8.count <= maximumLength && !name.hasPrefix("/") && name.split(separator: "/", omittingEmptySubsequences: false).allSatisfy {
      !$0.isEmpty && $0 != "." && $0 != ".." && $0.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || [45,46,95].contains($0) }
    }
  }
  static func read(root: URL, name: String, maximum: Int = maximumBytes) throws -> Data {
    guard validRelative(name, maximumLength: 4096) else { throw StackControlError.invalid("Artifact name is not a bounded relative file") }
    let fd = open(root.standardizedFileURL.resolvingSymlinksInPath().path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
    guard fd >= 0 else { throw StackControlError(code: "artifact_missing", message: "The owned build output directory is unavailable") }
    defer { close(fd) }
    var parent = dup(fd); guard parent >= 0 else { throw StackControlError.invalid("Cannot open build output") }
    defer { close(parent) }
    let parts = name.split(separator: "/").map(String.init)
    for part in parts.dropLast() {
      let next = openat(parent, part, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
      guard next >= 0 else { throw StackControlError(code: "artifact_missing", message: "Artifact directories cannot be missing or symlinked") }
      close(parent); parent = next
    }
    let file = openat(parent, parts.last!, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK)
    guard file >= 0 else { throw StackControlError(code: "artifact_missing", message: "Build did not produce its declared regular artifact") }
    defer { close(file) }
    var before = stat(), after = stat()
    guard fstat(file, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_nlink == 1, before.st_uid == getuid(), before.st_size > 0, before.st_size <= maximum else {
      throw StackControlError(code: "artifact_refused", message: "Artifact must be a fresh owned regular file, with one link and at most 8 MiB")
    }
    var data = Data(), bytes = [UInt8](repeating: 0, count: 65_536)
    while true {
      let count = bytes.withUnsafeMutableBytes { Darwin.read(file, $0.baseAddress, $0.count) }
      if count == 0 { break }
      guard count > 0, data.count + count <= maximum else { throw StackControlError(code: "artifact_changed", message: "Artifact changed or exceeded its read budget") }
      data.append(contentsOf: bytes.prefix(count))
    }
    guard fstat(file, &after) == 0, before.st_dev == after.st_dev, before.st_ino == after.st_ino,
      before.st_size == after.st_size, before.st_mode == after.st_mode, before.st_nlink == after.st_nlink,
      before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
      before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
      data.count == Int(before.st_size) else { throw StackControlError(code: "artifact_changed", message: "Artifact changed while being hashed") }
    return data
  }
  static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
