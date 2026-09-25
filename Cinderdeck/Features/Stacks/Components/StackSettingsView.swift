import SwiftUI

struct StackSettingsView: View {
  @AppStorage(PreferencesKeys.stacksEnabled) private var enabled = true
  @AppStorage(PreferencesKeys.stacksDirectory) private var directory = "~/.config/cinderdeck/stacks"
  @AppStorage(PreferencesKeys.stacksLanesDirectory) private var lanesDirectory = "~/.cinderdeck/lanes"
  @AppStorage(PreferencesKeys.stacksQuitBehavior) private var quitBehavior = "ask"
  @AppStorage(PreferencesKeys.stacksNotifyOnCrash) private var notify = true
  @AppStorage(PreferencesKeys.stacksAutoFetchMinutes) private var autoFetch = 0
  @State private var managesSecrets = false
  @State private var managesAgents = false
  var body: some View {
    Section("Workspaces") {
      Toggle("Show workspace quick controls in History", isOn: $enabled)
      HStack {
        Text("Stack definitions")
        TextField("~/.config/cinderdeck/stacks", text: $directory).textFieldStyle(.roundedBorder)
        Button("Choose…") {
          let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
          panel.canCreateDirectories = true
          if panel.runModal() == .OK, let url = panel.url { directory = url.path }
        }
      }
      HStack {
        Text("Lane worktrees")
        TextField("~/.cinderdeck/lanes", text: $lanesDirectory).textFieldStyle(.roundedBorder)
          .help("New lanes create their worktrees here, in <workspace>/<lane>/. Keep it outside your projects. A workspace's [lanes] dir overrides it.")
        Button("Choose…") {
          let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true
          panel.canCreateDirectories = true
          if panel.runModal() == .OK, let url = panel.url { lanesDirectory = url.path }
        }
      }
      Picker("When quitting with services running", selection: $quitBehavior) {
        Text("Ask every time").tag("ask")
        Text("Stop services and quit").tag("stop")
        Text("Leave services running").tag("leave")
      }
      Toggle("Notify when a service crashes", isOn: $notify)
      HStack {
        Text("Fetch Git remotes automatically")
        Spacer()
        Picker("Fetch interval", selection: $autoFetch) {
          Text("Off").tag(0)
          ForEach([5, 15, 30, 60], id: \.self) { Text("Every \($0) minutes").tag($0) }
          if ![0, 5, 15, 30, 60].contains(autoFetch) { Text("Every \(autoFetch) minutes").tag(autoFetch) }
        }.labelsHidden().frame(width: 175)
      }
      HStack {
        Text("Secrets stay in Keychain and are never exported.").font(.caption).foregroundColor(.secondary)
        Spacer()
        Button("Manage secrets…") { managesSecrets = true }
      }
      HStack {
        Text("Let Cursor, Codex and Claude Code manage workspaces through MCP or the cinderdeck CLI.").font(.caption).foregroundColor(.secondary)
        Spacer()
        Button("Agent access…") { managesAgents = true }
      }
    }
    Section("Workspace logs in screen recordings") {
      WorkspaceLogSettingsRows()
    }
    .sheet(isPresented: $managesSecrets) { StackSecretsSheet() }
    .sheet(isPresented: $managesAgents) { StackAgentsSheet() }
  }
}

struct StackSecretsSheet: View {
  @Environment(\.dismiss) private var dismiss
  @State private var names: [String] = []
  @State private var name = ""
  @State private var value = ""
  @State private var error: String?
  @State private var deleting: String?
  private let store = StackSecretsStore()
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Stack secrets").font(.title2.weight(.semibold))
      Text("Reference a secret in your workspace with [secrets], for example API_KEY = \"my-api-key\". Values are passed to services and tasks only when they start.")
        .font(.callout).foregroundColor(.secondary)
      List(names, id: \.self) { name in
        HStack { Image(systemName: "key"); Text(name); Spacer(); Button("Remove…") { deleting = name } }
      }
      TextField("Secret name", text: $name).textFieldStyle(.roundedBorder)
      SecureField("Secret value", text: $value).textFieldStyle(.roundedBorder)
      if let error { Text(error).font(.caption).foregroundColor(.red) }
      HStack {
        Button("Save secret") {
          do { try store.save(value, named: name); name = ""; value = ""; error = nil; reload() }
          catch { self.error = error.localizedDescription }
        }.disabled(name.isEmpty || value.isEmpty)
        Spacer(); Button("Done") { value = ""; dismiss() }.keyboardShortcut(.defaultAction)
      }
    }.padding(20).frame(width: 500, height: 380).onAppear { reload() }
      .alert("Remove Keychain secret?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } })) {
        Button("Cancel", role: .cancel) { deleting = nil }
        Button("Remove", role: .destructive) {
          do { if let deleting { try store.delete(deleting) }; deleting = nil; reload() }
          catch { self.error = error.localizedDescription }
        }
      } message: { Text("Services that reference \(deleting ?? "this secret") will need it added again before they can start.") }
  }
  private func reload() { do { names = try store.names() } catch { self.error = error.localizedDescription } }
}
