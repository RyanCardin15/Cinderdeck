import Combine
import Foundation

nonisolated struct WorkspaceFolderSelection: Equatable, Identifiable, Sendable {
  let id = UUID()
  var path: String
}

@MainActor
final class WorkspaceSetupModel: ObservableObject {
  @Published var name = ""
  @Published var folder = "" { didSet { if folder != oldValue { folderChanged() } } }
  @Published var additionalFolders: [WorkspaceFolderSelection] = [] { didSet { if additionalFolders != oldValue { folderChanged() } } }
  @Published var repositories: [RepoDefinition] = [] { didSet { if repositories != oldValue { edited() } } }
  @Published var copyEnvironmentFiles = false { didSet { edited() } }
  @Published var setupTask = "" { didSet { edited() } }
  @Published var commands: [WorkspaceDiscoveredCommand] = [] { didSet { edited() } }
  @Published private(set) var proposal: WorkspaceDiscoveryResult?
  @Published private(set) var issues: [WorkspaceSetupIssue] = []
  @Published private(set) var isBusy = false
  @Published private(set) var isChecked = false
  @Published var error: String?
  private var operation: Task<Void, Never>?
  private var generation = UUID()

  // No actor-bound teardown: Swift 6.2 isolated deinit crashes on older macOS runtimes.
  nonisolated deinit {}

  var selectedServiceCount: Int { commands.filter { $0.selected && $0.kind == .service }.count }
  var canStart: Bool { isChecked && selectedServiceCount > 0 && !issues.contains { $0.severity == .blocker } }

  func folderChanged() {
    cancel()
    proposal = nil; commands = []; repositories = []; setupTask = ""; issues = []; isChecked = false; error = nil
  }
  func edited() { isChecked = false; error = nil }
  func cancel() { operation?.cancel(); generation = UUID(); isBusy = false }

  func addFolders(_ paths: [String]) {
    var known = Set(additionalFolders.map(\.path) + [folder])
    var newPaths = paths.filter { known.insert($0).inserted }
    if folder.isEmpty, !newPaths.isEmpty { folder = newPaths.removeFirst() }
    guard additionalFolders.count + newPaths.count <= 63 else { error = "Choose up to 64 workspace folders."; return }
    additionalFolders += newPaths.map { WorkspaceFolderSelection(path: $0) }
  }

  func discover() {
    cancel(); error = nil; isBusy = true; isChecked = false
    let token = generation
    let root = URL(fileURLWithPath: (folder as NSString).expandingTildeInPath, isDirectory: true)
    let extra = additionalFolders.map { URL(fileURLWithPath: ($0.path as NSString).expandingTildeInPath, isDirectory: true) }
    operation = Task {
      do {
        let scan = Task.detached(priority: .utility) { try WorkspaceDiscovery.discover(root: root, additionalFolders: extra) }
        let result = try await withTaskCancellationHandler { try await scan.value } onCancel: { scan.cancel() }
        guard generation == token, !Task.isCancelled else { return }
        proposal = result; commands = result.commands; repositories = result.repositories; issues = []
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { name = result.root.lastPathComponent }
        await performCheck(token: token)
      } catch {
        guard generation == token, !Task.isCancelled else { return }
        self.error = error.localizedDescription
      }
      if generation == token { isBusy = false }
    }
  }

  func check() {
    guard proposal != nil else { return }
    cancel(); error = nil; isBusy = true; isChecked = false
    let token = generation
    operation = Task { await performCheck(token: token); if generation == token { isBusy = false } }
  }

