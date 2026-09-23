import Foundation

extension StackControlService {
  func handleWorkspace(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let runner = workspaceRunner
    if method == "workspace.list" {
      return .array(try supervisor.files.map { file in
        .object(["id": .string(file.id), "name": .string(file.name),
          "services": .array((file.definition?.services ?? []).map { .string($0.id) }),
          "tasks": .array((file.definition?.tasks ?? []).map { .string($0.id) }),
          "workflows": .array((file.definition?.workflows ?? []).map { .string($0.id) }),
          "issues": .array(file.issues.map { .string($0.message) }),
          "activeRun": try runner.activeRun(file.id).map { try JSONValue(encoding: $0) } ?? .null])
      })
    }
    if method == "workspace.runs" {
      let workspace = params["workspace"]?.stringValue
      return try JSONValue(encoding: runner.runs.filter { workspace == nil || $0.workspaceID == workspace })
    }
    if ["workspace.run.get", "workspace.run.logs", "workspace.run.cancel"].contains(method) {
      guard let raw = params["run"]?.stringValue, let id = UUID(uuidString: raw), let run = runner.run(id) else {
        throw StackControlError.notFound("Unknown run. Pass the run UUID returned when starting a task or workflow.")
      }
      if method == "workspace.run.cancel" {
        try checkClaim(run.workspaceID, actor: actor, force: params["force"]?.boolValue == true)
        try await runner.cancel(id)
      } else if method == "workspace.run.logs" {
        var step: UUID?
        if let raw = params["step"]?.stringValue {
          guard let id = UUID(uuidString: raw), run.steps.contains(where: { $0.id == id }) else { throw StackControlError.notFound("Unknown step") }
          step = id
        }
        let limit = min(max(params["lines"]?.intValue ?? 200, 1), 5000)
        let lines = await runner.output(id, stepID: step)
        return .object(["run": .string(raw), "status": .string(runner.run(id)?.status.rawValue ?? run.status.rawValue),
          "lines": .array(lines.suffix(limit).map { .object(["step": .string($0.service), "text": .string(AnsiParser.plainText($0.text))]) })])
      }
      return try JSONValue(encoding: runner.run(id))
    }
    var query = params.objectValue ?? [:]
    if let workspace = params["workspace"] { query["stack"] = workspace }
    let file = try stackFile(.object(query))
    switch method {
    case "workspace.get":
      return .object(["workspace": try JSONValue(encoding: stackSnapshot(file)),
        "tasks": try JSONValue(encoding: file.definition?.tasks ?? []),
        "workflows": try JSONValue(encoding: file.definition?.workflows ?? []),
        "runs": try JSONValue(encoding: runner.runs.filter { $0.workspaceID == file.id }.prefix(20).map { $0 })])
    case "workspace.task.run", "workspace.workflow.run":
      try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
      let kind: WorkspaceRunKind = method == "workspace.task.run" ? .task : .workflow
      guard let name = params[kind.rawValue]?.stringValue else { throw StackControlError.invalid("Pass the configured \(kind.rawValue) id") }
      await runner.recover()
      return try JSONValue(encoding: runner.submit(workspace: file.id, kind: kind, definitionID: name, actor: actor))
    default: throw StackControlError(code: "unknown_method", message: "Unknown workspace method \(method)")
    }
  }
}
