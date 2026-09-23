import AppKit
import Combine
import SwiftUI

struct StackBranchPickerContext: Identifiable {
  let stackID: String
  let repo: RepoDefinition
  var id: String { stackID + "/" + repo.id }
}

struct StackBranchChoice: Identifiable {
  let name: String
  let branches: [String: GitBranch]
  var id: String { name }
}

struct StackEditorContext: Identifiable {
  let file: URL?
  var id: String { file?.path ?? "new-stack" }
}

@MainActor
final class StacksViewModel: ObservableObject {
  @Published private(set) var files: [StackDefinitionFile] = []
  @Published private(set) var states: [String: StackRuntimeState] = [:]
  @Published private(set) var repoStatuses: [URL: GitRepoStatus] = [:]
  @Published var selectedStackID: String?
  @Published var selectedServiceID: String?
  @Published var stackFilter = ""
  @Published var logFilter = ""
  @Published var logService: String?
  @Published var autoScroll = true
  @Published var logFocused = false
  @Published var logFocusRequest = 0
  @Published private(set) var logLines: [StackLogLine] = []
  @Published private(set) var activity: [StackEventRecord] = []
  @Published var error: String?
  @Published var branchPicker: StackBranchPickerContext?
  @Published private(set) var branches: [GitBranch] = []
  @Published private(set) var recentBranches: [String] = []
  @Published private(set) var loadingBranches = false
  @Published private(set) var stashes: [URL: [GitStash]] = [:]
  @Published var stackBranchPicker = false
  @Published private(set) var stackBranches: [StackBranchChoice] = []
  @Published var editor: StackEditorContext?
  @Published private(set) var isConfirming = false
  @Published private(set) var busyRepos = Set<URL>()
  let supervisor: StackSupervisor
  private let git: GitService
  private var subscriptions = Set<AnyCancellable>()
  private var logTask: Task<Void, Never>?
  private var visible = false
  private var expanded = false

  init(supervisor: StackSupervisor? = nil, git: GitService = .shared) {
    let supervisor = supervisor ?? .shared
    self.supervisor = supervisor; self.git = git
    supervisor.$files.sink { [weak self] files in
      guard let self else { return }
      self.files = files
      if !files.contains(where: { $0.id == self.selectedStackID }) { self.selectedStackID = files.first?.id }
    }.store(in: &subscriptions)
    supervisor.$states.assign(to: &$states)
    supervisor.gitMonitor.$statuses.assign(to: &$repoStatuses)
    supervisor.$errorMessage.compactMap { $0 }.sink { [weak self] in self?.error = $0 }.store(in: &subscriptions)
    let manager = HistoryFloatingManager.shared
    Publishers.CombineLatest3(manager.$panelIsVisible, manager.$selectedSection, manager.$presentationMode)
      .debounce(for: .milliseconds(20), scheduler: RunLoop.main)
      .sink { [weak self] visible, section, mode in
        self?.setPresentation(visible: visible && section == .stacks, expanded: mode == .expanded)
      }.store(in: &subscriptions)
  }

