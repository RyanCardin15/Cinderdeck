import SwiftUI

struct StackExpandedView: View {
  let file: StackDefinitionFile
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject var manager: HistoryFloatingManager
  private var state: StackRuntimeState { viewModel.selectedState }

  var body: some View {
    GeometryReader { geometry in
      VStack(alignment: .leading, spacing: 12) {
        header
        notices
        ScrollView(.vertical) {
          VStack(alignment: .leading, spacing: 12) {
            servicesGrid
            if let repos = file.definition?.repos, !repos.isEmpty { repoList(repos) }
          }.padding(2)
        }
        .frame(maxHeight: geometry.size.height * 0.48)
        StackConsoleView(file: file, viewModel: viewModel)
          .frame(minHeight: 150, maxHeight: .infinity)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  // MARK: Header

  private var header: some View {
    HStack(alignment: .center, spacing: 10) {
      VStack(alignment: .leading, spacing: 5) {
        Text(file.name).font(.system(size: 19, weight: .bold)).lineLimit(1).help(file.name)
        HStack(spacing: 6) {
          StackStateBadge(label: file.definition == nil ? "Degraded" : state.label, since: state.isActive ? state.startedAt : nil)
          if let operation = state.operation { StackChip(systemImage: "hourglass", text: operation + "…", tint: .orange) }
          if let claim = viewModel.claim(file.id) { StackClaimChip(claim: claim) { viewModel.releaseClaim(file.id) } }
          Text(file.id + ".toml").font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary.opacity(0.8)).lineLimit(1)
            .onTapGesture { viewModel.openInEditor(file) }.help("Open the definition in your editor")
        }
      }
      Spacer(minLength: 6)
      if state.isActive {
        Button { viewModel.toggle(file.id) } label: { Label("Stop", systemImage: "stop.fill") }
          .buttonStyle(StackPillButtonStyle())
      } else {
        Button { viewModel.toggle(file.id) } label: { Label("Start stack", systemImage: "play.fill") }
          .buttonStyle(StackPillButtonStyle(kind: .primary(StackPalette.color(phase: .ready))))
          .disabled(file.definition == nil || viewModel.isBusy(file.id))
      }
      Button { viewModel.restart(file.id) } label: { Label("Restart", systemImage: "arrow.clockwise") }
        .buttonStyle(StackPillButtonStyle())
        .disabled(file.definition == nil || viewModel.isBusy(file.id))
      StackActionsMenu(file: file, viewModel: viewModel, manager: manager)
    }
  }

  @ViewBuilder private var notices: some View {
    if !file.issues.isEmpty {
      ScrollView {
        VStack(alignment: .leading, spacing: 3) {
          ForEach(file.issues) { issue in
            Label(issue.message, systemImage: issue.severity == .error ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
              .foregroundColor(issue.severity == .error ? StackPalette.color(phase: .crashed) : .orange)
          }
        }.font(.system(size: 11, weight: .medium)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
      }
      .frame(maxHeight: 58)
      .padding(8).stackSurface(cornerRadius: 10, tint: .orange)
    }
    if viewModel.supervisor.definitionChanged(file.id) {
      HStack(spacing: 8) {
        Label("Definition changed — restart to apply", systemImage: "arrow.triangle.2.circlepath")
          .font(.system(size: 11, weight: .medium)).foregroundColor(.orange)
        Spacer()
        Button("Restart now") { viewModel.restart(file.id) }.buttonStyle(StackPillButtonStyle(compact: true))
      }
    }
  }

  // MARK: Services

  private var servicesGrid: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), spacing: 10)], spacing: 10) {
      ForEach(viewModel.selectedServices) { service in
        StackServiceTile(stack: file, service: service, viewModel: viewModel, manager: manager)
      }
    }
  }

  // MARK: Repos

  private func repoList(_ repos: [RepoDefinition]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("REPOSITORIES").font(.system(size: 9, weight: .bold)).foregroundColor(.secondary).tracking(0.6)
      ForEach(repos) { repo in StackRepoRow(stack: file.id, repo: repo, viewModel: viewModel) }
    }
  }
}

// MARK: - Service tile

