import Foundation
import GRDB
import XCTest
@testable import Snapzy

@MainActor
final class StackRunStoreTests: XCTestCase {
  func testFreshAndUpgradeMigrationsPreserveClipboardData() throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("snapzy.db")
    let pool = try DatabaseManager.openDatabase(at: url).dbPool
    try pool.write { db in
      XCTAssertTrue(try db.tableExists("stackRunRecord")); XCTAssertTrue(try db.tableExists("stackEventRecord"))
      try db.execute(sql: "INSERT INTO clipboardTextRecord (id, text, contentHash, copiedAt) VALUES (?, ?, ?, ?)", arguments: [UUID().uuidString, "keep me", "hash", Date()])
      try db.execute(sql: "DROP TABLE stackRunRecord; DROP TABLE stackEventRecord; DELETE FROM grdb_migrations WHERE identifier LIKE 'custom_%'")
    }
    let upgraded = try DatabaseManager.openDatabase(at: url).dbPool
    try upgraded.read { db in
      XCTAssertTrue(try db.tableExists("stackRunRecord")); XCTAssertTrue(try db.tableExists("stackEventRecord"))
      XCTAssertEqual(try String.fetchOne(db, sql: "SELECT text FROM clipboardTextRecord"), "keep me")
      XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM grdb_migrations WHERE identifier LIKE 'custom_%'"), 2)
    }
  }
  func testReattachLiveRecordDropReusedAndDeadRecords() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let pool = try DatabaseManager.openDatabase(at: root.appendingPathComponent("runs.db")).dbPool
    let store = StackRunStore(pool: pool)
    let process = ServiceProcess()
    let log = root.appendingPathComponent("test.log")
    let launch = StackTestSupport.simpleDefinition(root: root)
    let identity = try await process.launch(launch, environment: ProcessInfo.processInfo.environment, logURL: log)
    try await store.save(.init(definition: launch, process: identity, logURL: log, startedAt: Date()))
    let defaults = UserDefaults(suiteName: "SnapzyStacksTests-\(UUID().uuidString)")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    let supervisor = StackSupervisor(store: store, defaults: defaults)
    await supervisor.bootstrap()
    XCTAssertEqual(supervisor.runtime("test", "test").process, identity)
    XCTAssertTrue(supervisor.hasRunningServices)
    await supervisor.stopAll()
    await supervisor.shutdownMonitoring()
    _ = await process.waitForExit()
    let stopped = try await store.records()
    XCTAssertTrue(stopped.isEmpty)
    let reused = StackProcessIdentity(pid: getpid(), pgid: getpid(), startTime: 1)
    try await store.save(.init(definition: launch, process: reused, logURL: log, startedAt: Date()))
    let next = StackSupervisor(store: store, defaults: defaults)
    await next.bootstrap()
    let remaining = try await store.records()
    XCTAssertTrue(remaining.isEmpty); XCTAssertFalse(next.hasRunningServices)
    await next.shutdownMonitoring()
  }
  func testEventRetentionKeepsNewestThousand() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let pool = try DatabaseManager.openDatabase(at: root.appendingPathComponent("runs.db")).dbPool
    let store = StackRunStore(pool: pool)
    try await pool.write { db in
      for n in 0..<1005 { try StackEventRecord(stackID: "test", kind: "started", detail: String(n), occurredAt: Date(timeIntervalSince1970: Double(n))).insert(db) }
    }
    try await store.pruneEvents()
    try await pool.read { db in
      XCTAssertEqual(try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM stackEventRecord"), 1000)
      XCTAssertEqual(try String.fetchOne(db, sql: "SELECT detail FROM stackEventRecord ORDER BY occurredAt LIMIT 1"), "5")
    }
  }
  func testDamagedSnapshotStillReattachesAndCanStopOwnedProcess() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let pool = try DatabaseManager.openDatabase(at: root.appendingPathComponent("runs.db")).dbPool
    let store = StackRunStore(pool: pool)
    let process = ServiceProcess()
    let log = root.appendingPathComponent("test.log")
    let launch = StackTestSupport.simpleDefinition(root: root)
    let identity = try await process.launch(launch, environment: ProcessInfo.processInfo.environment, logURL: log)
    try await store.save(.init(definition: launch, process: identity, logURL: log, startedAt: Date()))
    try await pool.write { try $0.execute(sql: "UPDATE stackRunRecord SET definitionJSON = '{}' ") }
    let defaults = UserDefaults(suiteName: "SnapzyStacksTests-\(UUID().uuidString)")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    let supervisor = StackSupervisor(store: store, defaults: defaults)
    await supervisor.bootstrap()
    XCTAssertEqual(supervisor.runtime("test", "test").process, identity)
    XCTAssertEqual(supervisor.runtime("test", "test").phase, .unhealthy)
    await supervisor.stopAll()
    await supervisor.shutdownMonitoring()
    _ = await process.waitForExit()
    XCTAssertFalse(identity.matchesLiveProcess)
  }
}

