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
      DeckSheetHeader(icon: "folder.badge.gearshape", title: model.proposal == nil ? "Get your project running" : "Review your workspace",
        detail: model.proposal == nil ? "Choose a repository. Cinderdeck will find likely services, tests, and build commands." : "Choose what to include and check what needs attention before starting.")
      HStack(spacing: 12) {
        step("1", "Repository", active: model.proposal == nil)
        step("2", "Review & check", active: model.proposal != nil)
        Spacer()
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          repositoryPicker
          if let proposal = model.proposal {
            VStack(alignment: .leading, spacing: 6) {
              DeckSectionLabel(title: "Workspace name")
              TextField("Workspace name", text: $model.name).textFieldStyle(.roundedBorder).accessibilityLabel("Workspace name")
            }
            commandList(.service, title: "Services", detail: "Stay running, such as development servers and databases.")
            commandList(.task, title: "Tasks", detail: "Run once, such as tests and builds. Tasks are saved for you to run later.")
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
      if model.isBusy { HStack { ProgressView().controlSize(.small); Text("Inspecting project and checking launch requirements…").font(.caption).foregroundStyle(.secondary) } }
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

  private var repositoryPicker: some View {
    VStack(alignment: .leading, spacing: 6) {
      DeckSectionLabel(title: "Repository folder")
      HStack {
        TextField("Choose a local repository", text: $model.folder).textFieldStyle(.roundedBorder).accessibilityLabel("Repository folder")
        Button("Choose…") {
          let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
          panel.prompt = "Choose repository"; panel.message = "Select the root of your local project."
          if panel.runModal() == .OK, let url = panel.url { model.folder = url.path }
        }.accessibilityLabel("Choose repository")
      }
      if model.proposal != nil {
        Text("To inspect another repository, change the folder above.").font(.caption).foregroundStyle(.secondary)
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
        Button("Discover project") { model.discover() }.buttonStyle(DeckButtonStyle(prominent: true))
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
