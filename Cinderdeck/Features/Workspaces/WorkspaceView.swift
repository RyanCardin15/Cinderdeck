import SwiftUI

enum WorkspaceSection: String, CaseIterable {
  case services = "Services", tasks = "Tasks", workflows = "Workflows", laneMap = "Lane map", runs = "Runs", recordings = "Recordings", linkedWork = "Agents & linked work"
  var icon: String {
    switch self {
    case .services: return "server.rack"
    case .tasks: return "terminal"
    case .workflows: return "point.3.connected.trianglepath.dotted"
    case .laneMap: return "arrow.triangle.branch"
    case .runs: return "play.rectangle"
    case .recordings: return "record.circle"
    case .linkedWork: return "person.2.badge.gearshape"
    }
  }
  static func initialSection(_ workspace: StackDefinition) -> WorkspaceSection {
    workspace.services.isEmpty && !workspace.tasks.isEmpty ? .tasks : .services
  }
  var agentShellSection: String {
    switch self {
    case .services: return "services"
    case .tasks: return "tasks"
    case .workflows: return "workflows"
    case .laneMap: return "lane-map"
    case .runs: return "runs"
    case .recordings: return "recordings"
    case .linkedWork: return "agents"
    }
  }
  var explanation: String {
    switch self {
    case .services: return "Keep APIs, databases, and development servers running together."
    case .tasks: return "Run a command once. Keep its result, duration, and output."
    case .workflows: return "Run tasks and service actions in order. A failed step stops the workflow."
    case .laneMap: return "Follow lanes to their services and running tasks. Select a block to highlight its connections."
    case .runs: return "Inspect progress and results. Completed runs stay available after relaunch."
    case .linkedWork: return "Cinderdeck conversations linked to this workspace, with their last observed state and review artifacts."
    case .recordings: return "Screen recordings saved with this workspace's logs. Every log line is stamped with its position in the video."
    }
  }
}

struct WorkspaceView: View {
  @ObservedObject var model: StacksViewModel
  @ObservedObject var runner: WorkspaceRunner
  var onOpenInCinderdeck: (() -> Void)? = nil
  var onToolSheetDismiss: (() -> Void)? = nil
  @ObservedObject private var theme = ThemeManager.shared
  @State private var section = WorkspaceSection.services
  @State private var editing: WorkspaceComponentEditor.Context?
  @State private var selectedRun: UUID?
  @State private var search = ""
  @State private var expandedWorkspaces = Set<String>()
  private var workspace: StackDefinition? { model.selectedDefinition }
  private var navigation: WorkspaceNavigation { model.workspaceNavigation }
  private var workspaceRuns: [WorkspaceRun] { runner.runs.filter { $0.workspaceID == model.selectedStackID } }

