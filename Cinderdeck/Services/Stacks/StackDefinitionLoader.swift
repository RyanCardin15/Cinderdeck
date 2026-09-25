import Foundation

nonisolated enum StackDefinitionLoader {
  static func directory(defaults: UserDefaults = .standard) -> URL {
    let path = defaults.string(forKey: PreferencesKeys.stacksDirectory) ?? "~/.config/cinderdeck/stacks"
    return URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true).standardizedFileURL
  }

  static func loadDirectory(_ directory: URL) throws -> [StackDefinitionFile] {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
      .filter { $0.pathExtension.lowercased() == "toml" }.sorted { $0.path < $1.path }
      .map { file in
        do { return load(try String(contentsOf: file, encoding: .utf8), file: file) }
        catch { return StackDefinitionFile(id: file.deletingPathExtension().lastPathComponent, file: file,
          issues: [.init(severity: .error, message: error.localizedDescription)]) }
      }
  }

  static func load(_ source: String, file: URL, validatePaths: Bool = true) -> StackDefinitionFile {
    let id = file.deletingPathExtension().lastPathComponent
    var result = StackDefinitionFile(id: id, file: file)
    do {
      let document = try SimpleTOMLParser.parse(source, strict: true)
      var reader = StackDefinitionReader(root: document.root)
      if !validID(id) { reader.error("File name must use letters, numbers, hyphens or underscores.") }
      reader.warnUnknown(document.root, allowed: ["name", "root", "shell", "restart_on_branch_change", "env", "secrets", "repos", "services", "tasks", "workflows", "lanes"], at: "")
      let root = resolve(reader.string(document.root, "root") ?? file.deletingLastPathComponent().path, relativeTo: file.deletingLastPathComponent())
      let shell = reader.string(document.root, "shell") ?? ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
      var stack = StackDefinition(id: id, name: reader.string(document.root, "name") ?? id, file: file,
        root: root, shell: (shell as NSString).expandingTildeInPath)
      stack.restartOnBranchChange = reader.bool(document.root, "restart_on_branch_change") ?? true
      stack.environment = reader.strings(document.root, "env")
      stack.rawEnvironment = stack.environment.filter { StackTemplates.containsTemplate($0.value) }
      stack.secrets = reader.strings(document.root, "secrets")
      if validatePaths {
        reader.directory(root, label: "root")
        if !FileManager.default.isExecutableFile(atPath: stack.shell) { reader.error("Shell is not executable: \(stack.shell)") }
      }
      for (repoID, value) in reader.table(document.root, "repos").sorted(by: { $0.key < $1.key }) {
        guard case .table(let table) = value else { reader.error("repos.\(repoID) must be a table"); continue }
        if !validID(repoID) { reader.error("Invalid repo ID: \(repoID)") }
        reader.warnUnknown(table, allowed: ["path", "lane"], at: "repos.\(repoID)")
        guard let path = reader.string(table, "path", at: "repos.\(repoID)"), !path.isEmpty else {
          reader.error("repos.\(repoID).path is required"); continue
        }
        let url = resolve(path, relativeTo: root)
        if validatePaths { reader.directory(url, label: "repos.\(repoID).path") }
        var mode = StackRepoLaneMode.worktree
        if let text = reader.string(table, "lane", at: "repos.\(repoID)") {
          if let parsed = StackRepoLaneMode(rawValue: text) { mode = parsed }
          else { reader.error("repos.\(repoID).lane must be worktree or shared") }
        }
        stack.repos.append(.init(id: repoID, path: url, laneMode: mode))
      }
      for (serviceID, value) in reader.table(document.root, "services").sorted(by: { $0.key < $1.key }) {
        let prefix = "services.\(serviceID)"
        guard case .table(let table) = value else { reader.error("\(prefix) must be a table"); continue }
        if !validID(serviceID) { reader.error("Invalid service ID: \(serviceID)") }
        reader.warnUnknown(table, allowed: ["cmd", "repo", "cwd", "depends_on", "port", "ports", "ready", "env", "restart", "stop_signal", "stop_timeout", "autostart", "lane"], at: prefix)
        guard let cmd = reader.string(table, "cmd", at: prefix), !cmd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
          reader.error("\(prefix).cmd is required"); continue
        }
        let repo = reader.string(table, "repo", at: prefix)
        if let repo, stack.repo(repo) == nil { reader.error("\(prefix).repo refers to unknown repo \(repo)") }
        let base = repo.flatMap { stack.repo($0)?.path } ?? root
        let directory = reader.string(table, "cwd", at: prefix).map { resolve($0, relativeTo: base) } ?? base
        if validatePaths { reader.directory(directory, label: "\(prefix).cwd") }
        var service = ServiceDefinition(id: serviceID, command: cmd, repo: repo, directory: directory)
        service.dependencies = reader.array(table, "depends_on", at: prefix) ?? []
        service.port = reader.port(table, "port", at: prefix)
        service.ports = reader.namedPorts(table, at: prefix)
        service.environment = reader.strings(table, "env", at: prefix)
        var raw = StackRawValues()
        if StackTemplates.containsTemplate(cmd) { raw.command = cmd }
        raw.environment = service.environment.filter { StackTemplates.containsTemplate($0.value) }
        if let text = reader.string(table, "lane", at: prefix) {
          if let mode = StackServiceLaneMode(rawValue: text) { service.laneMode = mode }
          else { reader.error("\(prefix).lane must be isolate, shared or off") }
        }
        service.autostart = reader.bool(table, "autostart", at: prefix) ?? true
        if let restart = reader.string(table, "restart", at: prefix) {
          if !["no", "on-failure"].contains(restart) { reader.error("\(prefix).restart must be no or on-failure") }
          service.restartOnFailure = restart == "on-failure"
        }
        if let signal = reader.string(table, "stop_signal", at: prefix) {
          if !["INT", "TERM"].contains(signal) { reader.error("\(prefix).stop_signal must be INT or TERM") }
          service.stopSignal = signal == "INT" ? SIGINT : SIGTERM
        }
        service.stopTimeout = reader.timeout(table, "stop_timeout", at: prefix) ?? 10
        let ready = reader.table(table, "ready", at: prefix)
        reader.warnUnknown(ready, allowed: ["port", "http", "log", "timeout"], at: "\(prefix).ready")
        service.readyTimeout = reader.timeout(ready, "timeout", at: "\(prefix).ready") ?? 90
        var port: Int?
        if case .string(let name) = ready["port"] {
          if let named = service.allPorts[name] ?? (name == "default" ? service.port : nil) { port = named; raw.readyPort = name }
          else { reader.error("\(prefix).ready.port names no port of this service: \(name)") }
        } else { port = reader.port(ready, "port", at: "\(prefix).ready") }
        let http = reader.string(ready, "http", at: "\(prefix).ready")
        let log = reader.string(ready, "log", at: "\(prefix).ready")
        if [port != nil, http != nil, log != nil].filter({ $0 }).count > 1 {
          reader.warning("\(prefix): multiple readiness checks; port, http, log precedence applies")
        }
        if let port { service.readiness = .port(port) }
        else if let http {
          // Rendered below, once every service's ports are known.
          if StackTemplates.containsTemplate(http) { raw.readyHTTP = http }
          else if let url = URL(string: http), ["http", "https"].contains(url.scheme), url.host != nil { service.readiness = .http(url) }
          else { reader.error("\(prefix).ready.http must be an http(s) URL") }
        } else if let log {
          do { _ = try NSRegularExpression(pattern: log); service.readiness = .log(log) }
          catch { reader.error("\(prefix).ready.log is not a valid regular expression") }
        }
        if !raw.isEmpty { service.raw = raw }
        stack.services.append(service)
      }
      readWorkspaceComponents(document.root, into: &stack, reader: &reader, validatePaths: validatePaths)
      readLaneSettings(document.root, into: &stack, reader: &reader)
      for service in stack.services {
        for dependency in service.dependencies {
          if dependency.contains(":") {
            let parts = dependency.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
            if parts.count != 2 || !parts.allSatisfy(validID) {
              reader.error("services.\(service.id) depends on \(dependency); use <workspace>:<service> for another workspace's service")
            }
          } else if stack.service(dependency) == nil {
            reader.error("services.\(service.id) depends on unknown service \(dependency)")
          } else if stack.service(dependency)?.laneMode == .off, service.laneMode != .off {
            reader.error("services.\(service.id) depends on \(dependency), which has lane = \"off\". Set lane = \"off\" or \"shared\" on \(service.id) too, or change \(dependency)")
          }
        }
      }
      validatePortVariables(stack, reader: &reader)
      for error in StackTemplates.apply(to: &stack, context: StackTemplates.context(for: stack)) { reader.error(error) }
      warnHardcodedPorts(stack, reader: &reader)
      if !reader.issues.contains(where: { $0.severity == .error }) {
        do { _ = try stack.dependencyLayers() } catch { reader.error(error.localizedDescription) }
      }
      result.issues = reader.issues
      if !reader.issues.contains(where: { $0.severity == .error }) { result.definition = stack }
    } catch { result.issues.append(.init(severity: .error, message: error.localizedDescription)) }
    return result
  }

  static func readLaneSettings(_ root: [String: SimpleTOMLValue], into stack: inout StackDefinition, reader: inout StackDefinitionReader) {
    guard root["lanes"] != nil else { return }
    let table = reader.table(root, "lanes")
    reader.warnUnknown(table, allowed: ["dir", "from", "copy", "link", "setup", "teardown", "hosts", "env"], at: "lanes")
    var settings = StackLaneSettings()
    settings.directory = reader.string(table, "dir", at: "lanes")
    settings.from = reader.string(table, "from", at: "lanes")
    if let from = settings.from, from.isEmpty || from.hasPrefix("-") || from.contains("\n") { reader.error("lanes.from must be a branch, tag or commit") }
    for key in ["copy", "link"] {
      let patterns = reader.array(table, key, at: "lanes") ?? []
      for pattern in patterns where pattern.isEmpty || pattern.hasPrefix("/") || pattern.hasPrefix("~")
        || pattern.split(separator: "/").contains("..") {
        reader.error("lanes.\(key): \(pattern) must be a path relative to each repository, without ..")
      }
      if key == "copy" { settings.copy = patterns } else { settings.link = patterns }
    }
    for key in ["setup", "teardown"] {
      guard let reference = reader.string(table, key, at: "lanes") else { continue }
      let parts = reference.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
      let known = parts.count == 2 && (parts[0] == "task" ? stack.task(parts[1]) != nil : parts[0] == "workflow" && stack.workflow(parts[1]) != nil)
      if !known { reader.error("lanes.\(key) must name an existing task:<id> or workflow:<id> (\(reference))") }
      if key == "setup" { settings.setup = reference } else { settings.teardown = reference }
    }
    settings.hosts = reader.bool(table, "hosts", at: "lanes") ?? false
    settings.environment = reader.strings(table, "env", at: "lanes")
    settings.rawEnvironment = settings.environment.filter { StackTemplates.containsTemplate($0.value) }
    stack.laneSettings = settings
  }

  /// Services, their named ports and links become CINDERDECK_PORT_* variables; two must not share a name.
  static func validatePortVariables(_ stack: StackDefinition, reader: inout StackDefinitionReader) {
    var seen: [String: String] = [:]
    for service in stack.services {
      for name in service.allPorts.keys.sorted() {
        let variable = name.isEmpty ? StackLaneInfo.portVariable(service.id) : StackLaneInfo.portVariable(service.id, port: name)
        let label = name.isEmpty ? service.id : service.id + "." + name
        if let other = seen[variable] { reader.warning("\(label) and \(other) both set \(variable); rename one so services can tell them apart") }
        seen[variable] = label
      }
    }
  }

  /// Literal localhost URLs to a sibling's port are not rewritten in lanes; a lane would call the original checkout.
  static func warnHardcodedPorts(_ stack: StackDefinition, reader: inout StackDefinitionReader) {
    var owners: [Int: String] = [:]
    for service in stack.services { for (name, port) in service.allPorts { owners[port] = name.isEmpty ? service.id : service.id + "." + name } }
    guard !owners.isEmpty, let regex = try? NSRegularExpression(pattern: "(?:localhost|127\\.0\\.0\\.1|\\[::1\\]|0\\.0\\.0\\.0):([0-9]{2,5})") else { return }
    func check(_ text: String, _ field: String, own: String?) {
      guard !StackTemplates.containsTemplate(text) else { return }
      for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        guard let range = Range(match.range(at: 1), in: text), let port = Int(text[range]), let owner = owners[port] else { continue }
        if let own, owner == own || owner.hasPrefix(own + ".") { continue }
        let target = owner.split(separator: ".").joined(separator: ".")
        reader.warning("\(field) hard-codes localhost:\(port) (\(owner)). Lanes keep that value, so a lane would use the original checkout's \(owner). Use \"{{url.\(target)}}\" instead.")
      }
    }
    for (key, value) in stack.environment { check(value, "env.\(key)", own: nil) }
    for service in stack.services {
      for (key, value) in service.environment { check(value, "services.\(service.id).env.\(key)", own: service.id) }
      check(service.command, "services.\(service.id).cmd", own: service.id)
    }
    for task in stack.tasks {
      for (key, value) in task.environment { check(value, "tasks.\(task.id).env.\(key)", own: nil) }
    }
  }

  static func resolve(_ path: String, relativeTo root: URL) -> URL {
    let expanded = (path as NSString).expandingTildeInPath
    return (expanded.hasPrefix("/") ? URL(fileURLWithPath: expanded) : root.appendingPathComponent(expanded)).standardizedFileURL
  }

  static func validID(_ id: String) -> Bool {
    !id.isEmpty && id.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
  }

  static let template = """
  # A workspace contains services, tasks, and workflows. Nothing starts on save.
  name = "My workspace"
  root = "~"
  restart_on_branch_change = true

  # Use Add project for long-running services.
  # After saving, open Tasks or Workflows to add commands with the visual editors.
  # Advanced examples:
  # [tasks.test]
  # cmd = "npm test"
  # cwd = "Src/my-app"
  # timeout = 600
  # requires_services = ["api"]
  # [workflows.verify]
  # steps = ["start:api", "task:test"]
  # cleanup_services = true
  """
}

