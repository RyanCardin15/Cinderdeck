import Foundation

extension StackControlService {
  func handleWorkspaceLifecycle(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let file = try workspaceFile(params)
    guard file.lane == nil, file.file.pathExtension.lowercased() == "toml" else {
      throw StackControlError(code: "lane", message: "Edit the source workspace's definition; use update_lane, remove_lane, or release_lane for a lane.")
    }
    if method == "workspace.definition" { return try workspaceSourceResult(file) }
    let deleted = method == "workspace.delete"
    try await supervisor.withDefinitionLock(workspace: file.id) {
      try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
      try requireStoppedForDefinition(file.id)
      let original = try String(contentsOf: file.file, encoding: .utf8)
      if let revision = params["revision"]?.stringValue, revision != WorkspaceDefinitionWriter.revision(original) {
        throw StackControlError(code: "stale_definition", message: "Workspace changed. Read workspace_definition again before saving or removing it.")
      }
      let records = try StackLaneStore.records(in: supervisor.lanesDirectory).filter { $0.info.sourceStackID == file.id }
      if deleted, !records.isEmpty {
        throw StackControlError(code: "in_use", message: "Remove or release this workspace's lanes first: " + records.map { $0.info.reference }.joined(separator: ", "))
      }
      for lane in records {
        try checkClaim(lane.id, actor: actor, force: params["force"]?.boolValue == true)
        try requireStoppedForDefinition(lane.id)
      }
      let replacement: String?
      if deleted { replacement = nil }
      else if let source = params["source"]?.stringValue {
        guard params["revision"]?.stringValue != nil else { throw StackControlError.invalid("Pass revision from workspace_definition when replacing source") }
        guard params["name"] == nil, params["folder"] == nil else { throw StackControlError.invalid("Use source or name/folder, not both") }
        replacement = source
      } else {
        var values: [String: String] = [:]
        if let name = params["name"]?.stringValue {
          let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !name.isEmpty else { throw StackControlError.invalid("name must not be empty") }
          values["name"] = name
        }
        if let folder = params["folder"]?.stringValue {
          let folder = (folder as NSString).expandingTildeInPath
          guard folder.hasPrefix("/") else { throw StackControlError.invalid("folder must be an absolute path or start with ~") }
          values["root"] = folder
        }
        guard !values.isEmpty else { throw StackControlError.invalid("Pass name, folder, or source to save") }
        replacement = try WorkspaceDefinitionWriter.metadata(original, values: values)
      }
      try validateWorkspaceReplacement(file, source: replacement)
      if let replacement {
        try WorkspaceDefinitionWriter.saveSource(file: file.file, original: original, source: replacement)
      } else {
        // Remove only the definition; projects, Git branches, service logs and saved run results stay.
        guard try String(contentsOf: file.file, encoding: .utf8) == original else {
          throw StackControlError(code: "stale_definition", message: "Workspace changed before removal. Read it again.")
        }
        try FileManager.default.removeItem(at: file.file)
        release(stack: file.id)
      }
    }
    if deleted { return .object(["removed": .string(file.id), "file": .string(file.file.path)]) }
    var result = try workspaceDetails(supervisor.files.first { $0.id == file.id } ?? file).objectValue ?? [:]
    result["saved"] = .string(file.id)
    result["revision"] = try workspaceSourceResult(file)["revision"]
    return .object(result)
  }

  private func workspaceSourceResult(_ file: StackDefinitionFile) throws -> JSONValue {
    let source = try String(contentsOf: file.file, encoding: .utf8)
    return .object(["workspace": .string(file.id), "file": .string(file.file.path), "source": .string(source),
      "revision": .string(WorkspaceDefinitionWriter.revision(source))])
  }

  func requireStoppedForDefinition(_ id: String) throws {
    guard !supervisor.isBootstrapping, !supervisor.isRemovingLane(id), supervisor.states[id]?.operation == nil,
      workspaceRunner.activeRun(id) == nil, supervisor.states[id]?.isActive != true else {
      throw StackControlError(code: "busy", message: "Stop services and finish or cancel active runs in \(id) before changing its definition or lane settings.")
    }
  }

  /// Validate the candidate together with all other definitions and lanes before writing. Refuse
  /// new broken references, but don't make an unrelated pre-existing error block a repair.
  private func validateWorkspaceReplacement(_ file: StackDefinitionFile, source: String?) throws {
    let bases = try StackDefinitionLoader.loadDirectory(supervisor.definitionsDirectory)
    let before = StackWorkspaceResolver.resolve(bases + (try StackLaneStore.files(in: supervisor.lanesDirectory, sources: bases)))
    var afterBases = bases.filter { $0.id != file.id }
    if let source {
      let candidate = StackDefinitionLoader.load(source, file: file.file)
      guard candidate.definition != nil else {
        throw StackControlError(code: "invalid_definition", message: candidate.issues.map(\.message).joined(separator: "; "))
      }
      afterBases.append(candidate)
    }
    let after = StackWorkspaceResolver.resolve(afterBases + (try StackLaneStore.files(in: supervisor.lanesDirectory, sources: afterBases)))
    for candidate in after {
      let old = Set(before.first { $0.id == candidate.id }?.issues.filter { $0.severity == .error }.map(\.message) ?? [])
      let errors = candidate.issues.filter { $0.severity == .error && (candidate.id == file.id || !old.contains($0.message)) }
      if !errors.isEmpty {
        throw StackControlError(code: source == nil ? "in_use" : "invalid_definition",
          message: "\(candidate.id): " + errors.map(\.message).joined(separator: "; "))
      }
    }
  }
}