final class StackConfigurationTests: XCTestCase {
  func testConfigurationRoundTripAndDefaults() throws {
    let defaults = UserDefaults(suiteName: "SnapzyStacksTests-\(UUID().uuidString)")!
    let source = "[stacks]\nenabled = false\ndirectory = \"~/custom stacks\"\nquit_behavior = \"leave\"\nnotify_on_crash = false\nauto_fetch_minutes = 15"
    let result = SnapzyConfigurationImporter.importTOML(source, defaults: defaults)
    XCTAssertFalse(result.hasErrors)
    var writer = SimpleTOMLWriter()
    StackConfiguration.write(&writer, defaults: defaults)
    let document = try SimpleTOMLParser.parse(writer.output)
    XCTAssertEqual(document.value(at: "stacks", "quit_behavior")?.stringValue, "leave")
    XCTAssertEqual(document.value(at: "stacks", "directory")?.stringValue, "~/custom stacks")
    XCTAssertEqual(document.value(at: "stacks", "auto_fetch_minutes")?.intValue, 15)
    XCTAssertEqual(document.value(at: "stacks", "enabled")?.boolValue, false)
    XCTAssertFalse(writer.output.contains("secret")); XCTAssertFalse(writer.output.contains("stackRunRecord"))
    let standard = try SimpleTOMLParser.parse(SnapzyConfigurationDefaultDocument.toml())
    XCTAssertEqual(standard.value(at: "stacks", "quit_behavior")?.stringValue, "ask")
    XCTAssertEqual(standard.value(at: "stacks", "enabled")?.boolValue, true)
  }
  func testInvalidConfigurationDoesNotApplyOtherFields() {
    let defaults = UserDefaults(suiteName: "SnapzyStacksTests-\(UUID().uuidString)")!
    for value in ["quit_behavior = \"kill\"", "auto_fetch_minutes = -1", "directory = \"relative\""] {
      let result = SnapzyConfigurationImporter.importTOML("[stacks]\nenabled = false\n" + value, defaults: defaults)
      XCTAssertTrue(result.hasErrors); XCTAssertNil(defaults.object(forKey: PreferencesKeys.stacksEnabled))
    }
  }
  func testHistorySelectionMigratesExactlyOnce() {
    let defaults = UserDefaults(suiteName: "SnapzyStacksTests-\(UUID().uuidString)")!
    defaults.set(true, forKey: PreferencesKeys.historyClipboardTextSelected)
    XCTAssertEqual(HistorySection.stored(defaults: defaults), .clipboard)
    defaults.set("stacks", forKey: PreferencesKeys.historySelectedSection)
    defaults.set(false, forKey: PreferencesKeys.historyClipboardTextSelected)
    XCTAssertEqual(HistorySection.stored(defaults: defaults), .stacks)
  }
}
