import AppKit
import SwiftUI

/// Visual workspace membership editing, with the original definition retained for conflict checks.
struct WorkspaceSettingsView: View {
  let file: URL
  let onSaved: () -> Void
  @Environment(\.dismiss) private var dismiss
  @ObservedObject private var supervisor = StackSupervisor.shared
  @State private var original = ""
  @State private var definition: StackDefinition?
  @State private var name = ""
  @State private var folders: [RepoDefinition] = []
  @State private var files: [URL] = []
  @State private var error: String?
  @State private var advanced = false
  @State private var refreshMessage: String?

  private var hasEdits: Bool {
    guard let definition else { return false }
    return name != definition.name || folders != definition.repos || files != definition.files
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      DeckSheetHeader(icon: "folder.badge.gearshape", title: "Workspace settings",
        detail: "Bring folders and files from different locations into one workspace.")
      HStack {
        DeckRefreshButton(title: "Refresh definition") { await refreshDefinition() }
        Text(refreshMessage ?? "Reload saved settings. Unsaved edits stay in this form.")
          .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      }
      if let definition, supervisor.definitionChanged(definition.id) {
        HStack {
          Text("Running services use older settings. Restart them to apply the saved definition.")
            .font(.caption).foregroundStyle(.orange)
          Spacer()
          Button("Open Services") {
            WorkspaceWindowController.shared.show(workspace: definition.id, section: .services)
          }
        }
      }
      TextField("Workspace name", text: $name).textFieldStyle(.roundedBorder)
        .accessibilityLabel("Workspace name")
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          if let definition {
            DeckSectionLabel(title: "Primary folder")
            pathRow(definition.root, icon: "folder.fill")
            Text("Chats can start in any workspace folder. Services and tasks keep their configured locations.")
              .font(.caption).foregroundStyle(.secondary)
          }
          HStack {
            DeckSectionLabel(title: "Folders")
            Spacer()
            Button("Add folders…") { choose(files: false) }.disabled(folders.count >= 64)
          }
          ForEach($folders) { $folder in
            HStack {
              pathRow(folder.path, icon: "folder")
              Spacer()
              Picker("Lane behavior for \(folder.id)", selection: $folder.laneMode) {
                Text("Isolate in lanes").tag(StackRepoLaneMode.worktree)
                Text("Shared folder").tag(StackRepoLaneMode.shared)
              }.labelsHidden().frame(width: 155)
              Button { folders.removeAll { $0.id == folder.id } } label: { Image(systemName: "minus.circle") }
                .buttonStyle(.plain).accessibilityLabel("Remove folder \(folder.path.path)")
            }
          }
          if folders.isEmpty { Text("The primary folder is used when no additional folders are configured.").font(.caption).foregroundStyle(.secondary) }
          HStack {
            DeckSectionLabel(title: "Files")
            Spacer()
            Button("Add files…") { choose(files: true) }.disabled(files.count >= 128)
          }
          ForEach(files, id: \.path) { url in
            HStack {
              pathRow(url, icon: "doc")
              Spacer()
              Button { files.removeAll { $0 == url } } label: { Image(systemName: "minus.circle") }
                .buttonStyle(.plain).accessibilityLabel("Remove file \(url.path)")
            }
          }
          Text("Folders are available to agents working in this workspace. Files are supplied as individual references; their surrounding folders are not added. Removing a reference keeps the original on disk. New selections apply when an agent session opens again.")
            .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(.trailing, 4)
      }
      if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
      Divider()
      HStack {
        Button("Edit definition…") { advanced = true }
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Save workspace") { save() }.keyboardShortcut(.defaultAction)
          .buttonStyle(.borderedProminent).disabled(definition == nil || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }.padding(24).frame(width: 740, height: 620).background(DeckStyle.canvas)
      .onAppear { load() }
      .sheet(isPresented: $advanced) {
        StackDefinitionEditor(file: file) { onSaved(); dismiss() }
      }
  }

