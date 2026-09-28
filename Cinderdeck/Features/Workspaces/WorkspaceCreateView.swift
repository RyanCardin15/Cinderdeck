import SwiftUI

struct WorkspaceCreateView: View {
  let onSaved: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var name = ""
  @State private var folder = FileManager.default.homeDirectoryForCurrentUser.path
  @State private var error: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      DeckSheetHeader(icon: "square.stack.3d.up", title: "Create a workspace",
        detail: "One home for your project's services, tasks, and workflows.")
      VStack(alignment: .leading, spacing: 7) {
        DeckSectionLabel(title: "Workspace name")
        TextField("e.g. Cinderdeck", text: $name).textFieldStyle(.roundedBorder).accessibilityLabel("Workspace name")
      }
      DeckSectionLabel(title: "Project folder")
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
        Button("Create workspace", action: save).buttonStyle(DeckButtonStyle(prominent: true))
          .keyboardShortcut(.defaultAction).disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }.padding(24).frame(width: 520).background(DeckStyle.canvas)
  }
  private func save() {
    do {
      let file = try WorkspaceDefinitionWriter.createWorkspace(name: name, root: folder)
      onSaved(file.deletingPathExtension().lastPathComponent)
    } catch { self.error = error.localizedDescription }
  }
}
