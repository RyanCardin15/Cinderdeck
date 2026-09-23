import SwiftUI

struct StackCompactCardView: View {
  let file: StackDefinitionFile
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject var manager: HistoryFloatingManager
  private var state: StackRuntimeState { viewModel.states[file.id] ?? .init() }
  private var selected: Bool { viewModel.selectedStackID == file.id }

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      VStack(alignment: .leading, spacing: 5) {
        Text(file.name).font(.system(size: 13.5, weight: .semibold)).lineLimit(1).help(file.name)
        StackStateBadge(label: file.definition == nil ? "Degraded" : state.label, since: state.isActive ? state.startedAt : nil)
      }
      notices
      ScrollView(showsIndicators: false) {
        VStack(spacing: 5) {
          ForEach(services) { service in serviceRow(service) }
          // Repos without services still show branch information.
          ForEach((file.definition?.repos ?? []).filter { repo in !services.contains { $0.repo == repo.id } }) { repo in
            HStack(spacing: 6) {
              Image(systemName: "folder").font(.system(size: 9)).foregroundColor(.secondary).frame(width: 14)
              Text(repo.id).font(.system(size: 11, weight: .medium)).foregroundColor(.secondary)
              Spacer(minLength: 2)
              StackBranchChip(stack: file.id, repo: repo, viewModel: viewModel)
            }
          }
        }
      }.frame(maxHeight: .infinity)
      footer
    }
    .padding(12)
    .frame(width: 300, height: 212)
    .stackSurface(cornerRadius: 16, selected: selected)
    .contentShape(RoundedRectangle(cornerRadius: 16))
    .onTapGesture { viewModel.select(file.id) }
    .accessibilityElement(children: .contain).accessibilityLabel(file.name)
  }

  @ViewBuilder private var notices: some View {
    if let claim = viewModel.claim(file.id) {
      StackClaimChip(claim: claim) { viewModel.releaseClaim(file.id) }
    }
    if !file.issues.isEmpty {
      Label(file.issues.map(\.message).joined(separator: " · "), systemImage: file.definition == nil ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
        .font(.system(size: 10, weight: .medium)).lineLimit(2)
        .foregroundColor(file.definition == nil ? StackPalette.color(phase: .crashed) : .orange)
    } else if viewModel.supervisor.definitionChanged(file.id) {
      Label("Definition changed — restart to apply", systemImage: "arrow.triangle.2.circlepath")
        .font(.system(size: 10, weight: .medium)).foregroundColor(.orange)
    }
    if let trouble = state.services.sorted(by: { $0.key < $1.key }).first(where: { $0.value.detail != nil && $0.value.phase != .waiting }) {
      VStack(alignment: .leading, spacing: 5) {
        Text("\(trouble.key): \(trouble.value.detail ?? "")").font(.system(size: 10)).lineLimit(2)
          .foregroundColor(trouble.value.phase == .crashed ? StackPalette.color(phase: .crashed) : .orange)
        if let conflict = trouble.value.conflict {
          HStack(spacing: 6) {
            Button("Kill & start") { viewModel.killConflict(stack: file.id, service: trouble.key, startAfter: true) }
              .buttonStyle(StackPillButtonStyle(kind: .destructive, compact: true)).disabled(conflict.owners.isEmpty)
            Button("Dismiss") { viewModel.supervisor.dismissPortConflict(stack: file.id, service: trouble.key) }
              .buttonStyle(StackPillButtonStyle(compact: true))
          }
        }
      }
    }
  }

  private func serviceRow(_ service: ServiceDefinition) -> some View {
    let runtime = viewModel.runtime(file.id, service.id)
    return HStack(spacing: 6) {
      StackStatusDot(phase: runtime.phase, size: 7)
      Text(service.id).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
        .foregroundColor(runtime.phase == .stopped ? .secondary : .primary)
      if runtime.process != nil, let owner = runtime.owner, owner.isAgent {
        Image(systemName: "sparkles").font(.system(size: 9, weight: .bold)).foregroundColor(StackPalette.agent)
          .help(StackOwnerBadge.help(owner))
      }
      Spacer(minLength: 2)
      if let port = service.port ?? { if case .port(let port) = service.readiness { return port }; return nil }() {
        Button { viewModel.openPort(port) } label: { StackChip(text: ":\(String(port))", tint: runtime.phase == .ready ? .accentColor : .secondary, monospaced: true) }
          .buttonStyle(.plain).help("Open http://localhost:\(String(port))").fixedSize()
      }
      if let repo = service.repo.flatMap({ file.definition?.repo($0) }) {
        StackBranchChip(stack: file.id, repo: repo, viewModel: viewModel)
      }
    }
    .padding(.vertical, 1)
  }

  private var footer: some View {
    HStack(spacing: 6) {
      if state.isActive {
        Button { viewModel.toggle(file.id) } label: { Label("Stop", systemImage: "stop.fill") }
          .buttonStyle(StackPillButtonStyle(kind: .secondary, compact: true))
        Button { viewModel.restart(file.id) } label: { Label("Restart", systemImage: "arrow.clockwise") }
          .buttonStyle(StackPillButtonStyle(compact: true)).disabled(viewModel.isBusy(file.id))
      } else {
        Button { viewModel.toggle(file.id) } label: { Label("Start", systemImage: "play.fill") }
          .buttonStyle(StackPillButtonStyle(kind: .primary(StackPalette.color(phase: .ready)), compact: true))
          .disabled(file.definition == nil || viewModel.isBusy(file.id))
      }
      Spacer(minLength: 4)
      if let crashed = state.services.values.filter({ $0.phase == .crashed }).compactMap(\.lastCrashedAt).max() {
        (Text("Crashed ") + Text(crashed, style: .relative) + Text(" ago")).font(.system(size: 10)).foregroundColor(.secondary).lineLimit(1)
      } else if let operation = state.operation {
        Text(operation + "…").font(.system(size: 10)).foregroundColor(.secondary)
      }
      StackActionsMenu(file: file, viewModel: viewModel, manager: manager)
    }
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
      Button("Edit workspace…") { viewModel.edit(file) }
      Button("Open workspace file in editor") { viewModel.openInEditor(file) }
      Button("Open terminal") { viewModel.showLogs(stack: file.id, service: nil) }
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
          Button("Switch workspace to branch…") { viewModel.select(file.id); viewModel.openStackBranchPicker() }
            .disabled(viewModel.isBusy(file.id))
        }
      }
      Divider()
      Button("Show log files") { viewModel.openLogFile(stack: file.id, service: nil) }
      if viewModel.claim(file.id) != nil {
        Button("Release agent claim…") { viewModel.releaseClaim(file.id) }
      }
      Button("Agent access…") { viewModel.agentsSheet = true }
      Button("Refresh shell environment") { viewModel.refreshEnvironment(file.definition) }
    } label: { Image(systemName: "ellipsis").font(.system(size: 11, weight: .semibold)).frame(width: 18, height: 18) }
      .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("Workspace actions").accessibilityLabel("Workspace actions")
  }
}

