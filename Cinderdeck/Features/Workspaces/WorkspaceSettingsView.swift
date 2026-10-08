import AppKit
import SwiftUI

/// Visual workspace membership editing, with the original definition retained for conflict checks.
struct WorkspaceSettingsView: View {
  let file: URL
  var requestsDeletion = false
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
  @State private var confirmsDeletion = false
  @State private var deleting = false
  @State private var deletionError: String?
  @State private var reviewSkill = ""
  @State private var savedReviewSkill: String?
  @State private var loadedReviewSkill = ""
  @State private var reviewSkillMessage: String?
  @ObservedObject private var runner = WorkspaceRunner.shared

  private var workspaceID: String { file.deletingPathExtension().lastPathComponent }
  private var deletionBlocker: String? {
    if supervisor.isBootstrapping || supervisor.isRemovingLane(workspaceID) || supervisor.states[workspaceID]?.operation != nil {
      return "Wait for the current workspace operation to finish."
    }
    if supervisor.states[workspaceID]?.isActive == true || runner.activeRun(workspaceID) != nil {
      return "Stop this workspace's services and finish or cancel its active runs before deleting."
    }
    if supervisor.files.contains(where: { $0.lane?.sourceStackID == workspaceID || $0.parentWorkspaceID == workspaceID }) {
      return "Remove or release this workspace's lanes before deleting."
    }
    return nil
  }

  private var hasEdits: Bool {
    guard let definition else { return false }
    return name != definition.name || folders != definition.repos || files != definition.files || reviewSkill != loadedReviewSkill
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
            VStack(alignment: .leading, spacing: 8) {
              DeckSectionLabel(title: "Code Review Skill")
              Text("Isolated review chats use these workspace instructions. Customize them here or open a session to view and edit the skill.")
                .font(.caption).foregroundStyle(.secondary)
              Text(WorkspaceCodeReviewSkill.file(root: definition.root).path)
                .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
              TextEditor(text: $reviewSkill).font(.system(.caption, design: .monospaced))
                .frame(height: 160).accessibilityLabel("Code Review Skill")
              HStack {
                Button("Save skill") { saveReviewSkill(openSession: false) }
                Button("Open in Session") { saveReviewSkill(openSession: true) }
                Spacer()
                Text(savedReviewSkill == nil ? "Using default skill" : "Workspace skill")
                  .font(.caption).foregroundStyle(.secondary)
              }
              if let reviewSkillMessage { Text(reviewSkillMessage).font(.caption).textSelection(.enabled) }
            }
          }
          HStack {
            DeckSectionLabel(title: "Folders")
            Spacer()
            Button("Add folders…") { choose(files: false) }.disabled(folders.count >= 64)
          }
          ForEach($folders) { $folder in
            VStack(alignment: .leading, spacing: 8) {
            HStack {
              pathRow(folder.path, icon: "folder")
              Spacer()
              Picker("New lanes use \(folder.id) as", selection: $folder.laneMode) {
                Text("Worktree").tag(StackRepoLaneMode.worktree)
                Text("Reference").tag(StackRepoLaneMode.shared)
              }.labelsHidden().frame(width: 155)
                .help("Default for new lanes. Worktree: isolated checkout on the lane branch. Reference: original checkout, read-only context.")
              Button { folders.removeAll { $0.id == folder.id } } label: { Image(systemName: "minus.circle") }
                .buttonStyle(.plain).accessibilityLabel("Remove folder \(folder.path.path)")
            }
              if folder.laneMode == .worktree {
                HStack {
                  Text("New lanes start from").font(.caption).foregroundStyle(.secondary)
                  LaneBaseBranchPicker(path: folder.path, selection: Binding(
                    get: { folder.laneFrom ?? definition?.laneSettings?.from ?? "HEAD" },
                    set: { folder.laneFrom = $0 == (definition?.laneSettings?.from ?? "HEAD") ? nil : $0 }),
                    label: "Default lane base for \(folder.id)")
                  Spacer()
                }
              }
            }.padding(10).background(DeckStyle.surface, in: RoundedRectangle(cornerRadius: 8))
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
      deletionSection
      Divider()
      HStack {
        Button("Edit definition…") { advanced = true }
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Save workspace") { save() }.keyboardShortcut(.defaultAction)
          .buttonStyle(.borderedProminent).disabled(definition == nil || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }.padding(24).frame(width: 740, height: 620).background(DeckStyle.canvas)
      .disabled(deleting)
      .interactiveDismissDisabled(deleting)
      .onAppear { load(); confirmsDeletion = requestsDeletion && !original.isEmpty && deletionBlocker == nil }
      .alert("Delete \(definition?.name ?? workspaceID)?", isPresented: $confirmsDeletion) {
        Button("Cancel", role: .cancel) {}
        Button("Delete workspace", role: .destructive) { deleteWorkspace() }
      } message: {
        Text("This removes the workspace from Cinderdeck. Project folders and files, Git branches, logs, and saved runs are kept."
          + (hasEdits ? " Unsaved workspace settings will be discarded." : ""))
      }
      .sheet(isPresented: $advanced) {
        StackDefinitionEditor(file: file) { onSaved(); dismiss() }
      }
  }

  private var deletionSection: some View {
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 5) {
        Label("Delete workspace", systemImage: "trash").font(.callout.weight(.semibold))
        Text("Remove from Cinderdeck. Your project folders and files stay on disk.")
          .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        if let message = deletionError ?? deletionBlocker {
          Text(message).font(.caption).foregroundStyle(.red)
            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
      }
      Spacer(minLength: 0)
      if deleting { ProgressView().controlSize(.small).accessibilityLabel("Deleting workspace") }
      Button(role: .destructive) { deletionError = nil; confirmsDeletion = true } label: {
        Text(deleting ? "Deleting…" : "Delete workspace…")
      }
      .buttonStyle(DeckButtonStyle(prominent: true, tint: .red))
      .disabled(original.isEmpty || deletionBlocker != nil || deleting)
      .accessibilityIdentifier("workspace.settings.delete")
    }
    .padding(14)
    .background(DeckStyle.surface, in: RoundedRectangle(cornerRadius: 10))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.red.opacity(0.2)))
  }

  private func deleteWorkspace() {
    guard !deleting, !original.isEmpty else { return }
    deleting = true; deletionError = nil
    let revision = WorkspaceDefinitionWriter.revision(original)
    Task { @MainActor in
      defer { deleting = false }
      do {
        _ = try await StackControlService.shared.handleWorkspaceLifecycle("workspace.delete",
          params: .object(["workspace": .string(workspaceID), "revision": .string(revision)]), actor: .user)
        onSaved(); dismiss()
      } catch {
        deletionError = (error as? StackControlError)?.code == "stale_definition"
          ? "Workspace settings changed since you opened this window. Cancel and reopen workspace settings before deleting."
          : error.localizedDescription
      }
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
      original = source
      let loaded = StackDefinitionLoader.load(source, file: file, validatePaths: false)
      guard let value = loaded.definition else { error = loaded.issues.map(\.message).joined(separator: "\n"); return }
      original = source; definition = value; name = value.name; folders = value.repos; files = value.files; error = nil
      let skill = try WorkspaceCodeReviewSkill.load(root: value.root)
      savedReviewSkill = skill.saved; loadedReviewSkill = skill.content; reviewSkill = skill.content; reviewSkillMessage = nil
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
      if reviewSkill != loadedReviewSkill {
        try WorkspaceCodeReviewSkill.save(root: definition.root, original: savedReviewSkill, content: reviewSkill)
        savedReviewSkill = reviewSkill; loadedReviewSkill = reviewSkill
      }
      try WorkspaceDefinitionWriter.saveSource(file: file, original: original, source: updated)
      onSaved(); dismiss()
    } catch { self.error = error.localizedDescription }
  }

  private func saveReviewSkill(openSession: Bool) {
    guard let definition else { return }
    do {
      try WorkspaceCodeReviewSkill.save(root: definition.root, original: savedReviewSkill, content: reviewSkill)
      savedReviewSkill = reviewSkill; loadedReviewSkill = reviewSkill; reviewSkillMessage = "Code review skill saved. New reviews will use these instructions."
      if openSession {
        guard CinderdeckRuntimeController.shared.show(workspaceID: workspaceID, section: "code-review-skill") else {
          throw StackError.message("The session could not be opened. Try again when Cinderdeck is connected.")
        }
        dismiss()
      }
    } catch { reviewSkillMessage = error.localizedDescription }
  }
}

