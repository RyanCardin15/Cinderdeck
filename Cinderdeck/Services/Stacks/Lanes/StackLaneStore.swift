import Darwin
import Foundation

nonisolated struct StackLaneInfo: Codable, Equatable, Sendable {
  let sourceStackID: String
  let name: String
  let owner: StackActor
  let createdAt: Date
  let directory: URL
  let ports: [String: Int]

  var reference: String { sourceStackID + "/" + name }
  static func portVariable(_ service: String) -> String {
    "CINDERDECK_PORT_" + service.uppercased().replacingOccurrences(of: "-", with: "_")
  }
}

nonisolated struct StackLaneWorktree: Codable, Equatable, Sendable {
  let source: URL
  let path: URL
}

nonisolated struct StackLaneRecord: Codable, Sendable {
  let definition: StackDefinition
  let worktrees: [StackLaneWorktree]
  var ready: Bool? = nil
}

/// Each lane owns a durable definition snapshot and a directory of worktrees.
/// The supervisor serializes mutations; reads can also run off the main actor.
nonisolated enum StackLaneStore {
  static func directory(for definitions: URL) -> URL { definitions.appendingPathComponent(".lanes", isDirectory: true) }

  static func record(id: String, in directory: URL) throws -> StackLaneRecord? {
    guard StackDefinitionLoader.validID(id) else { return nil }
    let folder = directory.appendingPathComponent(id, isDirectory: true)
    let file = folder.appendingPathComponent("lane.json")
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    do {
      let record = try StackControlCoding.decoder().decode(StackLaneRecord.self, from: Data(contentsOf: file))
      guard record.definition.id == id,
        record.definition.lane?.directory.standardizedFileURL == folder.standardizedFileURL else {
        throw StackError.message("Lane identity does not match its folder")
      }
      return record
    } catch {
      throw StackError.message("Cannot read lane record at \(file.path): \(error.localizedDescription). Repair this record before changing the lane.")
    }
  }

  static func records(in directory: URL) throws -> [StackLaneRecord] {
    guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
    return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .filter { FileManager.default.fileExists(atPath: $0.appendingPathComponent("lane.json").path) }
      .sorted { $0.path < $1.path }
      .compactMap { try record(id: $0.lastPathComponent, in: directory) }
  }

  static func files(in directory: URL) throws -> [StackDefinitionFile] {
    guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
    return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .filter { FileManager.default.fileExists(atPath: $0.appendingPathComponent("lane.json").path) }
      .sorted { $0.path < $1.path }.map { folder in
      let record: StackLaneRecord
      do { record = try StackControlCoding.decoder().decode(StackLaneRecord.self, from: Data(contentsOf: folder.appendingPathComponent("lane.json"))) }
      catch {
        return StackDefinitionFile(id: folder.lastPathComponent, file: folder.appendingPathComponent("lane.json"),
          issues: [.init(severity: .error, message: "Cannot read lane record: \(error.localizedDescription)")])
      }
      let definition = record.definition
      let missing = record.worktrees.filter { !FileManager.default.fileExists(atPath: $0.path.appendingPathComponent(".git").path) }
      var issues = missing.map { StackDefinitionIssue(severity: .error, message: "Lane worktree is missing: \($0.path.path). Restore it or remove the lane.") }
      if record.ready == false { issues.append(.init(severity: .error, message: "Lane creation did not finish. Remove this lane and create it again.")) }
      return StackDefinitionFile(id: definition.id, file: definition.file, definition: issues.isEmpty ? definition : nil,
        issues: issues, savedLane: definition.lane)
    }.sorted {
      let left = $0.lane?.createdAt ?? .distantPast, right = $1.lane?.createdAt ?? .distantPast
      return left == right ? $0.name < $1.name : left < right
    }
  }

  static func git(_ arguments: [String], at path: URL) async throws -> String {
    var environment = ProcessInfo.processInfo.environment
    environment["GIT_TERMINAL_PROMPT"] = "0"
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    let result = try await StackCommandRunner.run("/usr/bin/git", ["-c", "color.ui=false"] + arguments,
      directory: path, environment: environment, timeout: 60)
    guard result.status == 0 else {
      let detail = result.errorText.isEmpty ? result.text : result.errorText
      throw StackError.message(detail.isEmpty ? "Git \(arguments.first ?? "command") failed (exit \(result.status)). Check the branch name and repository." : String(detail.prefix(4000)))
    }
    return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  static func create(source: StackDefinition, branch: String, owner: StackActor, directory: URL,
    occupiedPorts: Set<Int>) async throws -> StackLaneRecord {
    guard source.lane == nil else { throw StackError.message("Create lanes from the original stack, not from another lane.") }
    guard !branch.isEmpty, !branch.hasPrefix("-"), !branch.contains("\0"), !branch.contains("\n"), branch != "HEAD" else {
      throw StackError.message("Use a valid local Git branch name for the lane.")
    }
    guard !(try records(in: directory)).contains(where: { $0.definition.lane?.reference == source.id + "/" + branch }) else {
      throw StackError.message("Lane \(source.id)/\(branch) already exists. Start or inspect it with that name.")
    }
    let variables = source.services.map { StackLaneInfo.portVariable($0.id) }
    guard Set(variables).count == variables.count else {
      throw StackError.message("Service names must have distinct uppercase port variables (hyphens become underscores).")
    }
    // Discover repositories even when a simple stack has no [repos] tables.
    let paths = Set((source.repos.map(\.path) + source.services.map(\.directory) + source.tasks.map(\.directory))
      .map { $0.resolvingSymlinksInPath().standardizedFileURL }).sorted { $0.path < $1.path }
    var roots: [URL] = []
    for path in paths {
      let root = URL(fileURLWithPath: try await git(["rev-parse", "--show-toplevel"], at: path)).resolvingSymlinksInPath().standardizedFileURL
      if !roots.contains(root) { roots.append(root) }
    }
    guard !roots.isEmpty else { throw StackError.message("A lane needs at least one Git repository.") }
    roots.sort { $0.path < $1.path }
    for root in roots {
      _ = try await git(["check-ref-format", "refs/heads/" + branch], at: root)
      let worktrees = try await git(["worktree", "list", "--porcelain"], at: root)
      guard !worktrees.components(separatedBy: "\n").contains("branch refs/heads/" + branch) else {
        throw StackError.message("Branch \(branch) is already checked out in \(root.path). Choose a different lane branch.")
      }
      if roots.contains(where: { $0 != root && relative(root, to: $0) != nil }) {
        throw StackError.message("Nested repositories are not supported in lanes. Define independent repository roots.")
      }
    }
    let id = source.id + "--lane-" + UUID().uuidString.lowercased()
    let laneDirectory = directory.appendingPathComponent(id, isDirectory: true)
    let worktrees = roots.enumerated().map { StackLaneWorktree(source: $0.element,
      path: laneDirectory.appendingPathComponent("repo-\($0.offset + 1)", isDirectory: true)) }
    func remap(_ path: URL) throws -> URL {
      for tree in worktrees {
        if let suffix = relative(path, to: tree.source) { return tree.path.appendingPathComponent(suffix, isDirectory: true) }
      }
      throw StackError.message("Cannot isolate folder outside a repository: \(path.path)")
    }
    var used = occupiedPorts
    var ports: [String: Int] = [:]
    for service in source.services.sorted(by: { $0.id < $1.id }) {
      let port = try availablePort(excluding: used)
      ports[service.id] = port; used.insert(port)
    }
    var definition = StackDefinition(id: id, name: source.name + " · " + branch, file: source.file,
      root: (try? remap(source.root)) ?? laneDirectory, shell: source.shell,
      restartOnBranchChange: source.restartOnBranchChange, environment: source.environment, secrets: source.secrets)
    definition.repos = try source.repos.map { .init(id: $0.id, path: try remap($0.path)) }
    // Surface the branch in simple single-repo stacks too.
    if definition.repos.isEmpty {
      definition.repos = worktrees.enumerated().map { .init(id: "repo-\($0.offset + 1)", path: $0.element.path) }
    }
    definition.services = try source.services.map { original in
      var service = original
      service.directory = try remap(original.directory)
      if service.repo == nil {
        service.repo = definition.repos.first { relative(service.directory, to: $0.path) != nil }?.id
      }
      let port = ports[service.id]!
      service.port = port
      switch original.readiness {
      case .port(let ready):
        guard original.port == nil || original.port == ready else {
          throw StackError.message("\(service.id) uses separate service and readiness ports. Lanes support one port per service.")
        }
        service.readiness = .port(port)
      case .http(let url):
        guard ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host?.lowercased() ?? ""),
          original.port == nil || original.port == (url.port ?? (url.scheme == "https" ? 443 : 80)),
          var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
          throw StackError.message("\(service.id) needs an HTTP readiness URL on its own localhost port to run in a lane.")
        }
        components.port = port
        service.readiness = .http(components.url!)
      default: break
      }
      return service
    }
    definition.tasks = try source.tasks.map { original in
      var task = original
      task.directory = try remap(original.directory)
      if task.repo == nil { task.repo = definition.repos.first { relative(task.directory, to: $0.path) != nil }?.id }
      return task
    }
    definition.workflows = source.workflows
    definition.lane = StackLaneInfo(sourceStackID: source.id, name: branch, owner: owner, createdAt: Date(),
      directory: laneDirectory, ports: ports)
    var record = StackLaneRecord(definition: definition, worktrees: worktrees, ready: false)
    try FileManager.default.createDirectory(at: laneDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    // Journal before Git mutations so a crash never leaves an undiscoverable worktree.
    try StackControlCoding.encoder(pretty: true).encode(record).write(to: laneDirectory.appendingPathComponent("lane.json"), options: .atomic)
    do {
      for tree in worktrees {
        let existing = try await git(["for-each-ref", "--format=%(refname)", "refs/heads/" + branch], at: tree.source)
          .components(separatedBy: "\n").contains("refs/heads/" + branch)
        let args = existing ? ["worktree", "add", "--", tree.path.path, branch] : ["worktree", "add", "-b", branch, "--", tree.path.path, "HEAD"]
        _ = try await git(args, at: tree.source)
      }
      // CWDs may not exist on an older branch, or may resolve through an escaping symlink.
      let directories = definition.services.map { ($0.id, $0.directory) } + definition.tasks.map { ($0.id, $0.directory) }
      for (id, directory) in directories {
        guard FileManager.default.fileExists(atPath: directory.path),
          worktrees.contains(where: { relative(directory, to: $0.path) != nil }) else {
          throw StackError.message("\(id)'s folder is missing or outside the lane on branch \(branch).")
        }
      }
      record.ready = true
      try StackControlCoding.encoder(pretty: true).encode(record).write(to: laneDirectory.appendingPathComponent("lane.json"), options: .atomic)
      return record
    } catch {
      var cleanupFailed = false
      for tree in worktrees.reversed() where FileManager.default.fileExists(atPath: tree.path.path) {
        do {
          try await requireClean(StackLaneRecord(definition: definition, worktrees: [tree]))
          _ = try await git(["worktree", "remove", "--", tree.path.path], at: tree.source)
        }
        catch { cleanupFailed = true }
      }
      if !cleanupFailed {
        try? FileManager.default.removeItem(at: laneDirectory.appendingPathComponent("lane.json"))
        _ = rmdir(laneDirectory.path)
      }
      throw StackError.message(error.localizedDescription + (cleanupFailed ? " Lane recovery record kept at \(laneDirectory.path)." : " No source checkout was changed; any newly created branches were kept."))
    }
  }

  static func requireClean(_ record: StackLaneRecord) async throws {
    for tree in record.worktrees where FileManager.default.fileExists(atPath: tree.path.path) {
      // Include ignored build output and .env files: removal must never silently erase them.
      let changes = try await git(["status", "--porcelain", "--untracked-files=all", "--ignored"], at: tree.path)
      guard changes.isEmpty else { throw StackError.message("Lane has local or ignored files in \(tree.path.path). Commit or move them before removal.") }
    }
  }

  static func remove(_ record: StackLaneRecord) async throws {
    try await requireClean(record)
    for tree in record.worktrees where FileManager.default.fileExists(atPath: tree.path.path) {
      _ = try await git(["worktree", "remove", "--", tree.path.path], at: tree.source)
    }
    if let directory = record.definition.lane?.directory {
      try FileManager.default.removeItem(at: directory.appendingPathComponent("lane.json"))
      // Only remove the now-empty directory, never recursively delete unexpected user files.
      _ = rmdir(directory.path)
    }
  }

  static func relative(_ path: URL, to root: URL) -> String? {
    let path = path.resolvingSymlinksInPath().standardizedFileURL.path
    let root = root.resolvingSymlinksInPath().standardizedFileURL.path
    if path == root { return "" }
    guard path.hasPrefix(root + "/") else { return nil }
    return String(path.dropFirst(root.count + 1))
  }

  /// Reserve against all saved lanes, base definitions and live launches, then
  /// test both address families. Launch still rechecks conflicts with outsiders.
  static func availablePort(excluding used: Set<Int>) throws -> Int {
    for port in 20000...60000 where !used.contains(port) {
      let v4 = socket(AF_INET, SOCK_STREAM, 0), v6 = socket(AF_INET6, SOCK_STREAM, 0)
      guard v4 >= 0, v6 >= 0 else {
        if v4 >= 0 { close(v4) }; if v6 >= 0 { close(v6) }
        throw StackError.message("Cannot allocate lane ports")
      }
      var only: Int32 = 1
      _ = setsockopt(v6, IPPROTO_IPV6, IPV6_V6ONLY, &only, socklen_t(MemoryLayout<Int32>.size))
      var a4 = sockaddr_in(); a4.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      a4.sin_family = sa_family_t(AF_INET); a4.sin_port = UInt16(port).bigEndian
      var a6 = sockaddr_in6(); a6.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
      a6.sin6_family = sa_family_t(AF_INET6); a6.sin6_port = UInt16(port).bigEndian
      let b4 = withUnsafePointer(to: &a4) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(v4, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
      let b6 = withUnsafePointer(to: &a6) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(v6, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) } }
      close(v4); close(v6)
      if b4 == 0 && b6 == 0 { return port }
    }
    throw StackError.message("No available lane ports in 20000–60000")
  }
}