struct StackServiceTile: View {
  let stack: StackDefinitionFile
  let service: ServiceDefinition
  @ObservedObject var viewModel: StacksViewModel
  @ObservedObject var manager: HistoryFloatingManager
  private var runtime: StackServiceRuntime { viewModel.runtime(stack.id, service.id) }
  private var selected: Bool { viewModel.selectedServiceID == service.id }
  private var port: Int? { service.port ?? { if case .port(let port) = service.readiness { return port }; return nil }() }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 7) {
        StackStatusDot(phase: runtime.phase)
        Text(service.id).font(.system(size: 12.5, weight: .semibold)).lineLimit(1).help(service.id)
        Spacer(minLength: 2)
        actions.fixedSize()
      }
      HStack(spacing: 5) {
        if let port {
          Button { viewModel.openPort(port) } label: {
            StackChip(systemImage: "globe", text: ":\(String(port))", tint: runtime.phase == .ready ? .accentColor : .secondary, monospaced: true)
          }.buttonStyle(.plain).help("Open http://localhost:\(String(port))").fixedSize()
        }
        if let repo = service.repo.flatMap({ stack.definition?.repo($0) }) {
          StackBranchChip(stack: stack.id, repo: repo, viewModel: viewModel)
        }
        Spacer(minLength: 4)
      }
      HStack(spacing: 6) {
        Text(runtime.phase.label).font(.system(size: 10.5)).foregroundColor(StackPalette.color(phase: runtime.phase)).lineLimit(1)
        Spacer(minLength: 4)
        if let started = runtime.startedAt {
          StackElapsedTime(since: started).font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary)
        }
      }
      meta
      if let detail = runtime.detail {
        HStack(spacing: 6) {
          Text(detail).font(.system(size: 10)).lineLimit(2).textSelection(.enabled)
            .foregroundColor(runtime.phase == .crashed ? StackPalette.color(phase: .crashed) : .secondary)
          if let conflict = runtime.conflict {
            Button(runtime.phase == .stopped ? "Kill" : "Kill & start") {
              viewModel.killConflict(stack: stack.id, service: service.id, startAfter: runtime.phase != .stopped)
            }.buttonStyle(StackPillButtonStyle(kind: .destructive, compact: true)).disabled(conflict.owners.isEmpty)
            Button("Dismiss") { viewModel.supervisor.dismissPortConflict(stack: stack.id, service: service.id) }
              .buttonStyle(StackPillButtonStyle(compact: true))
          }
        }
      }
    }
    .padding(.horizontal, 11).padding(.vertical, 9)
    .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
    .stackSurface(cornerRadius: 12, selected: selected, tint: runtime.phase == .crashed ? StackPalette.color(phase: .crashed) : nil)
    .contentShape(RoundedRectangle(cornerRadius: 12))
    .onTapGesture { viewModel.selectService(selected ? nil : service.id) }
    .accessibilityElement(children: .contain).accessibilityLabel("\(service.id), \(runtime.phase.label)")
  }

  private var meta: some View {
    HStack(spacing: 4) {
      if let process = runtime.process { Text("pid \(String(process.pid))") }
      if runtime.restartCount > 0 { Text("↻ \(runtime.restartCount)").help("\(runtime.restartCount) automatic restarts") }
      Spacer(minLength: 0)
      if runtime.process != nil { StackOwnerBadge(owner: runtime.owner, compact: true) }
    }
    .font(.system(size: 9.5, design: .monospaced)).foregroundColor(.secondary).lineLimit(1)
  }

  private var actions: some View {
    HStack(spacing: 1) {
      if !runtime.phase.isActive && runtime.process == nil {
        StackIconButton(systemName: "play.fill", help: "Start \(service.id)", tint: StackPalette.color(phase: .ready), size: 22) {
          viewModel.start(stack.id, service: service.id)
        }.disabled(viewModel.isBusy(stack.id))
      } else {
        StackIconButton(systemName: "arrow.clockwise", help: "Restart \(service.id) (Option: also dependents)", size: 22) {
          viewModel.restart(stack.id, service: service.id, dependents: NSEvent.modifierFlags.contains(.option))
        }.disabled(viewModel.isBusy(stack.id))
        StackIconButton(systemName: "stop.fill", help: "Stop \(service.id)", size: 22) { viewModel.stop(stack.id, service: service.id) }
      }
      StackIconButton(systemName: "text.alignleft", help: "Show \(service.id) logs", size: 22) {
        viewModel.selectService(service.id)
        viewModel.showsActivity = false
      }
    }
  }
}

// MARK: - Repo card

