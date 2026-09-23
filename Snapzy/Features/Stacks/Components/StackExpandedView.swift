import SwiftUI

struct StackExpandedView: View {
  let file: StackDefinitionFile
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject var manager: HistoryFloatingManager
  @FocusState private var logFilterFocused: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      header
      if !file.issues.isEmpty {
        ScrollView { Text(file.issues.map(\.message).joined(separator: "\n")).font(.caption).foregroundColor(.orange).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }
          .frame(maxHeight: 65)
      }
      if viewModel.supervisor.definitionChanged(file.id) {
        Label("Definition changed — restart to apply", systemImage: "doc.badge.clock").font(.caption).foregroundColor(.orange)
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 10) {
          if let repos = file.definition?.repos, !repos.isEmpty {
            sectionLabel("REPOS")
            ForEach(repos) { repo in StackRepoRow(stack: file.id, repo: repo, viewModel: viewModel) }
            Divider().padding(.vertical, 2)
          }
          sectionLabel("SERVICES")
          ForEach(viewModel.selectedServices) { service in
            StackServiceRow(stack: file.id, service: service, viewModel: viewModel, manager: manager)
          }
        }.padding(.trailing, 5)
      }.frame(maxHeight: 255)
      logsToolbar
      StackLogView(lines: viewModel.filteredLogs, allServices: viewModel.logService == nil,
        autoScroll: viewModel.autoScroll, focusRequest: viewModel.logFocusRequest,
        onFocus: { viewModel.logFocused = true })
        .frame(minHeight: 85, maxHeight: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.15)))
      if let latest = viewModel.activity.first {
        DisclosureGroup {
          ScrollView {
            VStack(alignment: .leading, spacing: 4) {
              ForEach(viewModel.activity) { event in
                HStack {
                  Text([event.serviceName, event.kind, event.detail].compactMap { $0 }.joined(separator: " · "))
                  Spacer(); Text(event.occurredAt, style: .relative)
                }.font(.caption2).foregroundColor(.secondary)
              }
            }
          }.frame(maxHeight: 75)
        } label: {
          HStack(spacing: 4) {
            Text([latest.serviceName, latest.kind].compactMap { $0 }.joined(separator: " "))
            Text(latest.occurredAt, style: .relative)
            Text("ago")
          }.font(.caption2).foregroundColor(.secondary)
        }
      }
    }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
  private var header: some View {
    HStack(spacing: 8) {
      VStack(alignment: .leading, spacing: 3) {
        Text(file.name).font(.system(size: 18, weight: .semibold)).lineLimit(1)
        HStack(spacing: 5) {
          StackStatusDot(label: viewModel.selectedState.label)
          Text(viewModel.selectedState.label)
          if let started = viewModel.selectedState.startedAt { Text(started, style: .relative) }
        }.font(.caption).foregroundColor(.secondary)
      }
      Spacer(minLength: 4)
      Button(viewModel.selectedState.isActive ? "Stop" : "Start", systemImage: viewModel.selectedState.isActive ? "stop.fill" : "play.fill") { viewModel.toggle(file.id) }
        .disabled(!viewModel.selectedState.isActive && (file.definition == nil || viewModel.isBusy(file.id)))
      Button("Restart all", systemImage: "arrow.clockwise") { viewModel.restart(file.id) }
        .disabled(file.definition == nil || viewModel.isBusy(file.id))
      StackActionsMenu(file: file, viewModel: viewModel, manager: manager)
    }.controlSize(.small)
  }
  private var logsToolbar: some View {
    HStack(spacing: 8) {
      sectionLabel("LOGS")
      Picker("Service", selection: $viewModel.logService) {
        Text("All").tag(Optional<String>.none)
        ForEach(viewModel.selectedServices) { Text($0.id).tag(Optional($0.id)) }
      }.labelsHidden().frame(width: 115)
      TextField("Filter logs…", text: $viewModel.logFilter).textFieldStyle(.roundedBorder)
        .focused($logFilterFocused).onChange(of: logFilterFocused) { if $0 { viewModel.logFocused = true } }
      Toggle("Auto-scroll", isOn: $viewModel.autoScroll).toggleStyle(.checkbox).fixedSize()
      Button { viewModel.copyLogs() } label: { Image(systemName: "doc.on.doc") }.help("Copy visible logs").accessibilityLabel("Copy logs")
      Button("Clear") { viewModel.clearLogs() }.help("Clear the in-memory console; the log file is kept")
    }.font(.caption).controlSize(.small)
  }
  private func sectionLabel(_ title: String) -> some View { Text(title).font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary) }
}

