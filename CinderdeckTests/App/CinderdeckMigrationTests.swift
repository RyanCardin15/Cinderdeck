import Foundation
import GRDB
import XCTest
@testable import Cinderdeck

final class CinderdeckMigrationTests: XCTestCase {
  func testLiveAgentSocketIsExcludedWhileClaimsArePreserved() throws {
    let home = URL(fileURLWithPath: "/tmp/cdm-\(UUID().uuidString.prefix(8))")
    let domain = "CinderdeckMigrationTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: domain)!
    defer { try? FileManager.default.removeItem(at: home); defaults.removePersistentDomain(forName: domain) }
    let old = home.appendingPathComponent("Library/Application Support/Snapzy/Stacks")
    let server = StackControlSocketServer(path: old.appendingPathComponent("control.sock").path) { _, _ in Data() }
    try server.start()
    defer { server.stop() }
    try Data("{\"legacy\":true}".utf8).write(to: old.appendingPathComponent("state.json"))
    try Data("[]".utf8).write(to: old.appendingPathComponent("claims.json"))
    try CinderdeckMigration.runIfNeeded(home: home, defaults: defaults, legacyPreferences: [:])
    let imported = home.appendingPathComponent("Library/Application Support/Cinderdeck/Stacks")
    XCTAssertFalse(FileManager.default.fileExists(atPath: imported.appendingPathComponent("control.sock").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: imported.appendingPathComponent("state.json").path))
    XCTAssertEqual(try Data(contentsOf: imported.appendingPathComponent("claims.json")), Data("[]".utf8))
    XCTAssertTrue(FileManager.default.fileExists(atPath: old.appendingPathComponent("control.sock").path))
  }

