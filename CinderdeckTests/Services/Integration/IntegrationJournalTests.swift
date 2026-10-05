import Foundation
import XCTest
import GRDB
@testable import Cinderdeck

final class IntegrationJournalTests: XCTestCase {
  private func workspace(_ name: String = "Demo", id: String = "demo") -> StackSnapshot {
    StackSnapshot(id: id, name: name, file: "/fixture/\(id).toml", state: "Stopped", operation: nil,
      definitionChanged: false, issues: [], claim: nil, services: [], repos: [], lane: nil)
  }
  func testSelectedRefreshPreservesUnrelatedRowsAndDefeatsOlderFullPublication() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try IntegrationJournal(directory: root)
    try await store.reconcile([workspace("A", id: "a"), workspace("B", id: "b")], sourceRevision: 1)
    let initial = try await store.snapshot(limit: 1)
    try await store.reconcileSelected(workspace("Fresh A", id: "a"), workspaceID: "a", sourceRevision: 3)
    // An older queued full publication may still bring a newer unrelated B.
    try await store.reconcile([workspace("B changed", id: "b")], sourceRevision: 2)
    let selected = try await store.snapshot(workspaceID: "a")
    let unrelated = try await store.snapshot(workspaceID: "b")
    XCTAssertEqual(selected.resources.first?.workspace?.name, "Fresh A")
    XCTAssertTrue(selected.resources.first?.available ?? false)
    XCTAssertEqual(unrelated.resources.first?.workspace?.name, "B changed")
    XCTAssertEqual(unrelated.resources.first?.generation, 1)
    XCTAssertNotEqual(selected.cursor, initial.cursor)
    let secondPage = try await store.snapshot(offset: 1, limit: 1)
    XCTAssertEqual(secondPage.cursor, selected.cursor)
    XCTAssertEqual(secondPage.total, 2)
    XCTAssertEqual(secondPage.resources.first?.workspaceID, "b")
    try await store.reconcile([workspace("Fresh A", id: "a"), workspace("B changed", id: "b")], sourceRevision: 4)
    let unchanged = try await store.snapshot()
    XCTAssertEqual(unchanged.cursor, secondPage.cursor)
    try await store.reconcileSelected(nil, workspaceID: "never-present", sourceRevision: 5)
    let missing = try await store.snapshot(workspaceID: "never-present")
    XCTAssertTrue(missing.resources.isEmpty)
    XCTAssertEqual(missing.cursor, unchanged.cursor)
    do {
      try await store.reconcileSelected(workspace("Wrong", id: "a"), workspaceID: "b", sourceRevision: 6)
      XCTFail("Selected context cannot update another workspace")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "invalid_params") }
  }

  func testSelectedTombstoneRecreationAndNewFullDeletionPreserveGeneration() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try IntegrationJournal(directory: root)
    try await store.reconcile([workspace("A", id: "a"), workspace("B", id: "b")], sourceRevision: 1)
    try await store.reconcileSelected(nil, workspaceID: "a", sourceRevision: 3)
    try await store.reconcile([workspace("Old A", id: "a"), workspace("B", id: "b")], sourceRevision: 2)
    let removed = try await store.snapshot(workspaceID: "a")
    XCTAssertFalse(removed.resources.first?.available ?? true)
    XCTAssertNil(removed.resources.first?.workspace)
    XCTAssertEqual(removed.resources.first?.generation, 1)
    try await store.reconcileSelected(workspace("Recreated A", id: "a"), workspaceID: "a", sourceRevision: 4)
    let recreated = try await store.snapshot(workspaceID: "a")
    XCTAssertTrue(recreated.resources.first?.available ?? false)
    XCTAssertEqual(recreated.resources.first?.generation, 2)
    try await store.reconcile([workspace("B", id: "b")], sourceRevision: 5)
    let deleted = try await store.snapshot(workspaceID: "a")
    let preserved = try await store.snapshot(workspaceID: "b")
    XCTAssertFalse(deleted.resources.first?.available ?? true)
    XCTAssertEqual(deleted.resources.first?.generation, 2)
    XCTAssertTrue(preserved.resources.first?.available ?? false)
    let events = try await store.events(after: recreated.cursor)
    XCTAssertEqual(events.events.map(\.workspaceID), ["a"])
    XCTAssertEqual(events.events.map(\.kind), ["workspace.unavailable"])
  }

  func testFreshSelectedAbsenceFencesAnUnpublishedOlderResourceWithoutCreatingPlaceholder() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try IntegrationJournal(directory: root)
    try await store.reconcileSelected(nil, workspaceID: "removed-before-publish", sourceRevision: 3)
    try await store.reconcile([workspace("Old queued value", id: "removed-before-publish")], sourceRevision: 2)
    let absent = try await store.snapshot(workspaceID: "removed-before-publish")
    XCTAssertEqual(absent.total, 0)
    XCTAssertTrue(absent.resources.isEmpty)
    try await store.reconcile([workspace("Actually recreated", id: "removed-before-publish")], sourceRevision: 4)
    let created = try await store.snapshot(workspaceID: "removed-before-publish")
    XCTAssertEqual(created.resources.first?.generation, 1)
    XCTAssertEqual(created.resources.first?.workspace?.name, "Actually recreated")
  }
  func testCoherentSnapshotReplayRestartAndGenerationReuse() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-journal-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try IntegrationJournal(directory: root)
    let initial = try await store.snapshot()
    try await store.reconcile([workspace()], sourceRevision: 1)
    let first = try await store.snapshot()
    XCTAssertEqual(first.resources.first?.generation, 1)
    let events = try await store.events(after: initial.cursor)
    XCTAssertEqual(events.events.map(\.kind), ["workspace.available"])
    XCTAssertEqual(events.events.first?.sourceID, first.installationID)
    XCTAssertEqual(events.events.first?.eventID, "\(first.installationID):\(events.events.first!.sequence)")
    XCTAssertEqual(events.events.first?.revision, first.resources.first?.revision)
    XCTAssertNotNil(events.events.first?.observedAt)
    XCTAssertNil(events.events.first?.occurredAt) // Source time is unknown, never inferred from the read.
    XCTAssertEqual(events.cursor, first.cursor)
    try await store.reconcile([workspace()], sourceRevision: 2)
    let unchanged = try await store.snapshot()
    XCTAssertEqual(unchanged.cursor, first.cursor)
    try await store.reconcile([workspace("Renamed")], sourceRevision: 3)
    try await store.reconcile([workspace("Outdated")], sourceRevision: 2)
    let renamed = try await store.snapshot()
    XCTAssertEqual(renamed.resources.first?.workspace?.name, "Renamed")
    XCTAssertEqual(renamed.resources.first?.generation, 1)
    try await store.reconcile([], sourceRevision: 4)
    let deleted = try await store.snapshot()
    XCTAssertFalse(deleted.resources.first?.available ?? true)
    XCTAssertNil(deleted.resources.first?.workspace)
    try await store.reconcile([workspace("Recreated")], sourceRevision: 5)
    let recreated = try await store.snapshot()
    XCTAssertEqual(recreated.resources.first?.generation, 2)
    let restarted = try IntegrationJournal(directory: root)
    let recovered = try await restarted.snapshot()
    XCTAssertEqual(recovered.installationID, first.installationID)
    XCTAssertNotEqual(recovered.runtimeEpoch, first.runtimeEpoch)
    XCTAssertEqual(recovered.cursor, recreated.cursor)
    let replay = try await restarted.events(after: first.cursor)
    XCTAssertEqual(replay.events.map(\.kind), ["workspace.updated", "workspace.unavailable", "workspace.available"])
    XCTAssertFalse(replay.resyncRequired)
  }
  func testCompactionForeignCursorAndLongPoll() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-journal-\(UUID())")
    let otherRoot = root.appendingPathComponent("other")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try IntegrationJournal(directory: root, retention: 2)
    let initial = try await store.snapshot()
    for index in 1...3 { try await store.reconcile([workspace("Version \(index)")], sourceRevision: UInt64(index)) }
    let compacted = try await store.events(after: initial.cursor)
    XCTAssertTrue(compacted.resyncRequired)
    let other = try IntegrationJournal(directory: otherRoot)
    let foreign = try await other.events(after: compacted.cursor)
    XCTAssertTrue(foreign.resyncRequired)
    let current = try await store.snapshot()
    let pending = Task { try await store.events(after: current.cursor, waitMs: 1_000) }
    try await store.reconcile([workspace("Changed")], sourceRevision: 4)
    let result = try await pending.value
    XCTAssertEqual(result.events.count, 1)
    XCTAssertEqual(result.events.first?.kind, "workspace.updated")
    do { _ = try await store.events(after: "malformed"); XCTFail("Expected invalid cursor") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "invalid_params") }
    do { _ = try await store.events(after: result.cursor, waitMs: 25_001); XCTFail("Expected wait bound") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "invalid_params") }
  }
  @MainActor
  func testHandshakeRejectsWrongIdentityChannelAndArguments() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-control-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    let defaults = UserDefaults(suiteName: "deckhand-control-\(UUID())")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    let supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("logs"))
    let control = StackControlService(supervisor: supervisor, claimsFile: root.appendingPathComponent("claims.json"), integrationDirectory: root.appendingPathComponent("integration"))
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "unit")
    let hello = try await control.handle("integration.hello", params: .object(["protocolVersions": .array([.number(1)])]), actor: actor)
    XCTAssertEqual(hello["protocolVersion"], .number(1))
    let capabilities = try XCTUnwrap(hello["capabilities"]?.stringsValue)
    XCTAssertEqual(Set(capabilities).count, capabilities.count, "Capabilities must be unique")
    let required: Set<String> = ["projection.snapshot", "projection.events", "operations.lane.create", "operations.lane.create.repositoryRefs", "operations.lane.create.managedWriter", "operations.lane.adopt", "operations.lane.adopt.managedWriter", "operations.lane.setup", "operations.lane.release", "operations.lane.remove", "operations.services", "operations.receipts", "operations.receipts.wait", "checkout.reservations", "checkout.contexts"]
    XCTAssertTrue(required.isSubset(of: Set(capabilities)), "Additive capabilities must retain the supported consumer contract")
    for (params, expected) in [
      (JSONValue.object(["protocolVersions": .array([.number(2)])]), "unsupported_version"),
      (.object(["protocolVersions": .array([.number(1)]), "expectedInstallationID": .string("wrong")]), "installation_changed"),
      (.object(["protocolVersions": .array([.number(1)]), "expectedExecutionHostID": .string("wrong")]), "wrong_host"),
      (.object(["protocolVersions": .array([.number(1)]), "expectedChannel": .string("wrong")]), "wrong_channel"),
      (.object(["protocolVersions": .array([.number(1.5)])]), "invalid_params"),
      (.object(["protocolVersions": .array([.number(1)]), "unexpected": .bool(true)]), "invalid_params"),
    ] {
      do { _ = try await control.handle("integration.hello", params: params, actor: actor); XCTFail("Expected \(expected)") }
      catch { XCTAssertEqual((error as? StackControlError)?.code, expected) }
    }
    let snapshot = try await control.handle("integration.snapshot", params: .object([:]), actor: actor)
    XCTAssertEqual(snapshot["installationID"], hello["installationID"])
    do { _ = try await control.handle("integration.snapshot", params: .object(["offset": .number(1), "expectedCursor": .string("old")]), actor: actor); XCTFail("Expected revision refusal") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "snapshot_changed") }
  }
  func testUpgradeKeepsLegacyEventsUnknownAndRefusesOversizedResources() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("deckhand-upgrade-\(UUID())")
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let queue = try DatabaseQueue(path: root.appendingPathComponent("integration.sqlite").path)
    try await queue.write { db in
      try db.execute(sql: "CREATE TABLE journal (sequence INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL); PRAGMA user_version = 1;")
      try db.execute(sql: "INSERT INTO journal(workspace_id, generation, kind) VALUES ('demo', 1, 'workspace.updated')")
    }
    let store = try IntegrationJournal(directory: root)
    let legacy: (String?, String?) = try await queue.read { db in
      let row = try Row.fetchOne(db, sql: "SELECT * FROM journal WHERE sequence = 1")!
      return (row["revision"], row["observed_at"])
    }
    XCTAssertNil(legacy.0)
    XCTAssertNil(legacy.1)
    try await store.reconcile([workspace(String(repeating: "x", count: StackControlSocketServer.maximumFrameBytes))], sourceRevision: 1)
    do { _ = try await store.snapshot(); XCTFail("Expected bounded-frame refusal") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "resource_too_large") }
    try await queue.write { try $0.execute(sql: "PRAGMA user_version = 3") }
    do { _ = try IntegrationJournal(directory: root); XCTFail("Expected newer-store refusal") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "store_too_new") }
    let rows = try await queue.read { try Int.fetchOne($0, sql: "SELECT COUNT(*) FROM journal") }
    XCTAssertEqual(rows, 2)
  }

}