  var runningCount: Int { states.values.filter(\.isActive).count }
  var filteredFiles: [StackDefinitionFile] {
    files.filter { stackFilter.isEmpty || $0.name.localizedCaseInsensitiveContains(stackFilter) || $0.id.localizedCaseInsensitiveContains(stackFilter) }
  }
  var selectedFile: StackDefinitionFile? { files.first { $0.id == selectedStackID } }
  var selectedDefinition: StackDefinition? { selectedFile?.definition }
  var selectedState: StackRuntimeState { selectedStackID.flatMap { states[$0] } ?? .init() }
  var selectedServices: [ServiceDefinition] {
    var services = selectedDefinition?.services ?? []
    for runtime in selectedState.services.values {
      if let service = runtime.launchDefinition?.service, !services.contains(where: { $0.id == service.id }) { services.append(service) }
    }
    return services.sorted { $0.id < $1.id }
  }
  var filteredLogs: [StackLogLine] {
    logLines.filter { logFilter.isEmpty || AnsiParser.plainText($0.text).localizedCaseInsensitiveContains(logFilter) }
  }
  var hasAuxiliaryUI: Bool { branchPicker != nil || stackBranchPicker || editor != nil || isConfirming }
  func runtime(_ stack: String, _ service: String) -> StackServiceRuntime { states[stack]?.services[service] ?? .init() }
  func isBusy(_ stack: String) -> Bool { states[stack]?.operation != nil || supervisor.isBootstrapping }
  func status(_ repo: RepoDefinition) -> GitRepoStatus { repoStatuses[repo.path] ?? .init(branch: "Loading…") }
  func canSwitch(stack: String, repo: String) -> Bool {
    guard !isBusy(stack) else { return false }
    let services = files.first { $0.id == stack }?.definition?.services.filter { $0.repo == repo } ?? []
    return !services.contains { [.starting, .stopping, .waiting].contains(runtime(stack, $0.id).phase) }
  }
  func select(_ stack: String) {
    selectedStackID = stack; selectedServiceID = nil; logService = nil; logFocused = false
    logLines = []; activity = []
    refreshLogs()
    refreshStashes()
  }
  func moveSelection(_ delta: Int) {
    let files = filteredFiles
    guard !files.isEmpty else { return }
    let index = files.firstIndex { $0.id == selectedStackID } ?? 0
    select(files[min(max(index + delta, 0), files.count - 1)].id)
  }
  func setPresentation(visible: Bool, expanded: Bool) {
    self.visible = visible; self.expanded = expanded
    supervisor.gitMonitor.setVisible(visible)
    logTask?.cancel(); logTask = nil
    guard visible else { return }
    refreshStashes()
    guard expanded else { return }
    logTask = Task { [weak self] in
      var lastActivity = Date.distantPast
      while !Task.isCancelled {
        guard let self else { return }
        if let id = selectedStackID {
          let lines = await supervisor.logLines(stack: id, service: logService)
          if id == selectedStackID, lines != logLines { logLines = lines }
          if Date().timeIntervalSince(lastActivity) > 2 {
            let events = await supervisor.events(stack: id)
            if id == selectedStackID { activity = events }
            lastActivity = Date()
          }
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
    }
  }
  private func refreshLogs() {
    Task {
      guard let id = selectedStackID else { return }
      let lines = await supervisor.logLines(stack: id, service: logService)
      if id == selectedStackID { logLines = lines }
    }
  }
  func toggle(_ id: String) {
    Task { if states[id]?.isActive == true { await supervisor.stop(stack: id) } else { await supervisor.start(stack: id) } }
  }
  func stop(_ id: String, service: String? = nil) { Task { await supervisor.stop(stack: id, services: service.map { [$0] }) } }
  func start(_ id: String, service: String) { Task { await supervisor.start(stack: id, services: [service]) } }
  func restart(_ id: String, service: String? = nil, dependents: Bool = false) {
    Task { await supervisor.restart(stack: id, service: service, includeDependents: dependents) }
  }
  func command(_ command: StackKeyboardCommand, manager: HistoryFloatingManager) {
    guard !hasAuxiliaryUI, let id = selectedStackID else { return }
    switch command {
    case .toggle: toggle(id)
    case .stop: stop(id)
    case .restart: restart(id)
    case .restartService: if expanded, let service = selectedServiceID { restart(id, service: service) }
    case .branch:
      let repoID = selectedServices.first { $0.id == selectedServiceID }?.repo
      if let repo = repoID.flatMap({ selectedDefinition?.repo($0) }) ?? selectedDefinition?.repos.first { openBranchPicker(stack: id, repo: repo) }
    case .logs: showLogs(stack: id, service: selectedServiceID, manager: manager)
    }
  }
  func showLogs(stack: String, service: String?, manager: HistoryFloatingManager) {
    selectedStackID = stack; logService = service
    if manager.presentationMode != .expanded { manager.showExpanded() }
    logFocused = true; logFocusRequest += 1; refreshLogs()
  }
  func copyLogs() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(filteredLogs.map { "\($0.service) | \(AnsiParser.plainText($0.text))" }.joined(separator: "\n"), forType: .string)
  }
  func clearLogs() {
    guard let id = selectedStackID else { return }
    Task { await supervisor.clearLogs(stack: id, service: logService); refreshLogs() }
  }
  func openPort(_ port: Int) { if let url = URL(string: "http://localhost:\(port)") { NSWorkspace.shared.open(url) } }
  func openRepo(_ repo: RepoDefinition, inCode: Bool = false) {
    if inCode {
      var components = URLComponents()
      components.scheme = "vscode"; components.host = "file"; components.path = repo.path.path
      if let url = components.url { NSWorkspace.shared.open(url) }
    } else { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: repo.path.path) }
  }
  func edit(_ file: StackDefinitionFile) { editor = .init(file: file.file) }
  func create() { editor = .init(file: nil) }
  func openInEditor(_ file: StackDefinitionFile) { NSWorkspace.shared.open(file.file) }
  func refreshEnvironment(_ stack: StackDefinition?) {
    Task {
      do {
        _ = try await ShellEnvironmentResolver.shared.resolve(shell: stack?.shell ?? ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh", refresh: true)
        toast("Shell environment refreshed")
      } catch { self.error = error.localizedDescription }
    }
  }

  func openBranchPicker(stack: String, repo: RepoDefinition) {
    guard canSwitch(stack: stack, repo: repo.id), !busyRepos.contains(repo.path) else { return }
    let context = StackBranchPickerContext(stackID: stack, repo: repo)
    branchPicker = context; branches = []; recentBranches = []; loadingBranches = true
    Task {
      do {
        let all = try await git.branches(at: repo.path)
        let recent = (try? await git.recentBranches(at: repo.path)) ?? []
        guard branchPicker?.id == context.id else { return }
        branches = all; recentBranches = recent; loadingBranches = false
      } catch { self.error = error.localizedDescription; loadingBranches = false }
    }
  }
  func chooseBranch(_ branch: GitBranch) {
    guard let context = branchPicker else { return }
    branchPicker = nil
    Task { await switchBranches(stack: context.stackID, choices: [context.repo.id: branch]) }
  }
  func openStackBranchPicker() {
    guard let stack = selectedDefinition, !isBusy(stack.id) else { return }
    stackBranchPicker = true; stackBranches = []; loadingBranches = true
    Task {
      do {
        var choices: [String: [String: GitBranch]] = [:]
        for repo in stack.repos {
          for branch in try await git.branches(at: repo.path) {
            if choices[branch.name]?[repo.id] == nil || !branch.isRemote { choices[branch.name, default: [:]][repo.id] = branch }
          }
        }
        stackBranches = choices.map { .init(name: $0.key, branches: $0.value) }.sorted { $0.name < $1.name }
      } catch { self.error = error.localizedDescription }
      loadingBranches = false
    }
  }
  func chooseStackBranch(_ choice: StackBranchChoice) {
    guard let stack = selectedDefinition else { return }
    stackBranchPicker = false
    let unchanged = stack.repos.filter { choice.branches[$0.id] == nil }.map(\.id)
    let message = "Switch \(choice.branches.count) of \(stack.repos.count) repos to \(choice.name)." +
      (unchanged.isEmpty ? "" : "\nThese repos stay on their current branch: \(unchanged.joined(separator: ", ")).")
    guard confirm(title: "Switch stack branches?", message: message, buttons: ["Switch", "Cancel"]) == 0 else { return }
    Task { await switchBranches(stack: stack.id, choices: choice.branches) }
  }

  private func switchBranches(stack id: String, choices: [String: GitBranch]) async {
    guard let stack = supervisor.definition(id) else { return }
    let repos = stack.repos.filter { choices[$0.id] != nil }
    guard repos.allSatisfy({ !busyRepos.contains($0.path) }) else { return }
    repos.forEach { busyRepos.insert($0.path) }
    defer { repos.forEach { busyRepos.remove($0.path) }; refreshStashes() }
    do {
      var dirty: [String] = []
      var transitions: [String] = []
      for repo in repos {
        let status = try await git.status(at: repo.path)
        if let branch = choices[repo.id] { transitions.append("\(repo.id): \(status.branchLabel) → \(branch.name)") }
        if let operation = status.operation { throw StackError.message("\(repo.id): \(operation) — resolve in a terminal") }
        if status.isDirty { dirty.append(repo.id) }
      }
      var strategy = GitDirtyStrategy.requireClean
      if !dirty.isEmpty {
        switch confirm(title: "Uncommitted changes", message: "\(dirty.joined(separator: ", ")) has local changes. Stashes include untracked files and are never restored automatically. Switching anyway lets Git carry changes that do not conflict.",
          buttons: ["Stash & switch", "Switch anyway", "Cancel"]) {
        case 0: strategy = .stash
        case 1: strategy = .carry
        default: return
        }
      }
      try await supervisor.performGitChange(stack: id, repos: Set(choices.keys), eventDetail: transitions.joined(separator: ", ")) {
        var completed: [String] = []
        for repo in repos {
          guard let branch = choices[repo.id] else { continue }
          do { try await git.switchBranch(branch, at: repo.path, dirty: strategy); completed.append(repo.id) }
          catch {
            throw StackError.message("\(repo.id): \(error.localizedDescription)" + (completed.isEmpty ? "" : "\nAlready switched: \(completed.joined(separator: ", ")). Remaining repos were not changed."))
          }
        }
      }
      toast(repos.count == 1 ? "Switched to \(choices.values.first?.name ?? "branch")" : "Switched \(repos.count) repos")
    } catch { self.error = error.localizedDescription }
    for repo in repos { await supervisor.gitMonitor.refresh(repo.path) }
  }

  func fetch(_ repo: RepoDefinition) { gitAction(repo) { try await self.git.fetch(at: repo.path) } }
  func pull(_ repo: RepoDefinition, stack: String) {
    gitAction(repo) {
      try await self.supervisor.performGitChange(stack: stack, repos: [repo.id], eventKind: "pulled", eventDetail: repo.id) { try await self.git.pull(at: repo.path) }
    }
  }
  private func gitAction(_ repo: RepoDefinition, action: @escaping () async throws -> Void) {
    guard !busyRepos.contains(repo.path) else { return }
    busyRepos.insert(repo.path)
    Task {
      defer { busyRepos.remove(repo.path) }
      do { try await action(); await supervisor.gitMonitor.refresh(repo.path) }
      catch { self.error = error.localizedDescription }
    }
  }
  private func refreshStashes() {
    guard let stack = selectedDefinition else { return }
    Task { for repo in stack.repos { stashes[repo.path] = (try? await git.stashes(at: repo.path)) ?? [] } }
  }
  func useStash(_ stash: GitStash, repo: RepoDefinition, drop: Bool) {
    guard confirm(title: drop ? "Delete this Snapzy stash?" : "Restore this Snapzy stash?",
      message: stash.message + (drop ? "\nThis permanently removes the saved stash." : "\nGit may report conflicts. The stash is kept if restoration fails."),
      buttons: [drop ? "Drop stash" : "Pop stash", "Cancel"]) == 0 else { return }
    gitAction(repo) {
      try await self.git.applyStash(stash, at: repo.path, drop: drop)
      self.refreshStashes()
    }
  }
  func killConflict(stack id: String, service: String, startAfter: Bool) {
    guard let conflict = runtime(id, service).conflict,
      confirm(title: startAfter ? "Kill port owner & start?" : "Kill port owner?",
        message: conflict.description + "\nThis stops the listed process. Unsaved work in it may be lost.",
        buttons: [startAfter ? "Kill & start" : "Kill", "Cancel"]) == 0 else { return }
    Task {
      do { try await supervisor.killPortOwner(stack: id, service: service, startAfter: startAfter) }
      catch { self.error = error.localizedDescription }
    }
  }
  private func confirm(title: String, message: String, buttons: [String]) -> Int {
    isConfirming = true
    HistoryFloatingManager.shared.isPresentingAuxiliaryUI = true
    defer {
      HistoryFloatingManager.shared.focusPanel()
      isConfirming = false
      HistoryFloatingManager.shared.isPresentingAuxiliaryUI = hasAuxiliaryUI
    }
    let alert = NSAlert()
    alert.messageText = title; alert.informativeText = message; alert.alertStyle = .warning
    buttons.forEach { alert.addButton(withTitle: $0) }
    return alert.runModal().rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
  }
  private func toast(_ message: String) { AppToastManager.shared.show(message: message, style: .success, variant: .compact) }
}
