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
      let file = try WorkspaceDefinitionWriter.createWorkspace(name: name, root: folder)
      onSaved(file.deletingPathExtension().lastPathComponent)
    } catch { self.error = error.localizedDescription }
  }
}
