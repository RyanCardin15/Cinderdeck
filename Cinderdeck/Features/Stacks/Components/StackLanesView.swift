import AppKit
import SwiftUI

/// The original checkout and every branch lane share one view, but each card
/// controls only its own processes, logs and worktrees.
struct StackLanesView: View {
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject private var supervisor: StackSupervisor
  @Environment(\.dismiss) private var dismiss
  @State private var branch = ""
  @State private var from = ""
  @State private var startAfterCreation = true
  @State private var runSetup = true
  @State private var working = false
  @State private var error: String?
  @State private var warnings: [String] = []
  @State private var removal: Removal?

  /// What removing a lane would delete, shown before anything happens.
  struct Removal: Identifiable {
    let file: StackDefinitionFile
    var ignored: [StackLaneIgnoredEntry] = []
    var discardIgnored = true
    var deleteLogs = false
    var keepWorktrees = false
    var id: String { file.id }
  }

  init(viewModel: StacksViewModel) {
    self.viewModel = viewModel
    _supervisor = ObservedObject(wrappedValue: viewModel.supervisor)
  }

  private var coordinator: StackLaneCoordinator { StackControlService.shared.lanes }
  private var sourceID: String? {
    let selected = viewModel.selectedWorkspaceID ?? viewModel.selectedStackID
    return viewModel.files.first { $0.id == selected }?.lane?.sourceStackID ?? selected
  }
  private var source: StackDefinitionFile? { viewModel.files.first { $0.id == sourceID } }
  private var lanes: [StackDefinitionFile] {
    guard let sourceID else { return [] }
    return [source].compactMap { $0 } + viewModel.workspaceNavigation.lanes(for: sourceID)
  }
  private var setupReference: String? { source?.definition?.laneSettings?.setup }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text("\(source?.name ?? "Stack") lanes").font(.title2.bold())
          Text("Run branches side by side in isolated working folders.").foregroundColor(.secondary)
        }
        Spacer()
        Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
      }
      ScrollView([.horizontal, .vertical]) {
        HStack(alignment: .top, spacing: 12) { ForEach(lanes) { card($0) } }.padding(3)
      }.frame(maxHeight: 360)
      Divider()
      Text("Create a lane").font(.headline)
      HStack {
        TextField("Branch, e.g. agent/codex-1", text: $branch)
          .textFieldStyle(.roundedBorder).accessibilityIdentifier("stacks.laneBranch")
        TextField(source?.definition?.laneSettings?.from ?? "From (default: HEAD)", text: $from)
          .textFieldStyle(.roundedBorder).frame(width: 200).help("Start point for a new branch, such as origin/main. Existing local or remote branches are used as they are.")
        Button(working ? "Working…" : "Create lane") { create() }
          .disabled(working || branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || source?.definition == nil)
          .accessibilityIdentifier("stacks.createLane")
      }
      HStack(spacing: 18) {
        if let setupReference {
          Toggle("Run setup (\(setupReference))", isOn: $runSetup).disabled(working)
        }
        if source?.definition?.services.isEmpty == false {
          Toggle("Start services after creation", isOn: $startAfterCreation).disabled(working)
        }
      }
      Text(hint)
        .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
      ForEach(warnings, id: \.self) { Text($0).font(.caption).foregroundColor(.orange).fixedSize(horizontal: false, vertical: true) }
      if let error { Text(error).foregroundColor(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
    }
    .padding(24).frame(width: 900)
    .task { await supervisor.refreshLaneGitStates(lanes.filter { $0.lane != nil }.map(\.id)) }
    .sheet(item: $removal) { item in removalSheet(item) }
  }

  private var hint: String {
    var text = "Uses an existing local branch, tracks a remote-only branch, or creates one from each repository's HEAD."
    if source?.definition?.services.isEmpty == true {
      text += " Tasks and workflows run inside the new lane's working folders."
    } else {
      text += " Services get their own PORT, CINDERDECK_PORT_<SERVICE> and CINDERDECK_URL_<SERVICE>; definition values written as {{url.api}} follow the lane."
    }
    if source?.definition?.laneSettings == nil { text += " Add a [lanes] table to copy .env files, run setup, or share services." }
    return text
  }

  // MARK: Cards

  private func card(_ file: StackDefinitionFile) -> some View {
    let lane = file.lane
    let state = viewModel.states[file.id] ?? .init()
    let hasServices = file.definition?.services.isEmpty == false || state.isActive
    let branches = file.definition?.repos.compactMap { viewModel.repoStatuses[$0.path]?.branchLabel } ?? []
    let git = supervisor.laneGitStates[file.id]
    let host = file.definition?.host ?? "localhost"
    return VStack(alignment: .leading, spacing: 10) {
      HStack {
        if hasServices || file.definition == nil { StackStatusDot(label: state.label) }
        Text(lane?.name ?? (file.id == sourceID ? branches.first ?? "Original checkout" : file.name)).font(.headline).lineLimit(2)
      }
      Text(lane?.owner.label ?? (file.id == sourceID ? "Original checkout" : "Workspace in lane"))
        .font(.caption).foregroundColor(.secondary)
      if let lane {
        HStack(spacing: 6) {
          if lane.pinned { badge("Pinned", .orange, help: "Keeps the definition saved when it was created") }
          if lane.adopted { badge("Adopted", .secondary, help: "Cinderdeck never deletes this worktree") }
          if git?.merged == true { badge("Merged", .green, help: "Every branch with new commits is in the default remote branch") }
          if git?.upstreamGone == true { badge("Upstream deleted", .orange, help: "The tracked remote branch was deleted") }
          if let unpushed = git?.unpushed, unpushed > 0 { badge("\(unpushed) unpushed", .secondary, help: "Commits on no remote") }
        }
      }
      if let definition = file.definition {
        ForEach(definition.repos.filter { repo in
          guard let branch = viewModel.repoStatuses[repo.path]?.branchLabel else { return false }
          return branch != (lane?.name ?? branches.first)
        }) { repo in
          Label("\(repo.id): \(viewModel.repoStatuses[repo.path]?.branchLabel ?? "")", systemImage: "arrow.triangle.branch")
            .font(.caption).foregroundColor(.secondary).lineLimit(2)
        }
      }
      if let setup = file.laneSetup { setupRow(file, setup) }
      if hasServices || file.definition == nil {
        Text(state.operation ?? state.label).font(.caption).foregroundColor(.secondary)
      } else if let definition = file.definition {
        Text("\(definition.tasks.count) \(definition.tasks.count == 1 ? "task" : "tasks") · \(definition.workflows.count) \(definition.workflows.count == 1 ? "workflow" : "workflows")")
          .font(.caption).foregroundColor(.secondary)
      }
      ForEach(file.issues) { issue in Text(issue.message).font(.caption).foregroundColor(.orange).lineLimit(3) }
      ForEach(file.definition?.services ?? []) { service in
        let runtime = viewModel.runtime(file.id, service.id)
        HStack(spacing: 6) {
          StackStatusDot(phase: runtime.phase, size: 6)
          Text(service.id).lineLimit(1)
          if runtime.bindWarning != nil {
            Image(systemName: "exclamationmark.triangle.fill").foregroundColor(.orange).help(runtime.bindWarning ?? "")
          }
          Spacer()
          if let port = service.port {
            Button(":\(String(port))") { viewModel.openPort(port, host: host) }.buttonStyle(.link)
              .help("Open http://\(host):\(String(port))")
          }
        }.font(.caption)
      }
      ForEach((file.definition?.links ?? []).filter(\.shared)) { link in
        HStack(spacing: 6) {
          StackStatusDot(phase: viewModel.runtime(link.stack, link.service).phase, size: 6)
          Text(link.id).lineLimit(1)
          Text("shared").foregroundColor(.secondary)
          Spacer()
          if let port = link.port {
            Button(":\(String(port))") { viewModel.openPort(port, host: link.host) }.buttonStyle(.link)
          }
        }.font(.caption).opacity(0.7).help("Runs in the original checkout; every lane uses the same instance.")
      }
      if let claim = viewModel.claim(file.id) {
        Label("Claimed by \(claim.holder.name)", systemImage: "lock.fill").font(.caption).foregroundColor(StackPalette.agent)
      }
      HStack {
        if hasServices {
          Button(state.isActive ? "Stop" : "Start") { viewModel.toggle(file.id) }
            .disabled(!state.isActive && file.definition == nil)
          Button("Logs") { viewModel.showLogs(stack: file.id, service: nil) }
        }
        Button("Inspect") { viewModel.select(file.id); dismiss() }
      }.disabled(working || viewModel.isBusy(file.id))
      if let lane {
        HStack {
          Menu("Open") {
            Button("Finder") { NSWorkspace.shared.open(lane.directory) }
            Button("Copy shell exports") { copyExports(file) }
              .help("export lines for this lane's ports, URLs and variables, for tests you run yourself")
            ForEach(Self.editors, id: \.bundle) { editor in
              if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: editor.bundle) {
                Button(editor.name) { open(lane.directory, with: app) }
              }
            }
          }.fixedSize()
          if lane.pinned { Button("Unpin") { unpin(file) }.help("Follow \(lane.sourceStackID)'s current definition") }
          Spacer()
          Menu("Remove") {
            Button("Remove lane…") { prepareRemoval(file, keep: false) }
            Button("Release, keep worktrees…") { prepareRemoval(file, keep: true) }
          }.fixedSize()
        }.disabled(working || viewModel.isBusy(file.id))
      }
    }
    .padding(14).frame(width: 260, alignment: .topLeading).stackSurface(cornerRadius: 12)
  }

  private func badge(_ text: String, _ color: Color, help: String) -> some View {
    Text(text).font(.caption2.weight(.semibold)).foregroundColor(color)
      .padding(.horizontal, 6).padding(.vertical, 2)
      .background(Capsule().fill(color.opacity(0.12))).help(help)
  }

  private func setupRow(_ file: StackDefinitionFile, _ setup: StackLaneSetupState) -> some View {
    HStack(spacing: 6) {
      switch setup.status {
      case .running, .pending: ProgressView().controlSize(.mini); Text("Setting up (\(setup.reference))…")
      case .succeeded: Image(systemName: "checkmark.circle").foregroundColor(.green); Text("Set up")
      case .skipped: Image(systemName: "minus.circle").foregroundColor(.secondary); Text("Setup skipped")
      case .failed: Image(systemName: "xmark.octagon").foregroundColor(.red); Text("Setup failed")
      }
      Spacer()
      if setup.status != .running {
        Button(setup.status == .succeeded ? "Rerun" : "Run setup") { retrySetup(file) }.buttonStyle(.link)
      }
    }
    .font(.caption).help(setup.detail ?? setup.reference)
    .disabled(working || viewModel.isBusy(file.id))
  }

  private static let editors: [(name: String, bundle: String)] = [
    ("Terminal", "com.apple.Terminal"), ("iTerm", "com.googlecode.iterm2"), ("Visual Studio Code", "com.microsoft.VSCode"),
    ("Cursor", "com.todesktop.230313mzl4w4u92"), ("Xcode", "com.apple.dt.Xcode"),
  ]

  private func open(_ folder: URL, with app: URL) {
    NSWorkspace.shared.open([folder], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
      if let error { Task { @MainActor in self.error = error.localizedDescription } }
    }
  }

  // MARK: Removal

  private func removalSheet(_ item: Removal) -> some View {
    let binding = Binding(get: { removal ?? item }, set: { removal = $0 })
    let total = item.ignored.compactMap(\.bytes).reduce(0, +)
    return VStack(alignment: .leading, spacing: 12) {
      Text(item.keepWorktrees ? "Release \(item.file.lane?.name ?? "lane")?" : "Remove \(item.file.lane?.name ?? "lane")?").font(.headline)
      Text(item.keepWorktrees
        ? "Stops only this lane and forgets it. Its worktrees and files stay on disk; Git branches are kept."
        : "Stops only this lane\(item.file.definition?.laneSettings?.teardown.map { ", runs teardown (\($0))," } ?? ""), and removes its worktrees. Git branches and adopted worktrees are kept. Tracked or untracked changes block removal.")
        .fixedSize(horizontal: false, vertical: true)
      if !item.keepWorktrees, !item.ignored.isEmpty {
        Toggle("Delete ignored files (\(ByteCountFormatter.string(fromByteCount: total, countStyle: .file)))", isOn: binding.discardIgnored)
        ScrollView {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(item.ignored, id: \.path) { entry in
              HStack {
                Text(entry.path).lineLimit(1).truncationMode(.head)
                Spacer()
                if let note = entry.note { Text(note).foregroundColor(.orange) }
                if let bytes = entry.bytes { Text(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)).foregroundColor(.secondary) }
              }.font(.caption.monospaced())
            }
          }
        }.frame(maxHeight: 160)
      }
      Toggle("Delete this lane's service logs", isOn: binding.deleteLogs)
      HStack {
        Spacer()
        Button("Cancel", role: .cancel) { removal = nil }.keyboardShortcut(.cancelAction)
        Button(item.keepWorktrees ? "Stop and release" : "Stop and remove", role: .destructive) {
          let request = removal ?? item
          removal = nil
          remove(request)
        }
        .disabled(!item.keepWorktrees && !item.ignored.isEmpty && !(removal ?? item).discardIgnored)
        .keyboardShortcut(.defaultAction)
      }
    }
    .padding(20).frame(width: 560)
  }

  private func prepareRemoval(_ file: StackDefinitionFile, keep: Bool) {
    working = true; error = nil
    Task {
      defer { working = false }
      do {
        var item = Removal(file: file, keepWorktrees: keep)
        if !keep, let record = try StackLaneStore.record(id: file.id, in: supervisor.lanesDirectory) {
          item.ignored = try await StackLaneStore.check(record, others: try StackLaneStore.records(in: supervisor.lanesDirectory),
            options: .init(discardIgnored: true))
        }
        removal = item
      } catch { self.error = error.localizedDescription }
    }
  }

  private func remove(_ item: Removal) {
    working = true; error = nil
    Task {
      defer { working = false }
      do {
        let report = try await coordinator.remove(item.file.id, actor: .user, options: .init(discardIgnored: item.discardIgnored,
          keepWorktrees: item.keepWorktrees, deleteLogs: item.deleteLogs))
        StackControlService.shared.release(stack: item.file.id)
        warnings = report.unpushed.sorted { $0.key < $1.key }.map { "\($0.key) has \($0.value) commit\($0.value == 1 ? "" : "s") on no remote. The branch was kept." }
      } catch { self.error = error.localizedDescription }
    }
  }

  // MARK: Actions

  private func create() {
    guard let sourceID else { return }
    let name = branch.trimmingCharacters(in: .whitespacesAndNewlines)
    let start = from.trimmingCharacters(in: .whitespacesAndNewlines)
    working = true; error = nil; warnings = []
    Task {
      defer { working = false }
      do {
        let created = try await coordinator.create(stack: sourceID, request: .init(branch: name, from: start.isEmpty ? nil : start),
          actor: .user, setup: runSetup)
        branch = ""; from = ""
        warnings = created.warnings
        if !created.setupSucceeded {
          error = "Setup failed: \(created.setup?.detail ?? ""). Services were not started. Fix it, then choose Run setup."
        } else if startAfterCreation {
          await supervisor.start(stack: created.file.id, actor: .user)
        }
      } catch { self.error = error.localizedDescription }
    }
  }

  private func retrySetup(_ file: StackDefinitionFile) {
    working = true; error = nil
    Task {
      defer { working = false }
      if let state = await coordinator.runSetup(file.id, actor: .user), state.status == .failed {
        error = "Setup failed: \(state.detail ?? state.reference)"
      }
    }
  }

  private func copyExports(_ file: StackDefinitionFile) {
    do {
      let values = try coordinator.environment(stack: file.id, service: nil)
      let text = values.keys.sorted().map { "export \($0)=" + StackCLI.shellQuote(values[$0]!) }.joined(separator: "\n")
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text + "\n", forType: .string)
    } catch { self.error = error.localizedDescription }
  }

  private func unpin(_ file: StackDefinitionFile) {
    working = true; error = nil
    Task {
      defer { working = false }
      do { try await supervisor.unpinLane(file.id, actor: .user) } catch { self.error = error.localizedDescription }
    }
  }
}
