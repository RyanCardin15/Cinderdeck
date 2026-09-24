import SwiftUI

/// The original checkout and every branch lane share one view, but each card
/// controls only its own processes, logs and worktrees.
struct StackLanesView: View {
  @ObservedObject var viewModel: StacksViewModel
  @Environment(\.dismiss) private var dismiss
  @State private var branch = ""
  @State private var startAfterCreation = true
  @State private var working = false
  @State private var error: String?
  @State private var removing: StackDefinitionFile?

  private var sourceID: String? { viewModel.selectedFile?.lane?.sourceStackID ?? viewModel.selectedStackID }
  private var source: StackDefinitionFile? { viewModel.files.first { $0.id == sourceID } }
  private var lanes: [StackDefinitionFile] {
    viewModel.files.filter { $0.id == sourceID || $0.lane?.sourceStackID == sourceID }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text("\(source?.name ?? "Stack") lanes").font(.title2.bold())
          Text("Run branches side by side, each with its own services and ports.").foregroundColor(.secondary)
        }
        Spacer()
        Button("Done") { dismiss() }.keyboardShortcut(.cancelAction)
      }
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 12) { ForEach(lanes) { card($0) } }.padding(3)
      }
      Divider()
      Text("Create a lane").font(.headline)
      HStack {
        TextField("Branch, e.g. agent/codex-1", text: $branch)
          .textFieldStyle(.roundedBorder).accessibilityIdentifier("stacks.laneBranch")
        Button(working ? "Working…" : "Create lane") { create() }
          .disabled(working || branch.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || source?.definition == nil)
          .accessibilityIdentifier("stacks.createLane")
      }
      Toggle("Start services after creation", isOn: $startAfterCreation).disabled(working)
      Text("Uses an existing local branch or creates one from each repository’s HEAD. Uncheck start to install dependencies first. Services must use PORT and CINDERDECK_PORT_<SERVICE> for their assigned ports.")
        .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
      if let error { Text(error).foregroundColor(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
    }
    .padding(24).frame(width: 860)
    .alert("Remove this lane?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
      Button("Cancel", role: .cancel) { removing = nil }
      Button("Stop and remove", role: .destructive) {
        if let file = removing { remove(file) }; removing = nil
      }
    } message: {
      Text("Stops only this lane and removes its clean worktrees. Git branches are kept. Local and ignored files must be moved or committed first.")
    }
  }

  private func card(_ file: StackDefinitionFile) -> some View {
    let lane = file.lane
    let state = viewModel.states[file.id] ?? .init()
    let branches = file.definition?.repos.compactMap { viewModel.repoStatuses[$0.path]?.branchLabel } ?? []
    return VStack(alignment: .leading, spacing: 10) {
      HStack {
        StackStatusDot(label: state.label)
        Text(lane?.name ?? branches.first ?? "Original checkout").font(.headline).lineLimit(2)
      }
      Text(lane?.owner.label ?? "Original checkout").font(.caption).foregroundColor(.secondary)
      Text(state.operation ?? state.label).font(.caption).foregroundColor(.secondary)
      ForEach(file.issues) { issue in Text(issue.message).font(.caption).foregroundColor(.orange).lineLimit(3) }
      ForEach(file.definition?.services ?? []) { service in
        HStack(spacing: 6) {
          StackStatusDot(phase: viewModel.runtime(file.id, service.id).phase, size: 6)
          Text(service.id).lineLimit(1)
          Spacer()
          if let port = service.port {
            Button(":\(String(port))") { viewModel.openPort(port) }.buttonStyle(.link)
          }
        }.font(.caption)
      }
      if let claim = viewModel.claim(file.id) {
        Label("Claimed by \(claim.holder.name)", systemImage: "lock.fill").font(.caption).foregroundColor(StackPalette.agent)
      }
      HStack {
        Button(state.isActive ? "Stop" : "Start") { viewModel.toggle(file.id) }
          .disabled(!state.isActive && file.definition == nil)
        Button("Logs") { viewModel.showLogs(stack: file.id, service: nil) }
        Button("Inspect") { viewModel.select(file.id); dismiss() }
      }.disabled(working || viewModel.isBusy(file.id))
      if let lane {
        HStack {
          Button("Open folder") { NSWorkspace.shared.open(lane.directory) }
          Spacer()
          Button("Remove", role: .destructive) { removing = file }
        }.disabled(working || viewModel.isBusy(file.id))
      }
    }
    .padding(14).frame(width: 250, alignment: .topLeading).stackSurface(cornerRadius: 12)
  }

  private func create() {
    guard let sourceID else { return }
    let name = branch.trimmingCharacters(in: .whitespacesAndNewlines)
    working = true; error = nil
    Task {
      defer { working = false }
      do {
        let file = try await viewModel.supervisor.createLane(stack: sourceID, branch: name, actor: .user)
        branch = ""
        if startAfterCreation { await viewModel.supervisor.start(stack: file.id, actor: .user) }
      } catch { self.error = error.localizedDescription }
    }
  }

  private func remove(_ file: StackDefinitionFile) {
    working = true; error = nil
    Task {
      defer { working = false }
      do {
        try await viewModel.supervisor.removeLane(file.id, actor: .user)
        StackControlService.shared.release(stack: file.id)
      } catch { self.error = error.localizedDescription }
    }
  }
}