  private func performCheck(token: UUID) async {
    guard let proposal else { return }
    let snapshot = commands
    let repositorySnapshot = repositories
    let copySnapshot = copyEnvironmentFiles
    let setupSnapshot = setupTask
    do {
      let environment = try await ShellEnvironmentResolver.shared.resolve(refresh: true)
      var result = await WorkspaceSetupCheck.check(root: proposal.root, commands: snapshot, environment: environment)
      do { _ = try Self.components(root: proposal.root, commands: snapshot, repositories: repositorySnapshot,
        copyEnvironmentFiles: copySnapshot, setupTask: setupSnapshot) }
      catch { result.append(.init(id: "configuration", severity: .blocker, title: "Review workspace configuration", detail: error.localizedDescription)) }
      guard generation == token, commands == snapshot, repositories == repositorySnapshot,
        copyEnvironmentFiles == copySnapshot, setupTask == setupSnapshot, !Task.isCancelled else { return }
      issues = result; isChecked = true
    } catch {
      guard generation == token, !Task.isCancelled else { return }
      issues = [.init(id: "shell", severity: .blocker, title: "Could not check your login shell", detail: "Open a terminal to check your shell configuration, then try again. " + error.localizedDescription)]
      isChecked = true
    }
  }

  func add(_ kind: WorkspaceDiscoveredCommand.Kind) {
    guard let proposal else { return }
    let id = "custom-" + UUID().uuidString.prefix(8).lowercased()
    commands.append(.init(id: id, kind: kind, title: kind == .service ? "Service" : "Task", command: "", directory: proposal.root,
      evidence: "Added manually", runtimes: []))
    edited()
  }

  func moveCommand(_ id: String, to directory: URL) {
    guard let index = commands.firstIndex(where: { $0.id == id }) else { return }
    let directory = directory.standardizedFileURL.resolvingSymlinksInPath()
    let gitRoot = WorkspaceDiscovery.repositoryRoot(containing: directory)
    let member = gitRoot ?? directory
    if !repositories.contains(where: { $0.path == member || (gitRoot == nil && StackLaneStore.relative(directory, to: $0.path) != nil) }) {
      let base = WorkspaceDefinitionWriter.workspaceID(for: member.lastPathComponent)
      var repoID = base; var suffix = 2
      while repositories.contains(where: { $0.id == repoID }) { repoID = base + "-" + String(suffix); suffix += 1 }
      repositories.append(.init(id: repoID, path: member, laneMode: gitRoot == nil ? .shared : .worktree))
      if gitRoot != nil {
        repositories.removeAll { $0.laneMode == .shared && WorkspaceDiscovery.repositoryRoot(containing: $0.path) == nil && StackLaneStore.relative(member, to: $0.path) != nil }
      }
    }
    commands[index].directory = directory
    commands[index].discoveryRoot = gitRoot ?? directory
  }

  /// Validate and save the reviewed selection. Saving never launches commands.
  func save(start: Bool, onSaved: @escaping (String, Bool) -> Void) {
    guard let proposal, !isBusy else { return }
    cancel(); isBusy = true; error = nil
    let token = generation
    operation = Task {
      if start { await performCheck(token: token) }
      guard generation == token, !Task.isCancelled else { return }
      defer { isBusy = false }
      guard !start || canStart else { error = "Resolve launch blockers and check again, or save the workspace to finish setup later."; return }
      do {
        let components = try Self.components(root: proposal.root, commands: commands, repositories: repositories,
          copyEnvironmentFiles: copyEnvironmentFiles, setupTask: setupTask)
        let file = try WorkspaceDefinitionWriter.createWorkspace(name: name, root: proposal.root.path, components: components)
        onSaved(file.deletingPathExtension().lastPathComponent, start)
      } catch { self.error = error.localizedDescription }
    }
  }

  /// Include implicit repositories used by commands, matching lane creation for
  /// existing definitions that do not declare every repository explicitly.
  nonisolated static func laneRepositories(in definition: StackDefinition) -> [RepoDefinition] {
    let shared = definition.repos.filter { $0.laneMode == .shared }.map(\.path)
    var folders = definition.repos.filter { $0.laneMode == .worktree }.map(\.path)
    folders += definition.services.filter {
      $0.laneMode != .off && $0.laneMode != .shared
        && !($0.laneMode == nil && $0.repo.flatMap(definition.repo)?.laneMode == .shared)
    }.map(\.directory)
    folders += definition.tasks.filter { $0.repo.flatMap(definition.repo)?.laneMode != .shared }.map(\.directory)
    var seen = Set<String>()
    return folders.compactMap { folder in
      guard !shared.contains(where: { StackLaneStore.relative(folder, to: $0) != nil }),
        let root = WorkspaceDiscovery.repositoryRoot(containing: folder), seen.insert(root.path).inserted else { return nil }
      let id = definition.repos.first { WorkspaceDiscovery.repositoryRoot(containing: $0.path)?.path == root.path }?.id ?? root.lastPathComponent
      return RepoDefinition(id: id, path: root)
    }
  }

