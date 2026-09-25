//
//  HistoryCollectionStore.swift
//  Cinderdeck
//
//  Favorites and user groups for captures and clipboard text
//

import Combine
import Foundation
import GRDB
import os.log

private let logger = Logger(subsystem: "Cinderdeck", category: "HistoryCollectionStore")

/// A capture or a clipboard text entry that can be saved to Favorites or a group.
nonisolated enum SavedHistoryItem: Hashable, Sendable {
  case capture(UUID)
  case clipboardText(UUID)
}

/// Favorites, or a group the user named. Favorites always exists and cannot be renamed or deleted.
nonisolated struct HistoryCollection: Identifiable, Codable, Equatable, FetchableRecord, PersistableRecord, Sendable {
  static let favoritesID = UUID(uuidString: "00000000-0000-0000-0000-0000000FA7E5")!

  let id: UUID
  var name: String
  let createdAt: Date

  var isFavorites: Bool { id == Self.favoritesID }
  var systemIconName: String { isFavorites ? "star.fill" : "folder" }
}

/// Membership of one capture or clipboard text entry in a collection. Rows cascade away with
/// their collection or item, and saved items are skipped by history retention.
nonisolated struct HistoryCollectionItem: Codable, Equatable, FetchableRecord, PersistableRecord, Sendable {
  let collectionId: UUID
  let captureId: UUID?
  let clipboardTextId: UUID?
  let addedAt: Date

  init(collectionId: UUID, item: SavedHistoryItem, addedAt: Date) {
    self.collectionId = collectionId
    self.addedAt = addedAt
    switch item {
    case let .capture(id):
      captureId = id
      clipboardTextId = nil
    case let .clipboardText(id):
      captureId = nil
      clipboardTextId = id
    }
  }

  var item: SavedHistoryItem? {
    if let captureId { return .capture(captureId) }
    if let clipboardTextId { return .clipboardText(clipboardTextId) }
    return nil
  }

  /// Subqueries for retention: rows in these sets are kept past age and count limits.
  static let savedCaptureIDsSQL =
    "SELECT captureId FROM historyCollectionItem WHERE captureId IS NOT NULL"
  static let savedClipboardTextIDsSQL =
    "SELECT clipboardTextId FROM historyCollectionItem WHERE clipboardTextId IS NOT NULL"

  static func registerMigrations(_ migrator: inout DatabaseMigrator) {
    migrator.registerMigration("v4_createHistoryCollections") { db in
      try db.create(table: "historyCollection") { t in
        t.column("id", .text).primaryKey()
        t.column("name", .text).notNull()
        t.column("createdAt", .datetime).notNull()
      }
      try db.create(table: "historyCollectionItem") { t in
        t.column("collectionId", .text).notNull().indexed()
          .references("historyCollection", onDelete: .cascade)
        t.column("captureId", .text).indexed()
          .references("captureHistoryRecord", onDelete: .cascade)
        t.column("clipboardTextId", .text).indexed()
          .references("clipboardTextRecord", onDelete: .cascade)
        t.column("addedAt", .datetime).notNull()
        t.check(sql: "(captureId IS NULL) <> (clipboardTextId IS NULL)")
        t.uniqueKey(["collectionId", "captureId"])
        t.uniqueKey(["collectionId", "clipboardTextId"])
      }
      try HistoryCollection(
        id: HistoryCollection.favoritesID,
        name: "Favorites",
        createdAt: Date(timeIntervalSince1970: 0)
      ).insert(db)
    }
  }
}

@MainActor
final class HistoryCollectionStore: ObservableObject {
  static let shared = HistoryCollectionStore(dbPool: try? DatabaseManager.shared().dbPool)

  /// Favorites first, then groups in the order they were made.
  @Published private(set) var collections: [HistoryCollection] = []
  @Published private(set) var errorMessage: String?
  /// Items per collection, newest first.
  @Published private(set) var itemsByCollection: [UUID: [SavedHistoryItem]] = [:]
  private var collectionsByItem: [SavedHistoryItem: Set<UUID>] = [:]

  private let dbPool: DatabasePool?
  private var cancellable: AnyDatabaseCancellable?

  // No actor-bound cleanup: avoid the Swift 6.2 main-actor deinit back-deployment shim.
  nonisolated deinit {}

  init(dbPool: DatabasePool?) {
    self.dbPool = dbPool
    guard let dbPool else { return }
    let observation = ValueObservation.tracking(Self.fetchAll)
    // Picks up changes made elsewhere, such as rows cascading away when a capture is deleted.
    cancellable = observation.start(
      in: dbPool,
      scheduling: .immediate,
      onError: { [weak self] error in
        logger.error("Collection observation failed: \(error.localizedDescription)")
        self?.errorMessage = "Could not load saved items. Restart Cinderdeck to try again."
      },
      onChange: { [weak self] value in
        self?.apply(collections: value.0, items: value.1)
      }
    )
  }

