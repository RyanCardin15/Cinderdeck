import Combine
import Foundation

@MainActor
final class WorkspaceSetupModel: ObservableObject {
  @Published var name = ""
  @Published var folder = "" { didSet { if folder != oldValue { folderChanged() } } }
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
    proposal = nil; commands = []; issues = []; isChecked = false; error = nil
  }
  func edited() { isChecked = false; error = nil }
  func cancel() { operation?.cancel(); generation = UUID(); isBusy = false }

  func discover() {
    cancel(); error = nil; isBusy = true; isChecked = false
    let token = generation
    let root = URL(fileURLWithPath: (folder as NSString).expandingTildeInPath, isDirectory: true)
    operation = Task {
      do {
        let scan = Task.detached(priority: .utility) { try WorkspaceDiscovery.discover(root: root) }
        let result = try await withTaskCancellationHandler { try await scan.value } onCancel: { scan.cancel() }
        guard generation == token, !Task.isCancelled else { return }
        proposal = result; commands = result.commands; issues = []
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
    do {
      let environment = try await ShellEnvironmentResolver.shared.resolve(refresh: true)
      let result = await WorkspaceSetupCheck.check(root: proposal.root, commands: snapshot, environment: environment)
      guard generation == token, commands == snapshot, !Task.isCancelled else { return }
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
        let components = try Self.components(root: proposal.root, commands: commands)
        let file = try WorkspaceDefinitionWriter.createWorkspace(name: name, root: proposal.root.path, components: components)
        onSaved(file.deletingPathExtension().lastPathComponent, start)
      } catch { self.error = error.localizedDescription }
    }
  }

  nonisolated static func components(root: URL, commands: [WorkspaceDiscoveredCommand]) throws -> String {
    let selected = commands.filter(\.selected)
    let git = FileManager.default.fileExists(atPath: root.appendingPathComponent(".git").path)
    var sections = git ? [WorkspaceDefinitionWriter.repo(id: "project", path: root)] : []
    for command in selected {
      guard !command.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw StackError.message("Enter a command for \(command.title), or deselect it.")
      }
      let repo: String? = git ? "project" : nil
      switch command.kind {
      case .service:
        var port: Int?
        if !command.port.isEmpty {
          guard let value = Int(command.port), (1...65535).contains(value) else { throw StackError.message("Enter a valid port for \(command.title).") }
          port = value
        }
        let service = ServiceDefinition(id: command.id, command: command.command, repo: repo, directory: command.directory,
          port: port, readiness: port.map(StackReadiness.port) ?? .alive, ports: command.extraPorts)
        sections.append(WorkspaceDefinitionWriter.service(service, base: root))
      case .task:
        sections.append(WorkspaceDefinitionWriter.task(.init(id: command.id, name: command.title, command: command.command, repo: repo, directory: command.directory)))
      }
    }
    return sections.isEmpty ? "" : "\n" + sections.joined(separator: "\n\n") + "\n"
  }
}
