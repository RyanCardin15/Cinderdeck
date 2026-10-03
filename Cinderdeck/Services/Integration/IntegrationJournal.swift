import CryptoKit
import Darwin
import Foundation
import GRDB

nonisolated struct IntegrationResource: Codable, Sendable {
  let workspaceID: String
  let generation: Int
  let available: Bool
  let revision: String
  let workspace: StackSnapshot?
}
nonisolated struct IntegrationEvent: Codable, Sendable {
  let eventID: String
  let sourceID: String
  let revision: String?
  let occurredAt: Date?
  let observedAt: Date?
  let sequence: Int64
  let workspaceID: String
  let generation: Int
  let kind: String
}
nonisolated struct IntegrationSnapshot: Codable, Sendable {
  let installationID: String
  let runtimeEpoch: String
  let cursor: String
  let resources: [IntegrationResource]
  let total: Int
  let nextOffset: Int?
}
nonisolated struct IntegrationEvents: Codable, Sendable {
  let installationID: String
  let runtimeEpoch: String
  let events: [IntegrationEvent]
  let cursor: String
  let resyncRequired: Bool
}
nonisolated struct IntegrationCursor: Codable {
  let installationID: String
  let sequence: Int64
}

/// Persistent resource generations and event replay; independent of the existing service-event tail.
actor IntegrationJournal {
  nonisolated let installationID: String
  nonisolated let runtimeEpoch = UUID().uuidString
  nonisolated let executionHostID: String
  private let pool: DatabasePool
  private let retention: Int
  private var sourceRevision: UInt64 = 0
  private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

  init(directory: URL, retention: Int = 10_000) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let database = directory.appendingPathComponent("integration.sqlite")
    pool = try DatabasePool(path: database.path)
    self.retention = max(1, retention)
    let version = try pool.read { try Int.fetchOne($0, sql: "PRAGMA user_version") ?? 0 }
    guard version <= 2 else { throw StackControlError(code: "store_too_new", message: "The integration store requires a newer Cinderdeck. Restore a compatible application or backup.") }
    try pool.write { db in
      try db.execute(sql: """
        CREATE TABLE IF NOT EXISTS identity (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resources (workspace_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, available INTEGER NOT NULL, hash TEXT NOT NULL, payload BLOB);
        CREATE TABLE IF NOT EXISTS journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL);
        """)
      if version < 2 {
        try db.execute(sql: "ALTER TABLE journal ADD COLUMN revision TEXT")
        try db.execute(sql: "ALTER TABLE journal ADD COLUMN occurred_at TEXT")
        try db.execute(sql: "ALTER TABLE journal ADD COLUMN observed_at TEXT")
      }
      try db.execute(sql: "PRAGMA user_version = 2")
      try db.execute(sql: "INSERT OR IGNORE INTO identity(key, value) VALUES ('installation', ?)", arguments: [UUID().uuidString])
    }
    installationID = try pool.read { try String.fetchOne($0, sql: "SELECT value FROM identity WHERE key = 'installation'")! }
    var host = uuid_t(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    var timeout = timespec(tv_sec: 1, tv_nsec: 0)
    guard gethostuuid(&host, &timeout) == 0 else { throw StackControlError(code: "host_identity_unavailable", message: "Could not verify this execution host.") }
    executionHostID = UUID(uuid: host).uuidString.lowercased()
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: database.path)
  }

  func reconcile(_ workspaces: [StackSnapshot], sourceRevision revision: UInt64) throws {
    guard revision > sourceRevision else { return }
    // Encode before the transaction. A failed encode cannot publish a partly updated projection.
    let prepared = try workspaces.map { workspace -> (String, Data, String) in
      let data = try StackControlCoding.encoder().encode(workspace)
      return (workspace.id, data, SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined())
    }
    let observedAt = ISO8601DateFormatter().string(from: Date())
    let changed = try pool.write { db -> Bool in
      var changed = false
      let old = try Row.fetchAll(db, sql: "SELECT workspace_id, generation, available, hash FROM resources")
      let byID = Dictionary(uniqueKeysWithValues: old.map { row -> (String, Row) in (row["workspace_id"], row) })
      let live = Set(prepared.map { $0.0 })
      for (id, data, hash) in prepared {
        let prior = byID[id]
        let available: Bool = prior?["available"] ?? false
        let previousGeneration: Int = prior?["generation"] ?? 0
        let generation = prior == nil ? 1 : available ? previousGeneration : previousGeneration + 1
        let previousHash: String = prior?["hash"] ?? ""
        if available && previousHash == hash { continue }
        try db.execute(sql: "INSERT INTO resources(workspace_id, generation, available, hash, payload) VALUES (?, ?, 1, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET generation = excluded.generation, available = 1, hash = excluded.hash, payload = excluded.payload", arguments: [id, generation, hash, data])
        try db.execute(sql: "INSERT INTO journal(workspace_id, generation, kind, revision, observed_at) VALUES (?, ?, ?, ?, ?)", arguments: [id, generation, available ? "workspace.updated" : "workspace.available", hash, observedAt])
        changed = true
      }
      for row in old {
        let id: String = row["workspace_id"]
        let available: Bool = row["available"]
        guard available && !live.contains(id) else { continue }
        let generation: Int = row["generation"]
        try db.execute(sql: "UPDATE resources SET available = 0, payload = NULL, hash = '' WHERE workspace_id = ?", arguments: [id])
        try db.execute(sql: "INSERT INTO journal(workspace_id, generation, kind, revision, observed_at) VALUES (?, ?, 'workspace.unavailable', '', ?)", arguments: [id, generation, observedAt])
        changed = true
      }
      try db.execute(sql: "DELETE FROM journal WHERE sequence NOT IN (SELECT sequence FROM journal ORDER BY sequence DESC LIMIT ?)", arguments: [retention])
      return changed
    }
    sourceRevision = revision
    if changed { wakeWaiters() }
  }

  func snapshot(workspaceID: String? = nil, offset: Int = 0, limit: Int = 100) throws -> IntegrationSnapshot {
    guard offset >= 0, (1...500).contains(limit) else { throw StackControlError.invalid("offset must be nonnegative and limit must be 1...500") }
    return try pool.read { db in
      let total = try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM resources WHERE (? IS NULL OR workspace_id = ?)", arguments: [workspaceID, workspaceID]) ?? 0
      let rows = try Row.fetchAll(db, sql: "SELECT * FROM resources WHERE (? IS NULL OR workspace_id = ?) ORDER BY workspace_id LIMIT ? OFFSET ?", arguments: [workspaceID, workspaceID, limit, offset])
      var resources: [IntegrationResource] = []
      var bytes = 0
      for row in rows {
        let payload: Data? = row["payload"]
        let resource = IntegrationResource(workspaceID: row["workspace_id"], generation: row["generation"], available: row["available"], revision: row["hash"], workspace: try payload.map { try StackControlCoding.decoder().decode(StackSnapshot.self, from: $0) })
        let size = try StackControlCoding.encoder().encode(resource).count
        guard size < StackControlSocketServer.maximumFrameBytes - 65_536 else {
          throw StackControlError(code: "resource_too_large", message: "This workspace exceeds the bounded projection frame. Narrow its definition before loading it.")
        }
        if bytes + size > StackControlSocketServer.maximumFrameBytes - 65_536 { break }
        bytes += size
        resources.append(resource)
      }
      let highWater = try latestSequence(db)
      return IntegrationSnapshot(installationID: installationID, runtimeEpoch: runtimeEpoch, cursor: try cursor(highWater), resources: resources, total: total, nextOffset: offset + resources.count < total ? offset + resources.count : nil)
    }
  }

  func events(after rawCursor: String, limit: Int = 100, waitMs: Int = 0) async throws -> IntegrationEvents {
    guard (1...500).contains(limit), (0...25_000).contains(waitMs) else { throw StackControlError.invalid("limit must be 1...500 and waitMs must be 0...25000") }
    let position = try decodeCursor(rawCursor)
    let first = try readEvents(position, limit: limit)
    guard first.events.isEmpty, !first.resyncRequired, waitMs > 0 else { return first }
    guard waiters.count < 64 else { throw StackControlError(code: "busy", message: "Too many integration event subscribers") }
    let id = UUID()
    await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        waiters[id] = continuation
        Task {
          try? await Task.sleep(for: .milliseconds(waitMs))
          expireWaiter(id)
        }
      }
    } onCancel: { Task { await self.expireWaiter(id) } }
    try Task.checkCancellation()
    return try readEvents(position, limit: limit)
  }

  private func readEvents(_ position: IntegrationCursor, limit: Int) throws -> IntegrationEvents {
    try pool.read { db in
      let highWater = try latestSequence(db)
      let earliest = try Int64.fetchOne(db, sql: "SELECT MIN(sequence) FROM journal") ?? highWater + 1
      guard position.installationID == installationID, position.sequence <= highWater, position.sequence >= earliest - 1 else {
        return IntegrationEvents(installationID: installationID, runtimeEpoch: runtimeEpoch, events: [], cursor: try cursor(highWater), resyncRequired: true)
      }
      let rows = try Row.fetchAll(db, sql: "SELECT * FROM journal WHERE sequence > ? ORDER BY sequence LIMIT ?", arguments: [position.sequence, limit])
      let events = rows.map { row -> IntegrationEvent in
        let sequence: Int64 = row["sequence"]
        let occurred: String? = row["occurred_at"]
        let observed: String? = row["observed_at"]
        return IntegrationEvent(eventID: "\(installationID):\(sequence)", sourceID: installationID, revision: row["revision"], occurredAt: occurred.flatMap { ISO8601DateFormatter().date(from: $0) }, observedAt: observed.flatMap { ISO8601DateFormatter().date(from: $0) }, sequence: sequence, workspaceID: row["workspace_id"], generation: row["generation"], kind: row["kind"])
      }
      return IntegrationEvents(installationID: installationID, runtimeEpoch: runtimeEpoch, events: events, cursor: try cursor(events.last?.sequence ?? position.sequence), resyncRequired: false)
    }
  }
  private func latestSequence(_ db: Database) throws -> Int64 {
    try Int64.fetchOne(db, sql: "SELECT seq FROM sqlite_sequence WHERE name = 'journal'") ?? 0
  }
  private func cursor(_ sequence: Int64) throws -> String {
    try StackControlCoding.encoder().encode(IntegrationCursor(installationID: installationID, sequence: sequence)).base64EncodedString()
  }
  private func decodeCursor(_ raw: String) throws -> IntegrationCursor {
    guard raw.utf8.count <= 512, let data = Data(base64Encoded: raw), let value = try? StackControlCoding.decoder().decode(IntegrationCursor.self, from: data), value.sequence >= 0 else {
      throw StackControlError.invalid("Invalid integration cursor")
    }
    return value
  }
  private func expireWaiter(_ id: UUID) { waiters.removeValue(forKey: id)?.resume() }
  private func wakeWaiters() {
    let current = Array(waiters.values)
    waiters.removeAll()
    for waiter in current { waiter.resume() }
  }
}