struct StackServiceRow: View {
  let stack: String
  let service: ServiceDefinition
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject var manager: HistoryFloatingManager
  private var runtime: StackServiceRuntime { viewModel.runtime(stack, service.id) }
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 7) {
        StackStatusDot(phase: runtime.phase)
        Text(service.id).font(.system(size: 12, weight: .medium)).frame(minWidth: 70, alignment: .leading)
        if let port = service.port {
          Button(":\(String(port))") { viewModel.openPort(port) }.buttonStyle(.plain).foregroundColor(.accentColor)
        }
        if let process = runtime.process { Text("pid \(String(process.pid))").foregroundColor(.secondary) }
        if let started = runtime.startedAt { Text(started, style: .relative).foregroundColor(.secondary) }
        Text("\(runtime.restartCount) restarts").foregroundColor(.secondary)
        Spacer(minLength: 2)
        if !runtime.phase.isActive {
          Button { viewModel.start(stack, service: service.id) } label: { Image(systemName: "play.fill") }.help("Start service").accessibilityLabel("Start \(service.id)")
            .disabled(viewModel.isBusy(stack))
        }
        Button { viewModel.restart(stack, service: service.id, dependents: NSEvent.modifierFlags.contains(.option)) } label: { Image(systemName: "arrow.clockwise") }
          .help("Restart service (Option: also restart dependents)").accessibilityLabel("Restart \(service.id)").disabled(viewModel.isBusy(stack))
        Button { viewModel.stop(stack, service: service.id) } label: { Image(systemName: "stop.fill") }
          .disabled(!runtime.phase.isActive && runtime.process == nil).help("Stop service").accessibilityLabel("Stop \(service.id)")
        Button("Logs") { viewModel.selectedServiceID = service.id; viewModel.showLogs(stack: stack, service: service.id, manager: manager) }
      }.font(.caption).buttonStyle(.borderless)
      if let detail = runtime.detail {
        HStack {
          Text(detail).font(.caption2).foregroundColor(runtime.phase == .crashed ? .red : .secondary).textSelection(.enabled)
          if let conflict = runtime.conflict {
            Button(runtime.phase == .stopped ? "Kill" : "Kill & start") {
              viewModel.killConflict(stack: stack, service: service.id, startAfter: runtime.phase != .stopped)
            }.disabled(conflict.owners.isEmpty).font(.caption2)
            Button("Cancel") { viewModel.supervisor.dismissPortConflict(stack: stack, service: service.id) }.font(.caption2)
          }
        }
      }
    }
    .padding(6)
    .background(viewModel.selectedServiceID == service.id ? Color.accentColor.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
    .contentShape(Rectangle()).onTapGesture { viewModel.selectedServiceID = service.id }
  }
}

struct StackRepoRow: View {
  let stack: String
  let repo: RepoDefinition
  @ObservedObject var viewModel: StacksViewModel
  private var status: GitRepoStatus { viewModel.status(repo) }
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Text(repo.id).font(.system(size: 12, weight: .medium)).frame(minWidth: 85, alignment: .leading).lineLimit(1)
        StackBranchChip(stack: stack, repo: repo, viewModel: viewModel)
        Text(status.isDirty ? "\(status.changedFiles) changed" : "clean").foregroundColor(status.isDirty ? .orange : .secondary)
          .help("\(status.staged) staged · \(status.unstaged) unstaged · \(status.untracked) untracked · \(status.conflicted) conflicted")
        Spacer(minLength: 0)
        if viewModel.busyRepos.contains(repo.path) { ProgressView().controlSize(.mini) }
        Button("Fetch") { viewModel.fetch(repo) }.disabled(viewModel.busyRepos.contains(repo.path))
        Button("Pull") { viewModel.pull(repo, stack: stack) }.disabled(viewModel.busyRepos.contains(repo.path) || !viewModel.canSwitch(stack: stack, repo: repo.id) || status.upstream == nil)
      }.font(.caption).controlSize(.small)
      if let reason = status.operation ?? status.error { Text(reason).font(.caption2).foregroundColor(.orange).textSelection(.enabled) }
      let stashes = viewModel.stashes[repo.path] ?? []
      if !stashes.isEmpty {
        Menu("\(stashes.count) Snapzy stash\(stashes.count == 1 ? "" : "es")") {
          ForEach(stashes) { stash in
            Menu(stash.message) {
              Button("Pop") { viewModel.useStash(stash, repo: repo, drop: false) }
              Button("Drop…") { viewModel.useStash(stash, repo: repo, drop: true) }
            }
          }
        }.font(.caption2).fixedSize().disabled(viewModel.busyRepos.contains(repo.path))
      }
    }
  }
}
