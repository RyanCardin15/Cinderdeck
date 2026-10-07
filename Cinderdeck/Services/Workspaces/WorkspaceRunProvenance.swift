import CryptoKit
import Foundation

nonisolated struct WorkspaceRunRepositorySnapshot: Codable, Equatable, Sendable {
  let repositoryID: String
  let canonicalRepositoryKeys: [String]
  let checkoutPhysicalID: String?
  let repositoryPhysicalID: String?
  let head: String?
  let capturedAt: Date
  let fingerprint: ReproSourceFingerprintSnapshot?
  let complete: Bool
}
nonisolated struct WorkspaceRunSourceProvenance: Codable, Equatable, Sendable {
  let schemaVersion: Int
  let definitionHash: String
  let workflowHash: String
  var state: String = "preparing"
  var capturedAt: Date?
  var finishedAt: Date?
  var repositoriesAtStart: [WorkspaceRunRepositorySnapshot] = []
  var repositoriesAtEnd: [WorkspaceRunRepositorySnapshot] = []
  var detail: String?
  var buildState: String { "unknown" }
}

nonisolated enum WorkspaceRunProvenance {
  struct Selection: Sendable {
    let repositories: [RepoDefinition]
    let complete: Bool
  }
  static func select(_ workspace: StackDefinition, references: [String]) -> Selection {
    var selected: [String: RepoDefinition] = [:], complete = true
    func add(repoID: String?, directory: URL) {
      if let repoID {
        if let repo = workspace.repo(repoID) {
          selected[repo.id] = repo
          let root = repo.path.standardizedFileURL.resolvingSymlinksInPath().path
          let cwd = directory.standardizedFileURL.resolvingSymlinksInPath().path
          if cwd != root && !cwd.hasPrefix(root + "/") { complete = false }
        } else { complete = false }
        return
      }
      let path = directory.standardizedFileURL.resolvingSymlinksInPath().path
      let containing = workspace.repos.filter { let root = $0.path.standardizedFileURL.resolvingSymlinksInPath().path; return path == root || path.hasPrefix(root + "/") }
      if let closest = containing.max(by: { $0.path.path.count < $1.path.path.count }) { selected[closest.id] = closest; return }
      let beneath = workspace.repos.filter { $0.path.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(path + "/") }
      if !beneath.isEmpty { for repo in beneath { selected[repo.id] = repo }; return }
      if workspace.repos.isEmpty, let identity = try? PhysicalCheckoutIdentity.resolve(directory), identity.root.path == path {
        selected["checkout"] = RepoDefinition(id: "checkout", path: identity.root)
      } else { complete = false }
    }
    var services = Set<String>()
    for reference in references {
      let parts = reference.split(separator: ":", maxSplits: 1).map(String.init)
      guard parts.count == 2 else { complete = false; continue }
      if parts[0] == "task", let task = workspace.task(parts[1]) {
        add(repoID: task.repo, directory: task.directory); services.formUnion(task.requiresServices)
      } else if ["start", "stop"].contains(parts[0]) { services.insert(parts[1]) }
      else { complete = false }
    }
    for id in workspace.serviceDependencies(services) {
      if let service = workspace.service(id) { add(repoID: service.repo, directory: service.directory) }
      else { complete = false } // Shared external service source is not silently retargeted.
    }
    let repositories = selected.values.sorted { $0.id < $1.id }
    return Selection(repositories: Array(repositories.prefix(16)), complete: complete && !repositories.isEmpty && repositories.count <= 16)
  }
  static func digest<A: Encodable>(_ value: A) -> String {
    let encoder = JSONEncoder(); encoder.outputFormatting = .sortedKeys
    return SHA256.hash(data: (try? encoder.encode(value)) ?? Data()).map { String(format: "%02x", $0) }.joined()
  }
  static func canonicalKeys(_ remotes: String) -> [String] {
    Array(Set(remotes.split(separator: "\n").compactMap { line -> String? in
      let fields = line.split(whereSeparator: { $0.isWhitespace })
      guard fields.count >= 3, fields[2] == "(fetch)" else { return nil }
      let raw = String(fields[1]); var host: String?, path: String?
      if let url = URL(string: raw), let value = url.host {
        host = value; path = url.path
        if let port = url.port, !((url.scheme == "https" && port == 443) || (url.scheme == "http" && port == 80)) { host = "\(value):\(port)" }
      } else if !raw.contains("://"), let colon = raw.firstIndex(of: ":") {
        host = String(raw[..<colon].split(separator: "@").last ?? ""); path = String(raw[raw.index(after: colon)...])
      }
      guard let host, var path, !host.isEmpty else { return nil }
      path = path.trimmingCharacters(in: CharacterSet(charactersIn: "/")); if path.hasSuffix(".git") { path.removeLast(4) }
      return host.lowercased() + "/" + path.lowercased()
    })).sorted()
  }
  static func capture(_ selection: Selection, environment: [String: String]) async -> [WorkspaceRunRepositorySnapshot] {
    var result: [WorkspaceRunRepositorySnapshot] = []
    var environment = environment
    environment["GIT_TERMINAL_PROMPT"] = "0"; environment["GIT_OPTIONAL_LOCKS"] = "0"; environment["LC_ALL"] = "C"
    for repo in selection.repositories {
      let capturedAt = Date()
      guard let identity = try? PhysicalCheckoutIdentity.resolve(repo.path), identity.root.path == repo.path.standardizedFileURL.resolvingSymlinksInPath().path else {
        result.append(.init(repositoryID: repo.id, canonicalRepositoryKeys: [], checkoutPhysicalID: nil, repositoryPhysicalID: nil, head: nil, capturedAt: capturedAt, fingerprint: nil, complete: false)); continue
      }
      func git(_ arguments: [String]) async -> String? {
        guard let output = try? await StackCommandRunner.run("/usr/bin/git", StackCommandRunner.gitArguments(arguments, passive: true), directory: identity.root, environment: environment, timeout: 20),
          output.status == 0, output.output.count < 8 * 1024 * 1024 else { return nil }
        return String(data: output.output, encoding: .utf8)
      }
      let head = await git(["rev-parse", "HEAD"])?.trimmingCharacters(in: .whitespacesAndNewlines)
      let status = await git(["status", "--porcelain=v1", "--untracked-files=all", "-z"])
      let remotes = await git(["remote", "-v"])
      let fingerprint = await ReproRecorder.captureSourceFingerprint(root: identity.root, git: git)
      let afterFingerprint = await ReproRecorder.captureSourceFingerprint(root: identity.root, git: git)
      let finalHead = await git(["rev-parse", "HEAD"])?.trimmingCharacters(in: .whitespacesAndNewlines)
      let finalStatus = await git(["status", "--porcelain=v1", "--untracked-files=all", "-z"])
      let finalIdentity = try? PhysicalCheckoutIdentity.resolve(identity.root)
      let common = try? identity.repositoryPhysicalID()
      let keys = canonicalKeys(remotes ?? "")
      let boundedKeys = Array(keys.filter { $0.utf8.count <= 512 }.prefix(32))
      let complete = keys == boundedKeys && head != nil && status != nil && remotes != nil && common != nil && finalHead == head && finalStatus == status
        && finalIdentity?.physicalID == identity.physicalID && fingerprint.state == "complete" && afterFingerprint.state == "complete" && fingerprint.hash == afterFingerprint.hash
      result.append(.init(repositoryID: repo.id, canonicalRepositoryKeys: boundedKeys, checkoutPhysicalID: identity.physicalID,
        repositoryPhysicalID: common, head: head, capturedAt: capturedAt, fingerprint: fingerprint, complete: complete))
    }
    return result
  }
  static func assess(start: [WorkspaceRunRepositorySnapshot], end: [WorkspaceRunRepositorySnapshot], scopeComplete: Bool) -> String {
    guard scopeComplete, !start.isEmpty, start.count == end.count, start.allSatisfy(\.complete), end.allSatisfy(\.complete) else { return "unknown" }
    for initial in start {
      guard let final = end.first(where: { $0.repositoryID == initial.repositoryID }), initial.head == final.head,
        initial.checkoutPhysicalID == final.checkoutPhysicalID, initial.repositoryPhysicalID == final.repositoryPhysicalID,
        initial.canonicalRepositoryKeys == final.canonicalRepositoryKeys, initial.fingerprint?.hash == final.fingerprint?.hash else { return "changed" }
    }
    return "complete"
  }
}

