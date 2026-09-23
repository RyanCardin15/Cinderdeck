import SwiftUI

struct StackCompactCardView: View {
  let file: StackDefinitionFile
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject var manager: HistoryFloatingManager
  private var state: StackRuntimeState { viewModel.states[file.id] ?? .init() }
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        Text(file.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
        Spacer(minLength: 6)
        StackStatusDot(label: state.label)
        Text(state.label).font(.caption).foregroundColor(.secondary)
      }
      if !file.issues.isEmpty {
        Text(file.issues.map(\.message).joined(separator: "\n"))
          .font(.caption2).foregroundColor(file.definition == nil ? .red : .orange).lineLimit(3)
      }
      if viewModel.supervisor.definitionChanged(file.id) {
        Text("Definition changed — restart to apply").font(.caption2).foregroundColor(.orange)
      }
      if let trouble = state.services.sorted(by: { $0.key < $1.key }).first(where: { $0.value.detail != nil && $0.value.phase != .waiting }) {
        Text("\(trouble.key): \(trouble.value.detail ?? "")").font(.caption2).foregroundColor(.orange).lineLimit(2)
        if let conflict = trouble.value.conflict {
          HStack {
            Button("Kill & start") { viewModel.killConflict(stack: file.id, service: trouble.key, startAfter: true) }
              .disabled(conflict.owners.isEmpty)
            Button("Cancel") { viewModel.supervisor.dismissPortConflict(stack: file.id, service: trouble.key) }
          }.controlSize(.small)
        }
      }
      ScrollView {
        VStack(spacing: 6) {
          ForEach(services) { service in
            HStack(spacing: 6) {
              StackStatusDot(phase: viewModel.runtime(file.id, service.id).phase)
              Text(service.id).font(.system(size: 11, weight: .medium)).lineLimit(1)
              Spacer(minLength: 2)
              if let port = service.port ?? { if case .port(let port) = service.readiness { return port }; return nil }() {
                Button(":\(String(port))") { viewModel.openPort(port) }.buttonStyle(.plain).foregroundColor(.secondary).font(.caption2)
              }
              if let repo = service.repo.flatMap({ file.definition?.repo($0) }) {
                StackBranchChip(stack: file.id, repo: repo, viewModel: viewModel)
              }
            }
          }
          // Repos without services still show branch information.
          ForEach((file.definition?.repos ?? []).filter { repo in !services.contains { $0.repo == repo.id } }) { repo in
            HStack { Text(repo.id).font(.caption); Spacer(); StackBranchChip(stack: file.id, repo: repo, viewModel: viewModel) }
          }
        }
      }.frame(maxHeight: .infinity)
      HStack(spacing: 7) {
        Button(state.isActive ? "Stop" : "Start", systemImage: state.isActive ? "stop.fill" : "play.fill") { viewModel.toggle(file.id) }
          .disabled(!state.isActive && (file.definition == nil || viewModel.isBusy(file.id)))
        if state.isActive {
          Button { viewModel.restart(file.id) } label: { Image(systemName: "arrow.clockwise") }
            .disabled(viewModel.isBusy(file.id)).help("Restart stack")
        }
        Spacer()
        if let crashed = state.services.values.filter({ $0.phase == .crashed }).compactMap(\.lastCrashedAt).max() {
          (Text("Crashed ") + Text(crashed, style: .relative) + Text(" ago")).font(.caption2).foregroundColor(.secondary)
        } else if let started = state.startedAt { Text(started, style: .relative).font(.caption2).foregroundColor(.secondary) }
        StackActionsMenu(file: file, viewModel: viewModel, manager: manager)
      }.buttonStyle(.bordered).controlSize(.small)
    }
    .padding(12).frame(width: 300, height: 208)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    .overlay(RoundedRectangle(cornerRadius: 14).stroke(viewModel.selectedStackID == file.id ? Color.accentColor.opacity(0.8) : Color.secondary.opacity(0.15), lineWidth: 1))
    .onTapGesture { viewModel.select(file.id) }
    .accessibilityElement(children: .contain).accessibilityLabel(file.name)
  }
  private var services: [ServiceDefinition] {
    var result = file.definition?.services ?? []
    for runtime in state.services.values {
      if let service = runtime.launchDefinition?.service, !result.contains(where: { $0.id == service.id }) { result.append(service) }
    }
    return result.sorted { $0.id < $1.id }
  }
}

struct StackActionsMenu: View {
  let file: StackDefinitionFile
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject var manager: HistoryFloatingManager
  var body: some View {
    Menu {
      Button("Edit stack…") { viewModel.edit(file) }
      Button("Open stack file in editor") { viewModel.openInEditor(file) }
      Button("Show logs") { viewModel.showLogs(stack: file.id, service: nil, manager: manager) }
      if let stack = file.definition {
        Menu("Restart service") {
          ForEach(stack.services) { service in Button(service.id) { viewModel.restart(file.id, service: service.id) } }
        }.disabled(viewModel.isBusy(file.id))
        ForEach(stack.repos) { repo in
          Menu(repo.id) {
            Button("Open in Finder") { viewModel.openRepo(repo) }
            Button("Open in VS Code") { viewModel.openRepo(repo, inCode: true) }
          }
        }
        if !stack.repos.isEmpty {
          Button("Switch stack to branch…") { viewModel.select(file.id); viewModel.openStackBranchPicker() }
            .disabled(viewModel.isBusy(file.id))
        }
      }
      Divider()
      Button("Refresh shell environment") { viewModel.refreshEnvironment(file.definition) }
    } label: { Image(systemName: "ellipsis").frame(width: 16) }
      .menuStyle(.borderlessButton).fixedSize().help("Stack actions").accessibilityLabel("Stack actions")
  }
}

struct StackBranchChip: View {
  let stack: String
  let repo: RepoDefinition
  @ObservedObject var viewModel: StacksViewModel
  var body: some View {
    Button { viewModel.openBranchPicker(stack: stack, repo: repo) } label: {
      Label(viewModel.status(repo).chip, systemImage: "arrow.triangle.branch")
        .font(.system(size: 10, weight: .medium)).lineLimit(1).frame(maxWidth: 145)
        .padding(.horizontal, 6).padding(.vertical, 3)
        .background(Color.secondary.opacity(0.1), in: Capsule())
    }
    .buttonStyle(.plain).disabled(!viewModel.canSwitch(stack: stack, repo: repo.id) || viewModel.busyRepos.contains(repo.path))
    .help(viewModel.status(repo).error ?? repo.path.path)
    .accessibilityLabel("\(repo.id), branch \(viewModel.status(repo).chip)")
    .popover(isPresented: Binding(get: { viewModel.branchPicker?.id == stack + "/" + repo.id }, set: { if !$0 { viewModel.branchPicker = nil } })) {
      BranchPickerPopover(viewModel: viewModel)
    }
  }
}
