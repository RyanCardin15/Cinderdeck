import Foundation

extension StackControlService {
  static let workspaceDefinitionMethods: Set<String> = ["workspace.create", "workspace.service.save", "workspace.task.save",
    "workspace.workflow.save", "workspace.item.delete"]

  func handleWorkspace(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    if Self.workspaceDefinitionMethods.contains(method) { return try await handleWorkspaceDefinition(method, params: params, actor: actor) }
    let runner = workspaceRunner
    if method == "workspace.list" {
      // detail: true adds each workspace's service, repo, claim and lane status.
      let detail = params["detail"]?.boolValue == true
      return .array(try supervisor.files.map { file in
        var object: [String: JSONValue] = ["id": .string(file.id), "name": .string(file.name),
          "services": .array((file.definition?.services ?? []).map { .string($0.id) }),
          "tasks": .array((file.definition?.tasks ?? []).map { .string($0.id) }),
          "workflows": .array((file.definition?.workflows ?? []).map { .string($0.id) }),
          "issues": .array(file.issues.map { .string($0.message) }),
          "activeRun": try runner.activeRun(file.id).map { try JSONValue(encoding: $0) } ?? .null]
        if detail { object["status"] = try JSONValue(encoding: stackSnapshot(file)) }
        return .object(object)
      })
    }
    if method == "workspace.runs" {
      // Runs outlive their definitions, so an id that no longer resolves still matches saved runs.
      let workspace = params["workspace"]?.stringValue.map { raw in (try? workspaceFile(params).id) ?? raw }
      var runs = runner.runs.filter { workspace == nil || $0.workspaceID == workspace }
      if let limit = params["limit"]?.intValue { runs = Array(runs.prefix(min(max(limit, 1), 200))) }
      return try JSONValue(encoding: runs)
    }
    if method == "workspace.open" {
      let file = try params["workspace"].map { _ in try workspaceFile(params) }
      var section: WorkspaceSection?
      if let raw = params["section"]?.stringValue, !raw.isEmpty {
        guard let value = WorkspaceSection.allCases.first(where: { $0.rawValue.caseInsensitiveCompare(raw) == .orderedSame }) else {
          throw StackControlError.invalid("section must be one of " + WorkspaceSection.allCases.map { $0.rawValue.lowercased() }.joined(separator: ", "))
        }
        section = value
      }
      WorkspaceWindowController.shared.show(workspace: file?.id, section: section)
      return .object(["opened": .string(file?.id ?? "workspaces"), "section": section.map { .string($0.rawValue.lowercased()) } ?? .null])
    }
    if ["workspace.run.get", "workspace.run.logs", "workspace.run.cancel", "workspace.run.wait"].contains(method) {
      guard let raw = params["run"]?.stringValue, let id = UUID(uuidString: raw), let run = runner.run(id) else {
        throw StackControlError.notFound("Unknown run. Pass the run UUID returned when starting a task or workflow.")
      }
      switch method {
      case "workspace.run.cancel":
        try checkClaim(run.workspaceID, actor: actor, force: params["force"]?.boolValue == true)
        try await runner.cancel(id)
      case "workspace.run.logs":
        var step: UUID?
        if let raw = params["step"]?.stringValue {
          guard let id = UUID(uuidString: raw), run.steps.contains(where: { $0.id == id }) else { throw StackControlError.notFound("Unknown step") }
          step = id
        }
        let limit = min(max(params["lines"]?.intValue ?? 200, 1), 5000)
        let lines = await runner.output(id, stepID: step)
        return .object(["run": .string(raw), "status": .string(runner.run(id)?.status.rawValue ?? run.status.rawValue),
          "lines": .array(lines.suffix(limit).map { .object(["step": .string($0.service), "text": .string(AnsiParser.plainText($0.text))]) })])
      case "workspace.run.wait":
        let timeout = min(max(params["timeout"]?.doubleValue ?? 600, 1), 3600)
        let deadline = Date().addingTimeInterval(timeout)
        while runner.run(id)?.status.isActive == true, Date() < deadline { try? await Task.sleep(nanoseconds: 250_000_000) }
        let current = runner.run(id) ?? run
        var result: [String: JSONValue] = ["run": try JSONValue(encoding: current), "finished": .bool(!current.status.isActive)]
        if current.status.isActive {
          result["note"] = .string("Still \(current.status.rawValue). Waiting again is safe; do not start the run again.")
        } else if current.status != .succeeded {
          // The failing step's last output, so a failure can be diagnosed without another call.
          let failed = current.steps.last { $0.status == .failed || $0.status == .cancelled || $0.status == .interrupted }
          let lines = await runner.output(id, stepID: failed?.id)
          result["lastLines"] = .array(lines.suffix(30).map { .string(AnsiParser.plainText($0.text)) })
        }
        return .object(result)
      default: break
      }
      return try JSONValue(encoding: runner.run(id))
    }
    let file = try workspaceFile(params)
    switch method {
    case "workspace.get":
      return try workspaceDetails(file)
    case "workspace.task.run", "workspace.workflow.run":
      try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
      let kind: WorkspaceRunKind = method == "workspace.task.run" ? .task : .workflow
      guard let name = params[kind.rawValue]?.stringValue else { throw StackControlError.invalid("Pass the configured \(kind.rawValue) id") }
      await runner.recover()
      return try JSONValue(encoding: runner.submit(workspace: file.id, kind: kind, definitionID: name, actor: actor))
    default: throw StackControlError(code: "unknown_method", message: "Unknown workspace method \(method)")
    }
  }

  func workspaceDetails(_ file: StackDefinitionFile) throws -> JSONValue {
    .object(["workspace": try JSONValue(encoding: stackSnapshot(file)),
      "tasks": try JSONValue(encoding: file.definition?.tasks ?? []),
      "workflows": try JSONValue(encoding: file.definition?.workflows ?? []),
      "runs": try JSONValue(encoding: workspaceRunner.runs.filter { $0.workspaceID == file.id }.prefix(20).map { $0 })])
  }
}
