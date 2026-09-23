import Foundation

extension StackDefinitionLoader {
  nonisolated static func readWorkspaceComponents(_ root: [String: SimpleTOMLValue], into workspace: inout StackDefinition,
    reader: inout StackDefinitionReader, validatePaths: Bool) {
    for (id, value) in reader.table(root, "tasks").sorted(by: { $0.key < $1.key }) {
      let prefix = "tasks.\(id)"
      guard case .table(let table) = value else { reader.error("\(prefix) must be a table"); continue }
      if !validID(id) { reader.error("Invalid task ID: \(id)") }
      reader.warnUnknown(table, allowed: ["name", "cmd", "repo", "cwd", "env", "requires_services", "timeout"], at: prefix)
      guard let command = reader.string(table, "cmd", at: prefix), !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        reader.error("\(prefix).cmd is required"); continue
      }
      let repo = reader.string(table, "repo", at: prefix)
      if let repo, workspace.repo(repo) == nil { reader.error("\(prefix).repo refers to unknown repo \(repo)") }
      let base = repo.flatMap { workspace.repo($0)?.path } ?? workspace.root
      let directory = reader.string(table, "cwd", at: prefix).map { resolve($0, relativeTo: base) } ?? base
      if validatePaths { reader.directory(directory, label: "\(prefix).cwd") }
      let required = reader.array(table, "requires_services", at: prefix) ?? []
      for service in required where workspace.service(service) == nil { reader.error("\(prefix) requires unknown service \(service)") }
      workspace.tasks.append(.init(id: id, name: reader.string(table, "name", at: prefix) ?? id,
        command: command, repo: repo, directory: directory,
        environment: reader.strings(table, "env", at: prefix), requiresServices: required,
        timeout: reader.timeout(table, "timeout", at: prefix) ?? 600))
    }
    for (id, value) in reader.table(root, "workflows").sorted(by: { $0.key < $1.key }) {
      let prefix = "workflows.\(id)"
      guard case .table(let table) = value else { reader.error("\(prefix) must be a table"); continue }
      if !validID(id) { reader.error("Invalid workflow ID: \(id)") }
      reader.warnUnknown(table, allowed: ["name", "steps", "cleanup_services"], at: prefix)
      let steps = reader.array(table, "steps", at: prefix) ?? []
      if steps.isEmpty { reader.error("\(prefix).steps must contain at least one step") }
      if steps.count > 100 { reader.error("\(prefix) may contain at most 100 steps") }
      for step in steps {
        let parts = step.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2 else { reader.error("\(prefix): use task:name, start:service, or stop:service (\(step))"); continue }
        switch parts[0] {
        case "task": if workspace.task(parts[1]) == nil { reader.error("\(prefix) refers to unknown task \(parts[1])") }
        case "start", "stop": if workspace.service(parts[1]) == nil { reader.error("\(prefix) refers to unknown service \(parts[1])") }
        default: reader.error("\(prefix): unsupported step \(step); use task:, start:, or stop:")
        }
      }
      workspace.workflows.append(.init(id: id, name: reader.string(table, "name", at: prefix) ?? id,
        steps: steps, cleanupServices: reader.bool(table, "cleanup_services", at: prefix) ?? false))
    }
  }
}
