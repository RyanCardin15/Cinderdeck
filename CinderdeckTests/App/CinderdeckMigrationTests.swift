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
    XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Application Support/Cinderdeck/.legacy-import-completed").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("Library/Application Support/Cinderdeck/cinderdeck.db").path))
  }

  func testCompletedImportRepairsExportSettingsAndConfigurationWithoutMovingCaptures() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let domain = "CinderdeckMigrationTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: domain)!
    defer { try? FileManager.default.removeItem(at: home); defaults.removePersistentDomain(forName: domain) }
    let support = home.appendingPathComponent("Library/Application Support/Cinderdeck")
    let config = home.appendingPathComponent(".config/cinderdeck/config.toml")
    let oldExports = home.appendingPathComponent("Desktop/Snapzy")
    for url in [support, config.deletingLastPathComponent(), oldExports] {
      try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }
    try Data().write(to: support.appendingPathComponent(".snapzy-import-completed"))
    let capture = oldExports.appendingPathComponent("Snapzy_existing.png")
    try Data("original capture".utf8).write(to: capture)
    defaults.set(oldExports.path, forKey: "exportLocation")
    defaults.set(try oldExports.bookmarkData(), forKey: "exportLocation.bookmark")
    defaults.set("Snapzy_{datetime}_{ms}", forKey: "screenshot.fileNameTemplate")
    defaults.set("snapzy_Recording_{datetime}", forKey: "recording.fileNameTemplate")
    let original = """
    # Snapzy migration context stays in comments.
    schema_version = 1
    [general]
    export_location = "~/Desktop/Snapzy" # chosen folder
    [capture.naming]
    screenshot_template = "Snapzy_{datetime}_{ms}"
    recording_template = "Snapzy_Recording_{datetime}"
    [stacks]
    directory = "/custom/Snapzy-project"

    """
    try original.write(to: config, atomically: true, encoding: .utf8)

    try CinderdeckMigration.runIfNeeded(home: home, defaults: defaults, legacyPreferences: ["late.key": true])

    XCTAssertEqual(defaults.string(forKey: "exportLocation"), home.appendingPathComponent("Desktop/Cinderdeck").path)
    XCTAssertNil(defaults.data(forKey: "exportLocation.bookmark"))
    XCTAssertEqual(defaults.string(forKey: "screenshot.fileNameTemplate"), "Cinderdeck_{datetime}_{ms}")
    XCTAssertEqual(defaults.string(forKey: "recording.fileNameTemplate"), "Cinderdeck_Recording_{datetime}")
    XCTAssertNil(defaults.object(forKey: "late.key"))
    XCTAssertTrue(FileManager.default.fileExists(atPath: support.appendingPathComponent(".legacy-import-completed").path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: support.appendingPathComponent(".snapzy-import-completed").path))
    XCTAssertEqual(try Data(contentsOf: capture), Data("original capture".utf8))
    let expected = original.replacingOccurrences(of: "~/Desktop/Snapzy", with: "~/Desktop/Cinderdeck")
      .replacingOccurrences(of: "\"Snapzy_", with: "\"Cinderdeck_")
    XCTAssertEqual(try String(contentsOf: config, encoding: .utf8), expected)
    try CinderdeckMigration.runIfNeeded(home: home, defaults: defaults, legacyPreferences: [:])
    XCTAssertEqual(try String(contentsOf: config, encoding: .utf8), expected)
  }

  func testIdentityRepairPreservesCustomExportSettingsAndDiscardsStaleLegacyBookmark() throws {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let domain = "CinderdeckMigrationTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: domain)!
    defer { try? FileManager.default.removeItem(at: home); defaults.removePersistentDomain(forName: domain) }
    let old = home.appendingPathComponent("Desktop/Snapzy")
    try FileManager.default.createDirectory(at: old, withIntermediateDirectories: true)
    defaults.set("/custom/captures", forKey: "exportLocation")
    defaults.set(try old.bookmarkData(), forKey: "exportLocation.bookmark")
    defaults.set("Bug_{timestamp}", forKey: "screenshot.fileNameTemplate")
    defaults.set("Session_{datetime}", forKey: "recording.fileNameTemplate")
    try CinderdeckMigration.repairIdentity(home: home, defaults: defaults)
    XCTAssertEqual(defaults.string(forKey: "exportLocation"), "/custom/captures")
    XCTAssertNil(defaults.data(forKey: "exportLocation.bookmark"))
    XCTAssertEqual(defaults.string(forKey: "screenshot.fileNameTemplate"), "Bug_{timestamp}")
    XCTAssertEqual(defaults.string(forKey: "recording.fileNameTemplate"), "Session_{datetime}")
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