  var favorites: HistoryCollection? {
    collections.first(where: \.isFavorites)
  }

  var groups: [HistoryCollection] {
    collections.filter { !$0.isFavorites }
  }

  func items(in collectionID: UUID) -> [SavedHistoryItem] {
    itemsByCollection[collectionID] ?? []
  }

  func contains(_ item: SavedHistoryItem, in collectionID: UUID) -> Bool {
    collectionsByItem[item]?.contains(collectionID) ?? false
  }

  func isFavorite(_ item: SavedHistoryItem) -> Bool {
    contains(item, in: HistoryCollection.favoritesID)
  }

  func isSaved(_ item: SavedHistoryItem) -> Bool {
    !(collectionsByItem[item]?.isEmpty ?? true)
  }

  func toggleFavorite(_ item: SavedHistoryItem) {
    toggle(item, in: HistoryCollection.favoritesID)
  }

  func toggle(_ item: SavedHistoryItem, in collectionID: UUID) {
    if contains(item, in: collectionID) {
      remove([item], from: collectionID)
    } else {
      add([item], to: collectionID)
    }
  }

  func add(_ items: [SavedHistoryItem], to collectionID: UUID, at date: Date = Date()) {
    guard !items.isEmpty else { return }
    write("add saved items") { db in
      for item in items {
        try HistoryCollectionItem(collectionId: collectionID, item: item, addedAt: date)
          .insert(db, onConflict: .ignore)
      }
    }
  }

  func remove(_ items: [SavedHistoryItem], from collectionID: UUID) {
    guard !items.isEmpty else { return }
    write("remove saved items") { db in
      for item in items {
        let request = HistoryCollectionItem.filter(Column("collectionId") == collectionID)
        switch item {
        case let .capture(id):
          _ = try request.filter(Column("captureId") == id).deleteAll(db)
        case let .clipboardText(id):
          _ = try request.filter(Column("clipboardTextId") == id).deleteAll(db)
        }
      }
    }
  }

  /// Creates a group and returns it, or nil when the name is blank or the write fails.
  @discardableResult
  func createGroup(named name: String, at date: Date = Date()) -> HistoryCollection? {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let group = HistoryCollection(id: UUID(), name: trimmed, createdAt: date)
    let saved = write("create group") { db in try group.insert(db) }
    return saved ? group : nil
  }

  func renameGroup(_ id: UUID, to name: String) {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, id != HistoryCollection.favoritesID else { return }
    write("rename group") { db in
      guard var group = try HistoryCollection.fetchOne(db, id: id) else { return }
      group.name = trimmed
      try group.update(db)
    }
  }

  /// Deletes the group only; its captures and text stay in history.
  func deleteGroup(_ id: UUID) {
    guard id != HistoryCollection.favoritesID else { return }
    write("delete group") { db in _ = try HistoryCollection.deleteOne(db, id: id) }
  }

  @discardableResult
  private func write(_ operation: String, _ body: (Database) throws -> Void) -> Bool {
    guard let dbPool else {
      errorMessage = "Saved items are unavailable. Restart Cinderdeck to try again."
      return false
    }
    do {
      try dbPool.write(body)
      // Observation delivers later; refresh now so menus and stars update with the click.
      refresh()
      return true
    } catch {
      logger.error("Failed to \(operation): \(error.localizedDescription)")
      DiagnosticLogger.shared.logError(.history, error, "History collections \(operation) failed")
      errorMessage = "Could not update saved items. Please try again."
      return false
    }
  }

  func refresh() {
    guard let dbPool else { return }
    do {
      let (collections, items) = try dbPool.read(Self.fetchAll)
      apply(collections: collections, items: items)
    } catch {
      logger.error("Failed to load collections: \(error.localizedDescription)")
      errorMessage = "Could not load saved items. Restart Cinderdeck to try again."
    }
  }

  nonisolated private static func fetchAll(
    _ db: Database
  ) throws -> ([HistoryCollection], [HistoryCollectionItem]) {
    (
      try HistoryCollection.order(Column("createdAt"), Column("name")).fetchAll(db),
      try HistoryCollectionItem.order(Column("addedAt").desc).fetchAll(db)
    )
  }

  private func apply(collections: [HistoryCollection], items: [HistoryCollectionItem]) {
    var itemsByCollection: [UUID: [SavedHistoryItem]] = [:]
    var collectionsByItem: [SavedHistoryItem: Set<UUID>] = [:]
    for row in items {
      guard let item = row.item else { continue }
      itemsByCollection[row.collectionId, default: []].append(item)
      collectionsByItem[item, default: []].insert(row.collectionId)
    }
    self.collectionsByItem = collectionsByItem
    self.itemsByCollection = itemsByCollection
    // Favorites sorts first: it is created at the epoch.
    self.collections = collections
    errorMessage = nil
  }
}
