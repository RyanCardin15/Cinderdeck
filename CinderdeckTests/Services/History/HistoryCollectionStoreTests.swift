import AppKit
import XCTest
@testable import Cinderdeck

@MainActor
final class HistoryCollectionStoreTests: XCTestCase {
  private var directory: URL!
  private var defaults: UserDefaults!
  private var suite: String!
  private var pasteboard: NSPasteboard!
  private var database: DatabaseManager!
  private var clipboard: ClipboardTextHistoryStore!
  private var store: HistoryCollectionStore!

  override func setUpWithError() throws {
    suite = "CinderdeckTests.HistoryCollections.\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suite)
    defaults.set(true, forKey: PreferencesKeys.clipboardTextHistoryEnabled)
    pasteboard = NSPasteboard.withUniqueName()
    directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
    database = try DatabaseManager.openDatabase(at: directory.appendingPathComponent("history.db"))
    clipboard = ClipboardTextHistoryStore(dbPool: database.dbPool, pasteboard: pasteboard, defaults: defaults)
    store = HistoryCollectionStore(dbPool: database.dbPool)
  }

  override func tearDownWithError() throws {
    store = nil
    clipboard = nil
    database = nil
    pasteboard.releaseGlobally()
    defaults.removePersistentDomain(forName: suite)
    try FileManager.default.removeItem(at: directory)
  }

  func testFavoritesExistsAndCannotBeRenamedOrDeleted() {
    XCTAssertEqual(store.collections.map(\.id), [HistoryCollection.favoritesID])
    store.renameGroup(HistoryCollection.favoritesID, to: "Renamed")
    store.deleteGroup(HistoryCollection.favoritesID)
    XCTAssertEqual(store.favorites?.name, "Favorites")
    XCTAssertTrue(store.groups.isEmpty)
  }

  func testToggleFavoriteAddsOnceAndRemoves() throws {
    let item = try copyText("Summarize this diff")
    store.toggleFavorite(item)
    store.add([item], to: HistoryCollection.favoritesID)
    XCTAssertTrue(store.isFavorite(item))
    XCTAssertEqual(store.items(in: HistoryCollection.favoritesID), [item])

    store.toggleFavorite(item)
    XCTAssertFalse(store.isFavorite(item))
    XCTAssertFalse(store.isSaved(item))
  }

  func testGroupsCanBeCreatedRenamedAndDeletedWithoutDeletingItems() throws {
    let item = try copyText("Write tests first")
    XCTAssertNil(store.createGroup(named: "   "))
    let group = try XCTUnwrap(store.createGroup(named: " Prompts "))
    XCTAssertEqual(group.name, "Prompts")
    store.add([item], to: group.id)
    XCTAssertEqual(store.groups.map(\.name), ["Prompts"])
    XCTAssertTrue(store.contains(item, in: group.id))

    store.renameGroup(group.id, to: "Favorite prompts")
    XCTAssertEqual(store.groups.first?.name, "Favorite prompts")

    store.deleteGroup(group.id)
    XCTAssertTrue(store.groups.isEmpty)
    XCTAssertFalse(store.isSaved(item))
    XCTAssertEqual(clipboard.records.count, 1)
  }

  func testDeletingTextFromHistoryRemovesItFromGroups() throws {
    let item = try copyText("Temporary")
    store.add([item], to: HistoryCollection.favoritesID)
    guard case let .clipboardText(id) = item else { return XCTFail() }
    clipboard.remove(id)
    store.refresh()
    XCTAssertFalse(store.isFavorite(item))
    XCTAssertTrue(store.items(in: HistoryCollection.favoritesID).isEmpty)
  }

  func testSavedTextSurvivesRetentionAndClear() throws {
    let now = Date()
    let saved = try copyText("Saved prompt", at: now.addingTimeInterval(-40 * 86400))
    store.add([saved], to: HistoryCollection.favoritesID)
    for index in 0...ClipboardTextHistoryStore.maximumRecordCount {
      write("Entry \(index)")
      clipboard.poll(now: now.addingTimeInterval(Double(index)))
    }
    XCTAssertEqual(clipboard.records.count, ClipboardTextHistoryStore.maximumRecordCount + 1)
    XCTAssertTrue(clipboard.records.contains { $0.text == "Saved prompt" })

    clipboard.prune(now: now.addingTimeInterval(60 * 86400))
    XCTAssertEqual(clipboard.records.map(\.text), ["Saved prompt"])

    write("Unsaved")
    clipboard.poll(now: now.addingTimeInterval(60 * 86400))
    clipboard.clear()
    XCTAssertEqual(clipboard.records.map(\.text), ["Saved prompt"])
    XCTAssertTrue(store.isFavorite(saved))
  }

  func testRecopyingSavedTextKeepsItSaved() throws {
    let now = Date()
    let item = try copyText("Reusable prompt", at: now)
    store.add([item], to: HistoryCollection.favoritesID)
    write("Something else")
    clipboard.poll(now: now.addingTimeInterval(1))
    let recopied = try copyText("Reusable prompt", at: now.addingTimeInterval(2))
    XCTAssertEqual(recopied, item)
    XCTAssertTrue(store.isFavorite(item))
  }

  private func copyText(_ text: String, at date: Date = Date()) throws -> SavedHistoryItem {
    write(text)
    clipboard.poll(now: date)
    let record = try XCTUnwrap(clipboard.records.first { $0.text == text })
    return .clipboardText(record.id)
  }

  private func write(_ text: String) {
    pasteboard.clearContents()
    XCTAssertTrue(pasteboard.setString(text, forType: .string))
  }
}
