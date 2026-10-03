import CryptoKit
import Foundation
import GRDB

nonisolated struct PhysicalCheckoutIdentity: Equatable, Sendable {
  let root: URL
  let gitDirectory: URL
  let physicalID: String

  /// Resolve standard Git metadata without starting a process or trusting a
  /// caller's identity. The same device/inode key is used by Deckhand.
  static func resolve(_ path: URL) throws -> Self? {
    let fm = FileManager.default
    var root = path.resolvingSymlinksInPath().standardizedFileURL
    var directory: ObjCBool = false
    guard fm.fileExists(atPath: root.path, isDirectory: &directory), directory.boolValue else {
      throw StackControlError(code: "checkout_missing", message: "The checkout directory is missing.")
    }
    for _ in 0..<128 {
      let entry = root.appendingPathComponent(".git")
      if fm.fileExists(atPath: entry.path, isDirectory: &directory) {
        let gitDirectory: URL
        if directory.boolValue { gitDirectory = entry.resolvingSymlinksInPath().standardizedFileURL }
        else {
          let attributes = try fm.attributesOfItem(atPath: entry.path)
          guard ((attributes[.size] as? NSNumber)?.intValue ?? 4097) <= 4096 else {
            throw StackControlError.invalid("Git metadata is too large")
          }
          let value = try String(contentsOf: entry, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
          guard value.hasPrefix("gitdir: "), !value.contains("\n") else {
            throw StackControlError.invalid("Invalid worktree Git metadata")
          }
          let raw = String(value.dropFirst(8))
          gitDirectory = URL(fileURLWithPath: raw, relativeTo: URL(fileURLWithPath: root.path, isDirectory: true)).resolvingSymlinksInPath().standardizedFileURL
        }
        let attributes = try fm.attributesOfItem(atPath: gitDirectory.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
          let device = attributes[.systemNumber] as? NSNumber,
          let inode = attributes[.systemFileNumber] as? NSNumber else {
          throw StackControlError(code: "checkout_missing", message: "Cannot identify this checkout's Git directory.")
        }
        let key = "\(device.uint64Value):\(inode.uint64Value)"
        return .init(root: root, gitDirectory: gitDirectory, physicalID: digest(key))
      }
      let parent = root.deletingLastPathComponent()
      if parent.path == root.path { return nil }
      root = parent
    }
    throw StackControlError.invalid("Checkout nesting exceeds the supported depth")
  }
  func repositoryPhysicalID() throws -> String {
    let fm = FileManager.default
    let entry = gitDirectory.appendingPathComponent("commondir")
    let common: URL
    if fm.fileExists(atPath: entry.path) {
      let attributes = try fm.attributesOfItem(atPath: entry.path)
      guard ((attributes[.size] as? NSNumber)?.intValue ?? 4097) <= 4096 else {
        throw StackControlError.invalid("Git common-directory metadata is too large")
      }
      let value = try String(contentsOf: entry, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !value.isEmpty, !value.contains("\n") else { throw StackControlError.invalid("Invalid Git common-directory metadata") }
      common = URL(fileURLWithPath: value, relativeTo: URL(fileURLWithPath: gitDirectory.path, isDirectory: true)).resolvingSymlinksInPath().standardizedFileURL
    } else { common = gitDirectory }
    let attributes = try fm.attributesOfItem(atPath: common.path)
    guard attributes[.type] as? FileAttributeType == .typeDirectory,
      let device = attributes[.systemNumber] as? NSNumber, let inode = attributes[.systemFileNumber] as? NSNumber else {
      throw StackControlError(code: "checkout_missing", message: "Cannot identify the repository's shared Git directory.")
    }
    return Self.digest("\(device.uint64Value):\(inode.uint64Value)")
  }
  static func digest(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}

nonisolated struct CheckoutReservation: Codable, Sendable, Equatable {
  let id: String
  let ownerID: String
  let workspaceID: String
  let generation: Int?
  let kind: String
  var state: String
  let physicalIDs: [String]
  let createdAt: Date
}

/// One barrier for native runs/Git and external managed writers. No expiration
/// grants ownership; a crash preserves uncertain claims until reconciled.
@MainActor
final class CheckoutReservations {
  private let database: DatabaseQueue
  private let epoch = UUID().uuidString
  init(directory: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let file = directory.appendingPathComponent("checkout-reservations.sqlite")
    database = try DatabaseQueue(path: file.path)
    let version = try database.read { try Int.fetchOne($0, sql: "PRAGMA user_version") ?? 0 }
    guard version <= 1 else {
      throw StackControlError(code: "store_too_new", message: "Checkout reservations require a newer Cinderdeck.")
    }
    try database.write { db in
      try db.execute(sql: """
        CREATE TABLE IF NOT EXISTS reservations (
          id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, token_hash TEXT,
          kind TEXT NOT NULL, state TEXT NOT NULL, epoch TEXT NOT NULL, payload BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS reservation_scope (
          reservation_id TEXT NOT NULL REFERENCES reservations(id), physical_id TEXT NOT NULL,
          PRIMARY KEY(reservation_id, physical_id));
        CREATE INDEX IF NOT EXISTS reservation_scope_identity ON reservation_scope(physical_id, reservation_id);
        PRAGMA user_version = 1;
        """)
      let held = try Row.fetchAll(db, sql: "SELECT id,payload FROM reservations WHERE state = 'held'")
      for row in held {
        var record = try StackControlCoding.decoder().decode(CheckoutReservation.self, from: row["payload"])
        record.state = "uncertain"
        try db.execute(sql: "UPDATE reservations SET state = 'uncertain', payload = ? WHERE id = ?",
          arguments: [try StackControlCoding.encoder().encode(record), record.id])
      }
    }
    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
  }

  func begin(id: String, ownerID: String, workspaceID: String, generation: Int? = nil,
    kind: String, physicalIDs: [String], actorKey: String, token: String? = nil) throws -> CheckoutReservation {
    let scope = Array(Set(physicalIDs)).sorted()
    guard [id, ownerID, workspaceID, actorKey].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 160 }),
      ["writer", "run", "git", "lifecycle"].contains(kind), scope.count <= 64,
      scope.allSatisfy(Self.isToken),
      kind != "writer" || (token.map(Self.isToken) == true && !scope.isEmpty) else {
      throw StackControlError.invalid("A reservation requires bounded identity, scope and writer control token")
    }
    let tokenHash = token.map(PhysicalCheckoutIdentity.digest)
    return try database.write { db in
      if let row = try Row.fetchOne(db, sql: "SELECT owner_key,token_hash,payload FROM reservations WHERE id = ?", arguments: [id]) {
        let saved = try StackControlCoding.decoder().decode(CheckoutReservation.self, from: row["payload"])
        guard row["owner_key"] as String == actorKey, row["token_hash"] as String? == tokenHash,
          saved.ownerID == ownerID, saved.workspaceID == workspaceID, saved.generation == generation,
          saved.kind == kind, saved.physicalIDs == scope else {
          throw StackControlError(code: "reservation_conflict", message: "This reservation identity belongs to a different request.")
        }
        guard saved.state != "released" else {
          throw StackControlError(code: "reservation_released", message: "This reservation was released. Start a new request deliberately.")
        }
        return saved
      }
      guard (try Int.fetchOne(db, sql: "SELECT count(*) FROM reservations WHERE state <> 'released'") ?? 0) < 1000 else {
        throw StackControlError(code: "capacity", message: "Too many unresolved checkout reservations. Resolve existing owners first.")
      }
      if !scope.isEmpty {
        let placeholders = scope.map { _ in "?" }.joined(separator: ",")
        if let row = try Row.fetchOne(db, sql: """
          SELECT r.payload FROM reservations r JOIN reservation_scope s ON s.reservation_id = r.id
          WHERE r.state IN ('held','uncertain') AND s.physical_id IN (\(placeholders)) LIMIT 1
          """, arguments: StatementArguments(scope)) {
          let owner = try StackControlCoding.decoder().decode(CheckoutReservation.self, from: row["payload"])
          throw StackControlError(code: "checkout_reserved", message: "Checkout ownership is \(owner.state) by \(owner.ownerID). Wait for the owning process to stop, or use an isolated lane.")
        }
      }
      let record = CheckoutReservation(id: id, ownerID: ownerID, workspaceID: workspaceID, generation: generation,
        kind: kind, state: "held", physicalIDs: scope, createdAt: Date())
      let payload = try StackControlCoding.encoder().encode(record)
      try db.execute(sql: "INSERT INTO reservations(id,owner_key,token_hash,kind,state,epoch,payload) VALUES (?,?,?,?,?,?,?)",
        arguments: [id, actorKey, tokenHash, kind, "held", epoch, payload])
      for physicalID in scope {
        try db.execute(sql: "INSERT INTO reservation_scope VALUES (?,?)", arguments: [id, physicalID])
      }
      // Return the persisted timestamp precision, including on the first reply.
      return try StackControlCoding.decoder().decode(CheckoutReservation.self, from: payload)
    }
  }
  func get(_ id: String, actorKey: String, token: String) throws -> CheckoutReservation {
    try database.read { db in try authorized(db, id: id, actorKey: actorKey, token: token) }
  }
  func releaseWriter(_ id: String, actorKey: String, token: String) throws -> CheckoutReservation {
    try database.write { db in
      let record = try authorized(db, id: id, actorKey: actorKey, token: token)
      guard record.kind == "writer" else { throw StackControlError.invalid("This is not a writer reservation") }
      return try release(db, record)
    }
  }
  /// Call only after the native process or mutation is confirmed stopped.
  func releaseNative(_ id: String) throws {
    try database.write { db in
      guard let row = try Row.fetchOne(db, sql: "SELECT payload FROM reservations WHERE id = ?", arguments: [id]) else { return }
      let record = try StackControlCoding.decoder().decode(CheckoutReservation.self, from: row["payload"])
      guard record.kind != "writer" else { throw StackControlError.invalid("External writers need their scoped token") }
      _ = try release(db, record)
    }
  }
  func isReserved(physicalIDs: [String]) throws -> Bool {
    let scope = Array(Set(physicalIDs))
    guard !scope.isEmpty, scope.count <= 64 else { throw StackControlError.invalid("Invalid checkout lookup scope") }
    let slots = Array(repeating: "?", count: scope.count).joined(separator: ",")
    return try database.read { db in
      try Bool.fetchOne(db, sql: "SELECT EXISTS (SELECT 1 FROM reservation_scope s JOIN reservations r ON r.id=s.reservation_id WHERE r.state IN ('held','uncertain') AND s.physical_id IN (\(slots)))", arguments: StatementArguments(scope)) ?? false
    }
  }
  func list(offset: Int = 0, limit: Int = 100) throws -> [CheckoutReservation] {
    guard offset >= 0, (1...100).contains(limit) else { throw StackControlError.invalid("Invalid reservation page") }
    return try database.read { db in
      try Row.fetchAll(db, sql: "SELECT payload FROM reservations WHERE state <> 'released' ORDER BY id LIMIT ? OFFSET ?",
        arguments: [limit, offset]).map { try StackControlCoding.decoder().decode(CheckoutReservation.self, from: $0["payload"]) }
    }
  }
  private func authorized(_ db: Database, id: String, actorKey: String, token: String) throws -> CheckoutReservation {
    guard Self.isToken(token), let row = try Row.fetchOne(db, sql: "SELECT owner_key,token_hash,payload FROM reservations WHERE id = ?", arguments: [id]),
      row["owner_key"] as String == actorKey, row["token_hash"] as String? == PhysicalCheckoutIdentity.digest(token) else {
      throw StackControlError(code: "unauthorized_reservation", message: "This reservation requires its owner's scoped control token.")
    }
    return try StackControlCoding.decoder().decode(CheckoutReservation.self, from: row["payload"])
  }
  private static func isToken(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  private func release(_ db: Database, _ original: CheckoutReservation) throws -> CheckoutReservation {
    var record = original; record.state = "released"
    try db.execute(sql: "UPDATE reservations SET state = 'released',payload = ? WHERE id = ?",
      arguments: [try StackControlCoding.encoder().encode(record), record.id])
    try db.execute(sql: "DELETE FROM reservation_scope WHERE reservation_id = ?", arguments: [record.id])
    return record
  }
}
