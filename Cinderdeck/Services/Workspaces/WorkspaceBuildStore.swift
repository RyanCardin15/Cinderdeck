import CryptoKit
import Foundation

@MainActor
final class WorkspaceBuildStore {
  let directory: URL
  private var receipts: [WorkspaceBuildReceipt] = []
  private var failure: String?
  private var tickets: [String: String] = [:]
  private var ownershipTickets: [String: String] = [:]
  init(directory: URL) {
    self.directory = directory.standardizedFileURL.resolvingSymlinksInPath()
    do {
      if FileManager.default.fileExists(atPath: self.directory.appendingPathComponent("receipts.json").path) {
        let bytes = try WorkspaceBuildArtifactFiles.read(root: self.directory, name: "receipts.json")
        receipts = try StackControlCoding.decoder().decode([WorkspaceBuildReceipt].self, from: bytes)
        guard receipts.count <= 32, receipts.allSatisfy({ UUID(uuidString: $0.id) != nil }) else { throw StackControlError.invalid("Build receipt inventory exceeds its bound") }
        for index in receipts.indices where receipts[index].reservationState != "released" {
          receipts[index].state = "unknown"
          if receipts[index].reservationState != "pending" { receipts[index].reservationState = "uncertain" }
          for key in receipts[index].actionStates.keys where receipts[index].actionStates[key] == "pending" { receipts[index].actionStates[key] = "unknown" }
          receipts[index].detail = "Native execution was interrupted; inspect owned processes before explicit cancellation. No effects are replayed."
        }
        try save()
      }
    } catch { failure = "Build history could not be read: \(error.localizedDescription)" }
  }
  private func check() throws { if let failure { throw StackControlError(code: "build_storage_unavailable", message: failure) } }
  func save() throws {
    try check()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let bytes = try StackControlCoding.encoder().encode(receipts)
    guard bytes.count <= WorkspaceBuildArtifactFiles.maximumBytes else { throw StackControlError(code: "capacity", message: "Build receipt storage is full") }
    let file = directory.appendingPathComponent("receipts.json")
    try bytes.write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
  }
  func get(_ id: String, actor: StackActor, authority: WorkspaceRunAuthority) throws -> WorkspaceBuildReceipt {
    try check()
    guard let receipt = receipts.first(where: { $0.id == id && $0.actorKey == actor.key }), receipt.request.authority == authority else {
      throw StackControlError(code: "build_receipt_missing", message: "This build receipt is unavailable in the selected actor and exact workspace context")
    }
    return receipt
  }
  func get(operationKey: String, actor: StackActor, authority: WorkspaceRunAuthority) throws -> WorkspaceBuildReceipt {
    try check()
    guard let receipt = receipts.first(where: { $0.request.operationKey == operationKey && $0.actorKey == actor.key }) else { throw StackControlError.notFound("The original build operation has no saved receipt") }
    return try get(receipt.id, actor: actor, authority: authority)
  }
  func current(_ id: String) -> WorkspaceBuildReceipt? { receipts.first { $0.id == id } }
  func begin(_ input: WorkspaceBuildPrepareInput, adapter: WorkspaceBuildAdapterDefinition, actor: StackActor) throws -> (WorkspaceBuildReceipt, Bool) {
    try check()
    if let old = receipts.first(where: { $0.request.operationKey == input.operationKey && $0.actorKey == actor.key }) {
      guard old.request == input else { throw StackControlError(code: "operation_conflict", message: "This build operation key already has different immutable inputs") }
      return (old, false)
    }
    try pruneFinished()
    guard receipts.filter({ $0.reservationState != "released" }).count < 16 else { throw StackControlError(code: "capacity", message: "Resolve existing build attempts before preparing more") }
    let id = UUID().uuidString
    let lease = WorkspaceBuildLease(id: "verification:" + id, token: PhysicalCheckoutIdentity.digest(UUID().uuidString + UUID().uuidString))
    var receipt = WorkspaceBuildReceipt(id: id, request: input, adapter: adapter, actorKey: actor.key, actor: actor, lease: lease)
    receipt.actions[input.operationKey] = "prepare"; receipt.actionStates[input.operationKey] = "pending"
    receipts.insert(receipt, at: 0)
    do { try save() } catch { receipts.removeAll { $0.id == id }; throw error }
    return (receipt, true)
  }
  func update(_ id: String, _ change: (inout WorkspaceBuildReceipt) -> Void) throws {
    try check()
    guard let index = receipts.firstIndex(where: { $0.id == id }) else { throw StackControlError.notFound("Build receipt is unavailable") }
    let previous = receipts[index]
    change(&receipts[index]); receipts[index].updatedAt = Date()
    do { try save() } catch { receipts[index] = previous; throw error }
  }
  func action(_ id: String, key: String, kind: String) throws -> Bool {
    guard !key.isEmpty, key.utf8.count <= 160 else { throw StackControlError.invalid("Pass a bounded durable build action key") }
    guard let receipt = current(id) else { throw StackControlError.notFound("Build receipt is unavailable") }
    if let previous = receipt.actions[key] { guard previous == kind else { throw StackControlError(code: "operation_conflict", message: "This build action key already has a different meaning") }; return false }
    let previousPhase = receipt.actions.filter { $0.value == kind }
    let recoveryCancel = kind == "finish:cancel" && !previousPhase.isEmpty && previousPhase.keys.allSatisfy { ["unknown", "failed"].contains(receipt.actionStates[$0] ?? "pending") }
    guard receipt.actions.count < 8, previousPhase.isEmpty || recoveryCancel else { throw StackControlError(code: "operation_conflict", message: "This build phase was already requested; inspect its saved receipt") }
    try update(id) { $0.actions[key] = kind; $0.actionStates[key] = "pending" }
    return true
  }
  func prepareOutput(_ id: String) throws {
    guard UUID(uuidString: id) != nil else { throw StackControlError.invalid("Build output identity is invalid") }
    let folder = directory.appendingPathComponent(id)
    guard !FileManager.default.fileExists(atPath: folder.path) else { throw StackControlError(code: "artifact_stale", message: "Fresh build output already exists; it cannot be reused") }
    try FileManager.default.createDirectory(at: folder.appendingPathComponent("artifacts"), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }
  func output(_ id: String) -> URL { directory.appendingPathComponent(id).appendingPathComponent("artifacts") }
  func artifact(_ receipt: WorkspaceBuildReceipt) -> URL { output(receipt.id).appendingPathComponent(receipt.adapter.artifactName) }
  func readArtifact(_ receipt: WorkspaceBuildReceipt) throws -> Data {
    try WorkspaceBuildArtifactFiles.read(root: directory, name: receipt.id + "/artifacts/" + receipt.adapter.artifactName)
  }
  func writeManifest(_ id: String) throws {
    guard let receipt = current(id) else { throw StackControlError.notFound("Build receipt is unavailable") }
    let file = directory.appendingPathComponent(id).appendingPathComponent("manifest.json")
    try StackControlCoding.encoder().encode(receipt.value).write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
  }
  func arm(_ id: String) throws {
    guard let receipt = current(id), receipt.state == "launching", receipt.launchNonce != nil, receipt.artifact != nil else { throw StackControlError.invalid("Build launch has no saved intent and artifact") }
    tickets[receipt.request.workspaceID + "/" + receipt.request.serviceID] = id
    for service in receipt.launchServices ?? [receipt.request.serviceID] { ownershipTickets[receipt.request.workspaceID + "/" + service] = id }
  }
  func launchOwner(_ definition: StackLaunchDefinition) throws -> WorkspaceBuildReceipt? {
    let key = definition.stack.id + "/" + definition.service.id
    guard let id = ownershipTickets.removeValue(forKey: key), let receipt = current(id) else { return nil }
    guard !isFinishing(id), ["launching", "running"].contains(receipt.state), receipt.request.expectedDefinitionHash == definition.stack.fingerprint else {
      throw StackControlError(code: "build_cancelled", message: "The declared service launch was cancelled or changed")
    }
    return receipt
  }
  func ownedServiceLaunched(_ receipt: WorkspaceBuildReceipt, serviceID: String, process: StackProcessIdentity) throws {
    try update(receipt.id) { $0.ownedLaunchServices = ($0.ownedLaunchServices ?? [:]).merging([serviceID: process]) { old, _ in old } }
  }
  func revokeLaunchTickets(_ id: String) {
    tickets = tickets.filter { $0.value != id }; ownershipTickets = ownershipTickets.filter { $0.value != id }
  }
  func launchContext(_ definition: StackLaunchDefinition) async throws -> WorkspaceBuildReceipt? {
    let key = definition.stack.id + "/" + definition.service.id
    guard let id = tickets.removeValue(forKey: key), let receipt = current(id) else { return nil }
    let root = directory, name = receipt.id + "/artifacts/" + receipt.adapter.artifactName
    let hash = try await Task.detached { WorkspaceBuildArtifactFiles.digest(try WorkspaceBuildArtifactFiles.read(root: root, name: name)) }.value
    try Task.checkCancellation()
    guard !isFinishing(id), current(id)?.state == "launching", receipt.request.expectedDefinitionHash == definition.stack.fingerprint,
      receipt.adapter == definition.service.buildAdapter, let artifact = receipt.artifact, hash == artifact.sha256 else { throw StackControlError(code: "artifact_changed", message: "Prepared build or definition changed before service launch") }
    return receipt
  }
  func launched(_ receipt: WorkspaceBuildReceipt, process: StackProcessIdentity) throws {
    guard let nonce = receipt.launchNonce else { throw StackControlError.invalid("Build launch nonce is unavailable") }
    try update(receipt.id) { $0.launch = .init(process: process, nonceHash: PhysicalCheckoutIdentity.digest(nonce), startedAt: Date()); $0.state = "running"; $0.detail = nil }
    try writeManifest(receipt.id)
  }
  func isFinishing(_ id: String) -> Bool { current(id)?.actions.values.contains(where: { $0 == "finish" || $0 == "finish:cancel" }) == true }
  func retainsRun(_ run: WorkspaceRun) -> Bool {
    receipts.contains { receipt in
      receipt.reservationState != "released" && run.actor.key == receipt.actorKey && run.integrationAuthority == receipt.request.authority
        && (run.integrationOperationID == "build:" + receipt.id || run.integrationOperationID?.hasPrefix("build-check:" + receipt.id + ":") == true)
    }
  }
  func reconcileReservation(_ id: String, reservations: CheckoutReservations) throws -> WorkspaceBuildReceipt {
    guard let receipt = current(id) else { throw StackControlError.notFound("Build receipt is unavailable") }
    let lease = try reservations.existingWriter(receipt.lease.id, actorKey: receipt.actorKey, token: receipt.lease.token)
    let actual = lease?.state ?? (receipt.reservationState == "pending" || receipt.reservationState == "released" ? receipt.reservationState : "uncertain")
    if actual != receipt.reservationState || (actual == "uncertain" && receipt.state != "unknown") {
      try update(id) {
        $0.reservationState = actual
        if actual == "uncertain" { $0.state = "unknown"; $0.detail = "Native lease ownership is uncertain. Inspect and explicitly cancel owned processes before a fresh attempt." }
      }
    }
    return current(id) ?? receipt
  }
  func pruneFinished() throws {
    let terminal = receipts.filter { $0.reservationState == "released" }
    let removed = Set(terminal.dropFirst(16).map(\.id))
    guard !removed.isEmpty else { return }
    receipts.removeAll { removed.contains($0.id) }; try save()
    for id in removed where UUID(uuidString: id) != nil { try? FileManager.default.removeItem(at: directory.appendingPathComponent(id)) }
  }
}
