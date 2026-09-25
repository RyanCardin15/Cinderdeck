import CryptoKit
import Darwin
import Foundation

/// Lane records live in `<definitions>/.lanes/<id>/lane.json`; worktrees live in
/// `<lanes folder>/<workspace>/<slug>/<repository folder>`. A record is an overlay
/// on its source definition: worktrees, assigned ports and per-lane choices. The
/// definition a lane runs is derived from the current source every time it loads.
/// The supervisor serializes mutations; reads can also run off the main actor.
nonisolated enum StackLaneStore {
  static func directory(for definitions: URL) -> URL { definitions.appendingPathComponent(".lanes", isDirectory: true) }

  /// Default folder for worktrees; the Settings value or `[lanes] dir` override it.
  static var defaultWorktreeRoot: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".cinderdeck/lanes", isDirectory: true)
  }

  static let firstPort = 20000, lastPort = 60000, blockSize = 10

  // MARK: Records

  static func manifest(id: String, in directory: URL) -> URL {
    directory.appendingPathComponent(id, isDirectory: true).appendingPathComponent("lane.json")
  }

  static func record(id: String, in directory: URL) throws -> StackLaneRecord? {
    guard StackDefinitionLoader.validID(id) else { return nil }
    let file = manifest(id: id, in: directory)
    guard FileManager.default.fileExists(atPath: file.path) else { return nil }
    do {
      let record = try StackControlCoding.decoder().decode(StackLaneRecord.self, from: Data(contentsOf: file))
      guard record.id == id else { throw StackError.message("Lane identity does not match its folder") }
      return record
    } catch {
      throw StackError.message("Cannot read lane record at \(file.path): \(error.localizedDescription). Repair this record before changing the lane.")
    }
  }

  /// Every readable record. Unreadable ones are reported by `files(in:)` instead.
  static func records(in directory: URL) throws -> [StackLaneRecord] {
    try folders(in: directory).compactMap { try? record(id: $0.lastPathComponent, in: directory) }
  }

  private static func folders(in directory: URL) throws -> [URL] {
    guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
    return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .filter { FileManager.default.fileExists(atPath: $0.appendingPathComponent("lane.json").path) }
      .sorted { $0.path < $1.path }
  }

  static func write(_ record: StackLaneRecord, in directory: URL) throws {
    let folder = directory.appendingPathComponent(record.id, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try StackControlCoding.encoder(pretty: true).encode(record).write(to: folder.appendingPathComponent("lane.json"), options: .atomic)
  }

  /// Read-modify-write of one record. Missing records are left missing.
  @discardableResult
  static func update(id: String, in directory: URL, _ change: (inout StackLaneRecord) throws -> Void) throws -> StackLaneRecord? {
    guard var record = try record(id: id, in: directory) else { return nil }
    try change(&record)
    try write(record, in: directory)
    return record
  }

  // MARK: Loading

  /// One entry per record. `sources` are the loaded workspace definitions (raw, rendered for the original checkout).
  static func files(in directory: URL, sources: [StackDefinitionFile] = []) throws -> [StackDefinitionFile] {
    try folders(in: directory).map { folder in
      let id = folder.lastPathComponent
      let manifest = folder.appendingPathComponent("lane.json")
      let record: StackLaneRecord
      do {
        guard let loaded = try Self.record(id: id, in: directory) else { throw StackError.message("Lane record disappeared") }
        record = loaded
      } catch {
        return StackDefinitionFile(id: id, file: manifest,
          issues: [.init(severity: .error, message: "Cannot read lane record: \(error.localizedDescription)")])
      }
      var issues = record.worktrees.filter { !FileManager.default.fileExists(atPath: $0.path.appendingPathComponent(".git").path) }
        .map { StackDefinitionIssue(severity: .error, message: "Lane worktree is missing: \($0.path.path). Restore it or remove the lane.") }
      if record.ready == false { issues.append(.init(severity: .error, message: "Lane creation did not finish. Remove this lane and create it again.")) }
      let source = sources.first { $0.id == record.info.sourceStackID && $0.lane == nil }
      var file = StackDefinitionFile(id: id, file: source?.file ?? manifest, issues: issues, savedLane: record.info)
      file.laneSetup = record.setup
      file.laneWorktrees = record.worktrees
      guard issues.isEmpty else { return file }
      if record.info.pinned, var definition = record.definition {
        file.issues.append(.init(severity: .warning, message: "This lane keeps the definition saved when it was created. Unpin it to follow \(record.info.sourceStackID)."))
        definition.lane = record.info
        file.definition = definition
        return file
      }
      guard let base = source?.definition else {
        file.issues.append(.init(severity: .error, message: source == nil
          ? "Source workspace \(record.info.sourceStackID) is missing. Stop or remove this lane."
          : "Source workspace \(record.info.sourceStackID) has errors: " + (source?.issues.filter { $0.severity == .error }.map(\.message).joined(separator: "; ") ?? "")))
        return file
      }
      let derived = derive(record, source: base)
      file.issues += derived.issues
      file.pendingLanePorts = derived.missingPorts
      if derived.missingPorts.isEmpty, !derived.issues.contains(where: { $0.severity == .error }) { file.definition = derived.definition }
      return file
    }.sorted {
      let left = $0.lane?.createdAt ?? .distantPast, right = $1.lane?.createdAt ?? .distantPast
      return left == right ? $0.name < $1.name : left < right
    }
  }

  // MARK: Derivation

  static func portKey(_ service: String, _ port: String = "") -> String { port.isEmpty ? service : service + "." + port }
  static func taskPortKey(_ task: String, _ port: String = "") -> String { "task:" + portKey(task, port) }

  /// Where `path` lives inside the lane, or nil when it is outside every worktree.
  static func remap(_ path: URL, worktrees: [StackLaneWorktree]) -> URL? {
    // Longest source first, so a worktree of an inner folder wins.
    for tree in worktrees.sorted(by: { $0.source.path.count > $1.source.path.count }) {
      if let suffix = relative(path, to: tree.source) {
        return suffix.isEmpty ? tree.path : tree.path.appendingPathComponent(suffix, isDirectory: true)
      }
    }
    return nil
  }

  static func mode(of service: ServiceDefinition, in source: StackDefinition, worktrees: [StackLaneWorktree]) -> StackServiceLaneMode {
    if let mode = service.laneMode { return mode }
    if let repo = service.repo.flatMap(source.repo), repo.laneMode == .shared { return .shared }
    return remap(service.directory, worktrees: worktrees) == nil ? .shared : .isolate
  }

  /// Port keys an isolated copy of `source` needs, sorted.
  static func requiredPortKeys(_ source: StackDefinition, worktrees: [StackLaneWorktree]) -> [String] {
    var keys: [String] = []
    for service in source.services where mode(of: service, in: source, worktrees: worktrees) == .isolate {
      let hasPrimary = service.port != nil || { if case .port = service.readiness { return true }; return false }()
      if hasPrimary { keys.append(portKey(service.id)) }
      keys += service.ports.keys.sorted().map { portKey(service.id, $0) }
    }
    for task in source.tasks {
      if task.port != nil { keys.append(taskPortKey(task.id)) }
      keys += task.ports.keys.sorted().map { taskPortKey(task.id, $0) }
    }
    return keys
  }

  /// The lane's definition: the current source with folders, ports, modes and lane values applied.
  /// Templates are rendered later, together with every other workspace.
  static func derive(_ record: StackLaneRecord, source: StackDefinition) -> (definition: StackDefinition, issues: [StackDefinitionIssue], missingPorts: [String]) {
    var issues: [StackDefinitionIssue] = []
    let info = record.info
    let trees = record.worktrees
    let ports = info.ports
    let missing = requiredPortKeys(source, worktrees: trees).filter { ports[$0] == nil }
    var definition = StackDefinition(id: record.id, name: source.name + " · " + info.name, file: source.file,
      root: remap(source.root, worktrees: trees) ?? trees.first?.path ?? info.directory, shell: source.shell,
      restartOnBranchChange: source.restartOnBranchChange, environment: source.environment, secrets: source.secrets)
    definition.rawEnvironment = source.rawEnvironment
    definition.laneSettings = source.laneSettings
    if let settings = source.laneSettings {
      definition.environment.merge(settings.environment) { _, value in value }
      for key in settings.environment.keys { definition.rawEnvironment[key] = settings.rawEnvironment[key] }
    }
    definition.repos = source.repos.map { repo in
      guard repo.laneMode == .worktree else { return repo }
      if let path = remap(repo.path, worktrees: trees) { return .init(id: repo.id, path: path, laneMode: repo.laneMode) }
      issues.append(.init(severity: .warning, message: "Repo \(repo.id) has no worktree in this lane (it was added later or is outside Git); it uses the original checkout."))
      return repo
    }
    // Surface the branch in simple stacks without [repos] tables too.
    if definition.repos.isEmpty {
      var used = Set<String>()
      definition.repos = trees.map { tree in
        var id = tree.path.lastPathComponent.replacingOccurrences(of: "[^A-Za-z0-9_-]+", with: "-", options: .regularExpression)
        if id.isEmpty || used.contains(id) { id = "repo-\(used.count + 1)" }
        used.insert(id)
        return .init(id: id, path: tree.path)
      }
    }
    var services: [ServiceDefinition] = []
    for original in source.services {
      switch mode(of: original, in: source, worktrees: trees) {
      case .off: continue
      case .shared:
        definition.links.append(StackServiceLink(id: original.id, stack: source.id, service: original.id,
          port: original.port, ports: original.ports, host: source.host, shared: true))
      case .isolate:
        var service = original
        service.directory = remap(original.directory, worktrees: trees) ?? original.directory
        if let repo = original.repo, source.repo(repo)?.laneMode == .worktree { service.repo = repo }
        else if original.repo == nil { service.repo = definition.repos.first { relative(service.directory, to: $0.path) != nil }?.id }
        var mapping: [Int: Int] = [:]
        let readyPort: Int? = if case .port(let port) = original.readiness { port } else { nil }
        if let primary = ports[portKey(original.id)] {
          if let port = original.port { mapping[port] = primary }
          if let readyPort, original.port == nil || readyPort == original.port { mapping[readyPort] = primary }
          service.port = primary
        }
        service.ports = [:]
        for (name, base) in original.ports {
          guard let assigned = ports[portKey(original.id, name)] else { continue }
          mapping[base] = assigned; service.ports[name] = assigned
        }
        switch original.readiness {
        case .port(let port):
          if let mapped = mapping[port] { service.readiness = .port(mapped) }
          else if missing.isEmpty {
            issues.append(.init(severity: .error, message: "\(original.id) checks readiness on port \(port), which is not one of its ports. Use ready.port = \"<name>\" with ports.<name>."))
          }
        case .http(let url) where original.raw?.readyHTTP == nil:
          let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host?.lowercased() ?? "")
          let port = url.port ?? (url.scheme == "https" ? 443 : 80)
          if local, let mapped = mapping[port], var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.port = mapped
            service.readiness = .http(components.url ?? url)
          } else if missing.isEmpty {
            issues.append(.init(severity: .error, message: "\(original.id) needs an HTTP readiness URL on one of its own localhost ports to run in a lane, or ready.http = \"{{url.\(original.id)}}/…\"."))
          }
        default: break
        }
        services.append(service)
      }
    }
    definition.services = services
    definition.tasks = source.tasks.map { original in
      var task = original
      task.directory = remap(original.directory, worktrees: trees) ?? original.directory
      if task.repo == nil { task.repo = definition.repos.first { relative(task.directory, to: $0.path) != nil }?.id }
      if original.port != nil { task.port = ports[taskPortKey(original.id)] }
      task.ports = Dictionary(uniqueKeysWithValues: original.ports.keys.compactMap { name in ports[taskPortKey(original.id, name)].map { (name, $0) } })
      return task
    }
    definition.workflows = source.workflows
    var lane = info
    lane.host = source.laneSettings?.hosts == true
      ? "\(info.effectiveSlug).\(StackLaneInfo.hostLabel(source.id)).localhost" : nil
    definition.lane = lane
    return (definition, issues, missing)
  }

  // MARK: Git

  static func git(_ arguments: [String], at path: URL, timeout: TimeInterval = 60) async throws -> String {
    let result = try await gitResult(arguments, at: path, timeout: timeout)
    guard result.status == 0 else {
      let detail = result.errorText.isEmpty ? result.text : result.errorText
      throw StackError.message(detail.isEmpty ? "Git \(arguments.first ?? "command") failed (exit \(result.status)). Check the branch name and repository." : String(detail.prefix(4000)))
    }
    return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  static func gitResult(_ arguments: [String], at path: URL, timeout: TimeInterval = 60) async throws -> StackCommandResult {
    var environment = ProcessInfo.processInfo.environment
    environment["GIT_TERMINAL_PROMPT"] = "0"
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    return try await StackCommandRunner.run("/usr/bin/git", ["-c", "color.ui=false"] + arguments,
      directory: path, environment: environment, timeout: timeout)
  }

  static func hasRemote(_ path: URL) async -> Bool {
    !((try? await git(["remote"], at: path)) ?? "").isEmpty
  }

  static func topLevel(_ path: URL) async -> URL? {
    guard let text = try? await git(["rev-parse", "--show-toplevel"], at: path) else { return nil }
    return URL(fileURLWithPath: text).resolvingSymlinksInPath().standardizedFileURL
  }

  static func commonDirectory(_ path: URL) async -> URL? {
    guard let text = try? await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], at: path) else { return nil }
    return URL(fileURLWithPath: text).resolvingSymlinksInPath().standardizedFileURL
  }

  /// Worktree path → checked-out branch, for every worktree of the repository.
  static func checkouts(_ root: URL) async throws -> [URL: String] {
    let output = try await git(["worktree", "list", "--porcelain", "-z"], at: root)
    var result: [URL: String] = [:]
    var current: URL?
    for field in output.split(separator: "\0") {
      if field.hasPrefix("worktree ") {
        current = URL(fileURLWithPath: String(field.dropFirst("worktree ".count))).resolvingSymlinksInPath().standardizedFileURL
      } else if field.hasPrefix("branch refs/heads/"), let current {
        result[current] = String(field.dropFirst("branch refs/heads/".count))
      }
    }
    return result
  }

  // MARK: Creation

  struct Creation: Sendable {
    var record: StackLaneRecord
    var warnings: [String]
  }

  /// Creates or adopts worktrees and journals the record before any Git change, so an
  /// interrupted creation stays discoverable. `occupiedPorts` must include every port in use.
  static func create(source: StackDefinition, request: StackLaneRequest, owner: StackActor, directory: URL,
    worktreeRoot: URL, occupiedPorts: Set<Int>) async throws -> Creation {
    guard source.lane == nil else { throw StackError.message("Create lanes from the original stack, not from another lane.") }
    var warnings: [String] = []
    let existing = try records(in: directory)
    let settings = source.laneSettings

    // Repositories whose folders the lane isolates. Shared repositories and folders outside Git stay in place.
    var roots: [URL] = []
    var outside: [String] = []
    var candidates: [(String, URL)] = source.repos.filter { $0.laneMode == .worktree }.map { ("repos.\($0.id)", $0.path) }
    for service in source.services where service.laneMode != .off && service.laneMode != .shared {
      if let repo = service.repo.flatMap(source.repo), repo.laneMode == .shared, service.laneMode == nil { continue }
      candidates.append(("services.\(service.id)", service.directory))
    }
    for task in source.tasks {
      if let repo = task.repo.flatMap(source.repo), repo.laneMode == .shared { continue }
      candidates.append(("tasks.\(task.id)", task.directory))
    }
    let sharedRoots = source.repos.filter { $0.laneMode == .shared }.map { $0.path.resolvingSymlinksInPath().standardizedFileURL }
    for (label, path) in candidates {
      let resolved = path.resolvingSymlinksInPath().standardizedFileURL
      if sharedRoots.contains(where: { relative(resolved, to: $0) != nil }) { continue }
      guard let root = await topLevel(resolved) else { outside.append(label); continue }
      if !roots.contains(root) { roots.append(root) }
    }
    if !outside.isEmpty {
      warnings.append("Outside Git, so shared with the original checkout: " + outside.joined(separator: ", ") + ".")
    }
    guard !roots.isEmpty || request.adoptPath != nil else { throw StackError.message("A lane needs at least one Git repository.") }
    roots.sort { $0.path < $1.path }
    for root in roots where roots.contains(where: { $0 != root && relative(root, to: $0) != nil }) {
      throw StackError.message("Nested repositories are not supported in lanes. Define independent repository roots, or mark the inner one lane = \"shared\".")
    }

    // Adoption: an existing worktree of one of those repositories.
    var adopted: StackLaneWorktree?
    var branch = request.branch
    if let path = request.adoptPath {
      guard let top = await topLevel(path) else { throw StackError.message("\(path.path) is not inside a Git worktree.") }
      guard let common = await commonDirectory(top) else { throw StackError.message("Cannot read the Git folder of \(top.path).") }
      var match: URL?
      for root in roots where await commonDirectory(root) == common { match = root; break }
      guard let root = match else {
        throw StackError.message("\(top.path) is not a worktree of any repository in \(source.name): " + roots.map(\.path).joined(separator: ", "))
      }
      guard top != root else { throw StackError.message("\(top.path) is the original checkout. Adopt a separate worktree, or create a lane.") }
      let current = try await git(["branch", "--show-current"], at: top)
      if branch.isEmpty {
        guard !current.isEmpty else { throw StackError.message("\(top.path) has a detached HEAD. Pass a lane name.") }
        branch = current
      }
      let base = try? await git(["rev-parse", "HEAD"], at: top)
      adopted = StackLaneWorktree(source: root, path: top, branch: current.isEmpty ? nil : current, managed: false, baseCommit: base)
      if let other = existing.first(where: { $0.worktrees.contains { samePath($0.path, top) } && $0.info.sourceStackID == source.id }) {
        throw StackError.message("\(top.path) already belongs to lane \(other.info.reference).")
      }
    }
    guard !branch.isEmpty, !branch.hasPrefix("-"), !branch.contains("\0"), !branch.contains("\n"), branch != "HEAD" else {
      throw StackError.message("Use a valid local Git branch name for the lane.")
    }
    guard !existing.contains(where: { $0.info.reference == source.id + "/" + branch }) else {
      throw StackError.message("Lane \(source.id)/\(branch) already exists. Start or inspect it with that name.")
    }
    for (key, _) in request.environment where key.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) == nil {
      throw StackError.message("Invalid environment variable name \(key)")
    }

    // Where each repository's worktree comes from.
    enum Plan { case create, reuse(URL), adopt }
    var plans: [URL: Plan] = [:]
    for root in roots {
      if adopted?.source == root { plans[root] = .adopt; continue }
      _ = try await git(["check-ref-format", "refs/heads/" + branch], at: root)
      let checkouts = try await checkouts(root)
      if let (path, _) = checkouts.first(where: { $0.value == branch }) {
        if path == root {
          throw StackError.message("Branch \(branch) is checked out in the original checkout \(root.path). Choose a different lane branch.")
        }
        // Another workspace's lane already has this branch: share its worktree.
        if let shared = existing.lazy.flatMap(\.worktrees).first(where: { samePath($0.path, path) }) {
          plans[root] = .reuse(shared.path); continue
        }
        throw StackError.message("Branch \(branch) is already checked out in \(path.path). Adopt that worktree with `cinderdeck lane adopt \(source.id) --path \(path.path)`, or choose a different lane branch.")
      }
      plans[root] = .create
    }

    // Identity, folder and ports.
    let slug = uniqueSlug(StackLaneInfo.slug(for: branch), source: source.id, existing: existing,
      root: laneRoot(settings: settings, default: worktreeRoot, source: source))
    let laneDirectory = laneRoot(settings: settings, default: worktreeRoot, source: source)
      .appendingPathComponent(source.id, isDirectory: true).appendingPathComponent(slug, isDirectory: true)
    for root in roots + sharedRoots where relative(laneDirectory, to: root) != nil {
      throw StackError.message("The lanes folder \(laneDirectory.path) is inside the repository \(root.path). Choose a lanes folder outside your projects in Settings or with [lanes] dir.")
    }
    if relative(laneDirectory, to: directory) != nil || relative(laneDirectory, to: directory.deletingLastPathComponent()) != nil {
      throw StackError.message("The lanes folder is inside the workspace definitions folder. Choose another lanes folder.")
    }
    if ["/Library/Mobile Documents/", "/Library/CloudStorage/", "/Dropbox/"].contains(where: { laneDirectory.path.contains($0) }) {
      warnings.append("The lanes folder is in a synced folder; syncing node_modules and build output is slow. Consider ~/.cinderdeck/lanes.")
    }
    var used = Set<String>()
    var worktrees: [StackLaneWorktree] = []
    for root in roots {
      switch plans[root] {
      case .adopt: worktrees.append(adopted!)
      case .reuse(let path): worktrees.append(StackLaneWorktree(source: root, path: path, branch: branch, managed: true))
      default:
        var name = root.lastPathComponent
        if used.contains(name) { var n = 2; while used.contains("\(name)-\(n)") { n += 1 }; name = "\(name)-\(n)" }
        used.insert(name)
        worktrees.append(StackLaneWorktree(source: root, path: laneDirectory.appendingPathComponent(name, isDirectory: true), branch: branch, managed: true))
      }
    }
    let id = source.id + "--lane-" + UUID().uuidString.lowercased()
    let keys = requiredPortKeys(source, worktrees: worktrees)
    let ports = try allocate(keys, excluding: occupiedPorts)
    var info = StackLaneInfo(sourceStackID: source.id, name: branch, owner: owner, createdAt: Date(), directory: laneDirectory,
      ports: ports, slug: slug, environment: request.environment, from: request.from ?? settings?.from)
    info.adopted = adopted != nil
    var record = StackLaneRecord(id: id, info: info, worktrees: worktrees, ready: false)
    // Readiness checks and ports must work in a lane before anything is created.
    if let problem = derive(record, source: source).issues.first(where: { $0.severity == .error }) {
      throw StackError.message(problem.message)
    }
    // Journal before Git mutations so a crash never leaves an undiscoverable worktree.
    try write(record, in: directory)
    var created: [StackLaneWorktree] = []
    do {
      try FileManager.default.createDirectory(at: laneDirectory, withIntermediateDirectories: true)
      for (index, tree) in worktrees.enumerated() {
        if case .create = plans[tree.source] {
          try await addWorktree(tree, branch: branch, from: info.from)
          created.append(tree)
        }
        worktrees[index].baseCommit = try? await git(["rev-parse", "HEAD"], at: tree.path)
        if tree.managed, FileManager.default.fileExists(atPath: tree.path.appendingPathComponent(".gitmodules").path) {
          _ = try await git(["submodule", "update", "--init", "--recursive"], at: tree.path, timeout: 600)
        }
      }
      record.worktrees = worktrees
      // CWDs may not exist on an older branch, or may resolve through an escaping symlink.
      let isolated = source.services.filter { mode(of: $0, in: source, worktrees: worktrees) == .isolate }.map { ($0.id, $0.directory) }
        + source.tasks.map { ($0.id, $0.directory) }
      for (name, original) in isolated {
        guard let folder = remap(original, worktrees: worktrees) else { continue }
        guard FileManager.default.fileExists(atPath: folder.path),
          worktrees.contains(where: { relative(folder, to: $0.path) != nil }) else {
          throw StackError.message("\(name)'s folder is missing or outside the lane on branch \(branch).")
        }
      }
      let patterns = (settings?.copy ?? []) + request.copy
      record.copied = try copyFiles(patterns, link: settings?.link ?? [], worktrees: worktrees.filter { plans[$0.source].map { if case .create = $0 { return true }; return false } ?? false })
      record.ready = true
      try write(record, in: directory)
      return Creation(record: record, warnings: warnings)
    } catch {
      var cleanupFailed = false
      for tree in created.reversed() where FileManager.default.fileExists(atPath: tree.path.path) {
        do {
          for file in record.copied where relative(file.path, to: tree.path) != nil { try? FileManager.default.removeItem(at: file.path) }
          let inspection = try await inspect(tree, copied: [])
          guard inspection.changes.isEmpty, inspection.ignored.isEmpty else { throw StackError.message("Files were added") }
          _ = try await git(["worktree", "remove", "--", tree.path.path], at: tree.source)
        } catch { cleanupFailed = true }
      }
      if !cleanupFailed {
        try? FileManager.default.removeItem(at: manifest(id: id, in: directory))
        _ = rmdir(directory.appendingPathComponent(id).path)
        removeEmptyFolders(from: laneDirectory, upTo: laneRoot(settings: settings, default: worktreeRoot, source: source))
      }
      throw StackError.message(error.localizedDescription + (cleanupFailed
        ? " Lane recovery record kept at \(directory.appendingPathComponent(id).path)."
        : " No source checkout was changed; any newly created branches were kept."))
    }
  }

  static func laneRoot(settings: StackLaneSettings?, default root: URL, source: StackDefinition) -> URL {
    guard let text = settings?.directory, !text.isEmpty else { return root.standardizedFileURL }
    return StackDefinitionLoader.resolve(text, relativeTo: source.file.deletingLastPathComponent())
  }

  private static func uniqueSlug(_ base: String, source: String, existing: [StackLaneRecord], root: URL) -> String {
    var slug = base, number = 2
    let taken = Set(existing.filter { $0.info.sourceStackID == source }.map(\.info.effectiveSlug))
    while taken.contains(slug) || FileManager.default.fileExists(atPath: root.appendingPathComponent(source).appendingPathComponent(slug).path) {
      slug = "\(base)-\(number)"; number += 1
    }
    return slug
  }

  /// Local branch → check it out. Only on a remote → track it. Otherwise branch from `from` (default HEAD).
  private static func addWorktree(_ tree: StackLaneWorktree, branch: String, from: String?) async throws {
    let local = try await git(["for-each-ref", "--format=%(refname)", "refs/heads/" + branch], at: tree.source)
      .components(separatedBy: "\n").contains("refs/heads/" + branch)
    if local {
      _ = try await git(["worktree", "add", "--", tree.path.path, branch], at: tree.source)
      return
    }
    let remotes = try await git(["for-each-ref", "--format=%(refname:short)", "refs/remotes/*/" + branch], at: tree.source)
      .components(separatedBy: "\n").filter { !$0.isEmpty && !$0.hasSuffix("/HEAD") }
    if let remote = remotes.first(where: { $0.hasPrefix("origin/") }) ?? (remotes.count == 1 ? remotes.first : nil) {
      _ = try await git(["worktree", "add", "--track", "-b", branch, "--", tree.path.path, remote], at: tree.source)
      return
    }
    if remotes.count > 1 {
      throw StackError.message("Branch \(branch) exists on several remotes (\(remotes.joined(separator: ", "))). Create the local branch first.")
    }
    let start = from ?? "HEAD"
    guard (try? await git(["rev-parse", "--verify", "--quiet", start + "^{commit}"], at: tree.source)) != nil else {
      throw StackError.message("\(start) does not exist in \(tree.source.path). Fetch it or choose another start point.")
    }
    _ = try await git(["worktree", "add", "--no-track", "-b", branch, "--", tree.path.path, start], at: tree.source)
  }

  // MARK: Copy and link

  /// Copies (or links) matching untracked files from each repository's original checkout.
  static func copyFiles(_ copy: [String], link: [String], worktrees: [StackLaneWorktree]) throws -> [StackLaneCopiedFile] {
    var result: [StackLaneCopiedFile] = []
    for tree in worktrees {
      for (patterns, linking) in [(copy, false), (link, true)] {
        for pattern in patterns {
          for match in expand(pattern, in: tree.source) {
            guard let suffix = relative(match, to: tree.source), !suffix.isEmpty else { continue }
            let target = tree.path.appendingPathComponent(suffix)
            // Never replace what the branch already has.
            if (try? FileManager.default.destinationOfSymbolicLink(atPath: target.path)) != nil || FileManager.default.fileExists(atPath: target.path) { continue }
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            if linking {
              try FileManager.default.createSymbolicLink(at: target, withDestinationURL: match)
              result.append(.init(path: target, hash: nil, link: true))
            } else {
              try FileManager.default.copyItem(at: match, to: target)
              result.append(.init(path: target, hash: hash(target)))
            }
          }
        }
      }
    }
    return result
  }

  /// Segment-wise `fnmatch` expansion relative to `root`. `**` is not supported.
  static func expand(_ pattern: String, in root: URL) -> [URL] {
    var current = [root]
    for segment in pattern.split(separator: "/").map(String.init) where !segment.isEmpty && segment != "." {
      var next: [URL] = []
      for folder in current {
        if segment.contains(where: { "*?[".contains($0) }) {
          let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
          for name in names.sorted() where name != ".git" && fnmatch(segment, name, 0) == 0 {
            if segment.hasPrefix(".") || !name.hasPrefix(".") { next.append(folder.appendingPathComponent(name)) }
          }
        } else if FileManager.default.fileExists(atPath: folder.appendingPathComponent(segment).path) {
          next.append(folder.appendingPathComponent(segment))
        }
      }
      current = next
    }
    return current == [root] ? [] : current
  }

  static func hash(_ url: URL) -> String? {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory), !isDirectory.boolValue,
      let data = try? Data(contentsOf: url) else { return nil }
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  // MARK: Ports

  /// Blocks of ten from 20000, so a lane's ports sit together and stay predictable.
  /// A block is free when none of its ports is used and the needed ones can be bound.
  static func allocate(_ keys: [String], excluding used: Set<Int>) throws -> [String: Int] {
    guard !keys.isEmpty else { return [:] }
    let size = max(blockSize, (keys.count + blockSize - 1) / blockSize * blockSize)
    var start = firstPort
    while start + size - 1 <= lastPort {
      let block = start..<(start + size)
      if !block.contains(where: used.contains), block.prefix(keys.count).allSatisfy(isBindable) {
        return Dictionary(uniqueKeysWithValues: zip(keys, block))
      }
      start += size
    }
    throw StackError.message("No available lane ports in \(firstPort)–\(lastPort)")
  }

  /// Ports for services added after the lane was created: free slots in the lane's own blocks first.
  static func extend(_ ports: [String: Int], adding keys: [String], excluding used: Set<Int>) throws -> [String: Int] {
    var result = ports
    var taken = used.union(ports.values)
    let blocks = Set(ports.values.map { $0 / blockSize * blockSize })
    for key in keys where result[key] == nil {
      let slot = blocks.sorted().flatMap { $0..<($0 + blockSize) }.first { !taken.contains($0) && isBindable($0) }
      let port = try slot ?? availablePort(excluding: taken)
      result[key] = port; taken.insert(port)
    }
    return result
  }

  /// Reserve against all saved lanes, base definitions and live launches, then
  /// test both address families. Launch still rechecks conflicts with outsiders.
  static func availablePort(excluding used: Set<Int>) throws -> Int {
    for port in firstPort...lastPort where !used.contains(port) && isBindable(port) { return port }
    throw StackError.message("No available lane ports in \(firstPort)–\(lastPort)")
  }

  static func isBindable(_ port: Int) -> Bool {
    let v4 = socket(AF_INET, SOCK_STREAM, 0), v6 = socket(AF_INET6, SOCK_STREAM, 0)
    defer { if v4 >= 0 { close(v4) }; if v6 >= 0 { close(v6) } }
    guard v4 >= 0, v6 >= 0 else { return false }
    var only: Int32 = 1
    _ = setsockopt(v6, IPPROTO_IPV6, IPV6_V6ONLY, &only, socklen_t(MemoryLayout<Int32>.size))
    var a4 = sockaddr_in(); a4.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    a4.sin_family = sa_family_t(AF_INET); a4.sin_port = UInt16(port).bigEndian
    var a6 = sockaddr_in6(); a6.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
    a6.sin6_family = sa_family_t(AF_INET6); a6.sin6_port = UInt16(port).bigEndian
    let b4 = withUnsafePointer(to: &a4) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(v4, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    let b6 = withUnsafePointer(to: &a6) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(v6, $0, socklen_t(MemoryLayout<sockaddr_in6>.size)) } }
    return b4 == 0 && b6 == 0
  }

  // MARK: Removal

  struct Inspection: Sendable {
    var changes: [String] = []
    var ignored: [StackLaneIgnoredEntry] = []
  }

  /// Tracked and untracked changes block removal. Ignored files are listed; unchanged
  /// copies Cinderdeck made, and links it created, are not.
  static func inspect(_ tree: StackLaneWorktree, copied: [StackLaneCopiedFile]) async throws -> Inspection {
    var result = Inspection()
    let output = try await git(["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignored=traditional"], at: tree.path)
    let ours = Dictionary(copied.map { ($0.path.standardizedFileURL.path, $0) }, uniquingKeysWith: { first, _ in first })
    var fields = output.split(separator: "\0", omittingEmptySubsequences: true).map(String.init)[...]
    while let entry = fields.popFirst() {
      guard entry.count > 3 else { continue }
      let code = String(entry.prefix(2)), path = String(entry.dropFirst(3))
      if code.first == "R" || code.first == "C" { _ = fields.popFirst() }
      let absolute = tree.path.appendingPathComponent(path).standardizedFileURL.path.replacingOccurrences(of: "/$", with: "", options: .regularExpression)
      if let file = ours[absolute] {
        if file.link { continue }
        if let hash = file.hash, Self.hash(URL(fileURLWithPath: absolute)) == hash { continue }
        if file.hash == nil, code == "!!" { continue }
        result.ignored.append(.init(path: absolute, bytes: nil, note: "changed after Cinderdeck copied it"))
        continue
      }
      if code == "!!" { result.ignored.append(.init(path: absolute, bytes: nil)) }
      else { result.changes.append("\(code) \(path)") }
    }
    if !result.ignored.isEmpty {
      let sizes = await diskUsage(result.ignored.map { URL(fileURLWithPath: $0.path) })
      result.ignored = result.ignored.map { .init(path: $0.path, bytes: sizes[$0.path], note: $0.note) }
    }
    return result
  }

  /// Worktrees removal may delete: managed, present, and not used by another lane.
  static func removable(_ record: StackLaneRecord, others: [StackLaneRecord]) -> [StackLaneWorktree] {
    record.worktrees.filter { tree in
      tree.managed && FileManager.default.fileExists(atPath: tree.path.path)
        && !others.contains { $0.id != record.id && $0.worktrees.contains { samePath($0.path, tree.path) } }
    }
  }

  /// Throws when removal would lose work. Returns the ignored files removal would delete.
  static func check(_ record: StackLaneRecord, others: [StackLaneRecord], options: StackLaneRemovalOptions) async throws -> [StackLaneIgnoredEntry] {
    guard !options.keepWorktrees else { return [] }
    var ignored: [StackLaneIgnoredEntry] = []
    for tree in removable(record, others: others) {
      let inspection = try await inspect(tree, copied: record.copied)
      guard inspection.changes.isEmpty else {
        let sample = inspection.changes.prefix(5).joined(separator: ", ")
        throw StackControlError(code: "dirty", message: "Lane has local changes in \(tree.path.path): \(sample)\(inspection.changes.count > 5 ? ", …" : ""). Commit or move them before removal.")
      }
      ignored += inspection.ignored
    }
    if !ignored.isEmpty, !options.discardIgnored {
      let total = ignored.compactMap(\.bytes).reduce(0, +)
      let list = ignored.prefix(8).map { entry in
        let size = entry.bytes.map { " (" + ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) + ")" } ?? ""
        return entry.path + size + (entry.note.map { " — " + $0 } ?? "")
      }.joined(separator: "\n  ")
      throw StackControlError(code: "ignored_files",
        message: "Lane has ignored files (\(ByteCountFormatter.string(fromByteCount: total, countStyle: .file))):\n  \(list)\(ignored.count > 8 ? "\n  …" : "")\nPass discard_ignored=true (CLI: --discard-ignored) to delete them with the lane, or move what you need first.")
    }
    return ignored
  }

  /// Removes the lane's managed worktrees (unless kept) and its record. Branches are kept.
  static func remove(_ record: StackLaneRecord, in directory: URL, others: [StackLaneRecord],
    options: StackLaneRemovalOptions) async throws -> StackLaneRemovalReport {
    var report = StackLaneRemovalReport()
    report.ignored = try await check(record, others: others, options: options)
    let removable = options.keepWorktrees ? [] : removable(record, others: others)
    for tree in record.worktrees {
      if await hasRemote(tree.source), let branch = try? await git(["branch", "--show-current"], at: tree.path), !branch.isEmpty,
        let count = Int((try? await git(["rev-list", "--count", branch, "--not", "--remotes"], at: tree.source)) ?? ""), count > 0 {
        report.unpushed[branch] = count
      }
      if !removable.contains(tree) { report.keptWorktrees.append(tree.path.path) }
    }
    for tree in removable {
      for file in record.copied where file.link && relative(file.path, to: tree.path) != nil {
        if (try? FileManager.default.destinationOfSymbolicLink(atPath: file.path.path)) != nil { try FileManager.default.removeItem(at: file.path) }
      }
      // Only ignored files remain (checked above): unchanged copies, or what the caller agreed to discard.
      _ = try await git(["clean", "-fdX"], at: tree.path, timeout: 600)
      _ = try await git(["worktree", "remove", "--", tree.path.path], at: tree.source, timeout: 300)
      report.removedWorktrees.append(tree.path.path)
    }
    try FileManager.default.removeItem(at: manifest(id: record.id, in: directory))
    // Only remove now-empty folders, never recursively delete unexpected user files.
    _ = rmdir(directory.appendingPathComponent(record.id).path)
    if !options.keepWorktrees { removeEmptyFolders(from: record.info.directory, upTo: record.info.directory.deletingLastPathComponent().deletingLastPathComponent()) }
    return report
  }

  static func removeEmptyFolders(from folder: URL, upTo stop: URL) {
    var current = folder.standardizedFileURL
    let stop = stop.standardizedFileURL
    while current.path.count > stop.path.count, current.path.hasPrefix(stop.path), rmdir(current.path) == 0 {
      current = current.deletingLastPathComponent().standardizedFileURL
    }
  }

  // MARK: Status

  /// Merged: every branch with commits since the lane started is contained in the default remote branch.
  /// Upstream gone: a tracked remote branch was deleted, as after merging a pull request.
  static func gitState(_ record: StackLaneRecord) async -> StackLaneGitState {
    var state = StackLaneGitState()
    var progressed = 0, merged = 0
    for tree in record.worktrees where FileManager.default.fileExists(atPath: tree.path.path) {
      guard let branch = try? await git(["branch", "--show-current"], at: tree.path), !branch.isEmpty else { continue }
      state.branches.append(branch)
      if (try? await git(["for-each-ref", "--format=%(upstream:track)", "refs/heads/" + branch], at: tree.path)) == "[gone]" {
        state.upstreamGone = true
      }
      // Without a remote every commit would count; that says nothing about lost work.
      if await hasRemote(tree.path), let count = Int((try? await git(["rev-list", "--count", branch, "--not", "--remotes"], at: tree.path)) ?? "") {
        state.unpushed += count
      }
      guard let tip = try? await git(["rev-parse", branch], at: tree.path), tip != tree.baseCommit else { continue }
      progressed += 1
      var target = try? await git(["rev-parse", "--abbrev-ref", "origin/HEAD"], at: tree.path)
      if target == nil {
        for name in ["origin/main", "origin/master"] where (try? await git(["rev-parse", "--verify", "--quiet", name], at: tree.path)) != nil {
          target = name; break
        }
      }
      if let target, let result = try? await gitResult(["merge-base", "--is-ancestor", branch, target], at: tree.path), result.status == 0 {
        merged += 1
      }
    }
    state.merged = progressed > 0 && merged == progressed
    return state
  }

  /// Allocated size of each path, keyed by path.
  static func diskUsage(_ paths: [URL]) async -> [String: Int64] {
    guard !paths.isEmpty else { return [:] }
    var result: [String: Int64] = [:]
    for chunk in stride(from: 0, to: paths.count, by: 64).map({ Array(paths[$0..<min($0 + 64, paths.count)]) }) {
      guard let output = try? await StackCommandRunner.run("/usr/bin/du", ["-sk"] + chunk.map(\.path), timeout: 60) else { continue }
      for line in output.text.split(separator: "\n") {
        let parts = line.split(separator: "\t", maxSplits: 1)
        guard parts.count == 2, let kilobytes = Int64(parts[0]) else { continue }
        result[URL(fileURLWithPath: String(parts[1])).standardizedFileURL.path] = kilobytes * 1024
      }
    }
    return result
  }

  static func samePath(_ left: URL, _ right: URL) -> Bool {
    left.resolvingSymlinksInPath().standardizedFileURL.path == right.resolvingSymlinksInPath().standardizedFileURL.path
  }

  static func relative(_ path: URL, to root: URL) -> String? {
    let path = path.resolvingSymlinksInPath().standardizedFileURL.path
    let root = root.resolvingSymlinksInPath().standardizedFileURL.path
    if path == root { return "" }
    guard path.hasPrefix(root == "/" ? "/" : root + "/") else { return nil }
    return String(path.dropFirst(root == "/" ? 1 : root.count + 1))
  }
}