struct StackRepoRow: View {
  let stack: String
  let repo: RepoDefinition
  @ObservedObject var viewModel: StacksViewModel
  private var status: GitRepoStatus { viewModel.status(repo) }
  private var busy: Bool { viewModel.busyRepos.contains(repo.path) }
  private var pullHelp: String {
    if busy { return "Wait for the current Git operation to finish." }
    if !viewModel.canSwitch(stack: stack, repo: repo.id) { return "Wait for services to finish starting or stopping before pulling." }
    if status.upstream == nil { return "No upstream branch is configured for \(repo.id)." }
    return "Pull \(repo.id) from its upstream branch (fast-forward only)."
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(spacing: 7) {
        Image(systemName: "shippingbox").font(.system(size: 10, weight: .semibold)).foregroundColor(.secondary)
        Text(repo.id).font(.system(size: 11.5, weight: .semibold)).lineLimit(1).help(repo.path.path)
        Spacer(minLength: 4)
        Group {
          if let reason = status.operation ?? status.error {
            Text(reason).foregroundColor(.orange).lineLimit(1).help(reason)
          } else if status.isDirty {
            Text("\(status.changedFiles) changed").foregroundColor(.orange)
              .help("\(status.staged) staged · \(status.unstaged) unstaged · \(status.untracked) untracked · \(status.conflicted) conflicted")
          } else {
            Text("clean").foregroundColor(.secondary)
          }
        }.font(.system(size: 10, weight: .medium))
        let stashes = viewModel.stashes[repo.path] ?? []
        if !stashes.isEmpty {
          Menu {
            ForEach(stashes) { stash in
              Menu(stash.message) {
                Button("Pop") { viewModel.useStash(stash, repo: repo, drop: false) }
                Button("Drop…") { viewModel.useStash(stash, repo: repo, drop: true) }
              }
            }
          } label: { StackChip(systemImage: "tray.full", text: "\(stashes.count)", tint: .orange) }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().disabled(busy)
            .help("\(stashes.count) Cinderdeck stash\(stashes.count == 1 ? "" : "es")")
        }
        if busy { ProgressView().controlSize(.mini) }
        Button { viewModel.fetch(repo) } label: { Label("Fetch", systemImage: "arrow.down.circle") }
          .buttonStyle(StackPillButtonStyle(compact: true)).disabled(busy)
          .stackHelp(busy ? "Fetching or updating \(repo.id)…" : "Fetch remote updates for \(repo.id) without changing local files.")
        Button { viewModel.pull(repo, stack: stack) } label: { Label("Pull", systemImage: "arrow.down.to.line") }
          .buttonStyle(StackPillButtonStyle(compact: true))
          .disabled(busy || !viewModel.canSwitch(stack: stack, repo: repo.id) || status.upstream == nil)
          .stackHelp(pullHelp)
      }
      StackBranchChip(stack: stack, repo: repo, viewModel: viewModel, wraps: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .stackSurface(cornerRadius: 11)
  }
}

// MARK: - Console

struct StackConsoleView: View {
  let file: StackDefinitionFile
  @ObservedObject var viewModel: StacksViewModel
  @FocusState private var filterFocused: Bool
  private let background = Color(red: 0.07, green: 0.075, blue: 0.09)