extension WorkspaceRunRepositorySnapshot {
  var value: JSONValue { .object([
    "repositoryID": .string(repositoryID), "canonicalRepositoryKeys": .array(canonicalRepositoryKeys.map(JSONValue.string)),
    "checkoutPhysicalID": checkoutPhysicalID.map(JSONValue.string) ?? .null, "repositoryPhysicalID": repositoryPhysicalID.map(JSONValue.string) ?? .null,
    "head": head.map(JSONValue.string) ?? .null, "capturedAt": .string(ISO8601DateFormatter().string(from: capturedAt)),
    "fingerprint": fingerprint?.value ?? .null, "complete": .bool(complete),
  ]) }
}
extension WorkspaceRunSourceProvenance {
  var value: JSONValue { .object([
    "schemaVersion": .number(Double(schemaVersion)), "definitionHash": .string(definitionHash), "workflowHash": .string(workflowHash),
    "state": .string(state), "capturedAt": capturedAt.map { .string(ISO8601DateFormatter().string(from: $0)) } ?? .null,
    "finishedAt": finishedAt.map { .string(ISO8601DateFormatter().string(from: $0)) } ?? .null,
    "repositoriesAtStart": .array(repositoriesAtStart.map(\.value)), "repositoriesAtEnd": .array(repositoriesAtEnd.map(\.value)),
    "buildState": .string("unknown"), "detail": detail.map(JSONValue.string) ?? .null,
  ]) }
}
