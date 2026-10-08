import AppKit
import SwiftUI

/// The manual lane form: one feature, one branch. Every choice has a default, so
/// Create works immediately; edits are validated inline before any Git effect.
struct LaneCreationSheet: View {
  let source: StackDefinition
  let options: LaneCreationOptions
  let onCancel: () -> Void
  let create: @MainActor (LaneCreationOptions) async throws -> Void

  private let existingNames: [String]
  private let proposedName: String
  @State private var name: String
  @State private var branch: String
  @State private var branchEdited: Bool
  @State private var bases: [String: String] = [:]
  /// Bases the sheet opened with. Unchanged bases are not sent, so the store
  /// applies workspace defaults and reuses or tracks an existing branch.
  @State private var defaultBases: [String: String] = [:]
  @State private var modes: [String: StackLaneRepositoryMode] = [:]
  @State private var current: [String: String] = [:]
  @State private var catalogs: [String: LaneBranchCatalog] = [:]
  /// Generated branches are numbered past existing ones, so wait for the first branch read.
  @State private var catalogsLoaded = false
  @State private var repositorySnapshot: LaneCreationRepositories?
  @State private var creationProgress = LaneCreationProgressState()
  @State private var creationStarted: Date?
  @State private var creation: Task<Void, Never>?
  @State private var runSetup: Bool
  @State private var startServices: Bool
  @State private var adopting: Bool
  @State private var adoptPath: String
  @State private var working = false
  @State private var error: String?
  @State private var advanced: Bool
  @State private var copyFiles: String
  @State private var environment: String
  @State private var remember = false
  @State private var searchingBranches = false
  @FocusState private var nameFocused: Bool

  init(source: StackDefinition, options: LaneCreationOptions, onCancel: @escaping () -> Void,
    create: @escaping @MainActor (LaneCreationOptions) async throws -> Void) {
    self.source = source; self.options = options; self.onCancel = onCancel; self.create = create
    existingNames = StackSupervisor.shared.files.compactMap { $0.lane?.sourceStackID == source.id ? $0.lane?.name : nil }
    proposedName = StackLaneInfo.proposedName(existing: existingNames)
    _name = State(initialValue: options.request.name ?? "")
    _branch = State(initialValue: options.request.branch)
    _branchEdited = State(initialValue: !options.request.branch.isEmpty)
    _runSetup = State(initialValue: options.setup)
    _startServices = State(initialValue: options.start)
    _adopting = State(initialValue: options.request.adoptPath != nil)
    _adoptPath = State(initialValue: options.request.adoptPath?.path ?? "")
    _copyFiles = State(initialValue: options.request.copy.joined(separator: "\n"))
    _environment = State(initialValue: options.request.environment.sorted(by: { $0.key < $1.key }).map { "\($0.key)=\($0.value)" }.joined(separator: "\n"))
    _advanced = State(initialValue: options.request.adoptPath != nil)
  }

  // MARK: Derived choices

