import Foundation

nonisolated struct WorkspaceBuildAdapterDefinition: Codable, Equatable, Sendable {
  let buildTaskID: String; let requiredTaskIDs: [String]; let artifactName: String; let stampPath: String; let servedArtifactPath: String
  func value(serviceID: String) -> JSONValue { .object(["serviceID": .string(serviceID), "buildTaskID": .string(buildTaskID),
    "requiredTaskIDs": .array(requiredTaskIDs.map(JSONValue.string)), "artifactName": .string(artifactName), "stampPath": .string(stampPath), "servedArtifactPath": .string(servedArtifactPath)]) }
}
nonisolated struct WorkspaceBuildExpectedRepository: Codable, Equatable, Sendable {
  let repositoryID: String; let checkoutPhysicalID: String; let repositoryPhysicalID: String; let canonicalRepositoryKeys: [String]; let head: String
}
nonisolated struct WorkspaceBuildPrepareInput: Codable, Equatable, Sendable {
  let installationID: String; let workspaceID: String; let generation: Int; let operationKey: String; let serviceID: String
  let expectedDefinitionHash: String; let expectedWorkflowHash: String; let expectedRepositories: [WorkspaceBuildExpectedRepository]; let requiredTaskIDs: [String]
  var authority: WorkspaceRunAuthority { .init(installationID: installationID, workspaceID: workspaceID, generation: generation) }
}
nonisolated struct WorkspaceBuildLease: Codable, Equatable, Sendable { let id: String; let token: String }
nonisolated struct WorkspaceBuildArtifact: Codable, Equatable, Sendable { let name: String; let sha256: String; let size: Int }
nonisolated struct WorkspaceBuildLaunch: Codable, Equatable, Sendable { let process: StackProcessIdentity; let nonceHash: String; let startedAt: Date }
nonisolated struct WorkspaceBuildCheck: Codable, Equatable, Sendable {
  let taskID: String; let runID: UUID; var status: WorkspaceRunStatus; var finishedAt: Date?; var outcomeHash: String?; var buildMatched: Bool?
  var value: JSONValue { .object(["taskID": .string(taskID), "runID": .string(runID.uuidString), "status": .string(status.rawValue),
    "finishedAt": finishedAt.map { .string(ISO8601DateFormatter().string(from: $0)) } ?? .null, "outcomeHash": outcomeHash.map(JSONValue.string) ?? .null, "buildMatched": .bool(buildMatched == true)]) }
}
nonisolated struct WorkspaceBuildObservation: Codable, Equatable, Sendable {
  let receiptID: String; let workspaceID: String; let serviceID: String; let phase: String
  var serviceURL: String?
  var state = "unknown"; var observedAt = Date(); var artifactSHA256: String?; var servedArtifactSHA256: String?
  var sourceUnchanged = false; var processMatched = false; var stampMatched = false; var detail: String?
  var value: JSONValue {
    var value: [String: JSONValue] = ["receiptID": .string(receiptID), "workspaceID": .string(workspaceID),
      "serviceID": .string(serviceID), "phase": .string(phase), "state": .string(state),
      "observedAt": .string(ISO8601DateFormatter().string(from: observedAt))]
    value["artifactSHA256"] = artifactSHA256.map(JSONValue.string) ?? .null
    value["servedArtifactSHA256"] = servedArtifactSHA256.map(JSONValue.string) ?? .null
    value["sourceUnchanged"] = .bool(sourceUnchanged)
    value["processMatched"] = .bool(processMatched)
    value["stampMatched"] = .bool(stampMatched)
    value["detail"] = detail.map(JSONValue.string) ?? .null
    if let serviceURL { value["serviceURL"] = .string(serviceURL) }
    return .object(value)
  }
}
nonisolated struct WorkspaceBuildReceipt: Codable, Equatable, Sendable {
  let id: String; let request: WorkspaceBuildPrepareInput; let adapter: WorkspaceBuildAdapterDefinition
  let actorKey: String; let actor: StackActor; let lease: WorkspaceBuildLease
  var state = "preparing"; var createdAt = Date(); var updatedAt = Date(); var detail: String?
  var buildRunID: UUID?; var repositoriesAtStart: [WorkspaceRunRepositorySnapshot] = []; var repositoriesAtEnd: [WorkspaceRunRepositorySnapshot] = []
  var launchServices: [String]?; var ownedLaunchServices: [String: StackProcessIdentity]?
  var artifact: WorkspaceBuildArtifact?; var launch: WorkspaceBuildLaunch?; var launchNonce: String?
  var checks: [WorkspaceBuildCheck] = []; var observations: [WorkspaceBuildObservation] = []; var reservationState = "pending"
  var actions: [String: String] = [:]
  var actionStates: [String: String] = [:]
  var value: JSONValue {
    var value: [String: JSONValue] = [:]
    value["id"] = .string(id)
    value["request"] = (try? JSONValue(encoding: request)) ?? .null
    value["adapter"] = adapter.value(serviceID: request.serviceID)
    value["state"] = .string(state)
    value["createdAt"] = .string(ISO8601DateFormatter().string(from: createdAt))
    value["updatedAt"] = .string(ISO8601DateFormatter().string(from: updatedAt))
    value["detail"] = detail.map(JSONValue.string) ?? .null
    value["buildRunID"] = buildRunID.map { .string($0.uuidString) } ?? .null
    value["definitionHash"] = .string(request.expectedDefinitionHash)
    value["workflowHash"] = .string(request.expectedWorkflowHash)
    value["repositoriesAtStart"] = .array(repositoriesAtStart.map(\.value))
    value["repositoriesAtEnd"] = .array(repositoriesAtEnd.map(\.value))
    value["artifact"] = artifact.flatMap { try? JSONValue(encoding: $0) } ?? .null
    value["launch"] = launch.flatMap { try? JSONValue(encoding: $0) } ?? .null
    value["checks"] = .array(checks.map(\.value))
    value["observations"] = .array(observations.map(\.value))
    value["reservationState"] = .string(reservationState)
    let operations: [JSONValue] = actions.keys.sorted().map { key in
      let action = actions[key] == "finish:cancel" ? "finish" : actions[key]!
      return .object(["operationKey": .string(key), "action": .string(action), "state": .string(actionStates[key] ?? "pending")])
    }
    value["operations"] = .array(operations)
    return .object(value)
  }
}

nonisolated struct WorkspaceBuildCaptureProof: Codable, Equatable, Sendable {
  let receiptID: String; let artifactSHA256: String; let launchNonceHash: String
  var start: WorkspaceBuildObservation; var end: WorkspaceBuildObservation?
  var value: JSONValue { .object(["receiptID": .string(receiptID), "artifactSHA256": .string(artifactSHA256), "launchNonceHash": .string(launchNonceHash), "start": start.value, "end": end?.value ?? .null]) }
}