  func testCopiesCommittedWALAndConfigurationWithoutChangingOriginals() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let domain = "CinderdeckMigrationTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: domain)!
    defer { try? FileManager.default.removeItem(at: home); defaults.removePersistentDomain(forName: domain) }
    let old = home.appendingPathComponent("Library/Application Support/Snapzy")
    try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
    let database = try DatabasePool(path: old.appendingPathComponent("snapzy.db").path)
    try database.write { db in
      try db.execute(sql: "CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('keep me')")
    }
    let config = home.appendingPathComponent(".config/snapzy")
    try FileManager.default.createDirectory(at: config.appendingPathComponent("stacks"), withIntermediateDirectories: true)
    try Data("[stacks]\ndirectory = \"~/.config/snapzy/stacks\"\n".utf8).write(to: config.appendingPathComponent("config.toml"))
    try Data("name = \"My projects\"".utf8).write(to: config.appendingPathComponent("stacks/custom.toml"))
    try CinderdeckMigration.runIfNeeded(home: home, defaults: defaults,
      legacyPreferences: ["stacks.directory": "~/.config/snapzy/stacks", "history.enabled": true, "SUFeedURL": "https://example.com"])
    let imported = try DatabaseQueue(path: home.appendingPathComponent("Library/Application Support/Cinderdeck/cinderdeck.db").path)
    XCTAssertEqual(try imported.read { try String.fetchOne($0, sql: "SELECT value FROM sample") }, "keep me")
    XCTAssertEqual(try database.read { try String.fetchOne($0, sql: "SELECT value FROM sample") }, "keep me")
    XCTAssertEqual(defaults.string(forKey: "stacks.directory"), "~/.config/cinderdeck/stacks")
    XCTAssertTrue(defaults.bool(forKey: "history.enabled"))
    XCTAssertNil(defaults.object(forKey: "SUFeedURL"))
    XCTAssertTrue(try String(contentsOf: config.appendingPathComponent("config.toml"), encoding: .utf8).contains("snapzy"))
    XCTAssertTrue(try String(contentsOf: home.appendingPathComponent(".config/cinderdeck/config.toml"), encoding: .utf8).contains("cinderdeck"))
    XCTAssertTrue(FileManager.default.fileExists(atPath: home.appendingPathComponent(".config/cinderdeck/stacks/custom.toml").path))
  }

  func testExistingDataAndCustomPreferencesWinAndMigrationOnlyRunsOnce() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let domain = "CinderdeckMigrationTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: domain)!
    defer { try? FileManager.default.removeItem(at: home); defaults.removePersistentDomain(forName: domain) }
    for brand in ["snapzy", "cinderdeck"] {
      let config = home.appendingPathComponent(".config/\(brand)")
      try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
      try Data(brand.utf8).write(to: config.appendingPathComponent("config.toml"))
    }
    defaults.set("/custom/projects", forKey: "stacks.directory")
    try CinderdeckMigration.runIfNeeded(home: home, defaults: defaults, legacyPreferences: ["stacks.directory": "~/.config/snapzy/stacks"])
    XCTAssertEqual(defaults.string(forKey: "stacks.directory"), "/custom/projects")
    XCTAssertEqual(try String(contentsOf: home.appendingPathComponent(".config/cinderdeck/config.toml"), encoding: .utf8), "cinderdeck")
    try CinderdeckMigration.runIfNeeded(home: home, defaults: defaults, legacyPreferences: ["late.key": true])
    XCTAssertNil(defaults.object(forKey: "late.key"))
  }

  func testFailedDatabaseCopyDoesNotMarkMigrationComplete() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let domain = "CinderdeckMigrationTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: domain)!
    defer { try? FileManager.default.removeItem(at: home); defaults.removePersistentDomain(forName: domain) }
    let old = home.appendingPathComponent("Library/Application Support/Snapzy")
    try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
    try Data("invalid sqlite".utf8).write(to: old.appendingPathComponent("snapzy.db"))
    XCTAssertThrowsError(try CinderdeckMigration.runIfNeeded(home: home, defaults: defaults, legacyPreferences: [:]))
    XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Application Support/Cinderdeck/.snapzy-import-completed").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Application Support/Cinderdeck/cinderdeck.db").path))
  }

  func testUpdaterRejectsUpstreamFeedKeyAndUnconfiguredBuilds() {
    let feed = "https://raw.githubusercontent.com/RyanCardin15/Cinderdeck/main/appcast.xml"
    let key = Data(repeating: 1, count: 32).base64EncodedString()
    XCTAssertFalse(CinderdeckUpdatePolicy.isConfigured([:]))
    XCTAssertFalse(CinderdeckUpdatePolicy.isConfigured(["SUFeedURL": feed, "SUPublicEDKey": key]))
    XCTAssertFalse(CinderdeckUpdatePolicy.isConfigured(["CinderdeckSignedUpdatesEnabled": true, "SUFeedURL": "https://raw.githubusercontent.com/duongductrong/Snapzy/master/appcast.xml", "SUPublicEDKey": key]))
    XCTAssertFalse(CinderdeckUpdatePolicy.isConfigured(["CinderdeckSignedUpdatesEnabled": true, "CFBundleIdentifier": "com.ryancardin.cinderdeck", "SUFeedURL": feed, "SUPublicEDKey": "zcoJ90nh+SEFg6ZEkb9fwQCEK51vSIRwyn6tOsQisL0="]))
    XCTAssertFalse(CinderdeckUpdatePolicy.isConfigured(["CinderdeckSignedUpdatesEnabled": true, "CFBundleIdentifier": "com.ryancardin.cinderdeck.debug", "SUFeedURL": feed, "SUPublicEDKey": key]))
    XCTAssertTrue(CinderdeckUpdatePolicy.isConfigured(["CinderdeckSignedUpdatesEnabled": true, "CFBundleIdentifier": "com.ryancardin.cinderdeck", "SUFeedURL": feed, "SUPublicEDKey": key]))
    XCTAssertTrue(CinderdeckUpdatePolicy.isConfigured(["CinderdeckSignedUpdatesEnabled": true, "CFBundleIdentifier": "com.ryancardin.cinderdeck", "SUFeedURL": CinderdeckUpdatePolicy.localTestFeedURL, "SUPublicEDKey": key]))
    XCTAssertFalse(CinderdeckUpdatePolicy.isConfigured(["CinderdeckSignedUpdatesEnabled": true, "CFBundleIdentifier": "com.ryancardin.cinderdeck", "SUFeedURL": "http://example.com/appcast.xml", "SUPublicEDKey": key]))
  }

  @MainActor
  func testLegacyAndNewDeepLinksResolveTheSameAction() {
    let current = CinderdeckDeepLinkAction(url: URL(string: "cinderdeck://capture/area")!)
    let legacy = CinderdeckDeepLinkAction(url: URL(string: "snapzy://capture/area")!)
    XCTAssertNotNil(current)
    XCTAssertEqual(current, legacy)
  }
}