nonisolated struct StackDefinitionReader {
  let root: [String: SimpleTOMLValue]
  var issues: [StackDefinitionIssue] = []
  mutating func error(_ text: String) { issues.append(.init(severity: .error, message: text)) }
  mutating func warning(_ text: String) { issues.append(.init(severity: .warning, message: text)) }
  mutating func warnUnknown(_ table: [String: SimpleTOMLValue], allowed: Set<String>, at prefix: String) {
    for key in table.keys.sorted() where !allowed.contains(key) { warning("Unknown key: \(prefix.isEmpty ? key : prefix + "." + key)") }
  }
  mutating func string(_ table: [String: SimpleTOMLValue], _ key: String, at prefix: String = "") -> String? {
    guard let value = table[key] else { return nil }
    guard let string = value.stringValue, !string.contains("\0") else { error("\(prefix).\(key) must be a string without NUL characters"); return nil }
    return string
  }
  mutating func bool(_ table: [String: SimpleTOMLValue], _ key: String, at prefix: String = "") -> Bool? {
    guard let value = table[key] else { return nil }
    guard let bool = value.boolValue else { error("\(prefix).\(key) must be a boolean"); return nil }
    return bool
  }
  mutating func array(_ table: [String: SimpleTOMLValue], _ key: String, at prefix: String) -> [String]? {
    guard let value = table[key] else { return nil }
    guard let array = value.stringArrayValue else { error("\(prefix).\(key) must be an array of strings"); return nil }
    return array
  }
  mutating func table(_ table: [String: SimpleTOMLValue], _ key: String, at prefix: String = "") -> [String: SimpleTOMLValue] {
    guard let value = table[key] else { return [:] }
    guard case .table(let child) = value else { error("\(prefix).\(key) must be a table"); return [:] }
    return child
  }
  mutating func strings(_ parent: [String: SimpleTOMLValue], _ key: String, at prefix: String = "") -> [String: String] {
    let values = table(parent, key, at: prefix)
    var result: [String: String] = [:]
    for name in values.keys.sorted() {
      guard name.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil else {
        error("Invalid environment variable: \(name)"); continue
      }
      result[name] = string(values, name, at: "\(prefix).\(key)")
    }
    return result
  }
  mutating func port(_ table: [String: SimpleTOMLValue], _ key: String, at prefix: String) -> Int? {
    guard let value = table[key] else { return nil }
    guard case .integer(let number) = value, (1...65535).contains(number) else { error("\(prefix).\(key) must be an integer from 1 to 65535"); return nil }
    return number
  }
  /// `ports.<name> = 1234` dotted keys.
  mutating func namedPorts(_ parent: [String: SimpleTOMLValue], at prefix: String) -> [String: Int] {
    var result: [String: Int] = [:]
    let values = table(parent, "ports", at: prefix)
    for name in values.keys.sorted() {
      guard StackDefinitionLoader.validID(name), name != "default" else { error("\(prefix).ports.\(name): use letters, numbers, hyphens or underscores (not \"default\")"); continue }
      if let port = port(values, name, at: "\(prefix).ports") { result[name] = port }
    }
    return result
  }
  mutating func timeout(_ table: [String: SimpleTOMLValue], _ key: String, at prefix: String) -> Double? {
    guard let value = table[key] else { return nil }
    guard let number = value.doubleValue, number.isFinite, number > 0, number <= 3600 else { error("\(prefix).\(key) must be between 0 and 3600 seconds (exclusive of 0)"); return nil }
    return number
  }
  mutating func directory(_ url: URL, label: String) {
    var isDirectory: ObjCBool = false
    if !FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) || !isDirectory.boolValue {
      error("\(label): directory does not exist: \(url.path)")
    }
  }
}