  var body: some View {
    HSplitView {
      sidebar.frame(minWidth: 200, idealWidth: 225, maxWidth: 270)
      VStack(alignment: .leading, spacing: 16) {
        if let file = model.selectedFile {
          workspaceHeader(file)
          sectionNavigation
          if section != .laneMap {
            Text(section.explanation).foregroundStyle(.secondary).font(DeckStyle.body)
              .fixedSize(horizontal: false, vertical: true)
          }
          if model.selectedWorkspaceID != file.id, section != .laneMap {
            HStack {
              Label(file.lane.map { "Lane: \($0.name)" } ?? "Lane workspace", systemImage: "arrow.triangle.branch")
              Spacer()
              if let source = navigation.workspaces.first(where: { $0.id == model.selectedWorkspaceID }) {
                Button("Back to \(source.name)") { model.select(source.id) }
              }
            }.font(.callout)
            if file.lane != nil {
              Text("Edit the source workspace to change services, tasks, or workflows. Pinned lanes keep their saved definition until unpinned.")
                .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }
          }
          if let error = model.error ?? runner.storageError {
            HStack { Label(error, systemImage: "exclamationmark.triangle").textSelection(.enabled); Spacer(); Button("Dismiss") { model.error = nil } }
              .font(.callout).foregroundColor(.orange)
          }
          if let active = runner.activeRun(file.id), section != .runs, section != .laneMap {
            HStack {
              ProgressView().controlSize(.small)
              Text("\(active.name) · \(active.status.label)")
              Spacer()
              Button("View run") { selectedRun = active.id; section = .runs }
              Button("Cancel run") { cancel(active.id) }
            }.padding(10).background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
          }
          if file.definition == nil {
            Text(file.issues.map(\.message).joined(separator: "\n")).foregroundColor(.orange).textSelection(.enabled)
          }
          switch section {
          case .services:
            if workspace?.services.isEmpty == true {
              empty(file.lane == nil ? "No services yet" : "No services in this lane",
                file.lane == nil ? "Add the commands that should keep running, such as an API or database." : "Services added to the source workspace will be available in new lanes.",
                action: file.lane == nil ? "Add services" : "Edit source workspace") { model.edit(file) }
            } else {
              StackExpandedView(file: file, viewModel: model, manager: HistoryFloatingManager.shared, showsWorkspaceName: false)
            }
          case .tasks: tasks(file)
          case .workflows: workflows(file)
          case .laneMap: WorkspaceLaneMapView(model: model, runner: runner)
          case .runs: runs
          case .recordings: WorkspaceReprosView(file: file, recorder: .shared, controller: .shared, runner: runner)
          case .linkedWork: WorkspaceLinkedWorkView(workspaceID: file.id)
          }
        } else {
          empty("Get your project running", "Choose a repository to discover services, tests, and builds. Review the workspace and check launch requirements before starting.", action: "Set up project") { model.create() }
        }
      }.padding(24).frame(minWidth: 680, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .background(DeckStyle.canvas)
    .preferredColorScheme(theme.systemAppearance)
    .tint(DeckStyle.accent)
    .sheet(item: $model.editor, onDismiss: { onToolSheetDismiss?() }) { context in
      if context.file == nil {
        WorkspaceCreateView { id, start in
          model.editor = nil
          Task {
            await model.supervisor.reloadDefinitions(); model.select(id)
            section = model.supervisor.definition(id).map(WorkspaceSection.initialSection) ?? .services
            if start { await model.supervisor.start(stack: id, actor: .user) }
          }
        }
      } else {
        WorkspaceSettingsView(file: context.file!) { model.editor = nil; Task { await model.supervisor.reloadDefinitions() } }
      }
    }
    .sheet(item: $editing) { context in
      WorkspaceComponentEditor(context: context) { editing = nil; Task { await model.supervisor.reloadDefinitions() } }
    }
    .sheet(isPresented: $model.agentsSheet, onDismiss: { onToolSheetDismiss?() }) { StackAgentsSheet() }
    .sheet(isPresented: $model.lanesSheet) { StackLanesView(viewModel: model) }
    .sheet(item: $model.laneRemoval) { StackLaneRemovalView(request: $0, viewModel: model) }
    .sheet(item: $model.laneAttachment) { StackLaneAttachmentView(file: $0, model: model) }
    .sheet(isPresented: $model.stackBranchPicker) { StackBranchPickerSheet(viewModel: model) }
    .onChange(of: model.selectedStackID) { _ in selectedRun = nil; revealSelectedLane() }
    .onChange(of: model.selectedWorkspaceID) { _ in revealSelectedLane() }
    .onAppear { consumeSectionRequest(); revealSelectedLane() }
    .onChange(of: model.requestedSection) { _ in consumeSectionRequest() }
  }

  private func workspaceHeader(_ file: StackDefinitionFile) -> some View {
    HStack(alignment: .center, spacing: 12) {
      DeckFeatureIcon(systemName: file.lane == nil ? "square.stack.3d.up" : "arrow.triangle.branch")
        .workspaceReferenceDrag(file, model: model)
        .help("Drag a workspace reference to an editor or chat")
      VStack(alignment: .leading, spacing: 5) {
        DeckSectionLabel(title: file.lane == nil ? "Workspace" : "Worktree lane")
        Text(file.name).font(DeckStyle.title).lineLimit(2).help(file.name)
          .workspaceReferenceDrag(file, model: model)
          .accessibilityAddTraits(.isHeader)
        Text((workspace?.root.path ?? file.file.path)
          .replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path + "/", with: "~/"))
          .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
          .lineLimit(1).truncationMode(.middle).help(workspace?.root.path ?? file.file.path)
          .textSelection(.enabled)
      }
      Spacer(minLength: 12)
      HStack(spacing: 8) {
        if AgentShellController.shared.configured {
          Button {
            AgentShellController.shared.show(workspaceID: file.id, section: section.agentShellSection)
            if AgentShellController.shared.running { onOpenInCinderdeck?() }
          } label: {
            Label("Open in Cinderdeck", systemImage: "macwindow")
          }
          .help("Open this workspace in the main Cinderdeck window")
          .accessibilityIdentifier("workspace.openInCinderdeck")
        }
        Image(systemName: "hand.draw").foregroundStyle(.secondary)
          .frame(width: 28, height: 28).contentShape(Rectangle())
          .workspaceReferenceDrag(file, model: model)
          .help("Drag a workspace reference to an editor or chat")
          .accessibilityLabel("Drag workspace reference")
          .accessibilityIdentifier("workspace.dragReference")
        Button { model.lanesSheet = true } label: { Label("Lanes", systemImage: "arrow.triangle.branch") }
          .accessibilityIdentifier("stacks.lanes")
        Button { model.edit(file) } label: { Image(systemName: "slider.horizontal.3") }
          .help(file.lane == nil ? "Edit workspace" : "Edit source workspace")
          .accessibilityLabel(file.lane == nil ? "Edit workspace" : "Edit source workspace")
        Button { AgentAccessNavigation.open { model.agentsSheet = true } } label: { Image(systemName: "sparkles") }
          .help("Connect agents and CLI").accessibilityLabel("Connect agents and CLI")
      }.buttonStyle(DeckButtonStyle())
    }.padding(.bottom, 4)
  }

  private var sectionNavigation: some View {
    HStack(spacing: 4) {
      ForEach(WorkspaceSection.allCases, id: \.self) { item in
        Button { section = item } label: {
          Label(item.rawValue, systemImage: item.icon)
            .font(.system(size: 12, weight: section == item ? .semibold : .medium))
            .foregroundStyle(section == item ? DeckStyle.accent : .secondary)
            .padding(.horizontal, 10).padding(.vertical, 9)
            .background(section == item ? DeckStyle.accent.opacity(0.10) : .clear,
              in: RoundedRectangle(cornerRadius: 7))
            .contentShape(RoundedRectangle(cornerRadius: 7))
        }.buttonStyle(.plain).help(item.explanation)
          .accessibilityAddTraits(section == item ? .isSelected : [])
          .accessibilityIdentifier("workspace.section.\(item.rawValue)")
      }
      Spacer(minLength: 0)
    }.padding(4).deckSurface(radius: 11)
      .accessibilityElement(children: .contain).accessibilityIdentifier("workspace.sections")
  }

  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 10) {
        DeckFeatureIcon(systemName: "square.stack.3d.up.fill", size: 30)
        VStack(alignment: .leading, spacing: 3) {
          Text("Cinderdeck").font(DeckStyle.section)
          DeckSectionLabel(title: "Workspaces")
        }
        Spacer(minLength: 0)
        StackIconButton(systemName: "plus", help: "Create workspace", size: 28) { model.create() }
      }.padding(.vertical, 4)
      DeckSearchField(placeholder: "Find a workspace", text: $search)
      ScrollView {
        LazyVStack(spacing: 6) {
          if !search.isEmpty && !model.files.contains(where: matches) {
            VStack(spacing: 8) {
              Text("No workspaces found").font(DeckStyle.caption).foregroundStyle(.secondary)
              Button("Clear search") { search = "" }.buttonStyle(DeckButtonStyle(compact: true))
            }.padding(.vertical, 24)
          }
          ForEach(navigation.workspaces.filter { matches($0) || navigation.lanes(for: $0.id).contains(where: matches) }) { file in
            VStack(spacing: 4) {
              sidebarRow(file, isWorkspace: true)
              if expandedWorkspaces.contains(file.id) || !search.isEmpty {
                ForEach(navigation.lanes(for: file.id).filter { search.isEmpty || matches(file) || matches($0) }) { lane in
                  sidebarRow(lane, isWorkspace: false).padding(.leading, 16)
                }
              }
            }
          }
          if !navigation.unattachedLanes.isEmpty {
            DeckSectionLabel(title: "Unattached lanes")
              .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
            ForEach(navigation.unattachedLanes.filter(matches)) { file in
              sidebarRow(file, isWorkspace: false)
            }
          }
        }
      }
      Spacer(minLength: 0)
      Divider()
      HStack {
        Label("\(navigation.workspaces.count) \(navigation.workspaces.count == 1 ? "workspace" : "workspaces")", systemImage: "square.stack.3d.up")
          .font(DeckStyle.caption).foregroundStyle(.secondary)
        Spacer()
        StackIconButton(systemName: "folder", help: "Open definitions folder", size: 28) {
          NSWorkspace.shared.open(StackDefinitionLoader.directory())
        }
      }
    }.padding(16).frame(maxHeight: .infinity).background(DeckStyle.sidebar)
  }

  private func sidebarRow(_ file: StackDefinitionFile, isWorkspace: Bool) -> some View {
    let laneCount = isWorkspace ? navigation.lanes(for: file.id).count : 0
    let selected = model.selectedStackID == file.id
    let source = navigation.workspaceID(for: file.id) ?? file.id
    let tint = WorkspaceLaneMapStyle.tint(file.id, source: source, lanes: navigation.lanes(for: source).map(\.id))
    let state = model.states[file.id] ?? .init()
    let active = runner.activeRun(file.id) != nil || state.isActive
    return HStack(spacing: 0) {
      if laneCount > 0 {
        Button {
          if !expandedWorkspaces.insert(file.id).inserted { expandedWorkspaces.remove(file.id) }
        } label: {
          Image(systemName: expandedWorkspaces.contains(file.id) || !search.isEmpty ? "chevron.down" : "chevron.right")
            .font(.caption.weight(.semibold)).frame(width: 22, height: 38).contentShape(Rectangle())
        }.buttonStyle(.plain)
          .accessibilityLabel("\(expandedWorkspaces.contains(file.id) ? "Collapse" : "Expand") lanes for \(file.name)")
          .accessibilityIdentifier("workspace.expand.\(file.id)")
      }
      Button { model.select(file.id) } label: {
        HStack {
          VStack(spacing: 7) {
            Image(systemName: isWorkspace ? "square.stack.3d.up.fill" : "arrow.triangle.branch").foregroundColor(tint)
            if active { Circle().fill(.green).frame(width: 5, height: 5).help("Running") }
          }
          VStack(alignment: .leading, spacing: 4) {
            Text(isWorkspace ? file.name : file.lane?.name ?? file.name).fontWeight(.semibold).lineLimit(2)
            if !isWorkspace {
              Text(WorkspaceLaneGraph.branchSummary(file, statuses: model.repoStatuses))
                .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Text(runner.activeRun(file.id).map { "\($0.kind.rawValue.capitalized) running" }
              ?? (file.definition == nil ? "Needs attention" : "\(file.definition?.services.count ?? 0) \(file.definition?.services.count == 1 ? "service" : "services") · \(file.definition?.tasks.count ?? 0) \(file.definition?.tasks.count == 1 ? "task" : "tasks")"))
              .font(.caption).foregroundColor(.secondary).lineLimit(1)
            if laneCount > 0 {
              HStack(spacing: 5) {
                ForEach(navigation.lanes(for: file.id).prefix(5)) { lane in
                  Circle().fill(WorkspaceLaneMapStyle.tint(lane.id, source: file.id, lanes: navigation.lanes(for: file.id).map(\.id)))
                    .frame(width: 5, height: 5)
                }
                Text("\(laneCount) \(laneCount == 1 ? "lane" : "lanes")").font(.system(size: 10, weight: .medium))
              }.foregroundColor(.secondary)
            }
          }
          Spacer(minLength: 0)
        }.padding(10).contentShape(Rectangle())
      }.buttonStyle(.plain).accessibilityIdentifier("workspace.sidebar.\(file.id)")
        .workspaceReferenceDrag(file, model: model)
    }
    .background(selected ? tint.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(selected ? tint.opacity(0.35) : .clear))
    .help(WorkspaceLaneGraph.branchSummary(file, statuses: model.repoStatuses))
    .contextMenu {
      WorkspaceReferenceCopyButton(file: file, model: model)
      Divider()
      Button("Show lane map") { model.select(file.id); section = .laneMap }
      StackLaneAttachmentMenu(file: file, model: model)
      StackLaneDeletionMenu(file: file, model: model)
      if isWorkspace {
        Button("Edit workspace…") { model.edit(file) }
        Divider()
        Button("Delete workspace…", role: .destructive) { model.deleteWorkspace(file) }
          .accessibilityIdentifier("workspace.delete.\(file.id)")
      }
    }
  }

  private func matches(_ file: StackDefinitionFile) -> Bool {
    search.isEmpty || file.name.localizedCaseInsensitiveContains(search)
      || WorkspaceLaneGraph.branchSummary(file, statuses: model.repoStatuses).localizedCaseInsensitiveContains(search)
  }

  private func revealSelectedLane() {
    if let source = model.selectedWorkspaceID, source != model.selectedStackID { expandedWorkspaces.insert(source) }
  }

  private func tasks(_ file: StackDefinitionFile) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        Text("\(workspace?.tasks.count ?? 0) \(workspace?.tasks.count == 1 ? "task" : "tasks")").foregroundColor(.secondary)
        Spacer()
        if let workspace, workspace.lane == nil, !workspace.services.isEmpty {
          Menu("Move service to Tasks") {
            ForEach(workspace.services) { service in
              Button(service.id) { editing = .init(workspace: workspace, kind: .task, componentID: nil, sourceServiceID: service.id) }
                .disabled(workspace.lane != nil || model.runtime(file.id, service.id).phase.isActive || runner.activeRun(file.id) != nil)
            }
          }.help("Convert a stopped service that should run once, such as a build or test command")
        }
        Button("New task") { edit(file, kind: .task) }.buttonStyle(DeckButtonStyle(prominent: true)).disabled(workspace == nil || file.lane != nil)
      }
      if workspace?.tasks.isEmpty != false {
        empty("Turn commands into reusable tasks", "Tests, builds, linting, and migrations run once and produce a result.",
          action: file.lane == nil ? "Create task" : "Edit source workspace") {
          if file.lane == nil { edit(file, kind: .task) } else { model.edit(file) }
        }
      } else {
        ScrollView {
          LazyVStack(spacing: 10) {
            ForEach(workspace?.tasks ?? []) { task in
              VStack(alignment: .leading, spacing: 8) {
                HStack {
                  Label(task.name, systemImage: "terminal").font(.headline)
                  Spacer()
                  if let last = workspaceRuns.first(where: { $0.kind == .task && $0.definitionID == task.id }) { WorkspaceStatusLabel(status: last.status) }
                  Button("Edit") { edit(file, kind: .task, id: task.id) }.buttonStyle(DeckButtonStyle(compact: true)).disabled(file.lane != nil)
                  Menu {
                    Button("Delete task", role: .destructive) { remove(file, kind: .task, id: task.id) }
                  } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().disabled(file.lane != nil)
                  Button { start(file.id, .task, task.id) } label: { Label("Run", systemImage: "play.fill") }
                    .buttonStyle(DeckButtonStyle(prominent: true, compact: true))
                    .disabled(runner.activeRun(file.id) != nil).accessibilityIdentifier("workspace.runTask.\(task.id)")
                }
                Text(task.command).font(.system(size: 12, design: .monospaced)).textSelection(.enabled).lineLimit(3)
                  .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                  .background(DeckStyle.inset, in: RoundedRectangle(cornerRadius: 7))
                Text(task.requiresServices.isEmpty ? "Runs in \(task.directory.lastPathComponent) · \(Int(task.timeout))s timeout"
                  : "Requires \(task.requiresServices.joined(separator: ", ")) · \(Int(task.timeout))s timeout").font(.caption).foregroundColor(.secondary)
              }.padding(16).deckSurface()
            }
          }
        }
      }
    }
  }
  private func workflows(_ file: StackDefinitionFile) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack { Text("\(workspace?.workflows.count ?? 0) \(workspace?.workflows.count == 1 ? "workflow" : "workflows")").foregroundColor(.secondary); Spacer(); Button("New workflow") { edit(file, kind: .workflow) }.buttonStyle(DeckButtonStyle(prominent: true)).disabled(workspace == nil || file.lane != nil) }
      if workspace?.workflows.isEmpty != false {
        empty("Build a repeatable sequence", "For example: start your API, run integration tests, then build the app.",
          action: file.lane == nil ? "Create workflow" : "Edit source workspace") {
          if file.lane == nil { edit(file, kind: .workflow) } else { model.edit(file) }
        }
      } else {
        ScrollView {
          LazyVStack(spacing: 10) {
            ForEach(workspace?.workflows ?? []) { workflow in
              VStack(alignment: .leading, spacing: 10) {
                HStack {
                  Label(workflow.name, systemImage: "arrow.triangle.branch").font(.headline)
                  Spacer()
                  Button("Edit") { edit(file, kind: .workflow, id: workflow.id) }.buttonStyle(DeckButtonStyle(compact: true)).disabled(file.lane != nil)
                  Menu {
                    Button("Delete workflow", role: .destructive) { remove(file, kind: .workflow, id: workflow.id) }
                  } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().disabled(file.lane != nil)
                  Button { start(file.id, .workflow, workflow.id) } label: { Label("Run workflow", systemImage: "play.fill") }
                    .buttonStyle(DeckButtonStyle(prominent: true, compact: true))
                    .disabled(runner.activeRun(file.id) != nil).accessibilityIdentifier("workspace.runWorkflow.\(workflow.id)")
                }
                Text(workflow.steps.enumerated().map { "\($0.offset + 1). \($0.element.replacingOccurrences(of: ":", with: " "))" }.joined(separator: "  →  "))
                  .font(.callout).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                if workflow.cleanupServices { Label("Stop services started by this run when it finishes", systemImage: "checkmark.shield").font(.caption).foregroundColor(.secondary) }
              }.padding(16).deckSurface()
            }
          }
        }
      }
    }
  }
  @ViewBuilder private var runs: some View {
    if workspaceRuns.isEmpty {
      DeckEmptyState(icon: "play.rectangle", title: "No runs yet",
        detail: "Run a task or workflow to see its progress, output, and result here.") {
        Button("Browse tasks") { section = .tasks }.buttonStyle(DeckButtonStyle(prominent: true))
      }
    } else {
      HSplitView {
        ScrollView {
          LazyVStack(spacing: 6) {
            ForEach(workspaceRuns) { run in
              Button { selectedRun = run.id } label: {
                VStack(alignment: .leading, spacing: 6) {
                  Text(run.name).fontWeight(.semibold)
                  WorkspaceStatusLabel(status: run.status)
                  Text(run.createdAt, style: .date).font(.caption).foregroundColor(.secondary)
                  Text(run.createdAt, style: .time).font(.caption).foregroundColor(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(10)
                  .background((selectedRun ?? workspaceRuns.first?.id) == run.id ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 8))
              }.buttonStyle(.plain)
            }
          }
        }.frame(minWidth: 160, idealWidth: 190, maxWidth: 240)
        if let run = workspaceRuns.first(where: { $0.id == selectedRun }) ?? workspaceRuns.first {
          WorkspaceRunDetail(run: run, runner: runner, cancel: { cancel(run.id) }, rerun: { start(run.workspaceID, run.kind, run.definitionID) })
            .id(run.id)
        } else { Spacer() }
      }
    }
  }
  private func consumeSectionRequest() {
    guard let requested = model.requestedSection else { return }
    section = requested
    model.requestedSection = nil
  }
  private func remove(_ file: StackDefinitionFile, kind: WorkspaceRunKind, id: String) {
    guard file.lane == nil else { model.error = "Lane definitions are snapshots. Edit the source workspace and recreate the lane to change its tasks or workflows."; return }
    let alert = NSAlert()
    alert.messageText = "Delete \(kind.rawValue) \(id)?"
    alert.informativeText = "Saved run results are kept. Workflows that reference this task must be updated first."
    alert.addButton(withTitle: "Delete"); alert.addButton(withTitle: "Cancel")
    guard alert.runModal() == .alertFirstButtonReturn else { return }
    do {
      let original = try String(contentsOf: file.file, encoding: .utf8)
      try WorkspaceDefinitionWriter.save(file: file.file, original: original,
        section: "\(kind == .task ? "tasks" : "workflows").\(id)", replacement: "")
      Task { await model.supervisor.reloadDefinitions() }
    } catch { model.error = error.localizedDescription }
  }
  private func edit(_ file: StackDefinitionFile, kind: WorkspaceRunKind, id: String? = nil) {
    guard file.lane == nil else { model.error = "Lane definitions are snapshots. Edit the source workspace and recreate the lane to change its tasks or workflows."; return }
    guard let workspace = file.definition else { return }
    editing = .init(workspace: workspace, kind: kind, componentID: id)
  }
  private func start(_ workspace: String, _ kind: WorkspaceRunKind, _ definition: String) {
    do { selectedRun = try runner.submit(workspace: workspace, kind: kind, definitionID: definition).id; section = .runs }
    catch { model.error = error.localizedDescription }
  }
  private func cancel(_ id: UUID) { Task { do { try await runner.cancel(id) } catch { model.error = error.localizedDescription } } }
  private func empty(_ title: String, _ detail: String, action: String, perform: @escaping () -> Void) -> some View {
    DeckEmptyState(icon: workspace == nil ? "square.stack.3d.up" : section.icon, title: title, detail: detail) {
      Button(action, action: perform).buttonStyle(DeckButtonStyle(prominent: true))
    }
  }
}

