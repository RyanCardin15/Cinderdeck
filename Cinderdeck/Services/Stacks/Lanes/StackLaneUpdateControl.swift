import Foundation

extension StackControlService {
  func updateLane(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let file = try workspaceFile(params)
    guard file.lane != nil else { throw StackControlError.invalid("Select a lane from list_lanes") }
    guard params["name"] != nil || params["env"] != nil else { throw StackControlError.invalid("Pass name or env to update") }
    try await supervisor.withDefinitionLock(workspace: file.id) {
      try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
      try requireStoppedForDefinition(file.id)
      guard var record = try StackLaneStore.record(id: file.id, in: supervisor.lanesDirectory) else { throw StackControlError.notFound("Lane no longer exists") }
      guard !record.info.pinned else { throw StackControlError(code: "lane", message: "Unpin this lane before editing its settings") }
      if let raw = params["name"] {
        guard let name = raw.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty, name.count <= 100,
          name.rangeOfCharacter(from: .controlCharacters) == nil else { throw StackControlError.invalid("name must contain 1–100 characters without control characters") }
        let others = try StackLaneStore.records(in: supervisor.lanesDirectory)
        guard !others.contains(where: { $0.id != file.id && $0.info.sourceStackID == record.info.sourceStackID && $0.info.name.caseInsensitiveCompare(name) == .orderedSame }) else {
          throw StackControlError.invalid("A lane with this name already exists")
        }
        // Keep identity, Git branches, folders, ports and template slug stable across renames.
        record.info.slug = record.info.effectiveSlug
        record.info.name = name
      }
      if let raw = params["env"] {
        guard let object = raw.objectValue else { throw StackControlError.invalid("env must be an object of string values") }
        var environment: [String: String] = [:]
        for (key, value) in object {
          guard key.range(of: "^[A-Za-z_][A-Za-z0-9_]*$", options: .regularExpression) != nil, let string = value.stringValue else {
            throw StackControlError.invalid("env must map valid variable names to strings")
          }
          environment[key] = string
        }
        record.info.environment = environment
      }
      try StackLaneStore.write(record, in: supervisor.lanesDirectory)
    }
    let refreshed = supervisor.files.first { $0.id == file.id } ?? file
    return .object(["workspace": try JSONValue(encoding: stackSnapshot(refreshed)), "updated": .string(file.id)])
  }
}