struct StackBranchChip: View {
  let stack: String
  let repo: RepoDefinition
  @ObservedObject var viewModel: StacksViewModel
  var wraps = false
  private var status: GitRepoStatus { viewModel.status(repo) }
  private var helpText: String {
    var text = "\(repo.id) · \(status.chip)\n\(repo.path.path)"
    if let error = status.error { text += "\n\(error)" }
    if viewModel.busyRepos.contains(repo.path) { text += "\nA Git operation is in progress." }
    else if !viewModel.canSwitch(stack: stack, repo: repo.id) { text += "\nWait for services to finish starting or stopping before switching branches." }
    else { text += "\nClick to switch branches." }
    return text
  }
  var body: some View {
    Button { viewModel.openBranchPicker(stack: stack, repo: repo) } label: {
      StackChip(systemImage: "arrow.triangle.branch", text: status.chip,
        tint: status.error != nil ? .secondary : status.isDirty ? .orange : StackPalette.branch, wraps: wraps)
        .multilineTextAlignment(.leading)
    }
    .buttonStyle(.plain).disabled(!viewModel.canSwitch(stack: stack, repo: repo.id) || viewModel.busyRepos.contains(repo.path))
    .stackHelp(helpText)
    .accessibilityLabel("\(repo.id), branch \(viewModel.status(repo).chip)")
    .popover(isPresented: Binding(get: { viewModel.branchPicker?.id == stack + "/" + repo.id }, set: { if !$0 { viewModel.branchPicker = nil } })) {
      BranchPickerPopover(viewModel: viewModel)
    }
  }
}
