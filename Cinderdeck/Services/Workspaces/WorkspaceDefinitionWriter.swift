import Darwin
import Foundation

/// Changes one named component while preserving unrelated tables and comments.
nonisolated enum WorkspaceDefinitionWriter {
  static func quote(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
      .replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "\\r")
      .replacingOccurrences(of: "\t", with: "\\t") + "\""
  }
  static func array(_ values: [String]) -> String { "[" + values.map(quote).joined(separator: ", ") + "]" }
  static func number(_ value: Double) -> String { value.rounded() == value ? String(Int(value)) : String(value) }

  /// File name for a new workspace: the name folded to letters, numbers, hyphens and underscores.
  static func workspaceID(for name: String) -> String {
    let id = name.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: Locale(identifier: "en_US_POSIX"))
      .replacingOccurrences(of: "[^a-z0-9_-]+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return id.isEmpty ? "workspace-" + UUID().uuidString.prefix(8).lowercased() : id
  }

  /// Writes a new, empty workspace definition. Refuses to replace an existing file.
  @discardableResult
  static func createWorkspace(name: String, root: String, id: String? = nil, directory: URL = StackDefinitionLoader.directory()) throws -> URL {
    let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { throw StackError.message("Enter a workspace name") }
    let id = id ?? workspaceID(for: title)
    guard StackDefinitionLoader.validID(id) else { throw StackError.message("Use letters, numbers, hyphens, or underscores for the workspace ID") }
    let file = directory.appendingPathComponent(id + ".toml")
    guard !FileManager.default.fileExists(atPath: file.path) else { throw StackError.message("A workspace with this name already exists. Choose a different name.") }
    let source = "name = \(quote(title))\nroot = \(quote(root))\n"
    let definition = StackDefinitionLoader.load(source, file: file)
    guard definition.definition != nil else { throw StackError.message(definition.issues.map(\.message).joined(separator: "\n")) }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data(source.utf8).write(to: file, options: .withoutOverwriting)
    return file
  }

  static func repo(id: String, path: URL) -> String { "[repos.\(id)]\npath = \(quote(path.path))" }

  /// Every setting that differs from the loader's defaults. `base` is the folder `cwd` is relative to.
  static func service(_ service: ServiceDefinition, base: URL) -> String {
    // Templates are written as authored, not as rendered for the original checkout.
    let raw = service.raw ?? StackRawValues()
    var lines = ["[services.\(service.id)]", "cmd = \(quote(raw.command ?? service.command))"]
    if let repo = service.repo { lines.append("repo = \(quote(repo))") }
    if service.directory.standardizedFileURL.path != base.standardizedFileURL.path { lines.append("cwd = \(quote(service.directory.path))") }
    if !service.dependencies.isEmpty { lines.append("depends_on = \(array(service.dependencies))") }
    if let port = service.port { lines.append("port = \(port)") }
    for name in service.ports.keys.sorted() { lines.append("ports.\(name) = \(service.ports[name]!)") }
    if let mode = service.laneMode { lines.append("lane = \(quote(mode.rawValue))") }
    if !service.autostart { lines.append("autostart = false") }
    if !service.restartOnFailure { lines.append("restart = \"no\"") }
    if service.stopSignal == SIGINT { lines.append("stop_signal = \"INT\"") }
    if service.stopTimeout != 10 { lines.append("stop_timeout = \(number(service.stopTimeout))") }
    if let name = raw.readyPort { lines.append("ready.port = \(quote(name))") }
    else if let text = raw.readyHTTP { lines.append("ready.http = \(quote(text))") }
    else {
      switch service.readiness {
      case .alive: break
      case .port(let port): lines.append("ready.port = \(port)")
      case .http(let url): lines.append("ready.http = \(quote(url.absoluteString))")
      case .log(let pattern): lines.append("ready.log = \(quote(pattern))")
      }
    }
    if service.readyTimeout != 90 { lines.append("ready.timeout = \(number(service.readyTimeout))") }
    for key in service.environment.keys.sorted() { lines.append("env.\(key) = \(quote(raw.environment[key] ?? service.environment[key]!))") }
    return lines.joined(separator: "\n")
  }
  static func task(_ task: WorkspaceTaskDefinition) -> String {
    let raw = task.raw ?? StackRawValues()
    var lines = ["[tasks.\(task.id)]", "name = \(quote(task.name))", "cmd = \(quote(raw.command ?? task.command))", "cwd = \(quote(task.directory.path))",
      "timeout = \(number(task.timeout))", "requires_services = \(array(task.requiresServices))"]
    if let repo = task.repo { lines.append("repo = \(quote(repo))") }
    if let port = task.port { lines.append("port = \(port)") }
    for name in task.ports.keys.sorted() { lines.append("ports.\(name) = \(task.ports[name]!)") }
    for key in task.environment.keys.sorted() { lines.append("env.\(key) = \(quote(raw.environment[key] ?? task.environment[key]!))") }
    return lines.joined(separator: "\n")
  }
  static func workflow(_ workflow: WorkspaceWorkflowDefinition) -> String {
    "[workflows.\(workflow.id)]\nname = \(quote(workflow.name))\nsteps = \(array(workflow.steps))\ncleanup_services = \(workflow.cleanupServices)"
  }
  /// Removes `section` and its subtables, then appends `replacement` (nothing when empty).
  static func replacing(_ source: String, section: String, with replacement: String) throws -> String {
    // Refuse forms that could leave a stale definition alongside the edited table.
    let document = try SimpleTOMLParser.parse(source, strict: true)
    _ = document
    var result: [String] = []
    var removing = false
    for line in source.components(separatedBy: "\n") {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("["), let close = trimmed.firstIndex(of: "]") {
        let header = trimmed[trimmed.index(after: trimmed.startIndex)..<close].split(separator: ".").map {
          $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }.joined(separator: ".")
        removing = header == section || header.hasPrefix(section + ".")
      }
      if !removing { result.append(line) }
    }
    let kept = result.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    return replacement.isEmpty ? kept + "\n" : kept + "\n\n" + replacement + "\n"
  }
  static func convertService(file: URL, original: String, service: String, taskSection: String, replacement: String) throws {
    do {
      try save(file: file, original: original, changes: [("services." + service, ""), (taskSection, replacement)])
    } catch StackError.message(let message) where !message.hasPrefix("This workspace changed") {
      throw StackError.message("Update references to this service before converting it: " + message)
    }
  }
  static func save(file: URL, original: String, section: String, replacement: String) throws {
    try save(file: file, original: original, changes: [(section, replacement)])
  }
  /// Applies each section change in order, validates the result, and writes it only if the file is unchanged since `original` was read.
  static func save(file: URL, original: String, changes: [(section: String, replacement: String)]) throws {
    guard try String(contentsOf: file, encoding: .utf8) == original else {
      throw StackError.message("This workspace changed in another editor. Close and reopen this form to load those changes.")
    }
    var source = original
    for change in changes { source = try replacing(source, section: change.section, with: change.replacement) }
    let loaded = StackDefinitionLoader.load(source, file: file)
    guard loaded.definition != nil else { throw StackError.message(loaded.issues.map(\.message).joined(separator: "\n")) }
    try source.write(to: file, atomically: true, encoding: .utf8)
  }
}