  nonisolated static func laneEnvironment(_ text: String) throws -> [String: String] {
    var values: [String: String] = [:]
    for line in text.components(separatedBy: .newlines) {
      let line = line.trimmingCharacters(in: .whitespaces)
      if line.isEmpty { continue }
      guard let equals = line.firstIndex(of: "=") else { throw StackError.message("Enter lane environment overrides as KEY=value, one per line.") }
      let key = line[..<equals].trimmingCharacters(in: .whitespaces)
      guard key.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil else {
        throw StackError.message("Use a valid environment variable name: \(key).")
      }
      guard values[key] == nil else { throw StackError.message("Enter \(key) only once in lane environment overrides.") }
      values[key] = String(line[line.index(after: equals)...])
    }
    return values
  }

  nonisolated static func components(root: URL, commands: [WorkspaceDiscoveredCommand], repositories: [RepoDefinition]? = nil,
    copyEnvironmentFiles: Bool = false, setupTask: String = "") throws -> String {
    let selected = commands.filter(\.selected)
    let repos = repositories ?? WorkspaceDiscovery.repositoryRoot(containing: root).map { [RepoDefinition(id: "project", path: $0)] } ?? []
    var sections = repos.map { repo in
      WorkspaceDefinitionWriter.repo(id: repo.id, path: repo.path) + (repo.laneMode == .shared ? "\nlane = \"shared\"" : "")
    }
    // Nested Git roots cannot both be isolated. Make the choice in the form,
    // before saving a definition that would fail only when creating a lane.
    for repo in repos where repo.laneMode == .worktree && repos.contains(where: { $0.id != repo.id && StackLaneStore.relative(repo.path, to: $0.path) != nil }) {
      throw StackError.message("\(repo.id) is inside another repository. Set the nested repository to Shared in lane defaults.")
    }
    for command in selected {
      guard !command.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw StackError.message("Enter a command for \(command.title), or deselect it.")
      }
      let repo = repos.filter { StackLaneStore.relative(command.directory, to: $0.path) != nil }
        .max { $0.path.path.count < $1.path.path.count }?.id
      switch command.kind {
      case .service:
        var port: Int?
        if !command.port.isEmpty {
          guard let value = Int(command.port), (1...65535).contains(value) else { throw StackError.message("Enter a valid port for \(command.title).") }
          port = value
        }
        let service = ServiceDefinition(id: command.id, command: command.command, repo: repo, directory: command.directory,
          port: port, readiness: port.map(StackReadiness.port) ?? .alive, ports: command.extraPorts)
        sections.append(WorkspaceDefinitionWriter.service(service, base: repo.flatMap { id in repos.first { $0.id == id }?.path } ?? root))
      case .task:
        sections.append(WorkspaceDefinitionWriter.task(.init(id: command.id, name: command.title, command: command.command, repo: repo, directory: command.directory)))
      }
    }
    if copyEnvironmentFiles || !setupTask.isEmpty {
      if !setupTask.isEmpty && !selected.contains(where: { $0.kind == .task && $0.id == setupTask }) {
        throw StackError.message("Select the lane setup task, or choose None in lane defaults.")
      }
      var settings = ["[lanes]"]
      if copyEnvironmentFiles { settings.append("copy = [\".env\", \".env.local\"]") }
      if !setupTask.isEmpty { settings.append("setup = " + WorkspaceDefinitionWriter.quote("task:" + setupTask)) }
      sections.append(settings.joined(separator: "\n"))
    }
    return sections.isEmpty ? "" : "\n" + sections.joined(separator: "\n\n") + "\n"
  }
}