  private func pathRow(_ url: URL, icon: String) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Label(url.lastPathComponent, systemImage: icon).font(.callout.weight(.medium))
      Text(url.path).font(.caption.monospaced()).foregroundStyle(.secondary)
        .lineLimit(1).truncationMode(.middle).help(url.path)
    }
  }

  private func load(force: Bool = false) {
    guard force || original.isEmpty else { return }
    do {
      let source = try String(contentsOf: file, encoding: .utf8)
      let loaded = StackDefinitionLoader.load(source, file: file, validatePaths: false)
      guard let value = loaded.definition else { error = loaded.issues.map(\.message).joined(separator: "\n"); return }
      original = source; definition = value; name = value.name; folders = value.repos; files = value.files; error = nil
    } catch { self.error = error.localizedDescription }
  }

  private func refreshDefinition() async {
    refreshMessage = nil
    await supervisor.reloadDefinitions()
    guard supervisor.errorMessage == nil else { error = supervisor.errorMessage; return }
    guard let saved = supervisor.files.first(where: { $0.file.standardizedFileURL == file.standardizedFileURL }) else {
      error = "This workspace definition is no longer available at \(file.path)."; return
    }
    guard saved.definition != nil, !saved.issues.contains(where: { $0.severity == .error }) else {
      error = saved.issues.map(\.message).joined(separator: "\n"); return
    }
    error = nil
    // Include edits made while the asynchronous reload was in progress.
    let preserveEdits = hasEdits
    if !preserveEdits { load(force: true) }
    guard error == nil else { return }
    refreshMessage = supervisor.definitionChanged(saved.id)
      ? "Definition reloaded. Running services still use older settings. Restart services from Services to apply them."
      : preserveEdits ? "Definition reloaded. Your unsaved edits are preserved." : "Saved workspace settings refreshed."
  }

  private func choose(files selectingFiles: Bool) {
    let panel = NSOpenPanel()
    panel.canChooseFiles = selectingFiles; panel.canChooseDirectories = !selectingFiles
    panel.allowsMultipleSelection = true; panel.prompt = selectingFiles ? "Add files" : "Add folders"
    guard panel.runModal() == .OK else { return }
    error = nil
    if selectingFiles {
      var known = Set(files.map { $0.resolvingSymlinksInPath().path })
      let additions = panel.urls.filter { known.insert($0.resolvingSymlinksInPath().path).inserted }
      guard files.count + additions.count <= 128 else { error = "Choose up to 128 workspace files."; return }
      files += additions
    } else {
      var known = Set(folders.map { $0.path.resolvingSymlinksInPath().path })
      let additions = panel.urls.filter { known.insert($0.resolvingSymlinksInPath().path).inserted }
      guard folders.count + additions.count <= 64 else { error = "Choose up to 64 workspace folders."; return }
      for url in additions {
        let base = WorkspaceDefinitionWriter.workspaceID(for: url.lastPathComponent)
        var id = base; var suffix = 2
        while folders.contains(where: { $0.id == id }) { id = "\(base)-\(suffix)"; suffix += 1 }
        // Regular folders and subfolders stay at the selected path; only Git roots isolate.
        let git = WorkspaceDiscovery.repositoryRoot(containing: url)
        folders.append(.init(id: id, path: url, laneMode: git?.standardizedFileURL == url.standardizedFileURL ? .worktree : .shared))
      }
    }
  }

  private func save() {
    guard let definition else { return }
    do {
      let updated = try WorkspaceSettingsWriter.source(original: original, definition: definition,
        name: name, folders: folders, files: files)
      try WorkspaceDefinitionWriter.saveSource(file: file, original: original, source: updated)
      onSaved(); dismiss()
    } catch { self.error = error.localizedDescription }
  }
}

nonisolated enum WorkspaceSettingsWriter {
  static func source(original: String, definition: StackDefinition, name: String,
    folders: [RepoDefinition], files: [URL]) throws -> String {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { throw StackError.message("Enter a workspace name") }
    var source = try WorkspaceDefinitionWriter.metadata(original, values: ["name": name], arrays: ["files": files.map(\.path)])
    for folder in definition.repos where !folders.contains(where: { $0.id == folder.id }) {
      source = try WorkspaceDefinitionWriter.replacing(source, section: "repos." + folder.id, with: "")
    }
    for folder in folders where definition.repo(folder.id) != folder {
      source = try WorkspaceDefinitionWriter.replacing(source, section: "repos." + folder.id,
        with: WorkspaceDefinitionWriter.repo(id: folder.id, path: folder.path) + "\nlane = \(WorkspaceDefinitionWriter.quote(folder.laneMode.rawValue))")
    }
    return source
  }
}
