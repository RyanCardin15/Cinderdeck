import SwiftUI

struct StackLaneAttachmentView: View {
  let file: StackDefinitionFile
  @ObservedObject var model: StacksViewModel
  @Environment(\.dismiss) private var dismiss
  @State private var workspace = ""
  @State private var working = false
  @State private var error: String?
  private var workspaces: [StackDefinitionFile] { model.workspaceNavigation.workspaces.filter { $0.definition != nil } }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Add \(file.lane?.name ?? file.name) to a workspace").font(.headline)
      Text("Choose the workspace this lane belongs to. Its files and Git branches stay where they are.")
        .foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
      if workspaces.isEmpty {
        Text("Create a workspace first, then add this lane to it.").foregroundColor(.secondary)
      } else {
        Picker("Workspace", selection: $workspace) {
          Text("Choose a workspace").tag("")
          ForEach(workspaces) { Text($0.name).tag($0.id) }
        }.disabled(working).accessibilityIdentifier("workspace.lane.attach.picker")
      }
      if let error { Text(error).foregroundColor(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
      HStack {
        if working { ProgressView().controlSize(.small) }
        Spacer()
        Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).disabled(working)
        Button("Add to workspace") {
          working = true; error = nil
          Task {
            defer { working = false }
            do {
              try await StackControlService.shared.attachLane(file.id, to: workspace, actor: .user)
              model.select(file.id)
              dismiss()
            } catch { self.error = error.localizedDescription }
          }
        }.keyboardShortcut(.defaultAction)
          .disabled(working || !workspaces.contains { $0.id == workspace })
          .accessibilityIdentifier("workspace.lane.attach.confirm")
      }
    }.padding(20).frame(width: 460).interactiveDismissDisabled(working)
  }
}

struct StackLaneAttachmentMenu: View {
  let file: StackDefinitionFile
  @ObservedObject var model: StacksViewModel
  var body: some View {
    if model.workspaceNavigation.isUnattached(file.id) {
      Button("Add to workspace…") { model.attachLane(file) }
        .disabled(model.isBusy(file.id)).accessibilityIdentifier("workspace.lane.attach.\(file.id)")
    }
  }
}