  var body: some View {
    VStack(spacing: 0) {
      toolbar
      Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1)
      if viewModel.showsActivity { activity } else {
        StackLogView(lines: viewModel.filteredLogs, allServices: viewModel.logService == nil,
          serviceOrder: viewModel.selectedServices.map(\.id),
          autoScroll: viewModel.autoScroll, focusRequest: viewModel.logFocusRequest,
          onFocus: { viewModel.logFocused = true })
      }
    }
    .background(background)
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.white.opacity(0.08)))
    .environment(\.colorScheme, .dark)
  }

  private var toolbar: some View {
    HStack(spacing: 6) {
      ViewThatFits(in: .horizontal) {
        HStack(spacing: 4) {
          tab("All", color: nil, selected: viewModel.logService == nil && !viewModel.showsActivity) {
            viewModel.showsActivity = false; viewModel.selectService(nil)
          }
          ForEach(viewModel.selectedServices) { service in
            tab(service.id, color: StackPalette.service(service.id, in: viewModel.selectedServices.map(\.id)), selected: viewModel.logService == service.id && !viewModel.showsActivity) {
              viewModel.showsActivity = false; viewModel.selectService(service.id)
            }
          }
          tab("Activity", color: nil, icon: "clock.arrow.circlepath", selected: viewModel.showsActivity) { viewModel.showsActivity = true }
        }
        .fixedSize()
        Menu {
          Button("All services") { viewModel.showsActivity = false; viewModel.selectService(nil) }
          ForEach(viewModel.selectedServices) { service in
            Button(service.id) { viewModel.showsActivity = false; viewModel.selectService(service.id) }
          }
          Divider()
          Button("Activity") { viewModel.showsActivity = true }
        } label: {
          Text(viewModel.showsActivity ? "Activity" : viewModel.logService ?? "All services")
            .font(.system(size: 10.5, weight: .semibold)).lineLimit(1)
        }
        .menuStyle(.borderlessButton)
        .help("Choose which service logs to show")
      }
      Spacer(minLength: 4)
      if !viewModel.showsActivity {
        HStack(spacing: 5) {
          Image(systemName: "line.3.horizontal.decrease").font(.system(size: 9, weight: .bold)).foregroundColor(.secondary)
          TextField("Filter", text: $viewModel.logFilter).textFieldStyle(.plain)
            .font(.system(size: 11, design: .monospaced)).focused($filterFocused).frame(width: 120)
            .accessibilityLabel("Filter logs")
          if !viewModel.logFilter.isEmpty {
            Button { viewModel.logFilter = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 10)) }
              .buttonStyle(.plain).foregroundColor(.secondary)
              .stackHelp("Clear log filter").accessibilityLabel("Clear log filter")
          }
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Color.white.opacity(filterFocused ? 0.12 : 0.07), in: Capsule())
        StackIconButton(systemName: viewModel.autoScroll ? "arrow.down.to.line.compact" : "pause", help: viewModel.autoScroll ? "Auto-scroll on" : "Auto-scroll paused",
          tint: viewModel.autoScroll ? .accentColor : .secondary, size: 22) { viewModel.autoScroll.toggle() }
        StackIconButton(systemName: "doc.on.doc", help: "Copy visible logs", size: 22) { viewModel.copyLogs() }
        StackIconButton(systemName: "trash", help: "Clear the console (log files are kept)", size: 22) { viewModel.clearLogs() }
        StackIconButton(systemName: "arrow.up.forward.square", help: "Open log file", size: 22) {
          viewModel.openLogFile(stack: file.id, service: viewModel.logService)
        }
      }
    }
    .padding(.horizontal, 8).padding(.vertical, 6)
  }

  private func tab(_ title: String, color: Color?, icon: String? = nil, selected: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 5) {
        if let color { Circle().fill(color).frame(width: 6, height: 6) }
        if let icon { Image(systemName: icon).font(.system(size: 9, weight: .bold)) }
        Text(title).font(.system(size: 10.5, weight: .semibold)).lineLimit(1)
      }
      .foregroundColor(selected ? .white : .white.opacity(0.6))
      .padding(.horizontal, 9).padding(.vertical, 4)
      .background(selected ? Color.white.opacity(0.14) : Color.clear, in: Capsule())
      .contentShape(Capsule())
    }.buttonStyle(.plain)
  }

  private var activity: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        if viewModel.activity.isEmpty {
          Text("No activity yet").font(.system(size: 11)).foregroundColor(.secondary).padding(12)
        }
        ForEach(viewModel.activity) { event in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon(event.kind)).font(.system(size: 10, weight: .semibold)).foregroundColor(color(event.kind)).frame(width: 14)
            VStack(alignment: .leading, spacing: 2) {
              HStack(spacing: 5) {
                if let service = event.serviceName {
                  Text(service).font(.system(size: 11, weight: .semibold)).foregroundColor(StackPalette.service(service, in: viewModel.selectedServices.map(\.id)))
                }
                Text(title(event.kind)).font(.system(size: 11)).foregroundColor(.white.opacity(0.85))
                if let actor = event.actor {
                  StackChip(systemImage: actor == "You" ? "person.fill" : "sparkles", text: actor, tint: actor == "You" ? .secondary : StackPalette.agent)
                }
              }
              if let detail = event.detail { Text(detail).font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary).lineLimit(2) }
            }
            Spacer(minLength: 6)
            Text(event.occurredAt, style: .relative).font(.system(size: 10)).foregroundColor(.secondary)
          }
          .padding(.horizontal, 12).padding(.vertical, 6)
        }
      }.padding(.vertical, 4)
    }
  }

  private func title(_ kind: String) -> String {
    switch kind {
    case "branchSwitched": return "switched branches"
    case "repoChangeFailed": return "repo change failed"
    default: return kind
    }
  }
  private func icon(_ kind: String) -> String {
    switch kind {
    case "started": return "play.fill"
    case "ready": return "checkmark.circle.fill"
    case "stopped": return "stop.fill"
    case "crashed", "repoChangeFailed": return "xmark.octagon.fill"
    case "branchSwitched": return "arrow.triangle.branch"
    case "pulled": return "arrow.down.to.line"
    default: return "circle.fill"
    }
  }
  private func color(_ kind: String) -> Color {
    switch kind {
    case "ready", "started": return StackPalette.color(phase: .ready)
    case "crashed", "repoChangeFailed": return StackPalette.color(phase: .crashed)
    case "branchSwitched", "pulled": return StackPalette.branch
    default: return .secondary
    }
  }
}