  private var effectiveName: String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? proposedName : trimmed
  }
  private var worktreeIDs: [String] {
    repositorySnapshot?.repositories.filter { modes[$0.id] == .worktree }.map(\.id) ?? []
  }
  private var proposedBranch: String {
    StackLaneInfo.proposedBranch(name: effectiveName, prefix: source.laneSettings?.branchPrefix,
      taken: worktreeIDs.reduce(into: Set<String>()) { $0.formUnion(catalogs[$1]?.names ?? []) })
  }
  private var effectiveBranch: String {
    branchEdited ? branch.trimmingCharacters(in: .whitespacesAndNewlines) : proposedBranch
  }
  private var branchStates: [String: LaneBranchCatalog.State] {
    Dictionary(uniqueKeysWithValues: worktreeIDs.map { ($0, catalogs[$0]?.state(of: effectiveBranch) ?? .new) })
  }
  private var worktreePaths: [URL] {
    repositorySnapshot?.repositories.filter { modes[$0.id] == .worktree }.map(\.path) ?? []
  }

  /// Problems that would make Git or the store refuse, shown before submitting.
  private var problems: [String] {
    var result: [String] = []
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.count > 100 || trimmed.rangeOfCharacter(from: .controlCharacters) != nil {
      result.append("Lane names have at most 100 characters and no control characters.")
    }
    if existingNames.contains(where: { $0.caseInsensitiveCompare(effectiveName) == .orderedSame }) {
      result.append("A lane named “\(effectiveName)” already exists in \(source.name). Choose another name.")
    }
    if adopting {
      if adoptPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result.append("Choose the existing worktree folder.") }
    } else if !worktreeIDs.isEmpty {
      if let problem = StackLaneInfo.branchProblem(effectiveBranch) { result.append(problem) }
      let busy = worktreeIDs.filter { current[$0] == effectiveBranch }
      if !busy.isEmpty {
        result.append("\(effectiveBranch) is checked out in the original checkout of \(busy.joined(separator: ", ")). Choose another branch.")
      }
    }
    return result
  }

  private var branchSummary: String {
    let states = branchStates
    guard !states.isEmpty else { return "References only: no branch or worktree is created." }
    let local = states.filter { $0.value == .local }.keys.sorted()
    let remote = states.filter { $0.value == .remote }.keys.sorted()
    let new = states.filter { $0.value == .new }.keys.sorted()
    var parts: [String] = []
    if !local.isEmpty { parts.append("existing branch in \(local.joined(separator: ", ")), checked out as-is") }
    if !remote.isEmpty { parts.append("tracked from the remote in \(remote.joined(separator: ", "))") }
    if !new.isEmpty { parts.append("new branch in \(new.joined(separator: ", "))") }
    let text = parts.joined(separator: "; ")
    return text.prefix(1).uppercased() + text.dropFirst() + "."
  }

  /// Workspace defaults this lane would change, for "Remember".
  private var changesDefaults: Bool {
    guard let snapshot = repositorySnapshot else { return false }
    return snapshot.repositories.contains { repo in
      guard source.repo(repo.id) != nil else { return false }
      let mode: StackLaneRepositoryMode = repo.laneMode == .shared ? .reference : .worktree
      return modes[repo.id] != mode || (modes[repo.id] == .worktree && bases[repo.id] != defaultBases[repo.id])
    }
  }

  // MARK: View

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      DeckSheetHeader(icon: "arrow.triangle.branch", title: "New lane",
        detail: "\(source.name) · One feature, one branch. Worktrees get the branch; references stay as they are.")
      identity.disabled(working)
      HStack {
        Text("REPOSITORIES").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        Spacer()
        if let snapshot = repositorySnapshot {
          let references = snapshot.repositories.count - worktreeIDs.count
          Text("\(worktreeIDs.count) worktree\(worktreeIDs.count == 1 ? "" : "s") · \(references) reference\(references == 1 ? "" : "s")")
            .font(.caption).foregroundStyle(.secondary)
        }
      }
      ScrollView {
        if let repositorySnapshot {
          LaneCreationRepositoryList(snapshot: repositorySnapshot, current: current, catalogs: catalogs,
            adopting: adopting, branch: effectiveBranch, branchStates: branchStates,
            progress: creationProgress.repositories, selectedBases: bases, selectedModes: modes,
            bases: $bases, modes: $modes, fetched: { Task { await loadCatalogs() } }).equatable()
        } else {
          ProgressView("Reading repositories…").frame(maxWidth: .infinity, alignment: .leading)
        }
      }.frame(minHeight: 140, maxHeight: .infinity).disabled(working)
      moreOptions.disabled(working)
      if source.repos.isEmpty == false {
        Toggle("Remember these checkout and start choices as \(source.name)'s defaults", isOn: $remember)
          .toggleStyle(.checkbox).font(.callout)
          .disabled(working || adopting || !changesDefaults)
          .help(changesDefaults ? "Saves each repository's checkout and start point to the workspace settings after the lane is created."
            : "These choices already match the workspace defaults.")
          .accessibilityIdentifier("lane.creation.remember")
      }
      ForEach(problems, id: \.self) { Label($0, systemImage: "exclamationmark.triangle.fill").font(.callout).foregroundStyle(.orange) }
      if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
      Divider()
      footer
    }
    .padding(24).frame(minWidth: 640, idealWidth: 780, minHeight: 520, idealHeight: 700).background(DeckStyle.canvas)
    .task {
      nameFocused = true
      let snapshot = await LaneCreationRepositories.read(source)
      guard !Task.isCancelled else { return }
      bases = Dictionary(uniqueKeysWithValues: snapshot.repositories.map { repo in
        (repo.id, options.request.repositoryRefs[repo.id] ?? options.request.from ?? repo.laneFrom ?? source.laneSettings?.from ?? "HEAD")
      })
      // Bases requested by the caller are explicit choices; workspace defaults are not.
      defaultBases = bases.filter { options.request.repositoryRefs[$0.key] == nil }
      repositorySnapshot = snapshot
      modes = snapshot.modes(prefilling: options.request.repositoryModes)
      async let labels: Void = loadCurrentBranches(snapshot)
      async let refs: Void = loadCatalogs()
      _ = await (labels, refs)
    }
  }

  private var identity: some View {
    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 8) {
      GridRow {
        Text("Name").font(.callout.weight(.semibold))
        TextField(proposedName, text: $name).textFieldStyle(.roundedBorder)
          .accessibilityIdentifier("lane.creation.name").focused($nameFocused)
      }
      if !adopting {
        GridRow {
          Text("Branch").font(.callout.weight(.semibold))
          HStack {
            TextField(proposedBranch, text: Binding(get: { branchEdited ? branch : proposedBranch },
              set: { branchEdited = true; branch = $0 }))
              .textFieldStyle(.roundedBorder).font(.body.monospaced())
              .accessibilityIdentifier("lane.creation.branch")
            if branchEdited {
              Button("Auto") { branchEdited = false; branch = "" }
                .help("Name the branch after the lane again")
            }
            Button("Existing…") { searchingBranches = true }
              .help("Use a local or remote branch that already exists")
              .disabled(worktreePaths.isEmpty)
              .popover(isPresented: $searchingBranches, arrowEdge: .bottom) {
                LaneBranchSearchList(paths: worktreePaths, purpose: .laneBranch, currentBranch: nil,
                  preloaded: .merged(worktreeIDs.compactMap { catalogs[$0] }),
                  pick: { picked in branch = picked; branchEdited = true; searchingBranches = false },
                  fetched: { Task { await loadCatalogs() } })
              }
          }
        }
        GridRow {
          Color.clear.frame(width: 1, height: 1)
          Text(branchSummary).font(.caption).foregroundStyle(.secondary)
            .accessibilityIdentifier("lane.creation.branchSummary")
        }
      }
    }
  }

  private var moreOptions: some View {
    DisclosureGroup("More options", isExpanded: $advanced) {
      VStack(alignment: .leading, spacing: 10) {
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
          Text("The adopted worktree keeps its branch and files. Start points apply to the other worktrees.")
            .font(.caption).foregroundStyle(.secondary)
        }
        if let setup = source.laneSettings?.setup { Toggle("Run setup (\(setup))", isOn: $runSetup) }
        if !source.services.isEmpty { Toggle("Start services when ready", isOn: $startServices) }
        TextField("Extra files to copy (one relative path per line)", text: $copyFiles, axis: .vertical)
          .lineLimit(1...2).textFieldStyle(.roundedBorder).accessibilityLabel("Lane copy files")
        TextField("Environment overrides (KEY=value, one per line)", text: $environment, axis: .vertical)
          .lineLimit(1...2).textFieldStyle(.roundedBorder).accessibilityLabel("Lane environment overrides")
      }.padding(.top, 8)
    }
  }

  private var footer: some View {
    HStack {
      if working {
        ProgressView().controlSize(.small)
        VStack(alignment: .leading, spacing: 2) {
          Text(creationProgress.label).lineLimit(2)
          if let creationStarted {
            TimelineView(.periodic(from: creationStarted, by: 1)) { context in
              Text("Elapsed \(Int(max(0, context.date.timeIntervalSince(creationStarted))))s")
            }
          }
        }.font(.caption).foregroundStyle(.secondary)
          .accessibilityIdentifier("lane.creation.progress")
      }
      Spacer()
      // Stopping a checkout rolls back its worktrees and empty branches.
      Button(working ? "Stop" : "Cancel") { if working { creation?.cancel() } else { onCancel() } }
        .buttonStyle(DeckButtonStyle()).keyboardShortcut(.cancelAction)
        .disabled(creation?.isCancelled == true)
      Button("Create lane") { submit() }.buttonStyle(DeckButtonStyle(prominent: true)).keyboardShortcut(.defaultAction)
        .disabled(working || !problems.isEmpty || repositorySnapshot?.repositories.isEmpty != false
          || (!catalogsLoaded && !branchEdited && !worktreeIDs.isEmpty))
        .accessibilityIdentifier("lane.creation.create")
    }
  }

  // MARK: Loading

  private func loadCurrentBranches(_ snapshot: LaneCreationRepositories) async {
    let labels = try? await StackLaneStore.mapRepositories(snapshot.repositories) { repo in
      let branch = (try? await LaneBranchReader.shared.currentBranch(at: repo.path))
        ?? (snapshot.roots[repo.id] == nil ? "Not in Git" : "Unavailable")
      return (repo.id, branch)
    }
    if let labels, !Task.isCancelled { current = Dictionary(uniqueKeysWithValues: labels) }
  }

  /// One local `for-each-ref` per repository: feeds existing-branch detection and the pickers.
  private func loadCatalogs() async {
    guard let snapshot = repositorySnapshot else { return }
    let repositories = snapshot.repositories.filter { snapshot.roots[$0.id] != nil }
    let lists = try? await StackLaneStore.mapRepositories(repositories) { repo in
      (repo.id, LaneBranchCatalog((try? await LaneBranchReader.shared.branches(at: repo.path)) ?? []))
    }
    if let lists, !Task.isCancelled { catalogs = Dictionary(uniqueKeysWithValues: lists) }
    catalogsLoaded = true
  }

  // MARK: Submit

  private func submit() {
    guard !working, problems.isEmpty, let repositorySnapshot else { return }
    working = true; error = nil
    creationStarted = Date(); creationProgress = LaneCreationProgressState()
    let states = branchStates
    creation = Task { @MainActor in
      defer { working = false; creation = nil }
      do {
        var choices = options
        choices.request.name = effectiveName
        choices.request.branch = adopting ? "" : effectiveBranch
        choices.request.from = nil
        choices.request.environment = try WorkspaceSetupModel.laneEnvironment(environment)
        choices.request.copy = copyFiles.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        choices.request.repositoryRefs = [:]
        choices.request.rootRefs = [:]
        choices.request.repositoryModes = [:]
        choices.request.referenceRoots = []
        choices.request.adoptPath = adopting ? URL(fileURLWithPath: adoptPath.trimmingCharacters(in: .whitespacesAndNewlines)) : nil
        // Adoption infers the worktree's own branch; a detached HEAD uses the lane name.
        if adopting, let path = choices.request.adoptPath,
          (try await StackLaneStore.git(["branch", "--show-current"], at: path)).isEmpty { choices.request.branch = effectiveName }
        // The adopted repository supplies its own checkout; resolve every Git folder once, together.
        var adoptedCommon: String?, commons: [String: String] = [:]
        if let path = choices.request.adoptPath, let root = WorkspaceDiscovery.repositoryRoot(containing: path) {
          adoptedCommon = try await StackLaneStore.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], at: root)
          let roots = repositorySnapshot.repositories.compactMap { repo in repositorySnapshot.roots[repo.id].map { (repo.id, $0) } }
          commons = Dictionary(uniqueKeysWithValues: try await StackLaneStore.mapRepositories(roots) { item in
            (item.0, (try? await StackLaneStore.git(["rev-parse", "--path-format=absolute", "--git-common-dir"], at: item.1)) ?? "")
          })
        }
        for repo in repositorySnapshot.repositories {
          let mode = modes[repo.id] ?? .reference
          if source.repo(repo.id) != nil { choices.request.repositoryModes[repo.id] = mode }
          if mode == .reference {
            if source.repo(repo.id) == nil, let root = repositorySnapshot.roots[repo.id] { choices.request.referenceRoots.append(root) }
            continue
          }
          guard let root = repositorySnapshot.roots[repo.id] else { continue }
          if let adoptedCommon, commons[repo.id] == adoptedCommon { continue }
          // Existing branches are checked out as-is; workspace defaults are applied by the store.
          let ref = bases[repo.id] ?? "HEAD"
          if ref == defaultBases[repo.id] || (!adopting && states[repo.id] != .new) { continue }
          if adopting || source.repo(repo.id) == nil { choices.request.rootRefs[root] = ref }
          else { choices.request.repositoryRefs[repo.id] = ref }
        }
        choices.setup = runSetup; choices.start = startServices
        choices.rememberDefaults = remember && !adopting
        choices.progress = { creationProgress.receive($0) }
        try await create(choices)
      } catch {
        self.error = Task.isCancelled ? "Stopped. " + error.localizedDescription : error.localizedDescription
      }
    }
  }
}

/// Saves a created lane's checkout and start choices as its workspace's repository defaults.
@MainActor
enum LaneCreationDefaults {
  static func save(_ request: StackLaneRequest, source id: String, supervisor: StackSupervisor) async throws {
    guard let definition = supervisor.definition(id) else { throw StackError.message("\(id) has no valid definition") }
    let fallback = definition.laneSettings?.from ?? "HEAD"
    let folders = definition.repos.map { repo -> RepoDefinition in
      var repo = repo
      if let mode = request.repositoryModes[repo.id] { repo.laneMode = mode.laneMode }
      if let ref = request.repositoryRefs[repo.id] { repo.laneFrom = ref == fallback ? nil : ref }
      return repo
    }
    guard folders != definition.repos else { return }
    let original = try String(contentsOf: definition.file, encoding: .utf8)
    let updated = try WorkspaceSettingsWriter.source(original: original, definition: definition,
      name: definition.name, folders: folders, files: definition.files)
    _ = try await supervisor.withDefinitionLock(workspace: id) {
      try WorkspaceDefinitionWriter.saveSource(file: definition.file, original: original, source: updated)
    }
  }
}
