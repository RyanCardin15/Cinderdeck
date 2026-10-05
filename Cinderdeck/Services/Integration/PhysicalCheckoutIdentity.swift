import CryptoKit
import Foundation

nonisolated struct PhysicalCheckoutIdentity: Equatable, Sendable {
  let root: URL
  let gitDirectory: URL
  let physicalID: String

  /// Resolve standard Git metadata without starting a process or trusting a
  /// caller's identity. The same device/inode key is used by the agent runtime.
  static func resolve(_ path: URL) throws -> Self? {
    let fm = FileManager.default
    var root = path.resolvingSymlinksInPath().standardizedFileURL
    var directory: ObjCBool = false
    guard fm.fileExists(atPath: root.path, isDirectory: &directory), directory.boolValue else {
      throw StackControlError(code: "checkout_missing", message: "The checkout directory is missing.")
    }
    for _ in 0..<128 {
      let entry = root.appendingPathComponent(".git")
      if fm.fileExists(atPath: entry.path, isDirectory: &directory) {
        let gitDirectory: URL
        if directory.boolValue { gitDirectory = entry.resolvingSymlinksInPath().standardizedFileURL }
        else {
          let attributes = try fm.attributesOfItem(atPath: entry.path)
          guard ((attributes[.size] as? NSNumber)?.intValue ?? 4097) <= 4096 else {
            throw StackControlError.invalid("Git metadata is too large")
          }
          let value = try String(contentsOf: entry, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
          guard value.hasPrefix("gitdir: "), !value.contains("\n") else {
            throw StackControlError.invalid("Invalid worktree Git metadata")
          }
          let raw = String(value.dropFirst(8))
          gitDirectory = URL(fileURLWithPath: raw, relativeTo: URL(fileURLWithPath: root.path, isDirectory: true)).resolvingSymlinksInPath().standardizedFileURL
        }
        let attributes = try fm.attributesOfItem(atPath: gitDirectory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
          let device = attributes[.systemNumber] as? NSNumber,
          let inode = attributes[.systemFileNumber] as? NSNumber else {
          throw StackControlError(code: "checkout_missing", message: "Cannot identify this checkout's Git directory.")
        }
        let key = "\(device.uint64Value):\(inode.uint64Value)"
        return .init(root: root, gitDirectory: gitDirectory, physicalID: digest(key))
      }
      let parent = root.deletingLastPathComponent()
      if parent.path == root.path { return nil }
      root = parent
    }
    throw StackControlError.invalid("Checkout nesting exceeds the supported depth")
  }
  func commonDirectory() throws -> URL {
    let fm = FileManager.default
    let entry = gitDirectory.appendingPathComponent("commondir")
    let common: URL
    if fm.fileExists(atPath: entry.path) {
      let attributes = try fm.attributesOfItem(atPath: entry.path)
      guard ((attributes[.size] as? NSNumber)?.intValue ?? 4097) <= 4096 else {
        throw StackControlError.invalid("Git common-directory metadata is too large")
      }
      let value = try String(contentsOf: entry, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !value.isEmpty, !value.contains("\n") else { throw StackControlError.invalid("Invalid Git common-directory metadata") }
      common = URL(fileURLWithPath: value, relativeTo: URL(fileURLWithPath: gitDirectory.path, isDirectory: true)).resolvingSymlinksInPath().standardizedFileURL
    } else { common = gitDirectory }
    return common
  }
  private static func directoryID(_ directory: URL) throws -> String {
    let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
      let device = attributes[.systemNumber] as? NSNumber, let inode = attributes[.systemFileNumber] as? NSNumber else {
      throw StackControlError(code: "checkout_missing", message: "Cannot identify the repository's shared Git directory.")
    }
    return digest("\(device.uint64Value):\(inode.uint64Value)")
  }
  func repositoryPhysicalID() throws -> String { try Self.directoryID(commonDirectory()) }
  /// A removed checkout still has a physical identity while Git
  /// retains its worktree registration. Preserve that identity during safe cleanup.
  private func missingRegistration(_ root: URL) throws -> PhysicalCheckoutIdentity? {
    let fm = FileManager.default
    guard !fm.fileExists(atPath: root.path) else { return nil }
    let registrations = try commonDirectory().appendingPathComponent("worktrees")
    guard fm.fileExists(atPath: registrations.path) else { return nil }
    let entries = try fm.contentsOfDirectory(at: registrations, includingPropertiesForKeys: nil)
    guard entries.count <= 64 else { throw StackControlError.invalid("Too many worktree registrations") }
    let expected = StackLaneStore.canonicalPath(root.appendingPathComponent(".git"))
    for entry in entries {
      let pointer = entry.appendingPathComponent("gitdir")
      guard fm.fileExists(atPath: pointer.path),
        ((try fm.attributesOfItem(atPath: pointer.path)[.size] as? NSNumber)?.intValue ?? 4097) <= 4096 else { continue }
      let value = try String(contentsOf: pointer, encoding: .utf8).trimmingCharacters(in: .newlines)
      guard !value.isEmpty, !value.contains("\n") else { continue }
      let target = StackLaneStore.canonicalPath(URL(fileURLWithPath: value, relativeTo: entry))
      if target == expected {
        let directory = entry.resolvingSymlinksInPath().standardizedFileURL
        let linked = Self(root: root, gitDirectory: directory, physicalID: try Self.directoryID(directory))
        guard try linked.repositoryPhysicalID() == repositoryPhysicalID() else { throw StackControlError.invalid("Worktree common-directory identity changed") }
        return linked
      }
    }
    return nil
  }
  /// Inventory Git's actual worktrees, including unbound aliases and detached
  /// checkouts. Shared refs and lane creation/removal coordinate the whole repository.
  static func repositoryScope(_ paths: [URL]) async throws -> [String] {
    var scope = Set<String>(), repositories = Set<String>()
    for path in paths {
      guard let current = try resolve(path) else { continue }
      let common = try current.repositoryPhysicalID()
      guard repositories.insert(common).inserted else { continue }
      let result = try await StackLaneStore.gitResult(["worktree", "list", "--porcelain", "-z"], at: current.root, timeout: 10)
      guard result.status == 0, result.output.count <= 65_536, let output = String(data: result.output, encoding: .utf8) else {
        throw StackControlError(code: "checkout_unavailable", message: "Cannot inventory this repository's physical worktrees.")
      }
      let records = output.components(separatedBy: "\0\0").filter { !$0.isEmpty }
      guard !records.isEmpty else {
        throw StackControlError(code: "checkout_unavailable", message: "Git returned an empty physical worktree inventory.")
      }
      guard records.count <= 64 else {
        throw StackControlError(code: "capacity", message: "Physical worktree inventory exceeds the supported limit (\(records.count) entries; maximum 64).")
      }
      for record in records {
        let fields = record.components(separatedBy: "\0")
        guard let first = fields.first, first.hasPrefix("worktree ") else { throw StackControlError.invalid("Invalid Git worktree inventory") }
        if fields.contains("bare") { continue }
        let root = URL(fileURLWithPath: String(first.dropFirst(9))).resolvingSymlinksInPath().standardizedFileURL
        let linked = FileManager.default.fileExists(atPath: root.path) ? try resolve(root) : try current.missingRegistration(root)
        guard let linked, try linked.repositoryPhysicalID() == common else {
          throw StackControlError(code: "stale_revision", message: "A repository worktree is missing or has changed identity.")
        }
        scope.insert(linked.physicalID)
      }
      guard scope.contains(current.physicalID), scope.count <= 64 else { throw StackControlError.invalid("Unsupported physical mutation scope") }
    }
    return scope.sorted()
  }
  static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
