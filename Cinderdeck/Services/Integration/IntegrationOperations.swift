import CryptoKit
import Foundation
import GRDB

nonisolated struct IntegrationOperationInput: Codable, Sendable {
  let operationKey: String
  let installationID: String
  let workspaceID: String
  let generation: Int
  let revision: String
  let method: String
  let arguments: JSONValue
}
nonisolated struct IntegrationOperationReceipt: Codable, Sendable {
  let id: String
  let operationKey: String
  let argumentHash: String
  let workspaceID: String
  let generation: Int
  let method: String
  var state: String
  let createdAt: Date
  var updatedAt: Date
  var result: JSONValue?
  var error: StackControlError?
}

/// Intent is committed before a mutation starts. A previous launch's unfinished work
/// remains uncertain until its concrete resources are inspected; it is never relaunched.
actor IntegrationOperations {
  private let pool: DatabasePool
  private let epoch = UUID().uuidString
  private struct Waiter {
    let actor: StackActor
    let continuation: CheckedContinuation<IntegrationOperationReceipt, Error>
    let timeout: Task<Void, Never>
  }
  private var waiters: [String: [UUID: Waiter]] = [:]

  init(directory: URL) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let path = directory.appendingPathComponent("operations.sqlite").path
    pool = try DatabasePool(path: path)
    let version = try pool.read { try Int.fetchOne($0, sql: "PRAGMA user_version") ?? 0 }
    guard version <= 1 else { throw StackControlError(code: "store_too_new", message: "The operations store requires a newer Cinderdeck.") }
    try pool.write { db in
      try db.execute(sql: """
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY, operation_key TEXT NOT NULL UNIQUE, argument_hash TEXT NOT NULL,
          actor_key TEXT NOT NULL, epoch TEXT NOT NULL, input BLOB NOT NULL, receipt BLOB NOT NULL
        );
        PRAGMA user_version = 1;
        """)
      let old = try Row.fetchAll(db, sql: "SELECT id, receipt FROM operations")
      for row in old {
        var receipt = try StackControlCoding.decoder().decode(IntegrationOperationReceipt.self, from: row["receipt"])
        guard ["pending", "running"].contains(receipt.state) else { continue }
        receipt.state = "unknown_outcome"
        receipt.updatedAt = Date()
        receipt.error = .init(code: "unknown_outcome", message: "Cinderdeck restarted before this operation's outcome was saved. Inspect its created resources before starting new work.")
        try db.execute(sql: "UPDATE operations SET receipt = ? WHERE id = ?", arguments: [try StackControlCoding.encoder().encode(receipt), receipt.id])
      }
    }
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
  }
  static func hash(_ input: IntegrationOperationInput) throws -> String {
    SHA256.hash(data: try StackControlCoding.encoder().encode(input)).map { String(format: "%02x", $0) }.joined()
  }
  func existing(_ input: IntegrationOperationInput, actor: StackActor) throws -> IntegrationOperationReceipt? {
    let hash = try Self.hash(input)
    return try pool.read { db in
      guard let row = try Row.fetchOne(db, sql: "SELECT * FROM operations WHERE operation_key = ?", arguments: [input.operationKey]) else { return nil }
      let owner: String = row["actor_key"]
      guard owner == actor.key || actor.kind == .user else { throw StackControlError(code: "unauthorized_operation", message: "This operation belongs to a different actor.") }
      let original: String = row["argument_hash"]
      guard original == hash else { throw StackControlError(code: "operation_conflict", message: "This operation key was already used with different arguments. Retrieve its original receipt.") }
      return try StackControlCoding.decoder().decode(IntegrationOperationReceipt.self, from: row["receipt"])
    }
  }
  func begin(_ input: IntegrationOperationInput, actor: StackActor) throws -> (IntegrationOperationReceipt, Bool) {
    if let existing = try existing(input, actor: actor) { return (existing, false) }
    let now = Date()
    let receipt = IntegrationOperationReceipt(id: UUID().uuidString, operationKey: input.operationKey,
      argumentHash: try Self.hash(input), workspaceID: input.workspaceID, generation: input.generation,
      method: input.method, state: "pending", createdAt: now, updatedAt: now)
    try pool.write { db in
      try db.execute(sql: "INSERT INTO operations VALUES (?, ?, ?, ?, ?, ?, ?)", arguments: [receipt.id, input.operationKey, receipt.argumentHash, actor.key, epoch, try StackControlCoding.encoder().encode(input), try StackControlCoding.encoder().encode(receipt)])
    }
    return (receipt, true)
  }
  func get(key: String, actor: StackActor) throws -> IntegrationOperationReceipt {
    try pool.read { db in
      guard let row = try Row.fetchOne(db, sql: "SELECT * FROM operations WHERE operation_key = ?", arguments: [key]) else { throw StackControlError.notFound("Operation receipt is unavailable") }
      let owner: String = row["actor_key"]
      guard owner == actor.key || actor.kind == .user else { throw StackControlError(code: "unauthorized_operation", message: "This operation belongs to a different actor.") }
      return try StackControlCoding.decoder().decode(IntegrationOperationReceipt.self, from: row["receipt"])
    }
  }
  /// Recover the authenticated immutable accepted scope before native run admission.
  func intent(id: String, actor: StackActor) throws -> IntegrationOperationInput {
    try pool.read { db in
      guard let row = try Row.fetchOne(db, sql: "SELECT * FROM operations WHERE id = ?", arguments: [id]) else { throw StackControlError.notFound("Operation intent is unavailable") }
      let owner: String = row["actor_key"]
      guard owner == actor.key || actor.kind == .user else { throw StackControlError(code: "unauthorized_operation", message: "This operation belongs to a different actor.") }
      return try StackControlCoding.decoder().decode(IntegrationOperationInput.self, from: row["input"])
    }
  }
  /// Observe a committed terminal receipt without polling or granting mutation authority.
  func wait(key: String, actor: StackActor, waitMs: Int) async throws -> IntegrationOperationReceipt {
    guard (0...25_000).contains(waitMs) else { throw StackControlError.invalid("Receipt wait must be between 0 and 25000 milliseconds") }
    let token = UUID()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        do {
          let receipt = try get(key: key, actor: actor)
          guard !Task.isCancelled else { throw CancellationError() }
          guard waitMs > 0, ["pending", "running"].contains(receipt.state) else {
            continuation.resume(returning: receipt); return
          }
          let all = waiters.values.flatMap { $0.values }
          guard all.count < 128, all.filter({ $0.actor.key == actor.key }).count < 8 else {
            throw StackControlError(code: "busy", message: "Too many operation receipt waits; finish an existing wait before opening another.")
          }
          let timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(waitMs) * 1_000_000) }
            catch { return }
            await self?.finishWait(key: key, token: token)
          }
          waiters[key, default: [:]][token] = Waiter(actor: actor, continuation: continuation, timeout: timeout)
        } catch { continuation.resume(throwing: error) }
      }
    } onCancel: {
      Task { await self.cancelWait(key: key, token: token) }
    }
  }
  private func takeWaiter(key: String, token: UUID) -> Waiter? {
    let waiter = waiters[key]?.removeValue(forKey: token)
    if waiters[key]?.isEmpty == true { waiters.removeValue(forKey: key) }
    return waiter
  }
  private func finishWait(key: String, token: UUID) {
    guard let waiter = takeWaiter(key: key, token: token) else { return }
    do { waiter.continuation.resume(returning: try get(key: key, actor: waiter.actor)) }
    catch { waiter.continuation.resume(throwing: error) }
  }
  private func cancelWait(key: String, token: UUID) {
    guard let waiter = takeWaiter(key: key, token: token) else { return }
    waiter.timeout.cancel()
    waiter.continuation.resume(throwing: CancellationError())
  }
  // Internal observation used by focused tests; an active wait never owns effects.
  var activeWaitCount: Int { waiters.values.reduce(0) { $0 + $1.count } }
  func transition(key: String, actor: StackActor, state: String, result: JSONValue? = nil, error: StackControlError? = nil) throws -> IntegrationOperationReceipt {
    var receipt = try get(key: key, actor: actor)
    let allowed: [String: Set<String>] = ["pending": ["running"], "running": ["succeeded", "failed", "unknown_outcome"], "unknown_outcome": ["unknown_outcome"]]
    let incompleteCleanup = receipt.state == "unknown_outcome" && state == "failed"
      && ["lane.remove", "lane.release"].contains(receipt.method) && result?["resourceAvailable"]?.boolValue == true
    guard allowed[receipt.state]?.contains(state) == true || incompleteCleanup else { throw StackControlError(code: "operation_state_changed", message: "This operation's outcome is already terminal.") }
    if let result, try StackControlCoding.encoder().encode(result).count > 3 * 1024 * 1024 {
      throw StackControlError(code: "result_too_large", message: "The operation result exceeds its bounded receipt.")
    }
    receipt.state = state; receipt.result = result; receipt.error = error; receipt.updatedAt = Date()
    try pool.write { db in
      try db.execute(sql: "UPDATE operations SET receipt = ? WHERE operation_key = ?", arguments: [try StackControlCoding.encoder().encode(receipt), key])
    }
    if !["pending", "running"].contains(state), let completed = waiters.removeValue(forKey: key) {
      for waiter in completed.values {
        waiter.timeout.cancel()
        waiter.continuation.resume(returning: receipt)
      }
    }
    return receipt
  }
}