nonisolated enum WorkspaceCodeReviewSkill {
  static func file(root: URL) -> URL { root.appendingPathComponent(".cinderdeck/skills/code-review/SKILL.md") }

  static func load(root: URL, defaultContent: String? = nil) throws -> (saved: String?, content: String) {
    let url = file(root: root)
    if FileManager.default.fileExists(atPath: url.path) {
      let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard size <= 24000 else { throw StackError.message("Code review skills must contain at most 6000 characters.") }
      let text = try String(contentsOf: url, encoding: .utf8)
      return (text, text)
    }
    if let defaultContent { return (nil, defaultContent) }
    guard let bundled = StackAgentSkills.bundledFolder()?.appendingPathComponent("cinderdeck-code-review/SKILL.md") else {
      throw StackError.message("The bundled code review skill is unavailable. Rebuild the complete Cinderdeck app.")
    }
    return (nil, try String(contentsOf: bundled, encoding: .utf8))
  }

  static func save(root: URL, original: String?, content: String) throws {
    guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, content.utf16.count <= 6000 else {
      throw StackError.message("Enter a code review skill with at most 6000 characters.")
    }
    let url = file(root: root)
    let current = FileManager.default.fileExists(atPath: url.path) ? try String(contentsOf: url, encoding: .utf8) : nil
    guard current == original else { throw StackError.message("The code review skill changed on disk. Reopen workspace settings to review it before saving.") }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try content.write(to: url, atomically: true, encoding: .utf8)
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
        with: WorkspaceDefinitionWriter.repo(id: folder.id, path: folder.path) + "\nlane = \(WorkspaceDefinitionWriter.quote(folder.laneMode.rawValue))"
          + (folder.laneFrom.map { "\nlane_from = \(WorkspaceDefinitionWriter.quote($0))" } ?? ""))
    }
    return source
  }
}
