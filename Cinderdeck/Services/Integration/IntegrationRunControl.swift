import CryptoKit
import Foundation

extension StackControlService {
  func validateRunOperation(_ method: String, _ params: JSONValue) throws {
    let allowed: Set<String>
    switch method {
    case "runs.start":
      allowed = ["workspace", "kind", "definitionID"]
      guard let kind = params["kind"]?.stringValue, WorkspaceRunKind(rawValue: kind) != nil,
        let id = params["definitionID"]?.stringValue, !id.isEmpty, id.utf8.count <= 160 else { throw StackControlError.invalid("Choose a task or workflow") }
    case "runs.cancel", "runs.rerun":
      allowed = ["workspace", "runID"]
      guard let id = params["runID"]?.stringValue, UUID(uuidString: id) != nil else { throw StackControlError.invalid("Choose a run") }
    case "definition.apply":
      allowed = ["workspace", "source", "sourceHash"]
      guard let source = params["source"]?.stringValue, source.utf8.count <= 30_000,
        let hash = params["sourceHash"]?.stringValue, hash.count == 64 else { throw StackControlError.invalid("Pass a bounded definition and its reviewed version") }
    default: throw StackControlError(code: "unsupported_capability", message: "Unsupported run operation")
    }
    guard let object = params.objectValue, Set(object.keys).isSubset(of: allowed) else { throw StackControlError.invalid("Unknown run argument") }
  }
  private func runValue(_ run: WorkspaceRun, actor: StackActor, stepOffset: Int = 0, stepLimit: Int = 16, includeProvenance: Bool = true) -> JSONValue {
    let formatter = ISO8601DateFormatter()
    var value: [String: JSONValue] = [
      "id": .string(run.id.uuidString), "workspaceID": .string(run.workspaceID), "name": .string(run.name),
      "definitionID": .string(run.definitionID), "kind": .string(run.kind.rawValue), "status": .string(run.status.rawValue),
      "actor": .string(run.actor.label), "createdAt": .string(formatter.string(from: run.createdAt)),
      "finishedAt": run.finishedAt.map { .string(formatter.string(from: $0)) } ?? .null,
      "duration": .number(run.duration), "detail": run.detail.map(JSONValue.string) ?? .null,
      "cancelAllowed": .bool(run.status.isActive && (run.actor.key == actor.key || actor.kind == .user)),
      "steps": .array(run.steps.dropFirst(stepOffset).prefix(stepLimit).map { step in
        var value: [String: JSONValue] = [
        "id": .string(step.id.uuidString), "reference": .string(step.reference), "title": .string(step.title),
        "status": .string(step.status.rawValue), "command": step.command.map(JSONValue.string) ?? .null,
        "directory": step.directory.map(JSONValue.string) ?? .null,
        "exitCode": step.exitCode.map { .number(Double($0)) } ?? .null,
        "detail": step.detail.map(JSONValue.string) ?? .null,
        "startedAt": step.startedAt.map { .string(formatter.string(from: $0)) } ?? .null,
        "finishedAt": step.finishedAt.map { .string(formatter.string(from: $0)) } ?? .null,
      ]
        if let hash = step.definitionHash { value["definitionHash"] = .string(hash) }
        if let keys = step.environmentKeys { value["environmentKeys"] = .array(keys.map(JSONValue.string)) }
        if let process = step.executionProcess { value["executionProcess"] = .object(["pid": .number(Double(process.pid)), "pgid": .number(Double(process.pgid)), "startTime": .number(process.startTime)]) }
        if let complete = step.sourceScopeComplete { value["sourceScopeComplete"] = .bool(complete) }
        if let sources = step.repositoriesAtStart { value["repositoriesAtStart"] = .array(sources.map(\.value)) }
        if let sources = step.repositoriesAtEnd { value["repositoriesAtEnd"] = .array(sources.map(\.value)) }
        return .object(value)
      }),
    ]
    if includeProvenance, let provenance = run.sourceProvenance { value["sourceProvenance"] = provenance.value }
    if includeProvenance, let id = run.buildReceiptID { value["buildReceiptID"] = .string(id) }
    if includeProvenance, let observations = run.buildObservations { value["buildObservations"] = .array(observations.map(\.value)) }
    if let id = run.rerunOfID { value["rerunOfID"] = .string(id.uuidString) }
    if let authority = run.integrationAuthority { value["integrationAuthority"] = .object(["installationID": .string(authority.installationID), "workspaceID": .string(authority.workspaceID), "generation": .number(Double(authority.generation))]) }
    if let hash = run.outcomeHash { value["outcomeHash"] = .string(hash) }
    return .object(value)
  }
  func handleIntegrationRuns(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let common: Set<String> = ["installationID", "workspaceID", "generation"]
    let allowed: Set<String>
    switch method {
    case "integration.runs.list", "integration.runs.definition": allowed = common
    case "integration.runs.failures": allowed = common.union(["runIDs"])
    case "integration.runs.get": allowed = common.union(["runID", "stepOffset", "stepLimit"])
    case "integration.runs.logs": allowed = common.union(["runID", "stepID"])
    case "integration.runs.definition.validate": allowed = common.union(["source"])
    default: throw StackControlError(code: "unknown_method", message: "Unsupported run resource")
    }
    guard let object = params.objectValue, Set(object.keys).isSubset(of: allowed),
      let workspace = params["workspaceID"]?.stringValue, workspace.utf8.count <= 160,
      let generation = params["generation"]?.intValue, generation > 0 else { throw StackControlError.invalid("Pass the selected workspace context") }
    let journal = try integrationStore()
    guard params["installationID"]?.stringValue == journal.installationID else { throw StackControlError(code: "installation_changed", message: "Reconnect to the selected installation") }
    let projection = try await journal.snapshot(workspaceID: workspace, offset: 0, limit: 1)
    guard let resource = projection.resources.first, resource.available, resource.generation == generation else { throw StackControlError(code: "stale_binding", message: "The selected workspace changed") }
    let file = try workspaceFile(.object(["workspace": .string(workspace)]))
    if method == "integration.runs.definition" {
      let data = try Data(contentsOf: file.file)
      guard data.count <= 30_000 else { throw StackControlError(code: "definition_too_large", message: "Edit this definition in Cinderdeck") }
      return .object(["source": .string(String(decoding: data, as: UTF8.self)), "sourceHash": .string(Self.runSourceHash(data)), "editable": .bool(file.lane == nil)])
    }
    if method == "integration.runs.definition.validate" {
      guard let source = params["source"]?.stringValue, source.utf8.count <= 30_000 else { throw StackControlError.invalid("Definition is too large") }
      return Self.runDefinitionValidation(source, file: file.file)
    }
    if method == "integration.runs.logs" {
      guard let raw = params["runID"]?.stringValue, let id = UUID(uuidString: raw), let run = workspaceRunner.run(id), run.workspaceID == workspace else { throw StackControlError.notFound("Run is not in the selected workspace") }
      let step = params["stepID"]?.stringValue.flatMap(UUID.init(uuidString:))
      if params["stepID"] != nil && (step == nil || !run.steps.contains(where: { $0.id == step })) { throw StackControlError.notFound("Step is not part of this run") }
      let lines = await workspaceRunner.output(id, stepID: step, limit: 300)
      return .array(lines.map { line in .object(["source": .string(line.service), "text": .string(String(AnsiParser.plainText(line.text).prefix(4000))), "time": .string(ISO8601DateFormatter().string(from: line.timestamp))]) })
    }
    let retained = workspaceRunner.runs.filter { $0.workspaceID == workspace }
    if method == "integration.runs.get" {
      guard let raw = params["runID"]?.stringValue, let id = UUID(uuidString: raw), let run = retained.first(where: { $0.id == id }),
        let offset = params["stepOffset"]?.intValue, offset >= 0, offset <= run.steps.count,
        let limit = params["stepLimit"]?.intValue, (1...16).contains(limit) else { throw StackControlError.notFound("Choose a retained run and a bounded step page") }
      var count = min(limit, run.steps.count - offset)
      while true {
        let result: JSONValue = .object(["run": runValue(run, actor: actor, stepOffset: offset, stepLimit: count),
          "totalSteps": .number(Double(run.steps.count)),
          "nextStepOffset": offset + count < run.steps.count ? .number(Double(offset + count)) : .null])
        if try JSONEncoder().encode(result).count <= 2_000_000 { return result }
        guard count > 1 else { throw StackControlError(code: "resource_too_large", message: "This saved run step exceeds the detail page budget; inspect it in Cinderdeck") }
        count -= 1
      }
    }
    if method == "integration.runs.failures" {
      let authority = WorkspaceRunAuthority(installationID: journal.installationID, workspaceID: workspace, generation: generation)
      var requestedIDs: Set<UUID>?
      if let rawIDs = params["runIDs"] {
        guard let ids = rawIDs.stringsValue, ids.count <= 100, ids.allSatisfy({ UUID(uuidString: $0) != nil }) else { throw StackControlError.invalid("Choose at most 100 exact run IDs") }
        requestedIDs = Set(ids.compactMap(UUID.init(uuidString:)))
      }
      let failures = retained.filter { [.failed, .interrupted].contains($0.status) && ($0.integrationAuthority == nil || $0.integrationAuthority == authority) && (requestedIDs == nil || requestedIDs!.contains($0.id)) }
      let formatter = ISO8601DateFormatter()
      var values: [JSONValue] = [], resolutions: [JSONValue] = [], bytes = 0
      for run in failures.prefix(100) {
        let cause = run.outcomeHash ?? WorkspaceRunOutcome.digest(run)
        let value: JSONValue = .object(["id": .string(run.id.uuidString), "name": .string(run.name), "status": .string(run.status.rawValue),
          "finishedAt": run.finishedAt.map { .string(formatter.string(from: $0)) } ?? .null,
          "detail": run.detail.map(JSONValue.string) ?? .null, "causeVersion": .string(cause)])
        let size = try JSONEncoder().encode(value).count
        if bytes + size <= 1_000_000 { bytes += size; values.append(value) }
        if let successor = retained.first(where: { WorkspaceRunOutcome.resolves($0, failure: run, authority: authority) }), let finishedAt = successor.finishedAt {
          resolutions.append(.object(["runID": .string(run.id.uuidString), "causeVersion": .string(cause),
            "resolvedByRunID": .string(successor.id.uuidString), "observedAt": .string(formatter.string(from: finishedAt))]))
        }
      }
      return .object(["revision": .string(resource.revision), "storageError": workspaceRunner.storageError.map(JSONValue.string) ?? .null,
        "retainedRunCount": .number(Double(retained.count)), "runsTruncated": .bool(values.count < failures.count),
        "runs": .array(values), "resolutions": .array(resolutions)])
    }
    let definition = file.definition
    let snapshot = stackSnapshot(file)
    var overview: [String: JSONValue] = [
      "revision": .string(resource.revision), "storageError": workspaceRunner.storageError.map(JSONValue.string) ?? .null,
      "services": .array(snapshot.services.prefix(128).map { service in
        var value: [String: JSONValue] = [
        "id": .string(service.name), "phase": .string(service.phase), "status": .string(service.status), "ready": .bool(service.ready),
        "detail": service.detail.map(JSONValue.string) ?? .null, "port": service.port.map { .number(Double($0)) } ?? .null,
        "command": service.command.map(JSONValue.string) ?? .null, "directory": service.cwd.map(JSONValue.string) ?? .null,
        "dependencies": .array(service.dependsOn.map(JSONValue.string)), "sharedFrom": service.sharedFrom.map(JSONValue.string) ?? .null,
      ]
        if let adapter = definition?.service(service.name)?.buildAdapter { value["buildAdapter"] = adapter.value(serviceID: service.name) }
        return .object(value)
      }),
      "tasks": .array((definition?.tasks ?? []).prefix(128).map { task in .object([
        "id": .string(task.id), "name": .string(task.name), "command": .string(task.command), "directory": .string(task.directory.path),
        "requiresServices": .array(task.requiresServices.map(JSONValue.string)), "timeout": .number(task.timeout),
      ]) }),
      "workflows": .array((definition?.workflows ?? []).prefix(128).map { workflow in .object([
        "id": .string(workflow.id), "name": .string(workflow.name), "steps": .array(workflow.steps.map(JSONValue.string)), "cleanupServices": .bool(workflow.cleanupServices),
      ]) }),
      "retainedRunCount": .number(Double(retained.count)), "runsTruncated": .bool(retained.count > 100),
      "runs": .array([]), "detailAvailable": .bool(true),
    ]
    var runs: [JSONValue] = []
    for run in retained.prefix(100) {
      runs.append(runValue(run, actor: actor, stepLimit: 0, includeProvenance: false))
      overview["runs"] = .array(runs)
      if try JSONEncoder().encode(JSONValue.object(overview)).count > 2_000_000 { runs.removeLast(); break }
    }
    overview["runs"] = .array(runs)
    overview["runsTruncated"] = .bool(runs.count < retained.count)
    let result = JSONValue.object(overview)
    guard try JSONEncoder().encode(result).count <= 2_000_000 else { throw StackControlError(code: "resource_too_large", message: "The workspace definition exceeds the bounded run overview") }
    return result
  }
  func handleRunOperation(_ method: String, params: JSONValue, actor: StackActor, operationID: String?) async throws -> JSONValue {
    try validateRunOperation(method, params)
    guard let operationID else { throw StackControlError(code: "durable_operation_required", message: "Submit this mutation through the integration operation journal") }
    let file = try workspaceFile(params)

    if method == "definition.apply" {
      guard file.lane == nil else { throw StackControlError(code: "generated_definition", message: "Edit the original workspace definition in Cinderdeck; lane definitions are generated") }
      guard workspaceRunner.activeRun(file.id) == nil, supervisor.states[file.id]?.operation == nil,
        !(supervisor.states[file.id]?.services.values.contains { $0.phase.isActive || $0.process != nil } ?? false) else { throw StackControlError(code: "busy", message: "Stop services and finite runs before editing their definition") }
      let previous = try Data(contentsOf: file.file)
      guard Self.runSourceHash(previous) == params["sourceHash"]?.stringValue else { throw StackControlError(code: "stale_revision", message: "The definition changed since it was reviewed") }
      let source = params["source"]!.stringValue!
      let validation = Self.runDefinitionValidation(source, file: file.file)
      guard validation["valid"]?.boolValue == true else { throw StackControlError(code: "invalid_definition", message: (validation["issues"]?.stringsValue ?? []).joined(separator: "; ")) }
      try Data(source.utf8).write(to: file.file, options: .atomic)
      await supervisor.reloadDefinitions()
      return .object(["saved": .bool(true), "workspaceID": .string(file.id), "sourceHash": .string(Self.runSourceHash(Data(source.utf8)))])
    }
    if ["runs.start", "runs.rerun"].contains(method), let existing = workspaceRunner.runs.first(where: { $0.integrationOperationID == operationID }) {
      guard existing.workspaceID == file.id, existing.actor.key == actor.key else { throw StackControlError(code: "operation_conflict", message: "This operation belongs to a different run") }
      return .object(["run": runValue(existing, actor: actor)])
    }
    let journal = try integrationStore()
    guard let operations = integrationOperations else { throw StackControlError(code: "durable_operation_required", message: "The saved operation intent is unavailable") }
    let intent = try await operations.intent(id: operationID, actor: actor)
    let projection = try await journal.snapshot(workspaceID: file.id, offset: 0, limit: 1)
    guard let resource = projection.resources.first, resource.available, intent.installationID == journal.installationID, intent.workspaceID == file.id, intent.generation == resource.generation, intent.revision == resource.revision else { throw StackControlError(code: "stale_binding", message: "The accepted workspace identity or revision changed") }
    let authority = WorkspaceRunAuthority(installationID: journal.installationID, workspaceID: file.id, generation: resource.generation)

    if method == "runs.start" {
      let run = try workspaceRunner.submit(workspace: file.id, kind: WorkspaceRunKind(rawValue: params["kind"]!.stringValue!)!, definitionID: params["definitionID"]!.stringValue!, actor: actor, integrationOperationID: operationID, integrationAuthority: authority)
      return .object(["run": runValue(run, actor: actor)])
    }
    guard let raw = params["runID"]?.stringValue, let id = UUID(uuidString: raw), let run = workspaceRunner.run(id), run.workspaceID == file.id else { throw StackControlError.notFound("Run is not in this workspace") }
    if method == "runs.cancel" {
      guard actor.kind == .user || run.actor.key == actor.key else { throw StackControlError(code: "not_owner", message: "Only the run owner can cancel it") }
      try await workspaceRunner.cancel(id)
      return .object(["run": runValue(workspaceRunner.run(id) ?? run, actor: actor)])
    }
    guard !run.status.isActive else { throw StackControlError(code: "busy", message: "Wait for this run to stop before rerunning it") }
    return .object(["run": runValue(try workspaceRunner.submit(workspace: file.id, kind: run.kind, definitionID: run.definitionID, actor: actor, integrationOperationID: operationID, rerunOfID: run.id, integrationAuthority: authority), actor: actor)])
  }
  func reconciledRunOperation(_ operationID: String, actor: StackActor) -> JSONValue? {
    guard let run = workspaceRunner.runs.first(where: { $0.integrationOperationID == operationID && $0.actor.key == actor.key }) else { return nil }
    return .object(["run": runValue(run, actor: actor), "reconciliation": .string("This operation's persisted run was inspected; the earlier receipt outcome remains uncertain")])
  }
  nonisolated private static func runSourceHash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
  nonisolated private static func runDefinitionValidation(_ source: String, file: URL) -> JSONValue {
    let parsed = StackDefinitionLoader.load(source, file: file)
    return .object(["valid": .bool(parsed.definition != nil && !parsed.issues.contains { $0.severity == .error }),
      "issues": .array(parsed.issues.map { .string("\($0.severity.rawValue): \($0.message)") })])
  }
}
