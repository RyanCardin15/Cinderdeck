import SwiftUI

enum WorkspaceSection: String, CaseIterable {
  case services = "Services", tasks = "Tasks", workflows = "Workflows", runs = "Runs", recordings = "Recordings"
  var explanation: String {
    switch self {
    case .services: return "Keep APIs, databases, and development servers running together."
    case .tasks: return "Run a command once. Keep its result, duration, and output."
    case .workflows: return "Run tasks and service actions in order. A failed step stops the workflow."
    case .runs: return "Inspect progress and results. Completed runs stay available after relaunch."
    case .recordings: return "Screen recordings saved with this workspace's logs. Every log line is stamped with its position in the video."
    }
  }
}

struct WorkspaceView: View {
  @ObservedObject var model: StacksViewModel
  @ObservedObject var runner: WorkspaceRunner
  @State private var section = WorkspaceSection.services
  @State private var editing: WorkspaceComponentEditor.Context?
  @State private var selectedRun: UUID?
  @State private var search = ""
  private var workspace: StackDefinition? { model.selectedDefinition }
  private var workspaceRuns: [WorkspaceRun] { runner.runs.filter { $0.workspaceID == model.selectedStackID } }

  var body: some View {
    HSplitView {
      sidebar.frame(minWidth: 200, idealWidth: 235, maxWidth: 320)
      VStack(alignment: .leading, spacing: 16) {
        if let file = model.selectedFile {
          HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
              Text(file.name).font(.largeTitle.bold()).lineLimit(2).help(file.name)
              Text(workspace?.root.path ?? file.file.path).font(.caption).foregroundColor(.secondary).textSelection(.enabled)
            }
            Spacer()
            Button { model.lanesSheet = true } label: { Label("Lanes", systemImage: "arrow.triangle.branch") }
              .accessibilityIdentifier("stacks.lanes")
            Button { model.edit(file) } label: { Label(file.lane == nil ? "Edit workspace" : "Edit source workspace", systemImage: "slider.horizontal.3") }
            Button { model.agentsSheet = true } label: { Image(systemName: "sparkles") }.help("Connect agents and CLI")
          }
          Picker("Workspace component", selection: $section) {
            ForEach(WorkspaceSection.allCases, id: \.self) { Text($0.rawValue).tag($0) }
          }.pickerStyle(.segmented).labelsHidden().accessibilityIdentifier("workspace.sections")
          Text(section.explanation).foregroundColor(.secondary).font(.callout)
          if file.lane != nil {
            Text("This lane uses a snapshot of its source workspace. To change services, tasks, or workflows, edit the source and recreate the lane.")
              .font(.caption).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
          }
          if let error = model.error ?? runner.storageError {
            HStack { Label(error, systemImage: "exclamationmark.triangle").textSelection(.enabled); Spacer(); Button("Dismiss") { model.error = nil } }
              .font(.callout).foregroundColor(.orange)
          }
          if let active = runner.activeRun(file.id), section != .runs {
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
          case .runs: runs
          case .recordings: WorkspaceReprosView(file: file, recorder: .shared, controller: .shared, runner: runner)
          }
        } else {
          empty("Your development work, together", "A workspace contains services that stay running, tasks that finish, and workflows that coordinate both.", action: "Create workspace") { model.create() }
        }
      }.padding(22).frame(minWidth: 680, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
    .background(Color(nsColor: .windowBackgroundColor))
    .sheet(item: $model.editor) { context in
      if context.file == nil {
        WorkspaceCreateView { id in
          model.editor = nil
          Task { await model.supervisor.reloadDefinitions(); model.select(id) }
        }
      } else {
        StackDefinitionEditor(file: context.file) { model.editor = nil; Task { await model.supervisor.reloadDefinitions() } }
      }
    }
    .sheet(item: $editing) { context in
      WorkspaceComponentEditor(context: context) { editing = nil; Task { await model.supervisor.reloadDefinitions() } }
    }
    .sheet(isPresented: $model.agentsSheet) { StackAgentsSheet() }
    .sheet(isPresented: $model.lanesSheet) { StackLanesView(viewModel: model) }
    .sheet(isPresented: $model.stackBranchPicker) { StackBranchPickerSheet(viewModel: model) }
    .onChange(of: model.selectedStackID) { _ in selectedRun = nil }
    .onAppear { consumeSectionRequest() }
    .onChange(of: model.requestedSection) { _ in consumeSectionRequest() }
  }

  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack { Text("Workspaces").font(.title2.bold()); Spacer(); Button { model.create() } label: { Image(systemName: "plus") }.help("Create workspace") }
      TextField("Find a workspace", text: $search).textFieldStyle(.roundedBorder)
      ScrollView {
        LazyVStack(spacing: 6) {
          ForEach(model.files.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }) { file in
            Button { model.select(file.id) } label: {
              HStack {
                Image(systemName: "square.stack.3d.up.fill").foregroundColor(.accentColor)
                VStack(alignment: .leading, spacing: 4) {
                  Text(file.name).fontWeight(.semibold).lineLimit(1)
                  Text(runner.activeRun(file.id).map { "\($0.kind.rawValue.capitalized) running" }
                    ?? (file.definition == nil ? "Needs attention" : "\(file.definition?.services.count ?? 0) \(file.definition?.services.count == 1 ? "service" : "services") · \(file.definition?.tasks.count ?? 0) \(file.definition?.tasks.count == 1 ? "task" : "tasks")"))
                    .font(.caption).foregroundColor(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
              }.padding(10).contentShape(Rectangle())
                .background(model.selectedStackID == file.id ? Color.accentColor.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 8))
            }.buttonStyle(.plain)
          }
        }
      }
      Spacer(minLength: 0)
      Text("Services stay running.\nTasks finish.\nWorkflows bring them together.").font(.caption).foregroundColor(.secondary)
      Button("Open definitions folder") { NSWorkspace.shared.open(StackDefinitionLoader.directory()) }.font(.caption)
    }.padding(16).frame(maxHeight: .infinity).background(Color(nsColor: .controlBackgroundColor))
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
        Button("New task") { edit(file, kind: .task) }.disabled(workspace == nil || file.lane != nil)
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
                  Button("Edit") { edit(file, kind: .task, id: task.id) }.disabled(file.lane != nil)
                  Menu {
                    Button("Delete task", role: .destructive) { remove(file, kind: .task, id: task.id) }
                  } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().disabled(file.lane != nil)
                  Button { start(file.id, .task, task.id) } label: { Label("Run", systemImage: "play.fill") }
                    .disabled(runner.activeRun(file.id) != nil).accessibilityIdentifier("workspace.runTask.\(task.id)")
                }
                Text(task.command).font(.system(.callout, design: .monospaced)).textSelection(.enabled).lineLimit(3)
                Text(task.requiresServices.isEmpty ? "Runs in \(task.directory.lastPathComponent) · \(Int(task.timeout))s timeout"
                  : "Requires \(task.requiresServices.joined(separator: ", ")) · \(Int(task.timeout))s timeout").font(.caption).foregroundColor(.secondary)
              }.padding(14).stackSurface(cornerRadius: 10)
            }
          }
        }
      }
    }
  }
  private func workflows(_ file: StackDefinitionFile) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack { Text("\(workspace?.workflows.count ?? 0) \(workspace?.workflows.count == 1 ? "workflow" : "workflows")").foregroundColor(.secondary); Spacer(); Button("New workflow") { edit(file, kind: .workflow) }.disabled(workspace == nil || file.lane != nil) }
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
                  Button("Edit") { edit(file, kind: .workflow, id: workflow.id) }.disabled(file.lane != nil)
                  Menu {
                    Button("Delete workflow", role: .destructive) { remove(file, kind: .workflow, id: workflow.id) }
                  } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().disabled(file.lane != nil)
                  Button { start(file.id, .workflow, workflow.id) } label: { Label("Run workflow", systemImage: "play.fill") }
                    .disabled(runner.activeRun(file.id) != nil).accessibilityIdentifier("workspace.runWorkflow.\(workflow.id)")
                }
                Text(workflow.steps.enumerated().map { "\($0.offset + 1). \($0.element.replacingOccurrences(of: ":", with: " "))" }.joined(separator: "  →  "))
                  .font(.callout).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
                if workflow.cleanupServices { Label("Stop services started by this run when it finishes", systemImage: "checkmark.shield").font(.caption).foregroundColor(.secondary) }
              }.padding(14).stackSurface(cornerRadius: 10)
            }
          }
        }
      }
    }
  }
  private var runs: some View {
    HSplitView {
      ScrollView {
        LazyVStack(spacing: 6) {
          if workspaceRuns.isEmpty { Text("Run a task or workflow to see its results here.").foregroundColor(.secondary).padding() }
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
    VStack(spacing: 14) {
      Image(systemName: "square.stack.3d.up").font(.system(size: 34)).foregroundColor(.accentColor)
      Text(title).font(.title2.bold())
      Text(detail).foregroundColor(.secondary).multilineTextAlignment(.center).frame(maxWidth: 430)
      Button(action, action: perform).buttonStyle(.borderedProminent)
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
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
    switch status { case .succeeded: return .green; case .failed: return .red; case .running: return .accentColor; case .interrupted: return .orange; default: return .secondary }
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
  private var filtered: [StackLogLine] { lines.filter { filter.isEmpty || AnsiParser.plainText($0.text).localizedCaseInsensitiveContains(filter) } }
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text(run.name).font(.title3.bold())
        WorkspaceStatusLabel(status: run.status)
        Spacer()
        if run.status.isActive { Button("Cancel run", action: cancel) }
        else { Button("Run again", action: rerun).disabled(runner.activeRun(run.workspaceID) != nil).help("Run again using the current definition") }
      }
      TimelineView(.periodic(from: .now, by: 1)) { _ in
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
      }.frame(maxHeight: 160)
      HStack {
        TextField("Filter output", text: $filter).textFieldStyle(.roundedBorder)
        Toggle("Follow", isOn: $autoScroll).toggleStyle(.checkbox)
        Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(filtered.map { AnsiParser.plainText($0.text) }.joined(separator: "\n"), forType: .string) }
      }
      StackLogView(lines: filtered, allServices: selectedStep == nil, autoScroll: autoScroll, focusRequest: 0, onFocus: {}, accessibilityTitle: "Run output", accessibilityID: "workspace.runOutput")
        .clipShape(RoundedRectangle(cornerRadius: 8)).frame(minHeight: 150)
    }.padding(.leading, 12)
      .task(id: "\(run.id)-\(selectedStep?.uuidString ?? "all")") {
        lines = []
        while !Task.isCancelled {
          let output = await runner.output(run.id, stepID: selectedStep)
          guard !Task.isCancelled else { return }
          if lines.map(\.text) != output.map(\.text) || lines.map(\.service) != output.map(\.service) { lines = output }
          if runner.run(run.id)?.status.isActive != true { return }
          do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
        }
      }
  }
}
