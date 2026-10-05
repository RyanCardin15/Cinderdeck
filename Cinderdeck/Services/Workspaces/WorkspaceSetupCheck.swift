import Foundation

nonisolated struct WorkspaceSetupIssue: Identifiable, Equatable, Sendable {
  enum Severity: Sendable { case blocker, warning }
  var id: String
  var severity: Severity
  var title: String
  var detail: String
}

nonisolated enum WorkspaceSetupCheck {
  static func check(root: URL, commands: [WorkspaceDiscoveredCommand], environment: [String: String]) async -> [WorkspaceSetupIssue] {
    var issues: [WorkspaceSetupIssue] = []
    var ports: [Int: String] = [:]
    let selected = commands.filter(\.selected)
    for command in selected {
      let severity: WorkspaceSetupIssue.Severity = command.kind == .service ? .blocker : .warning
      if command.command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        issues.append(.init(id: command.id + "-empty-command", severity: .blocker,
          title: "Enter a command for \(command.title)", detail: "Add the command above, or deselect this entry."))
      }
      if command.runtimes.isEmpty {
        issues.append(.init(id: command.id + "-unknown-tools", severity: .warning,
          title: "Check tools for \(command.title)", detail: "Enter the required tools above to check their availability. Custom commands may need tools that discovery cannot infer."))
      }
      for runtime in command.runtimes where executable(runtime, directory: command.directory, environment: environment) == nil {
        issues.append(.init(id: command.id + "-runtime-" + runtime, severity: severity,
          title: "\(command.title) needs \(runtime)", detail: "Install or enable \(runtime) in your login shell, then check again. Cinderdeck uses that shell's PATH."))
      }
      if !FileManager.default.fileExists(atPath: command.directory.path) {
        issues.append(.init(id: command.id + "-folder", severity: .blocker, title: "Project folder is missing", detail: command.directory.path))
      }
      if let dependencyFolder = command.dependencyFolder, !hasDependencies(dependencyFolder, directory: command.directory, root: command.discoveryRoot ?? root) {
        issues.append(.init(id: command.id + "-dependencies", severity: severity,
          title: "\(command.title) needs dependencies", detail: "Install dependencies in \(command.directory.path) with the project's package manager, then check again."))
      }
      if command.kind == .service {
        if !command.port.isEmpty {
          if let port = Int(command.port), (1...65535).contains(port) {
            issues += await portIssues(port, owner: command.id, title: command.title, ports: &ports)
          } else {
            issues.append(.init(id: command.id + "-invalid-port", severity: .blocker,
              title: "Invalid port for \(command.title)", detail: "Use a port from 1 to 65535, or leave it blank if the command does not listen on a port."))
          }
        } else if command.composeFile == nil {
          issues.append(.init(id: command.id + "-unknown-port", severity: .warning,
            title: "Port not detected for \(command.title)", detail: "If this command runs a server, enter its port so Cinderdeck can check for conflicts."))
        }
        if let fixed = command.fixedPort, command.port != String(fixed),
          !command.command.contains("{{port."), WorkspaceDiscovery.explicitPort(command.command) != Int(command.port) {
          issues.append(.init(id: command.id + "-fixed-port", severity: .blocker,
            title: "The detected script uses port \(fixed)", detail: "Changing the port field does not update the script. Update its port argument or environment, then discover the project again; or use an explicit port argument in the command above."))
        }
        if command.runtimes.contains("docker"), let docker = executable("docker", directory: command.directory, environment: environment) {
          let version = try? await StackCommandRunner.run(docker, ["compose", "version"], environment: environment, timeout: 5)
          if version?.status != 0 {
            issues.append(.init(id: command.id + "-compose", severity: .blocker, title: "Docker Compose is unavailable", detail: "Install the Docker Compose plugin, then check again."))
          } else {
            if let filename = command.composeFile {
              issues += await composeIssues(command: command, filename: filename, docker: docker, environment: environment, ports: &ports)
            }
            let info = try? await StackCommandRunner.run(docker, ["info", "--format", "{{.ServerVersion}}"], environment: environment, timeout: 5)
            if info?.status != 0 { issues.append(.init(id: command.id + "-docker-engine", severity: .blocker,
              title: "Docker is not running", detail: "Start your Docker engine, then check again.")) }
          }
        }
        issues += environmentIssues(command: command, environment: environment)
      }
    }
    return issues
  }

  private static func portIssues(_ port: Int, owner: String, title: String, ports: inout [Int: String]) async -> [WorkspaceSetupIssue] {
    var issues: [WorkspaceSetupIssue] = []
    if let other = ports[port] {
      issues.append(.init(id: owner + "-duplicate-" + String(port), severity: .blocker,
        title: "Two services use port \(port)", detail: "\(title) and \(other) share this port. Update the port and the command's port argument together."))
    }
    ports[port] = title
    do {
      if let conflict = try await PortInspector.conflict(on: port) {
        issues.append(.init(id: owner + "-occupied-" + String(port), severity: .blocker,
          title: conflict.description, detail: "Stop that process in its terminal, or choose another port and update the command. Check again before starting."))
      }
    } catch {
      issues.append(.init(id: owner + "-port-check-" + String(port), severity: .blocker,
        title: "Could not check port \(port)", detail: "Check again before starting. " + error.localizedDescription))
    }
    return issues
  }

  /// Docker parses its own file format. This read-only check never runs Compose up
  /// or emits the rendered configuration (which can contain secret values).
  private static func composeIssues(command: WorkspaceDiscoveredCommand, filename: String, docker: String,
    environment: [String: String], ports: inout [Int: String]) async -> [WorkspaceSetupIssue] {
    guard let result = try? await StackCommandRunner.run(docker, ["compose", "-f", filename, "config", "--format", "json"],
      directory: command.directory, environment: environment, timeout: 10), result.status == 0,
      let config = try? JSONSerialization.jsonObject(with: result.output) as? [String: Any],
      let services = config["services"] as? [String: [String: Any]] else {
      return [.init(id: command.id + "-compose-config", severity: .blocker,
        title: "Docker Compose configuration needs attention", detail: "Run docker compose config in the project folder to resolve missing variables or invalid configuration, then check again. Rendered values are not displayed here.")]
    }
    var issues: [WorkspaceSetupIssue] = []
    var checked = Set<Int>()
    for name in services.keys.sorted() {
      for mapping in services[name]?["ports"] as? [[String: Any]] ?? [] {
        if let protocolName = mapping["protocol"] as? String, protocolName != "tcp" { continue }
        guard let published = mapping["published"] else { continue }
        let text = String(describing: published)
        guard let port = Int(text), (1...65535).contains(port) else {
          issues.append(.init(id: command.id + "-compose-range-" + name, severity: .blocker,
            title: "Compose uses a dynamic port or range", detail: "Choose a fixed published port in the Compose file so Cinderdeck can check it before launch."))
          continue
        }
        if checked.insert(port).inserted {
          issues += await portIssues(port, owner: command.id + "-" + name, title: command.title + " · " + name, ports: &ports)
        } else {
          issues.append(.init(id: command.id + "-compose-duplicate-" + name + String(port), severity: .blocker,
            title: "Compose services share port \(port)", detail: "Give each container a different published TCP port in the Compose file."))
        }
      }
    }
    if !result.error.isEmpty {
      issues.append(.init(id: command.id + "-compose-warning", severity: .warning,
        title: "Docker Compose reported configuration warnings", detail: "Review docker compose config in the project folder for missing variables or deprecated settings. Warning output is omitted because it can contain environment values."))
    }
    return issues
  }

  static func hasDependencies(_ name: String, directory: URL, root: URL) -> Bool {
    var folder = directory.standardizedFileURL.resolvingSymlinksInPath()
    let root = root.standardizedFileURL.resolvingSymlinksInPath()
    while true {
      var isDirectory: ObjCBool = false
      if FileManager.default.fileExists(atPath: folder.appendingPathComponent(name).path, isDirectory: &isDirectory), isDirectory.boolValue { return true }
      if name == "node_modules", [".pnp.cjs", ".pnp.js"].contains(where: { FileManager.default.fileExists(atPath: folder.appendingPathComponent($0).path) }) { return true }
      if name != "node_modules" || folder.standardizedFileURL.path == root.standardizedFileURL.path { return false }
      let parent = folder.deletingLastPathComponent().standardizedFileURL
      if parent.path == folder.path { return false }
      folder = parent
    }
  }

  static func executable(_ name: String, directory: URL, environment: [String: String]) -> String? {
    if name.contains("/") {
      let file = name.hasPrefix("/") ? URL(fileURLWithPath: name) : directory.appendingPathComponent(name)
      return FileManager.default.isExecutableFile(atPath: file.path) ? file.path : nil
    }
    return (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").components(separatedBy: ":")
      .map { ($0.isEmpty ? directory : URL(fileURLWithPath: $0)).appendingPathComponent(name).path }
      .first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  /// Only key names and whether values are filled in leave this function. Samples
  /// are hints, not a definitive required-variable schema.
  static func environmentIssues(command: WorkspaceDiscoveredCommand, environment: [String: String]) -> [WorkspaceSetupIssue] {
    let folder = command.directory
    var expected = Set<String>()
    for name in [".env.example", ".env.sample", ".env.template", ".env.local.example"] {
      if let source = try? WorkspaceDiscovery.read(folder.appendingPathComponent(name)) { expected.formUnion(envKeys(source, filledOnly: false)) }
    }
    var supplied = Set(environment.filter { !$0.value.isEmpty }.keys)
    if command.port.isEmpty == false { supplied.insert("PORT") }
    var local = Set<String>()
    for name in [".env", ".env.local", ".env.development", ".env.development.local"] {
      if let source = try? WorkspaceDiscovery.read(folder.appendingPathComponent(name)) { local.formUnion(envKeys(source, filledOnly: true)) }
    }
    if command.loadsDotEnv { supplied.formUnion(local) }
    let missing = expected.subtracting(supplied).sorted()
    guard !missing.isEmpty else { return [] }
    return [.init(id: command.id + "-environment", severity: .warning, title: "Check environment variables for \(command.title)",
      detail: "Sample files mention: " + missing.joined(separator: ", ") + ". " +
        (command.loadsDotEnv ? "Fill in the project's local environment file or export them in your login shell." : "Export required keys in your login shell, or edit the command to load a local environment file. This command is not known to load .env automatically.") +
        " Samples can include optional keys. Values are never shown or copied into the workspace.")]
  }

  static func envKeys(_ source: String, filledOnly: Bool) -> Set<String> {
    var keys = Set<String>()
    for raw in source.components(separatedBy: "\n") {
      var line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if line.hasPrefix("export ") { line = String(line.dropFirst(7)) }
      guard !line.hasPrefix("#"), let equals = line.firstIndex(of: "=") else { continue }
      let key = String(line[..<equals]).trimmingCharacters(in: .whitespaces)
      guard key.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil else { continue }
      let value = String(line[line.index(after: equals)...]).trimmingCharacters(in: .whitespaces)
      if !filledOnly || (!value.isEmpty && value != "\"\"" && value != "''" && !value.hasPrefix("#")) { keys.insert(key) }
    }
    return keys
  }
}
