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
      reader.warnUnknown(document.root, allowed: ["name", "root", "shell", "restart_on_branch_change", "env", "secrets", "repos", "services"], at: "")
      let root = resolve(reader.string(document.root, "root") ?? file.deletingLastPathComponent().path, relativeTo: file.deletingLastPathComponent())
      let shell = reader.string(document.root, "shell") ?? ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
      var stack = StackDefinition(id: id, name: reader.string(document.root, "name") ?? id, file: file,
        root: root, shell: (shell as NSString).expandingTildeInPath)
      stack.restartOnBranchChange = reader.bool(document.root, "restart_on_branch_change") ?? true
      stack.environment = reader.strings(document.root, "env")
      stack.secrets = reader.strings(document.root, "secrets")
      if validatePaths {
        reader.directory(root, label: "root")
        if !FileManager.default.isExecutableFile(atPath: stack.shell) { reader.error("Shell is not executable: \(stack.shell)") }
      }
      for (repoID, value) in reader.table(document.root, "repos").sorted(by: { $0.key < $1.key }) {
        guard case .table(let table) = value else { reader.error("repos.\(repoID) must be a table"); continue }
        if !validID(repoID) { reader.error("Invalid repo ID: \(repoID)") }
        reader.warnUnknown(table, allowed: ["path"], at: "repos.\(repoID)")
        guard let path = reader.string(table, "path", at: "repos.\(repoID)"), !path.isEmpty else {
          reader.error("repos.\(repoID).path is required"); continue
        }
        let url = resolve(path, relativeTo: root)
        if validatePaths { reader.directory(url, label: "repos.\(repoID).path") }
        stack.repos.append(.init(id: repoID, path: url))
      }
      for (serviceID, value) in reader.table(document.root, "services").sorted(by: { $0.key < $1.key }) {
        let prefix = "services.\(serviceID)"
        guard case .table(let table) = value else { reader.error("\(prefix) must be a table"); continue }
        if !validID(serviceID) { reader.error("Invalid service ID: \(serviceID)") }
        reader.warnUnknown(table, allowed: ["cmd", "repo", "cwd", "depends_on", "port", "ready", "env", "restart", "stop_signal", "stop_timeout", "autostart"], at: prefix)
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
        service.environment = reader.strings(table, "env", at: prefix)
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
        let port = reader.port(ready, "port", at: "\(prefix).ready")
        let http = reader.string(ready, "http", at: "\(prefix).ready")
        let log = reader.string(ready, "log", at: "\(prefix).ready")
        if [port != nil, http != nil, log != nil].filter({ $0 }).count > 1 {
          reader.warning("\(prefix): multiple readiness checks; port, http, log precedence applies")
        }
        if let port { service.readiness = .port(port) }
        else if let http {
          if let url = URL(string: http), ["http", "https"].contains(url.scheme), url.host != nil { service.readiness = .http(url) }
          else { reader.error("\(prefix).ready.http must be an http(s) URL") }
        } else if let log {
          do { _ = try NSRegularExpression(pattern: log); service.readiness = .log(log) }
          catch { reader.error("\(prefix).ready.log is not a valid regular expression") }
        }
        stack.services.append(service)
      }
      if stack.services.isEmpty { reader.error("Define at least one [services.<name>] table") }
      for service in stack.services {
        for dependency in service.dependencies where stack.service(dependency) == nil {
          reader.error("services.\(service.id) depends on unknown service \(dependency)")
        }
      }
      if !reader.issues.contains(where: { $0.severity == .error }) {
        do { _ = try stack.dependencyLayers() } catch { reader.error(error.localizedDescription) }
      }
      result.issues = reader.issues
      if !reader.issues.contains(where: { $0.severity == .error }) { result.definition = stack }
    } catch { result.issues.append(.init(severity: .error, message: error.localizedDescription)) }
    return result
  }

  static func resolve(_ path: String, relativeTo root: URL) -> URL {
    let expanded = (path as NSString).expandingTildeInPath
    return (expanded.hasPrefix("/") ? URL(fileURLWithPath: expanded) : root.appendingPathComponent(expanded)).standardizedFileURL
  }

  static func validID(_ id: String) -> Bool {
    !id.isEmpty && id.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
  }

  static let template = """
  # Save this file; Cinderdeck reloads it automatically. Start is always explicit.
  name = "My stack"
  root = "~"
  restart_on_branch_change = true

  # [repos.app]
  # path = "Src/my-app"

  [services.hello]
  # repo = "app"
  cmd = "echo 'READY — edit this stack to run your services'; sleep 3600"
  ready.log = "READY"
  restart = "no"
  # port = 3000
  # depends_on = ["database"]
  # env.NODE_ENV = "development"
  # autostart = false

  # [secrets]
  # API_KEY = "my-api-key" # Add the value in Settings > History > Manage secrets.
  """
}

nonisolated private struct StackDefinitionReader {
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
