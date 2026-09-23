import Foundation

/// Changes one named component while preserving unrelated tables and comments.
nonisolated enum WorkspaceDefinitionWriter {
  static func quote(_ value: String) -> String {
    "\"" + value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
      .replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "\\r")
      .replacingOccurrences(of: "\t", with: "\\t") + "\""
  }
  static func array(_ values: [String]) -> String { "[" + values.map(quote).joined(separator: ", ") + "]" }
  static func task(_ task: WorkspaceTaskDefinition) -> String {
    var lines = ["[tasks.\(task.id)]", "name = \(quote(task.name))", "cmd = \(quote(task.command))", "cwd = \(quote(task.directory.path))",
      "timeout = \(task.timeout)", "requires_services = \(array(task.requiresServices))"]
    if let repo = task.repo { lines.append("repo = \(quote(repo))") }
    for key in task.environment.keys.sorted() { lines.append("env.\(key) = \(quote(task.environment[key]!))") }
    return lines.joined(separator: "\n")
  }
  static func workflow(_ workflow: WorkspaceWorkflowDefinition) -> String {
    "[workflows.\(workflow.id)]\nname = \(quote(workflow.name))\nsteps = \(array(workflow.steps))\ncleanup_services = \(workflow.cleanupServices)"
  }
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
    return result.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines) + "\n\n" + replacement + "\n"
  }
  static func convertService(file: URL, original: String, service: String, taskSection: String, replacement: String) throws {
    let withoutService = try replacing(original, section: "services." + service, with: "")
    let updated = try replacing(withoutService, section: taskSection, with: replacement)
    guard try String(contentsOf: file, encoding: .utf8) == original else { throw StackError.message("This workspace changed. Reopen the form before saving.") }
    let loaded = StackDefinitionLoader.load(updated, file: file)
    guard loaded.definition != nil else {
      throw StackError.message("Update references to this service before converting it: " + loaded.issues.map(\.message).joined(separator: "; "))
    }
    try updated.write(to: file, atomically: true, encoding: .utf8)
  }
  static func save(file: URL, original: String, section: String, replacement: String) throws {
    guard try String(contentsOf: file, encoding: .utf8) == original else {
      throw StackError.message("This workspace changed in another editor. Close and reopen this form to load those changes.")
    }
    let source = try replacing(original, section: section, with: replacement)
    let loaded = StackDefinitionLoader.load(source, file: file)
    guard loaded.definition != nil else { throw StackError.message(loaded.issues.map(\.message).joined(separator: "\n")) }
    try source.write(to: file, atomically: true, encoding: .utf8)
  }
}
