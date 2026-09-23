import AppKit
import SwiftUI

struct StackDefinitionEditor: View {
  let file: URL?
  let onSaved: () -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var filename = "my-workspace"
  @State private var source = StackDefinitionLoader.template
  @State private var originalSource: String?
  @State private var issues: [StackDefinitionIssue] = []
  @State private var addingProject = false
  @State private var projectPath = ""
  @State private var projectID = "app"
  @State private var projectCommand = ""
  @State private var projectPort = ""
  @State private var projectUsesGit = true

  private var destination: URL { file ?? StackDefinitionLoader.directory().appendingPathComponent(filename + ".toml") }
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack {
        VStack(alignment: .leading, spacing: 4) {
          Text(file == nil ? "Create a workspace" : "Edit workspace").font(.title2.weight(.semibold))
          Text("Services stay running. Tasks finish. Workflows run them in order. Add project folders or edit the definition below.")
            .font(.callout).foregroundColor(.secondary)
        }
        Spacer()
      }
      if file == nil {
        HStack { Text("File name"); TextField("my-workspace", text: $filename); Text(".toml").foregroundColor(.secondary) }.textFieldStyle(.roundedBorder)
      }
      HStack {
        Button("Add project…", systemImage: "folder.badge.plus") { chooseProject() }
        Button("Validate") { validate() }
        Spacer()
        Text("Changes apply on the next start or restart").font(.caption).foregroundColor(.secondary)
      }
      if addingProject { projectForm }
      TextEditor(text: $source).font(.system(size: 12, design: .monospaced)).disableAutocorrection(true)
        .padding(5).background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2)))
        .accessibilityLabel("Workspace TOML configuration")
      if !issues.isEmpty {
        ScrollView {
          VStack(alignment: .leading, spacing: 4) {
            ForEach(issues) { issue in Text(issue.message).font(.caption).foregroundColor(issue.severity == .error ? .red : .orange).textSelection(.enabled) }
          }.frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxHeight: 70)
      }
      HStack {
        Text(destination.path.replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~"))
          .font(.caption2).foregroundColor(.secondary).lineLimit(1).truncationMode(.middle)
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Save & open in editor") { save(openInEditor: true) }
        Button("Save workspace") { save(openInEditor: false) }.keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
      }
    }.padding(20).frame(width: 730, height: 570)
      .onAppear {
        if let file {
          do { source = try String(contentsOf: file, encoding: .utf8); originalSource = source }
          catch { issues = [.init(severity: .error, message: error.localizedDescription)] }
        }
      }
  }
  private var projectForm: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(projectPath).font(.caption).foregroundColor(.secondary).lineLimit(1).truncationMode(.middle)
      HStack {
        TextField("Service name", text: $projectID).frame(width: 130)
        TextField("Start command, e.g. npm run dev", text: $projectCommand)
        TextField("Port (optional)", text: $projectPort).frame(width: 115)
      }.textFieldStyle(.roundedBorder)
      HStack {
        Toggle("Show Git branches for this project", isOn: $projectUsesGit)
        Spacer()
        Button("Cancel") { addingProject = false }
        Button("Add service") { addProject() }.disabled(projectCommand.trimmingCharacters(in: .whitespaces).isEmpty || !StackDefinitionLoader.validID(projectID))
      }.font(.caption)
    }.padding(10).background(Color.accentColor.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
  }
  private func chooseProject() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
    panel.prompt = "Choose project"
    guard panel.runModal() == .OK, let url = panel.url else { return }
    projectPath = url.path
    projectID = url.lastPathComponent.replacingOccurrences(of: "[^A-Za-z0-9_-]", with: "-", options: .regularExpression).lowercased()
    projectUsesGit = FileManager.default.fileExists(atPath: url.appendingPathComponent(".git").path)
    projectCommand = ""; projectPort = ""; addingProject = true
  }
  private func addProject() {
    let q: (String) -> String = { value in
      "\"" + value.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"").replacingOccurrences(of: "\n", with: "\\n")
        .replacingOccurrences(of: "\t", with: "\\t") + "\""
    }
    if !projectPort.isEmpty, Int(projectPort).map({ (1...65535).contains($0) }) != true {
      issues = [.init(severity: .error, message: "Port must be an integer from 1 to 65535")]; return
    }
    if source.contains("[services.\(projectID)]") || source.contains("[repos.\(projectID)]") {
      issues = [.init(severity: .error, message: "Choose a unique service name")]; return
    }
    if source == StackDefinitionLoader.template {
      source = "# Group any local projects. Start services explicitly from Workspaces.\nname = \(q(filename.replacingOccurrences(of: "-", with: " ").capitalized))\nroot = \(q("~"))\nrestart_on_branch_change = true\n"
    }
    if projectUsesGit { source += "\n[repos.\(projectID)]\npath = \(q(projectPath))\n" }
    source += "\n[services.\(projectID)]\n" + (projectUsesGit ? "repo = \(q(projectID))\n" : "cwd = \(q(projectPath))\n")
    source += "cmd = \(q(projectCommand))\n"
    if let port = Int(projectPort) { source += "port = \(port)\nready.port = \(port)\n" }
    source += "# depends_on = [\(q("other-service"))]\n"
    addingProject = false; validate()
  }
  private func validate() {
    guard file != nil || StackDefinitionLoader.validID(filename) else {
      issues = [.init(severity: .error, message: "File name must use letters, numbers, hyphens or underscores")]; return
    }
    issues = StackDefinitionLoader.load(source, file: destination).issues
  }
  private func save(openInEditor: Bool) {
    validate()
    guard !issues.contains(where: { $0.severity == .error }) else { return }
    do {
      if file == nil, FileManager.default.fileExists(atPath: destination.path) { throw StackError.message("A workspace with that file name already exists. Choose another name.") }
      if let file, let originalSource, try String(contentsOf: file, encoding: .utf8) != originalSource {
        throw StackError.message("The file changed in another editor. Reopen it before saving so those changes are preserved.")
      }
      try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
      try source.write(to: destination, atomically: true, encoding: .utf8)
      if openInEditor { NSWorkspace.shared.open(destination) }
      onSaved(); dismiss()
    } catch { issues = [.init(severity: .error, message: error.localizedDescription)] }
  }
}
