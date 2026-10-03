import Foundation

nonisolated struct IntegrationHelloParameters: Decodable {
  let protocolVersions: [Int]
  let expectedInstallationID: String?
  let expectedExecutionHostID: String?
  let expectedChannel: String?
}
nonisolated struct IntegrationSnapshotParameters: Decodable {
  let workspaceID: String?
  let offset: Int?
  let limit: Int?
  let expectedCursor: String?
}
nonisolated struct IntegrationEventParameters: Decodable {
  let after: String
  let limit: Int?
  let waitMs: Int?
}
nonisolated struct IntegrationHello: Encodable, Sendable {
  let protocolVersion = 1
  let installationID: String
  let executionHostID: String
  let channel: String
  let runtimeEpoch: String
  let capabilities = ["projection.snapshot", "projection.events", "operations.lane.create", "operations.services", "operations.receipts", "checkout.reservations"]
  let maximumFrameBytes = StackControlSocketServer.maximumFrameBytes
  let maximumPageSize = 500
  let maximumWaitMs = 25_000
}

extension StackControlService {
  func integrationStore() throws -> IntegrationJournal {
    if let integrationJournal { return integrationJournal }
    let created = try IntegrationJournal(directory: integrationDirectory)
    integrationJournal = created
    return created
  }
  private func integrationRevision() -> UInt64 {
    integrationProjectionRevision += 1
    return integrationProjectionRevision
  }
  func publishIntegrationProjection() {
    let workspaces = snapshot().workspaces
    let revision = integrationRevision()
    do {
      let store = try integrationStore()
      Task {
        do { try await store.reconcile(workspaces, sourceRevision: revision) }
        catch { DiagnosticLogger.shared.log(.warning, .system, "Integration projection unavailable: \(error.localizedDescription)") }
      }
    } catch { DiagnosticLogger.shared.log(.warning, .system, "Integration store unavailable: \(error.localizedDescription)") }
  }
  func handleIntegration(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    if method.hasPrefix("integration.reservation.") { return try await handleCheckoutReservation(method, params: params, actor: actor) }
    if method == "integration.operation.submit" { return try await submitIntegrationOperation(params, actor: actor) }
    if method == "integration.operation.get" { return try await getIntegrationOperation(params, actor: actor) }
    let allowed: Set<String>
    switch method {
    case "integration.hello": allowed = ["protocolVersions", "expectedInstallationID", "expectedExecutionHostID", "expectedChannel"]
    case "integration.snapshot": allowed = ["workspaceID", "offset", "limit", "expectedCursor"]
    case "integration.events": allowed = ["after", "limit", "waitMs"]
    default: throw StackControlError(code: "unknown_method", message: "Unsupported integration method \(method)")
    }
    guard let object = params.objectValue, Set(object.keys).isSubset(of: allowed) else {
      throw StackControlError.invalid("Unknown integration argument or non-object parameters")
    }
    let store = try integrationStore()
    #if DEBUG
    let channel = "development"
    #else
    let channel = "release"
    #endif
    switch method {
    case "integration.hello":
      let input: IntegrationHelloParameters = try decodeIntegration(params)
      guard !input.protocolVersions.isEmpty, input.protocolVersions.count <= 8, input.protocolVersions.contains(1) else {
        throw StackControlError(code: "unsupported_version", message: "No shared integration protocol version")
      }
      if let expected = input.expectedInstallationID, expected != store.installationID {
        throw StackControlError(code: "installation_changed", message: "The selected Cinderdeck installation has changed. Reconnect deliberately before using its resources.")
      }
      if let expected = input.expectedExecutionHostID, expected != store.executionHostID {
        throw StackControlError(code: "wrong_host", message: "Cinderdeck is running on a different execution host.")
      }
      if let expected = input.expectedChannel, expected != channel {
        throw StackControlError(code: "wrong_channel", message: "Cinderdeck's application channel differs from the selected connection.")
      }
      return try JSONValue(encoding: IntegrationHello(installationID: store.installationID, executionHostID: store.executionHostID, channel: channel, runtimeEpoch: store.runtimeEpoch))
    case "integration.snapshot":
      let input: IntegrationSnapshotParameters = try decodeIntegration(params)
      try await store.reconcile(snapshot().workspaces, sourceRevision: integrationRevision())
      let result = try await store.snapshot(workspaceID: input.workspaceID, offset: input.offset ?? 0, limit: input.limit ?? 100)
      if let expected = input.expectedCursor, expected != result.cursor {
        throw StackControlError(code: "snapshot_changed", message: "The projection changed during pagination. Begin a new snapshot.")
      }
      return try JSONValue(encoding: result)
    default:
      let input: IntegrationEventParameters = try decodeIntegration(params)
      return try await JSONValue(encoding: store.events(after: input.after, limit: input.limit ?? 100, waitMs: input.waitMs ?? 0))
    }
  }
  private func handleCheckoutReservation(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let allowed: Set<String>
    switch method {
    case "integration.reservation.acquire": allowed = ["id", "token", "installationID", "ownerID", "workspaceID", "generation", "revision", "repos"]
    case "integration.reservation.get", "integration.reservation.release": allowed = ["id", "token", "installationID"]
    case "integration.reservation.list": allowed = ["installationID", "offset", "limit"]
    default: throw StackControlError(code: "unknown_method", message: "Unsupported reservation operation")
    }
    guard let object = params.objectValue, Set(object.keys).isSubset(of: allowed),
      let installationID = params["installationID"]?.stringValue,
      installationID == (try integrationStore()).installationID else {
      throw StackControlError(code: "installation_changed", message: "Reservation arguments or installation identity changed.")
    }
    let reservations = try supervisor.checkoutReservations()
    if method == "integration.reservation.list" {
      let input: IntegrationReservationPage = try decodeIntegration(params)
      return try JSONValue(encoding: reservations.list(offset: input.offset ?? 0, limit: input.limit ?? 100))
    }
    guard let id = params["id"]?.stringValue, !id.isEmpty, id.utf8.count <= 160,
      let token = params["token"]?.stringValue, token.count == 64,
      token.allSatisfy({ "0123456789abcdef".contains($0) }) else {
      throw StackControlError.invalid("Reservation identity and scoped control token are required")
    }
    if method == "integration.reservation.get" {
      return try JSONValue(encoding: reservations.get(id, actorKey: actor.key, token: token))
    }
    if method == "integration.reservation.release" {
      return try JSONValue(encoding: reservations.releaseWriter(id, actorKey: actor.key, token: token))
    }
    let input: IntegrationWriterReservationInput = try decodeIntegration(params)
    guard (1...64).contains(input.repos.count), Set(input.repos).count == input.repos.count,
      input.repos.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 160 }),
      input.generation > 0, !input.ownerID.isEmpty, input.ownerID.utf8.count <= 160,
      !input.workspaceID.isEmpty, input.workspaceID.utf8.count <= 160,
      !input.revision.isEmpty, input.revision.utf8.count <= 64 else {
      throw StackControlError.invalid("Writer reservations require exact workspace generation, revision and repository scope")
    }
    let journal = try integrationStore()
    try await journal.reconcile(snapshot().workspaces, sourceRevision: integrationRevision())
    let snapshot = try await journal.snapshot(workspaceID: input.workspaceID, limit: 1)
    guard let resource = snapshot.resources.first, resource.available,
      resource.generation == input.generation, resource.revision == input.revision,
      let file = supervisor.files.first(where: { $0.id == input.workspaceID }), let definition = file.definition else {
      throw StackControlError(code: "stale_revision", message: "The checkout changed. Refresh its context before writer admission.")
    }
    guard !supervisor.isBootstrapping, !supervisor.isRemovingLane(file.id), supervisor.states[file.id]?.operation == nil,
      workspaceRunner.activeRun(file.id) == nil else {
      throw StackControlError(code: "busy", message: "Finish the native run or checkout operation before starting a writer.")
    }
    let repos = definition.repos.filter { input.repos.contains($0.id) }
    guard repos.count == input.repos.count else { throw StackControlError.notFound("A selected repository is no longer in this checkout") }
    let scope = try repos.map { repo -> String in
      guard let identity = try PhysicalCheckoutIdentity.resolve(repo.path) else {
        throw StackControlError(code: "unsupported_checkout", message: "Managed writers need an identifiable Git checkout.")
      }
      return identity.physicalID
    }
    try checkClaim(file.id, actor: actor, force: false)
    // Existing advisory workspace claims must also respect physical aliases.
    for claimed in supervisor.files where claimed.id != file.id && claims[claimed.id]?.isExpired == false {
      let shared = try claimed.definition?.repos.contains { repo in
        try PhysicalCheckoutIdentity.resolve(repo.path).map { scope.contains($0.physicalID) } ?? false
      } ?? false
      if shared { try checkClaim(claimed.id, actor: actor, force: false) }
    }
    // No await between final scope/preflight and durable admission. Native
    // submit/Git use this same transactional barrier on the main actor.
    return try JSONValue(encoding: reservations.begin(id: id, ownerID: input.ownerID, workspaceID: input.workspaceID,
      generation: input.generation, kind: "writer", physicalIDs: scope, actorKey: actor.key, token: token))
  }
  private func operationStore() throws -> IntegrationOperations {
    if let integrationOperations { return integrationOperations }
    let created = try IntegrationOperations(directory: integrationDirectory)
    integrationOperations = created
    return created
  }
  private func validateOperation(_ input: IntegrationOperationInput) throws {
    func bounded(_ value: String, _ maximum: Int) -> Bool {
      !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= maximum
    }
    guard bounded(input.operationKey, 160), bounded(input.installationID, 160), bounded(input.workspaceID, 160),
      input.generation > 0, bounded(input.revision, 64), try StackControlCoding.encoder().encode(input.arguments).count <= 32_768,
      let arguments = input.arguments.objectValue, arguments["workspace"]?.stringValue == input.workspaceID else {
      throw StackControlError.invalid("Operations require a bounded key, exact workspace identity, generation, revision and arguments")
    }
    let allowed: Set<String>
    if input.method == "lane.create" {
      allowed = ["workspace", "branch", "from", "start", "setup"]
      let decoded: IntegrationLaneOperation = try decodeIntegration(input.arguments)
      guard bounded(decoded.branch, 200), decoded.from.map({ bounded($0, 200) }) ?? true else { throw StackControlError.invalid("Invalid lane branch or source") }
    } else if ["services.start", "services.stop", "services.restart"].contains(input.method) {
      allowed = ["workspace", "services", "force", "wait", "timeout"]
      let decoded: IntegrationServiceOperation = try decodeIntegration(input.arguments)
      guard decoded.services.map({ $0.count <= 100 && $0.allSatisfy({ bounded($0, 160) }) }) ?? true,
        decoded.timeout.map({ $0.isFinite && (0...120).contains($0) }) ?? true else { throw StackControlError.invalid("Invalid service selection or timeout") }
    } else { throw StackControlError(code: "unsupported_capability", message: "This mutation is not yet supported by durable integration operations") }
    guard Set(arguments.keys).isSubset(of: allowed) else { throw StackControlError.invalid("Unknown mutation argument") }
  }
  private func submitIntegrationOperation(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let allowed: Set<String> = ["operationKey", "installationID", "workspaceID", "generation", "revision", "method", "arguments"]
    guard let object = params.objectValue, Set(object.keys).isSubset(of: allowed) else { throw StackControlError.invalid("Unknown operation argument") }
    let input: IntegrationOperationInput = try decodeIntegration(params)
    try validateOperation(input)
    let journal = try integrationStore()
    guard input.installationID == journal.installationID else { throw StackControlError(code: "installation_changed", message: "Reconnect to the selected installation before changing its resources") }
    let operations = try operationStore()
    if let receipt = try await operations.existing(input, actor: actor) { return try JSONValue(encoding: receipt) }
    try await journal.reconcile(snapshot().workspaces, sourceRevision: integrationRevision())
    let projection = try await journal.snapshot(workspaceID: input.workspaceID, limit: 1)
    guard let resource = projection.resources.first, resource.available else { throw StackControlError(code: "resource_missing", message: "This workspace is no longer available") }
    guard resource.generation == input.generation, resource.revision == input.revision else { throw StackControlError(code: "stale_revision", message: "The workspace changed. Refresh and review the operation before submitting it") }
    let (receipt, created) = try await operations.begin(input, actor: actor)
    if created {
      Task { [weak self] in
        guard let self else { return }
        var effectsStarted = false
        var resultReturned = false
        do {
          _ = try await operations.transition(key: input.operationKey, actor: actor, state: "running")
          effectsStarted = true
          let result = try await self.handle(input.method, params: input.arguments, actor: actor, operationID: receipt.id)
          resultReturned = true
          _ = try await operations.transition(key: input.operationKey, actor: actor, state: "succeeded", result: result)
        } catch {
          let failure = (error as? StackControlError) ?? StackControlError(code: "failed", message: error.localizedDescription)
          let refusedBeforeEffects: Set<String> = ["invalid_params", "not_found", "claimed", "busy", "stale_revision", "resource_missing", "unsupported_capability"]
          let state = effectsStarted && (resultReturned || !refusedBeforeEffects.contains(failure.code)) ? "unknown_outcome" : "failed"
          do { _ = try await operations.transition(key: input.operationKey, actor: actor, state: state, error: failure) }
          catch { DiagnosticLogger.shared.log(.warning, .system, "Integration operation outcome could not be saved") }
        }
      }
    }
    return try JSONValue(encoding: receipt)
  }
  private func getIntegrationOperation(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    guard let object = params.objectValue, Set(object.keys).isSubset(of: ["operationKey", "installationID"]),
      let key = object["operationKey"]?.stringValue, !key.isEmpty, key.utf8.count <= 160,
      object["installationID"]?.stringValue == (try integrationStore()).installationID else { throw StackControlError.invalid("A bounded operation key and selected installation are required") }
    let operations = try operationStore()
    var receipt = try await operations.get(key: key, actor: actor)
    if receipt.state == "unknown_outcome", receipt.method == "lane.create" {
      let records = try StackLaneStore.records(in: supervisor.lanesDirectory)
      if let lane = records.first(where: { $0.integrationOperationID == receipt.id }) {
        receipt = try await operations.transition(key: key, actor: actor, state: "unknown_outcome", result: .object([
          "createdWorkspaceID": .string(lane.id), "creationReady": .bool(lane.ready == true),
          "setup": (try? JSONValue(encoding: lane.setup)) ?? .null,
          "reconciliation": .string("Lane manifest inspected; this operation will not be repeated"),
        ]), error: receipt.error)
      }
    } else if receipt.state == "unknown_outcome", receipt.method.hasPrefix("services."),
      let file = supervisor.files.first(where: { $0.id == receipt.workspaceID }) {
      receipt = try await operations.transition(key: key, actor: actor, state: "unknown_outcome", result: .object([
        "workspace": try JSONValue(encoding: stackSnapshot(file)),
        "reconciliation": .string("Current services inspected; earlier process effects remain uncertain"),
      ]), error: receipt.error)
    }
    return try JSONValue(encoding: receipt)
  }
  private func decodeIntegration<T: Decodable>(_ value: JSONValue) throws -> T {
    do { return try value.decode(T.self) }
    catch { throw StackControlError.invalid("Integration argument types do not match the protocol") }
  }
}
nonisolated private struct IntegrationWriterReservationInput: Decodable {
  let id: String
  let token: String
  let installationID: String
  let ownerID: String
  let workspaceID: String
  let generation: Int
  let revision: String
  let repos: [String]
}
nonisolated private struct IntegrationReservationPage: Decodable {
  let installationID: String
  let offset: Int?
  let limit: Int?
}

nonisolated private struct IntegrationLaneOperation: Decodable {
  let workspace: String
  let branch: String
  let from: String?
  let start: Bool?
  let setup: Bool?
}
nonisolated private struct IntegrationServiceOperation: Decodable {
  let workspace: String
  let services: [String]?
  let force: Bool?
  let wait: Bool?
  let timeout: Double?
}
