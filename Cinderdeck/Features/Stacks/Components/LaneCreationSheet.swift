import AppKit
import SwiftUI

/// One review surface for manual, CLI, MCP, and managed-session lane creation.
struct LaneCreationOptions: Sendable {
  var request: StackLaneRequest
  var setup: Bool
  var start: Bool
}

/// Foreground branch reads must not wait behind GitService's full status scans
/// or network fetches. Read only local metadata, with four commands in flight.
private actor LaneBranchReader {
  static let shared = LaneBranchReader()
  private var active = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private func acquire() async {
    if active < StackLaneStore.repositoryConcurrency { active += 1; return }
    await withCheckedContinuation { waiters.append($0) }
  }
  private func release() {
    if waiters.isEmpty { active -= 1 } else { waiters.removeFirst().resume() }
  }
  func branches(at path: URL) async throws -> [GitBranch] {
    await acquire(); defer { release() }
    try Task.checkCancellation()
    let output = try await StackLaneStore.git(["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(upstream:short)%00%(subject)", "refs/heads", "refs/remotes"], at: path)
    return output.split(separator: "\n").compactMap { line in
      let fields = line.components(separatedBy: "\0")
      guard fields.count >= 3 else { return nil }
      let ref = fields[0], remote = ref.hasPrefix("refs/remotes/")
      guard !remote || !ref.hasSuffix("/HEAD") else { return nil }
      let short = String(ref.dropFirst(remote ? "refs/remotes/".count : "refs/heads/".count))
      let name = remote ? short.split(separator: "/", maxSplits: 1).dropFirst().joined(separator: "/") : short
      return GitBranch(name: name, reference: ref, isRemote: remote, upstream: fields[1].isEmpty ? nil : fields[1], subject: fields[2])
    }
  }
  func currentBranch(at path: URL) async throws -> String {
    await acquire(); defer { release() }
    try Task.checkCancellation()
    let branch = try await StackLaneStore.gitResult(["symbolic-ref", "--quiet", "--short", "HEAD"], at: path)
    if branch.status == 0 { return branch.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    let commit = try await StackLaneStore.git(["rev-parse", "--short", "HEAD"], at: path)
    return "Detached (\(commit))"
  }
}

/// Reads local branch references only. Selecting a base never switches the workspace.
struct LaneBaseBranchPicker: View {
  let path: URL
  @Binding var selection: String
  let label: String
  @State private var branches: [GitBranch] = []
  @State private var loading = true
  @State private var problem: String?

  var body: some View {
    Picker(label, selection: $selection) {
      Text("Current checkout (HEAD)").tag("HEAD")
      if selection != "HEAD" && !branches.contains(where: { $0.displayName == selection }) {
        Text(selection).tag(selection)
      }
      ForEach(branches) { branch in
        Text(branch.displayName).tag(branch.displayName)
      }
    }
    .labelsHidden()
    .frame(minWidth: 185, maxWidth: 260)
    .accessibilityLabel(label)
    .help(problem ?? (loading ? "Reading branches…" : "Start the lane from this branch's committed code."))
    .task(id: path) {
      loading = true; problem = nil
      do { branches = try await LaneBranchReader.shared.branches(at: path) }
      catch { problem = "Could not read branches: \(error.localizedDescription)" }
      loading = false
    }
  }
}

@MainActor
final class LaneCreationWindowController: NSWindowController, NSWindowDelegate {
  static let shared = LaneCreationWindowController()
  private var continuation: CheckedContinuation<JSONValue, Error>?
  private var working = false

  private init() {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 700),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "New lane — Cinderdeck"
    window.isReleasedWhenClosed = false
    super.init(window: window)
    window.delegate = self
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  @discardableResult
  func focusIfPresented() -> Bool {
    guard continuation != nil else { return false }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    return true
  }

  func present(source: StackDefinition, options: LaneCreationOptions,
    create: @escaping @MainActor (LaneCreationOptions) async throws -> JSONValue) async throws -> JSONValue {
    guard continuation == nil else {
      window?.makeKeyAndOrderFront(nil)
      throw StackControlError(code: "busy", message: "Finish or cancel the open lane creation sheet before creating another lane.")
    }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { pending in
        continuation = pending
        window?.contentView = NSHostingView(rootView: LaneCreationSheet(source: source, options: options,
          onCancel: { [weak self] in self?.cancel() },
          create: { [weak self] choices in
            guard let self, self.continuation != nil else { throw CancellationError() }
            self.working = true
            defer { self.working = false }
            let result = try await create(choices)
            let completed = self.continuation
            self.continuation = nil
            self.close()
            completed?.resume(returning: result)
          }))
        window?.center()
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.cancel() }
    }
  }

  private func cancel() {
    guard !working else { return }
    let pending = continuation
    continuation = nil
    close()
    pending?.resume(throwing: StackControlError(code: "cancelled", message: "Lane creation was cancelled. No lane was created."))
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool { !working }
  func windowWillClose(_ notification: Notification) {
    let pending = continuation
    continuation = nil
    pending?.resume(throwing: StackControlError(code: "cancelled", message: "Lane creation was cancelled. No lane was created."))
    CinderdeckRuntimeController.shared.activateOwnedWindow()
  }
}

private struct LaneCreationSheet: View {
  let source: StackDefinition
  let options: LaneCreationOptions
  let onCancel: () -> Void
  let create: @MainActor (LaneCreationOptions) async throws -> Void
  @State private var name: String
  @State private var branch: String
  @State private var bases: [String: String]
  @State private var current: [String: String] = [:]
  @State private var runSetup: Bool
  @State private var startServices: Bool
  @State private var adopting: Bool
  @State private var adoptPath: String
  @State private var working = false
  @State private var error: String?
  @State private var advanced = false
  @State private var copyFiles: String
  @State private var environment: String
  @State private var branchWasEdited: Bool
  @FocusState private var nameFocused: Bool

  init(source: StackDefinition, options: LaneCreationOptions, onCancel: @escaping () -> Void,
    create: @escaping @MainActor (LaneCreationOptions) async throws -> Void) {
    self.source = source; self.options = options; self.onCancel = onCancel; self.create = create
    let existing = StackSupervisor.shared.files.compactMap { $0.lane?.sourceStackID == source.id ? $0.lane?.name : nil }
    var number = 1
    while existing.contains(where: { $0.caseInsensitiveCompare("Lane \(number)") == .orderedSame }) { number += 1 }
    let proposedName = options.request.name ?? "Lane \(number)"
    _name = State(initialValue: proposedName)
    _branch = State(initialValue: options.request.branch.isEmpty ? Self.newBranch(proposedName) : options.request.branch)
    _branchWasEdited = State(initialValue: !options.request.branch.isEmpty)
    _runSetup = State(initialValue: options.setup)
    _startServices = State(initialValue: options.start)
    _adopting = State(initialValue: options.request.adoptPath != nil)
    _adoptPath = State(initialValue: options.request.adoptPath?.path ?? "")
    _copyFiles = State(initialValue: options.request.copy.joined(separator: "\n"))
    _environment = State(initialValue: options.request.environment.sorted(by: { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }.joined(separator: "\n"))
    _advanced = State(initialValue: options.request.adoptPath != nil)
    let repos = Self.repositories(source)
    _bases = State(initialValue: Dictionary(uniqueKeysWithValues: repos.map { repo in
      (repo.id, options.request.repositoryRefs[repo.id] ?? options.request.from ?? repo.laneFrom ?? source.laneSettings?.from ?? "HEAD")
    }))
  }

  private static func newBranch(_ name: String) -> String { "codex/" + StackLaneInfo.slug(for: name) + "-" + UUID().uuidString.prefix(6).lowercased() }
  private static func repositories(_ source: StackDefinition) -> [RepoDefinition] {
    let explicit = source.repos
    let implicit = WorkspaceSetupModel.laneRepositories(in: source).filter { candidate in
      !explicit.contains(where: { WorkspaceDiscovery.repositoryRoot(containing: $0.path) == candidate.path })
    }
    var result = explicit
    for var repo in implicit {
      if result.contains(where: { $0.id == repo.id }) {
        var suffix = 2
        while result.contains(where: { $0.id == "\(repo.id)-\(suffix)" }) { suffix += 1 }
        repo = RepoDefinition(id: "\(repo.id)-\(suffix)", path: repo.path)
      }
      result.append(repo)
    }
    return result
  }
  private var repos: [RepoDefinition] { Self.repositories(source) }
  private var isolated: [RepoDefinition] { WorkspaceSetupModel.laneRepositories(in: source) }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      DeckSheetHeader(icon: "arrow.triangle.branch", title: "New lane",
        detail: "\(source.name) · A separate checkout for your next piece of work.")
      VStack(alignment: .leading, spacing: 6) {
        Text("Lane name").font(.callout.weight(.semibold))
        TextField("Lane name", text: $name).textFieldStyle(.roundedBorder)
          .accessibilityIdentifier("lane.creation.name").focused($nameFocused)
          .onChange(of: name) { value in if !branchWasEdited { branch = Self.newBranch(value) } }
      }
      HStack {
        Text("REPOSITORIES").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        Spacer()
        Text("CURRENT WORKSPACE BRANCH").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(repos) { repo in
            VStack(alignment: .leading, spacing: 8) {
              HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                  Label(repo.id, systemImage: "folder").font(.callout.weight(.semibold))
                  Text(repo.path.path).font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle).help(repo.path.path)
                }
                Spacer()
                Label(current[repo.id] ?? "Reading…", systemImage: "arrow.triangle.branch")
                  .font(.caption.monospaced()).foregroundStyle(.secondary)
                  .textSelection(.enabled).frame(maxWidth: 250, alignment: .trailing)
              }
              if repo.laneMode == .shared {
                Text("Shared folder · uses the workspace's existing checkout").font(.caption).foregroundStyle(.secondary)
              } else {
                HStack {
                  Text(adopting ? "Base for additional worktrees" : "Start from").font(.caption).foregroundStyle(.secondary)
                  LaneBaseBranchPicker(path: repo.path, selection: Binding(
                    get: { bases[repo.id] ?? "HEAD" }, set: { bases[repo.id] = $0 }), label: "Base branch for \(repo.id)")
                    .accessibilityIdentifier("lane.creation.base.\(repo.id)")
                  Spacer()
                }
              }
            }.padding(12).background(DeckStyle.surface, in: RoundedRectangle(cornerRadius: 10))
          }
          if isolated.isEmpty { Text("Add a Git repository to this workspace and choose Isolate in lanes in workspace settings.").foregroundStyle(.secondary) }
        }
      }.frame(minHeight: 140, maxHeight: .infinity)
      DisclosureGroup("Lane options", isExpanded: $advanced) {
        VStack(alignment: .leading, spacing: 10) {
          HStack {
            Text("Git branch").font(.caption)
            TextField("New branch", text: $branch).textFieldStyle(.roundedBorder)
              .accessibilityIdentifier("lane.creation.branch")
              .onChange(of: branch) { _ in if nameFocused == false { branchWasEdited = true } }
          }
          Toggle("Use an existing worktree", isOn: $adopting)
            .onChange(of: adopting) { value in runSetup = !value && source.laneSettings?.setup != nil }
          if adopting {
            HStack {
              TextField("Worktree folder", text: $adoptPath).textFieldStyle(.roundedBorder)
              Button("Browse…") {
                let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
                if panel.runModal() == .OK { adoptPath = panel.url?.path ?? "" }
              }
            }
            Text("The adopted worktree keeps its branch and files. Base choices apply to the other repositories.").font(.caption).foregroundStyle(.secondary)
          }
          if let setup = source.laneSettings?.setup { Toggle("Run setup (\(setup))", isOn: $runSetup) }
          if !source.services.isEmpty { Toggle("Start services when ready", isOn: $startServices) }
          TextField("Extra files to copy (one relative path per line)", text: $copyFiles, axis: .vertical)
            .lineLimit(1...2).textFieldStyle(.roundedBorder).accessibilityLabel("Lane copy files")
          TextField("Environment overrides (KEY=value, one per line)", text: $environment, axis: .vertical)
            .lineLimit(1...2).textFieldStyle(.roundedBorder).accessibilityLabel("Lane environment overrides")
        }.padding(.top, 8)
      }
      Text("Base choices apply to this lane. Workspace settings keep your defaults for next time.")
        .font(.caption).foregroundStyle(.secondary)
      if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
      Divider()
      HStack {
        if working { ProgressView().controlSize(.small); Text("Creating lane…").font(.caption).foregroundStyle(.secondary) }
        Spacer()
        Button("Cancel", action: onCancel).buttonStyle(DeckButtonStyle()).keyboardShortcut(.cancelAction)
        Button("Create lane") { submit() }.buttonStyle(DeckButtonStyle(prominent: true)).keyboardShortcut(.defaultAction)
          .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isolated.isEmpty)
          .accessibilityIdentifier("lane.creation.create")
      }
    }.padding(24).frame(width: 780, height: 700).background(DeckStyle.canvas)
      .disabled(working)
      .task {
        nameFocused = true
        let labels = try? await StackLaneStore.mapRepositories(repos) { repo in
          let branch = (try? await LaneBranchReader.shared.currentBranch(at: repo.path))
            ?? (repo.laneMode == .shared ? "Shared folder" : "Unavailable")
          return (repo.id, branch)
        }
        if let labels, !Task.isCancelled { current = Dictionary(uniqueKeysWithValues: labels) }
      }
  }

  private func submit() {
    guard !working else { return }
    working = true; error = nil
    Task { @MainActor in
      defer { working = false }
      do {
        var choices = options
        choices.request.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        choices.request.branch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        choices.request.from = nil
        choices.request.environment = try WorkspaceSetupModel.laneEnvironment(environment)
        choices.request.copy = copyFiles.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        choices.request.repositoryRefs = [:]
        choices.request.rootRefs = [:]
        choices.request.adoptPath = adopting ? URL(fileURLWithPath: adoptPath.trimmingCharacters(in: .whitespacesAndNewlines)) : nil
        if adopting && adoptPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw StackError.message("Choose the existing worktree folder.") }
        // Adoption must infer its actual branch instead of using the generated branch.
        if adopting, let path = choices.request.adoptPath,
          !(try await StackLaneStore.git(["branch", "--show-current"], at: path)).isEmpty { choices.request.branch = "" }
        let adoptedRoot = choices.request.adoptPath.flatMap { WorkspaceDiscovery.repositoryRoot(containing: $0) }
        var adoptedCommon: String?
        if let adoptedRoot { adoptedCommon = try await StackLaneStore.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], at: adoptedRoot) }
        for repo in repos where repo.laneMode == .worktree {
          guard let root = WorkspaceDiscovery.repositoryRoot(containing: repo.path) else { continue }
          if let adoptedCommon, try await StackLaneStore.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], at: root) == adoptedCommon { continue }
          let ref = bases[repo.id] ?? "HEAD"
          if adopting || source.repo(repo.id) == nil { choices.request.rootRefs[root] = ref }
          else { choices.request.repositoryRefs[repo.id] = ref }
        }
        choices.setup = runSetup; choices.start = startServices
        try await create(choices)
      } catch { self.error = error.localizedDescription }
    }
  }
}