struct WorkspaceStatusLabel: View {
  let status: WorkspaceRunStatus
  var body: some View {
    Label(status.label, systemImage: icon).font(.caption.weight(.semibold)).foregroundColor(color)
  }
  private var icon: String {
    switch status {
    case .succeeded: return "checkmark.circle.fill"
    case .failed: return "xmark.circle.fill"
    case .running, .cancelling: return "circle.dotted"
    case .cancelled, .interrupted: return "stop.circle"
    case .queued: return "clock"
    case .skipped: return "arrow.right.to.line"
    }
  }
  private var color: Color {
    switch status { case .succeeded: return DeckStyle.success; case .failed: return DeckStyle.danger; case .running: return .accentColor; case .interrupted: return DeckStyle.warning; default: return .secondary }
  }
}

private struct WorkspaceRunDetail: View {
  let run: WorkspaceRun
  @ObservedObject var runner: WorkspaceRunner
  let cancel: () -> Void
  let rerun: () -> Void
  @State private var selectedStep: UUID?
  @State private var lines: [StackLogLine] = []
  @State private var filter = ""
  @State private var autoScroll = true
  @State private var logMatcher = StackLogFilter()
  @State private var filtered: [StackLogLine] = []
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(run.name).font(.title3.bold())
        WorkspaceStatusLabel(status: run.status)
        Spacer()
        if run.status.isActive { Button("Cancel run", action: cancel) }
        else { Button("Run again", action: rerun).buttonStyle(DeckButtonStyle(prominent: true, compact: true)).disabled(runner.activeRun(run.workspaceID) != nil).help("Run again using the current definition") }
      }
      TimelineView(.animation(minimumInterval: 1, paused: !run.status.isActive)) { _ in
        Text("\(run.kind.rawValue.capitalized) · \(run.actor.label) · \(String(format: "%.1f", run.duration))s").font(.caption).foregroundColor(.secondary)
      }
      if let detail = run.detail { Text(detail).font(.callout).foregroundColor(run.status == .failed ? .red : .secondary).textSelection(.enabled) }
      ScrollView {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(Array(run.steps.enumerated()), id: \.element.id) { index, step in
            Button { selectedStep = selectedStep == step.id ? nil : step.id } label: {
              HStack {
                Text("\(index + 1)").monospacedDigit().foregroundColor(.secondary)
                Text(step.title)
                WorkspaceStatusLabel(status: step.status)
                Spacer()
                if let code = step.exitCode { Text("Exit \(code)").font(.caption).monospacedDigit() }
                if let start = step.startedAt, let finish = step.finishedAt { Text(String(format: "%.1fs", finish.timeIntervalSince(start))).font(.caption).foregroundColor(.secondary) }
              }.padding(7).contentShape(Rectangle()).background(selectedStep == step.id ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
            }.buttonStyle(.plain)
          }
        }
      }.frame(maxHeight: min(180, CGFloat(max(1, run.steps.count)) * 40))
      HStack {
        DeckSearchField(placeholder: "Filter output", text: $filter)
        Toggle("Follow", isOn: $autoScroll).toggleStyle(.checkbox)
        Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(filtered.map { AnsiParser.plainText($0.text) }.joined(separator: "\n"), forType: .string) }
      }
      StackLogView(lines: filtered, allServices: selectedStep == nil, autoScroll: autoScroll, focusRequest: 0, onFocus: {}, accessibilityTitle: "Run output", accessibilityID: "workspace.runOutput")
        .clipShape(RoundedRectangle(cornerRadius: 8)).frame(minHeight: 150)
    }.padding(16).deckSurface()
      .padding(.leading, 12)
      .onChange(of: filter) { query in filtered = logMatcher.filter(lines, query: query) }
      .task(id: "\(run.id)-\(selectedStep?.uuidString ?? "all")") {
        lines = []
        filtered = logMatcher.filter([], query: filter)
        while !Task.isCancelled {
          let output = await runner.output(run.id, stepID: selectedStep)
          guard !Task.isCancelled else { return }
          // Line ids are stable for live and finished steps, so they identify new output.
          if lines.count != output.count || lines.last?.id != output.last?.id || lines.map(\.id) != output.map(\.id) {
            lines = output
            filtered = logMatcher.filter(output, query: filter)
          }
          if runner.run(run.id)?.status.isActive != true { return }
          do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
        }
      }
  }
}
