import Foundation
import GRDB

nonisolated struct StackRunRecord: Codable, FetchableRecord, PersistableRecord, Sendable {
  static let databaseTableName = "stackRunRecord"
  let id: String
  let stackID: String
  let serviceName: String
  let pid: Int32
  let pgid: Int32
  let processStartTime: Double
  let definitionHash: String
  let definitionJSON: String
  let logPath: String
  let startedAt: Date
  var ownerJSON: String?

  var identity: StackProcessIdentity { .init(pid: pid, pgid: pgid, startTime: processStartTime) }
  var definition: StackLaunchDefinition? { try? JSONDecoder().decode(StackLaunchDefinition.self, from: Data(definitionJSON.utf8)) }
  var owner: StackActor? { ownerJSON.flatMap { try? JSONDecoder().decode(StackActor.self, from: Data($0.utf8)) } }

  init(definition: StackLaunchDefinition, process: StackProcessIdentity, logURL: URL, startedAt: Date, owner: StackActor? = nil) throws {
    id = "\(definition.stack.id)/\(definition.service.id)"
    stackID = definition.stack.id; serviceName = definition.service.id
    pid = process.pid; pgid = process.pgid; processStartTime = process.startTime
    definitionHash = definition.stack.fingerprint
    definitionJSON = String(decoding: try JSONEncoder().encode(definition), as: UTF8.self)
    logPath = logURL.path; self.startedAt = startedAt
    ownerJSON = try owner.map { String(decoding: try JSONEncoder().encode($0), as: UTF8.self) }
  }
}

nonisolated struct StackEventRecord: Codable, FetchableRecord, PersistableRecord, Identifiable, Sendable {
  static let databaseTableName = "stackEventRecord"
  var id = UUID().uuidString
  let stackID: String
  var serviceName: String?
  let kind: String
  var detail: String?
  var occurredAt = Date()
  /// Display label of who caused the event, e.g. "Codex in Cursor"; nil for automatic events.
  var actor: String?
}

actor StackRunStore {
  private let pool: DatabasePool
  init(pool: DatabasePool) { self.pool = pool }
  func records() throws -> [StackRunRecord] { try pool.read { try StackRunRecord.fetchAll($0) } }
  func save(_ record: StackRunRecord) throws { try pool.write { try record.save($0) } }
  func delete(stack: String, service: String) throws {
    _ = try pool.write { try StackRunRecord.deleteOne($0, key: "\(stack)/\(service)") }
  }
  func event(_ record: StackEventRecord) throws { try pool.write { try record.insert($0) } }
  func events(stack: String, limit: Int = 40) throws -> [StackEventRecord] {
    try pool.read { try StackEventRecord.fetchAll($0,
      sql: "SELECT * FROM stackEventRecord WHERE stackID = ? ORDER BY occurredAt DESC LIMIT ?", arguments: [stack, max(1, min(limit, 500))]) }
  }
  func pruneEvents() throws {
    try pool.write { try $0.execute(sql: "DELETE FROM stackEventRecord WHERE id NOT IN (SELECT id FROM stackEventRecord ORDER BY occurredAt DESC LIMIT 1000)") }
  }

  nonisolated static func registerMigrations(_ migrator: inout DatabaseMigrator) {
    migrator.registerMigration("custom_v1_createStackRunRecords") { db in
      try db.create(table: "stackRunRecord") { t in
        t.column("id", .text).primaryKey()
        t.column("stackID", .text).notNull().indexed()
        t.column("serviceName", .text).notNull()
        t.column("pid", .integer).notNull()
        t.column("pgid", .integer).notNull()
        t.column("processStartTime", .double).notNull()
        t.column("definitionHash", .text).notNull()
        t.column("definitionJSON", .text).notNull()
        t.column("logPath", .text).notNull()
        t.column("startedAt", .datetime).notNull()
        t.uniqueKey(["stackID", "serviceName"])
      }
    }
    migrator.registerMigration("custom_v2_createStackEventRecords") { db in
      try db.create(table: "stackEventRecord") { t in
        t.column("id", .text).primaryKey()
        t.column("stackID", .text).notNull().indexed()
        t.column("serviceName", .text)
        t.column("kind", .text).notNull()
        t.column("detail", .text)
        t.column("occurredAt", .datetime).notNull().indexed()
      }
    }
    migrator.registerMigration("custom_v3_addStackActors") { db in
      try db.alter(table: "stackRunRecord") { t in t.add(column: "ownerJSON", .text) }
      try db.alter(table: "stackEventRecord") { t in t.add(column: "actor", .text) }
    }
  }
}
