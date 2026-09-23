import SwiftUI

struct WorkspaceComponentEditor: View {
  struct Context: Identifiable {
    let id = UUID()
    let workspace: StackDefinition
    let kind: WorkspaceRunKind
    let componentID: String?
    var sourceServiceID: String? = nil
  }
  let context: Context
  let onSaved: () -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var source: String?
  @State private var identifier = ""
  @State private var name = ""
  @State private var command = ""
  @State private var directory = ""
  @State private var timeout = "600"
  @State private var services = Set<String>()
  @State private var steps: [String] = []
  @State private var nextStep = ""
  @State private var cleanup = false
  @State private var error: String?
  private var choices: [String] {
    context.workspace.tasks.map { "task:" + $0.id }
      + context.workspace.services.map { "start:" + $0.id }
      + context.workspace.services.map { "stop:" + $0.id }
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("\(context.componentID == nil ? "New" : "Edit") \(context.kind.rawValue)").font(.title2.bold())
      if let service = context.sourceServiceID {
        Label("Move \(service) from Services to Tasks", systemImage: "arrow.right.circle").foregroundColor(.accentColor)
        Text("The command will run once and report its exit status. Its old service entry is removed when you save.").font(.callout).foregroundColor(.secondary)
      }
      Text(context.kind == .task ? "A task finishes with a result. Use services for commands that keep running."
        : "Steps run in order. A failure skips the remaining steps.").foregroundColor(.secondary)
      HStack {
        TextField("ID (e.g. integration-tests)", text: $identifier).disabled(context.componentID != nil)
        TextField("Display name", text: $name)
      }.textFieldStyle(.roundedBorder)
      if context.kind == .task {
        Text("Command").font(.headline)
        TextEditor(text: $command).font(.system(.body, design: .monospaced)).frame(height: 90)
          .overlay(RoundedRectangle(cornerRadius: 5).stroke(Color.secondary.opacity(0.2))).accessibilityLabel("Task command")
        HStack {
          TextField("Working folder", text: $directory).textFieldStyle(.roundedBorder)
          Button("Choose…") {
            let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
            if panel.runModal() == .OK, let path = panel.url?.path { directory = path }
          }
        }
        HStack { Text("Timeout (seconds)"); TextField("600", text: $timeout).frame(width: 90).textFieldStyle(.roundedBorder) }
        if !context.workspace.services.isEmpty {
          Text("Start these services and wait until ready").font(.headline)
          ScrollView {
            VStack(alignment: .leading) {
              ForEach(context.workspace.services) { service in
                Toggle(service.id, isOn: Binding(get: { services.contains(service.id) }, set: { if $0 { services.insert(service.id) } else { services.remove(service.id) } }))
              }
            }.frame(maxWidth: .infinity, alignment: .leading)
          }.frame(maxHeight: 100)
        }
        Text("Inherits workspace environment and Keychain secrets. Use Edit workspace for per-task environment variables.").font(.caption).foregroundColor(.secondary)
      } else {
        HStack {
          Picker("Add a step", selection: $nextStep) {
            Text("Choose task or service").tag("")
            ForEach(choices, id: \.self) { Text($0.replacingOccurrences(of: ":", with: " ")).tag($0) }
          }
          Button("Add") { steps.append(nextStep) }.disabled(nextStep.isEmpty)
        }
        if choices.isEmpty { Text("Add a task or service to this workspace first.").foregroundColor(.secondary) }
        ScrollView {
          VStack(spacing: 8) {
            ForEach(steps.indices, id: \.self) { index in
              HStack {
                Text("\(index + 1).").monospacedDigit().foregroundColor(.secondary)
                Text(steps[index].replacingOccurrences(of: ":", with: " "))
                Spacer()
                Button { steps.swapAt(index, index - 1) } label: { Image(systemName: "arrow.up") }.disabled(index == 0).help("Move step up")
                Button { steps.swapAt(index, index + 1) } label: { Image(systemName: "arrow.down") }.disabled(index == steps.count - 1).help("Move step down")
                Button { steps.remove(at: index) } label: { Image(systemName: "minus.circle") }.help("Remove step")
              }.padding(8).background(Color.secondary.opacity(0.07), in: RoundedRectangle(cornerRadius: 6))
            }
          }
        }.frame(minHeight: 150, maxHeight: 240)
        Toggle("Stop services started by this run when it finishes", isOn: $cleanup)
        Text("Applies after success, failure, or cancellation. Services already running are kept. An explicit stop step always stops its named service.").font(.caption).foregroundColor(.secondary)
      }
      if let error { Text(error).foregroundColor(.red).font(.callout).textSelection(.enabled) }
      HStack {
        Spacer()
        Button("Cancel") { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Save \(context.kind.rawValue)", action: save).buttonStyle(.borderedProminent)
          .disabled(source == nil || identifier.isEmpty || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }.padding(24).frame(width: 630)
      .onAppear(perform: load)
  }
  private func load() {
    do { source = try String(contentsOf: context.workspace.file, encoding: .utf8) } catch { self.error = error.localizedDescription }
    identifier = context.componentID ?? ""
    directory = context.workspace.root.path
    if let id = context.sourceServiceID, let service = context.workspace.service(id) {
      identifier = id; name = id; command = service.command; directory = service.directory.path
      services = Set(service.dependencies)
    }
    if let id = context.componentID {
      if let task = context.workspace.task(id), context.kind == .task {
        name = task.name; command = task.command; directory = task.directory.path
        timeout = String(Int(task.timeout)); services = Set(task.requiresServices)
      } else if let workflow = context.workspace.workflow(id) {
        name = workflow.name; steps = workflow.steps; cleanup = workflow.cleanupServices
      }
    }
  }
  private func save() {
    do {
      guard let source, StackDefinitionLoader.validID(identifier) else { throw StackError.message("Use letters, numbers, hyphens, or underscores for the ID") }
      if context.componentID == nil,
        (context.kind == .task ? context.workspace.task(identifier) != nil : context.workspace.workflow(identifier) != nil) {
        throw StackError.message("That ID already exists. Choose a different ID.")
      }
      let replacement: String
      if context.kind == .task {
        guard let seconds = Double(timeout), seconds.isFinite, seconds > 0, seconds <= 3600 else { throw StackError.message("Timeout must be greater than 0 and at most 3600 seconds") }
        let old = context.workspace.task(identifier)
        let converted = context.sourceServiceID.flatMap { context.workspace.service($0) }
        let task = WorkspaceTaskDefinition(id: identifier, name: name, command: command, repo: old?.repo ?? converted?.repo,
          directory: StackDefinitionLoader.resolve(directory, relativeTo: context.workspace.root),
          environment: old?.environment ?? converted?.environment ?? [:], requiresServices: services.sorted(), timeout: seconds)
        replacement = WorkspaceDefinitionWriter.task(task)
      } else {
        replacement = WorkspaceDefinitionWriter.workflow(.init(id: identifier, name: name, steps: steps, cleanupServices: cleanup))
      }
      if let service = context.sourceServiceID {
        guard WorkspaceRunner.shared.activeRun(context.workspace.id) == nil,
          !StackSupervisor.shared.runtime(context.workspace.id, service).phase.isActive,
          StackSupervisor.shared.runtime(context.workspace.id, service).process == nil else {
          throw StackError.message("Stop this service and finish active runs before moving it to Tasks")
        }
        try WorkspaceDefinitionWriter.convertService(file: context.workspace.file, original: source, service: service,
          taskSection: "tasks." + identifier, replacement: replacement)
        onSaved(); return
      }
      try WorkspaceDefinitionWriter.save(file: context.workspace.file, original: source,
        section: "\(context.kind == .task ? "tasks" : "workflows").\(identifier)", replacement: replacement)
      onSaved()
    } catch { self.error = error.localizedDescription }
  }
}
