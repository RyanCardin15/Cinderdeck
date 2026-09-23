//
//  CloudUploadHistoryStore.swift
//  Cinderdeck
//
//  SQLite persistence for cloud upload history records via GRDB
//

import Combine
import Foundation
import GRDB
import os.log

private let logger = Logger(subsystem: "Cinderdeck", category: "CloudUploadHistoryStore")

/// Manages persistent storage of cloud upload records using SQLite via GRDB
@MainActor
final class CloudUploadHistoryStore: ObservableObject {

  static let shared = CloudUploadHistoryStore()

  @Published private(set) var records: [CloudUploadRecord] = []

  private var dbPool: DatabasePool?
  private var cancellable: AnyDatabaseCancellable?

  private init() {
    do {
      dbPool = try DatabaseManager.shared().dbPool
    } catch {
      dbPool = nil
      logger.error("Cloud upload history disabled; database unavailable: \(error.localizedDescription)")
    }
    startObservation()
  }

  // MARK: - Reactive Observation

  /// Observe all records ordered by uploadedAt desc.
  /// Updates `records` automatically whenever the database changes.
  private func startObservation() {
    guard cancellable == nil else { return }
    guard let dbPool = resolveDatabasePool(for: "start observation") else { return }

    let observation = ValueObservation.tracking { db in
      try CloudUploadRecord
        .order(Column("uploadedAt").desc)
        .fetchAll(db)
    }
    cancellable = observation.start(
      in: dbPool,
      scheduling: .immediate,
      onError: { error in
        logger.error("Database observation error: \(error.localizedDescription)")
      },
      onChange: { [weak self] newRecords in
        Task { @MainActor in
          self?.records = newRecords
        }
      }
    )
  }

  // MARK: - Public API

  /// Add a new upload record
  func add(_ record: CloudUploadRecord) {
    guard let dbPool = requireDatabase(for: "add upload record") else { return }

    do {
      try dbPool.write { db in
        try record.insert(db)
      }
      logger.info("Upload record added: \(record.fileName)")
    } catch {
      logger.error("Failed to add upload record: \(error.localizedDescription)")
    }
  }

  /// Remove a record by ID
  func remove(id: UUID) {
    guard let dbPool = requireDatabase(for: "remove upload record") else { return }

    do {
      try dbPool.write { db in
        _ = try CloudUploadRecord.deleteOne(db, id: id)
      }
    } catch {
      logger.error("Failed to remove upload record: \(error.localizedDescription)")
    }
  }

  /// Remove a record by cloud key (used when overwriting replaces the old key)
  func removeByKey(_ key: String) {
    guard let dbPool = requireDatabase(for: "remove upload record by key") else { return }

    do {
      let count = try dbPool.write { db in
        try CloudUploadRecord
          .filter(Column("key") == key)
          .deleteAll(db)
      }
      if count > 0 {
        logger.info("Removed overwritten record for key: \(key)")
      }
    } catch {
      logger.error("Failed to remove record by key: \(error.localizedDescription)")
    }
  }

  /// Remove all records
  func removeAll() {
    guard let dbPool = requireDatabase(for: "remove all upload records") else { return }

    do {
      try dbPool.write { db in
        _ = try CloudUploadRecord.deleteAll(db)
      }
    } catch {
      logger.error("Failed to remove all records: \(error.localizedDescription)")
    }
  }

  /// Most recent N records
  func recentRecords(limit: Int = 5) -> [CloudUploadRecord] {
    Array(records.prefix(limit))
  }

  private func requireDatabase(for operation: String) -> DatabasePool? {
    guard let dbPool = resolveDatabasePool(for: operation) else { return nil }
    startObservation()
    return dbPool
  }

  private func resolveDatabasePool(for operation: String) -> DatabasePool? {
    if let dbPool {
      return dbPool
    }

    do {
      let manager = try DatabaseManager.shared()
      dbPool = manager.dbPool
      return manager.dbPool
    } catch {
      logger.error("Skipped \(operation); database unavailable: \(error.localizedDescription)")
      return nil
    }
  }
}
