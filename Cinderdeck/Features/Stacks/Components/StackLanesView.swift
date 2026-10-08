import AppKit
import SwiftUI

/// The original checkout and every branch lane share one view, but each card
/// controls only its own processes, logs and worktrees.
struct StackLanesView: View {
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject private var supervisor: StackSupervisor
  @Environment(\.dismiss) private var dismiss
  @State private var working = false
  @State private var error: String?
  @State private var warnings: [String] = []
  @State private var removal: StackLaneRemovalRequest?
  /// Repository discovery walks the filesystem; it runs off the main actor once per source.
  @State private var hasLaneRepositories = true

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

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        DeckSheetHeader(icon: "arrow.triangle.branch", title: "\(source?.name ?? "Workspace") lanes",
          detail: "Run branches side by side in isolated working folders.")
        Spacer()
        Button("Done") { dismiss() }.keyboardShortcut(.cancelAction).buttonStyle(DeckButtonStyle())
      }
      ScrollView([.horizontal, .vertical]) {
        HStack(alignment: .top, spacing: 12) { ForEach(lanes) { card($0) } }.padding(3)
      }.frame(height: 280)
      Divider()
      HStack {
        Text("One lane per feature: pick which repositories get a worktree and which stay a reference.")
          .font(.callout).foregroundStyle(.secondary)
        Spacer()
        Button("New lane…") { create() }.buttonStyle(DeckButtonStyle(prominent: true))
          .keyboardShortcut("n", modifiers: [.command, .shift])
          .disabled(working || source?.definition == nil || !hasLaneRepositories)
          .help(hasLaneRepositories ? "New lane (⇧⌘N)" : "Add a Git repository to this workspace before creating a lane.")
          .accessibilityIdentifier("stacks.createLane")
      }
      ForEach(warnings, id: \.self) { Text($0).font(.caption).foregroundColor(.orange) }
      if let error { Text(error).foregroundColor(.red).textSelection(.enabled) }
    }
    .padding(24).frame(width: 900, height: 445)
    .task { await supervisor.refreshLaneGitStates(lanes.filter { $0.lane != nil }.map(\.id)) }
    .task(id: source?.definition?.repos) {
      guard let definition = source?.definition else { return }
      if !definition.repos.isEmpty { hasLaneRepositories = true; return }
      hasLaneRepositories = await LaneCreationRepositories.read(definition).hasIsolatedRepositories
    }
    .sheet(item: $removal) { StackLaneRemovalView(request: $0, viewModel: viewModel) }
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
          if lane.isReviewer { badge("Reviewer", WorkspaceLaneMapStyle.reviewer, help: "Separate checkout pinned to the reviewed commits") }
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
      HStack {
        if hasServices {
          Button(state.isActive ? "Stop" : "Start") { viewModel.toggle(file.id) }
            .disabled(!state.isActive && file.definition == nil)
          Button("Logs") { viewModel.showLogs(stack: file.id, service: nil) }
        }
        Button("Inspect") { viewModel.select(file.id); dismiss() }
      }.disabled(working || viewModel.isBusy(file.id))
      if let lane {
        ForEach(worktreeFolders(file), id: \.path) { folder in
          Text(folder.path).font(.caption.monospaced()).foregroundColor(.secondary)
            .lineLimit(2).truncationMode(.middle).textSelection(.enabled)
        }
        HStack {
          Menu("Open") {
            let folders = worktreeFolders(file)
            if folders.count == 1, let folder = folders.first {
              folderActions(folder)
            } else {
              ForEach(folders, id: \.path) { folder in
                Menu(folder.lastPathComponent) { folderActions(folder) }
              }
            }
            Button("Copy shell exports") { copyExports(file) }
              .help("export lines for this lane's ports, URLs and variables, for tests you run yourself")
          }.fixedSize()
          if lane.pinned { Button("Unpin") { unpin(file) }.help("Follow \(lane.sourceStackID)'s current definition") }
          Spacer()
          Button("Remove lane…", role: .destructive) { removal = .init(file: file) }.fixedSize()
        }.disabled(working || viewModel.isBusy(file.id))
      }
    }
    .padding(14).frame(width: 260, alignment: .topLeading).stackSurface(cornerRadius: 12)
    .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(
      lane?.isReviewer == true ? WorkspaceLaneMapStyle.reviewer.opacity(0.5) : .clear, lineWidth: 1))
    .contextMenu {
      if file.lane != nil {
        Button("Delete lane…", role: .destructive) { removal = .init(file: file) }
          .disabled(working || viewModel.isBusy(file.id))
      }
    }
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

  private func worktreeFolders(_ file: StackDefinitionFile) -> [URL] {
    if !file.laneWorktrees.isEmpty { return file.laneWorktrees.map(\.path) }
    return [file.definition?.root ?? file.lane?.directory].compactMap { $0 }
  }

  @ViewBuilder private func folderActions(_ folder: URL) -> some View {
    Button("Finder") { NSWorkspace.shared.open(folder) }
    Button("Copy folder path") {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(folder.path, forType: .string)
    }
    ForEach(Self.editors, id: \.bundle) { editor in
      if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: editor.bundle) {
        Button(editor.name) { open(folder, with: app) }
      }
    }
  }

  // MARK: Actions

  /// Closes this sheet and opens the creation window, so only one window is in front.
  private func create() {
    guard let source else { return }
    dismiss()
    viewModel.newLane(from: source)
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
