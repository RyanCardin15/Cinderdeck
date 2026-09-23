import SwiftUI

struct WorkspaceCreateView: View {
  let onSaved: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var folder = FileManager.default.homeDirectoryForCurrentUser.path
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Create a workspace").font(.title2.bold())
      Text("Keep a project's services, tasks, and workflows together. You can add any of them after creating the workspace.").foregroundColor(.secondary)
      TextField("Workspace name", text: $name).textFieldStyle(.roundedBorder)
      HStack {
        TextField("Project folder", text: $folder).textFieldStyle(.roundedBorder)
        Button("Choose folder…") {
          let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
          if panel.runModal() == .OK, let url = panel.url { folder = url.path }
        }
      }
      Text("Commands use this folder by default. Each service or task can use a different folder.").font(.caption).foregroundColor(.secondary)
      if let error { Text(error).font(.callout).foregroundColor(.red).textSelection(.enabled) }
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Create workspace", action: save).buttonStyle(.borderedProminent).disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }.padding(24).frame(width: 520)
  }
  private func save() {
    do {
      let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
      var id = title.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
        .replacingOccurrences(of: "[^a-z0-9_-]+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
      if id.isEmpty { id = "workspace-" + UUID().uuidString.prefix(8).lowercased() }
      let directory = StackDefinitionLoader.directory()
      let file = directory.appendingPathComponent(id + ".toml")
      guard !FileManager.default.fileExists(atPath: file.path) else { throw StackError.message("A workspace with this name already exists. Choose a different name.") }
      let source = "name = \(WorkspaceDefinitionWriter.quote(title))\nroot = \(WorkspaceDefinitionWriter.quote(folder))\n"
      let definition = StackDefinitionLoader.load(source, file: file)
      guard definition.definition != nil else { throw StackError.message(definition.issues.map(\.message).joined(separator: "\n")) }
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try Data(source.utf8).write(to: file, options: .withoutOverwriting)
      onSaved(id)
    } catch { self.error = error.localizedDescription }
  }
}
