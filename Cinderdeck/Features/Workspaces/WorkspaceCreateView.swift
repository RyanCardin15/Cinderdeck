import SwiftUI

struct WorkspaceCreateView: View {
  let onSaved: (String, Bool) -> Void
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    WorkspaceSetupView(onCancel: { dismiss() }, onSaved: onSaved)
      .padding(24).frame(width: 720, height: 680).background(DeckStyle.canvas)
  }
}

/// Shared by first launch and workspace creation, with a persistent review footer.
struct WorkspaceSetupView: View {
  var onCancel: () -> Void
  var onSaved: (String, Bool) -> Void
  var isOnboarding = false
  @StateObject private var model = WorkspaceSetupModel()

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      DeckSheetHeader(icon: "folder.badge.gearshape", title: model.proposal == nil ? "Add a workspace" : "Review your workspace",
        detail: model.proposal == nil ? "Bring one repository, several repositories, or regular folders together." : "Choose what to include and check what needs attention before starting.")
      HStack(spacing: 12) {
        step("1", "Folders", active: model.proposal == nil)
        step("2", "Review & check", active: model.proposal != nil)
        Spacer()
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          folderPicker
          filePicker
          if let proposal = model.proposal {
            VStack(alignment: .leading, spacing: 6) {
              DeckSectionLabel(title: "Workspace name")
              TextField("Workspace name", text: $model.name).textFieldStyle(.roundedBorder).accessibilityLabel("Workspace name")
            }
            commandList(.service, title: "Services", detail: "Stay running, such as development servers and databases.")
            commandList(.task, title: "Tasks", detail: "Run once, such as tests and builds. Tasks are saved for you to run later.")
            laneDefaults
            checks
            VStack(alignment: .leading, spacing: 6) {
              DeckSectionLabel(title: "Discovery notes")
              ForEach(proposal.notes, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
          } else {
            VStack(alignment: .leading, spacing: 12) {
              Label("Find commands in project manifests", systemImage: "doc.text.magnifyingglass")
              Label("Review services, tests, and builds", systemImage: "checklist")
              Label("Check runtimes, variables, and ports", systemImage: "stethoscope")
            }.font(.callout).foregroundStyle(.secondary).padding(.vertical, 16)
            Text("Supports JavaScript packages and monorepos, Python, Rust, Go, Swift, Xcode, Make, and Docker Compose. You can edit suggestions or add your own commands.")
              .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          }
        }.padding(.trailing, 4)
      }
      .disabled(model.isBusy)
      if let error = model.error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
      if model.isBusy { HStack { ProgressView().controlSize(.small); Text("Inspecting folders and checking launch requirements…").font(.caption).foregroundStyle(.secondary) } }
      if model.proposal != nil && model.isChecked {
        let blockers = model.issues.filter { $0.severity == .blocker }.count
        let warnings = model.issues.filter { $0.severity == .warning }.count
        if blockers > 0 {
          Label("\(blockers) launch blocker\(blockers == 1 ? "" : "s") · save now or resolve before starting", systemImage: "exclamationmark.triangle")
            .font(.caption).foregroundStyle(.red)
        } else if warnings > 0 {
          Label("\(warnings) item\(warnings == 1 ? "" : "s") to review before starting", systemImage: "exclamationmark.triangle")
            .font(.caption).foregroundStyle(.orange)
        }
      }
      Divider()
      footer
    }
    .onDisappear { model.cancel() }
  }

  private func step(_ number: String, _ title: String, active: Bool) -> some View {
    HStack(spacing: 6) {
      Text(number).font(.caption.weight(.semibold)).frame(width: 22, height: 22)
        .background(active ? Color.accentColor.opacity(0.16) : Color.secondary.opacity(0.1), in: Circle())
      Text(title).font(.caption.weight(active ? .semibold : .regular))
    }.foregroundStyle(active ? Color.primary : Color.secondary)
  }

  private var folderPicker: some View {
    VStack(alignment: .leading, spacing: 8) {
      DeckSectionLabel(title: "Workspace folders")
      HStack {
        TextField("Choose a repository or folder", text: $model.folder).textFieldStyle(.roundedBorder).accessibilityLabel("Workspace folder")
        Button("Choose…") {
          chooseFolders(multiple: false) { paths in if let path = paths.first { model.folder = path } }
        }.accessibilityLabel("Choose workspace folder")
      }
      ForEach($model.additionalFolders) { $folder in
        HStack {
          TextField("Additional repository or folder", text: $folder.path).textFieldStyle(.roundedBorder)
            .accessibilityLabel("Additional workspace folder")
          Button { model.additionalFolders.removeAll { $0.id == folder.id } } label: { Image(systemName: "minus.circle") }
            .buttonStyle(.plain).accessibilityLabel("Remove folder \(folder.path)")
        }
      }
      HStack {
        Button("Add folders…") {
          chooseFolders(multiple: true) { model.addFolders($0) }
        }.disabled(model.additionalFolders.count >= 63)
        Spacer()
        if model.proposal != nil {
          Text("Changing folders requires a new discovery.").font(.caption).foregroundStyle(.secondary)
        }
      }
      Text("Choose a parent folder to find its repositories, or add folders from different locations. Git is optional.")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }

  private func chooseFolders(multiple: Bool, selected: ([String]) -> Void) {
    let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
    panel.allowsMultipleSelection = multiple; panel.prompt = multiple ? "Add folders" : "Choose folder"
    panel.message = "Select repositories or folders for this workspace."
    if panel.runModal() == .OK { selected(panel.urls.map(\.path)) }
  }

  private var filePicker: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        DeckSectionLabel(title: "Workspace files")
        Spacer()
        Button("Add files…") {
          let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = false
          panel.allowsMultipleSelection = true; panel.prompt = "Add files"
          guard panel.runModal() == .OK else { return }
          var known = Set(model.files.map { $0.resolvingSymlinksInPath().path })
          let additions = panel.urls.filter { known.insert($0.resolvingSymlinksInPath().path).inserted }
          guard model.files.count + additions.count <= 128 else { model.error = "Choose up to 128 workspace files."; return }
          model.files += additions
        }.disabled(model.files.count >= 128)
      }
      ForEach(model.files, id: \.path) { url in
        HStack {
          Label(url.lastPathComponent, systemImage: "doc")
          Text(url.path).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).help(url.path)
          Spacer()
          Button { model.files.removeAll { $0 == url } } label: { Image(systemName: "minus.circle") }
            .buttonStyle(.plain).accessibilityLabel("Remove file \(url.path)")
        }
      }
      Text("Add reference documents or individual files. Their parent folders are not included.")
        .font(.caption).foregroundStyle(.secondary)
    }
  }

  private var laneDefaults: some View {
    VStack(alignment: .leading, spacing: 8) {
      DeckSectionLabel(title: "Repositories & lane defaults")
      ForEach($model.repositories) { $repo in
        HStack {
          VStack(alignment: .leading, spacing: 3) {
            Label(repo.id, systemImage: WorkspaceDiscovery.repositoryRoot(containing: repo.path) == nil ? "folder" : "arrow.triangle.branch")
              .font(.callout.weight(.medium))
            Text(repo.path.path).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).help(repo.path.path)
          }
          Spacer()
          if WorkspaceDiscovery.repositoryRoot(containing: repo.path) != nil {
            Picker("Lane behavior for \(repo.id)", selection: $repo.laneMode) {
              Text("Isolate in each lane").tag(StackRepoLaneMode.worktree)
              Text("Shared across lanes").tag(StackRepoLaneMode.shared)
            }.labelsHidden().frame(width: 190)
          } else {
            Text("Shared folder").font(.caption).foregroundStyle(.secondary)
          }
        }
      }
      Text("A lane creates a worktree for each isolated Git repository. Shared repositories and regular folders use their original files. A workspace without Git can still run services and tasks.")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      if model.repositories.contains(where: { $0.laneMode == .worktree }) {
        Toggle("Copy .env and .env.local into new lanes", isOn: $model.copyEnvironmentFiles).font(.callout)
        Picker("Lane setup task", selection: $model.setupTask) {
          Text("None").tag("")
          ForEach(model.commands.filter { $0.kind == .task && $0.selected }) { command in Text(command.title).tag(command.id) }
        }
        Text("Setup runs before lane services start. Environment files are copied only when selected; their values stay out of this screen.")
          .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func commandList(_ kind: WorkspaceDiscoveredCommand.Kind, title: String, detail: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack {
        DeckSectionLabel(title: title)
        Spacer()
        Button(kind == .service ? "Add service" : "Add task") { model.add(kind) }.font(.caption)
      }
      Text(detail).font(.caption).foregroundStyle(.secondary)
      if !model.commands.contains(where: { $0.kind == kind }) {
        Text(kind == .service ? "No services detected. Add a command if this project runs a server." : "No tasks detected. Add your test or build command.")
          .font(.callout).foregroundStyle(.secondary)
      }
      ForEach($model.commands) { $command in
        if command.kind == kind {
          VStack(alignment: .leading, spacing: 6) {
            Toggle(command.title, isOn: $command.selected).toggleStyle(.checkbox).font(.callout.weight(.medium))
            VStack(alignment: .leading, spacing: 6) {
              TextField("Name", text: $command.title).textFieldStyle(.roundedBorder).accessibilityLabel("Command name")
              TextField("Command", text: $command.command).textFieldStyle(.roundedBorder)
                .font(.system(size: 12, design: .monospaced)).accessibilityLabel("Command for \(command.title)")
              HStack {
                Text("Tools").font(.caption).foregroundStyle(.secondary)
                TextField("Required tools, separated by commas", text: Binding(
                  get: { command.runtimes.joined(separator: ", ") },
                  set: { command.runtimes = $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
                )).textFieldStyle(.roundedBorder).font(.caption).accessibilityLabel("Required tools for \(command.title)")
              }
              HStack {
                Text("Folder").font(.caption).foregroundStyle(.secondary)
                Text(command.directory.path).font(.system(size: 11, design: .monospaced)).lineLimit(1).truncationMode(.middle).help(command.directory.path)
                Button("Change…") {
                  chooseFolders(multiple: false) { paths in if let path = paths.first { model.moveCommand(command.id, to: URL(fileURLWithPath: path, isDirectory: true)) } }
                }.font(.caption).accessibilityLabel("Change folder for \(command.title)")
                Spacer()
                if kind == .service {
                  Text("Port").font(.caption).foregroundStyle(.secondary)
                  TextField("None", text: $command.port).textFieldStyle(.roundedBorder).frame(width: 74).accessibilityLabel("Port for \(command.title)")
                }
              }
              Text("Found in \(command.evidence)").font(.caption).foregroundStyle(.secondary)
              if kind == .service && !command.port.isEmpty {
                Text("Port changes must match the command. {{port.\(command.id)}} follows the port above.")
                  .font(.caption2).foregroundStyle(.secondary)
              }
            }.disabled(!command.selected)
          }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))
        }
      }
    }
  }

  private var checks: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        DeckSectionLabel(title: "Before starting")
        Spacer()
        Button("Check again") { model.check() }
      }
      if !model.isChecked {
        Text("Check the current selection to see missing runtimes, environment hints, and port conflicts.").font(.callout).foregroundStyle(.secondary)
      } else if model.issues.isEmpty {
        Label("Launch checks passed", systemImage: "checkmark.circle.fill").font(.callout).foregroundStyle(.green)
        Text("Custom commands can have requirements that manifests do not describe.").font(.caption).foregroundStyle(.secondary)
      } else {
        ForEach(model.issues) { issue in
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: issue.severity == .blocker ? "xmark.octagon" : "exclamationmark.triangle").foregroundStyle(issue.severity == .blocker ? Color.red : Color.orange)
            VStack(alignment: .leading, spacing: 4) {
              Text(issue.title).font(.callout.weight(.medium))
              Text(issue.detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
          }
        }
      }
      Text("Saving creates the workspace. Starting launches only selected services. Dependencies are installed separately.")
        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }

  private var footer: some View {
    HStack {
      Button(isOnboarding ? "Set up later" : "Cancel") { onCancel() }.disabled(model.isBusy)
      Spacer()
      if model.proposal == nil {
        Button("Discover commands") { model.discover() }.buttonStyle(DeckButtonStyle(prominent: true))
          .keyboardShortcut(.defaultAction).disabled(model.folder.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isBusy)
      } else {
        Button("Save workspace") { model.save(start: false, onSaved: onSaved) }
          .disabled(model.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isBusy)
        Button("Create & start") { model.save(start: true, onSaved: onSaved) }
          .buttonStyle(DeckButtonStyle(prominent: true))
          .disabled(!model.canStart || model.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isBusy)
      }
    }
  }
}
