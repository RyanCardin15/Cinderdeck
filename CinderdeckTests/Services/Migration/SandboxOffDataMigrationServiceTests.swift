//
//  SandboxOffDataMigrationServiceTests.swift
//  CinderdeckTests
//
//  Tests for one-time App Sandbox data migration.
//

import Foundation
import XCTest
@testable import Cinderdeck

@MainActor
final class SandboxOffDataMigrationServiceTests: XCTestCase {
  private var rootDirectory: URL!
  private var homeDirectory: URL!
  private var libraryDirectory: URL!
  private var applicationSupportDirectory: URL!
  private var defaults: UserDefaults!
  private var bundleIdentifier: String!

  override func setUpWithError() throws {
    try super.setUpWithError()
    rootDirectory = FileManager.default.temporaryDirectory
      .appendingPathComponent("CinderdeckTests_SandboxOffMigration_\(UUID().uuidString)", isDirectory: true)
    homeDirectory = rootDirectory.appendingPathComponent("Home", isDirectory: true)
    libraryDirectory = rootDirectory
      .appendingPathComponent("DestinationLibrary", isDirectory: true)
    applicationSupportDirectory = libraryDirectory
      .appendingPathComponent("Application Support", isDirectory: true)
    bundleIdentifier = "com.ryancardin.cinderdeck.tests.\(UUID().uuidString)"
    defaults = UserDefaultsFactory.make()

    try FileManager.default.createDirectory(at: homeDirectory, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: applicationSupportDirectory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    defaults.removeObject(forKey: PreferencesKeys.sandboxOffMigrationCompleted)
    defaults = nil
    try? FileManager.default.removeItem(at: rootDirectory)
    try super.tearDownWithError()
  }

  func testRunIfNeeded_migratesSandboxedApplicationSupportPreferencesAndLogsOnce() throws {
    let sourceData = sourceDataDirectory()
    let sourceAppSupport = sourceData
      .appendingPathComponent("Library/Application Support/Cinderdeck", isDirectory: true)
    let sourceLogs = sourceData
      .appendingPathComponent("Library/Logs/Cinderdeck", isDirectory: true)
    let sourcePreferences = sourceData
      .appendingPathComponent("Library/Preferences", isDirectory: true)
      .appendingPathComponent("\(bundleIdentifier!).plist")
    try FileManager.default.createDirectory(at: sourceAppSupport, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      at: sourceAppSupport.appendingPathComponent("Captures", isDirectory: true),
      withIntermediateDirectories: true
    )
    try FileManager.default.createDirectory(at: sourceLogs, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: sourcePreferences.deletingLastPathComponent(), withIntermediateDirectories: true)

    try Data("database".utf8).write(to: sourceAppSupport.appendingPathComponent("cinderdeck.db"))
    try Data("capture".utf8).write(to: sourceAppSupport.appendingPathComponent("Captures/capture.png"))
    try Data("log".utf8).write(to: sourceLogs.appendingPathComponent("cinderdeck_2026-06-21.txt"))
    XCTAssertTrue(
      ([
        PreferencesKeys.screenshotFormat: "webp",
        PreferencesKeys.historyEnabled: false,
      ] as NSDictionary).write(to: sourcePreferences, atomically: true)
    )

    let firstResult = try makeService().runIfNeeded()

    XCTAssertTrue(firstResult.didRun)
    XCTAssertEqual(firstResult.copiedApplicationSupportItems, 2)
    XCTAssertEqual(firstResult.errorSkippedApplicationSupportItems, 0)
    XCTAssertEqual(defaults.string(forKey: PreferencesKeys.screenshotFormat), "webp")
    XCTAssertFalse(defaults.bool(forKey: PreferencesKeys.historyEnabled))
    XCTAssertTrue(defaults.bool(forKey: PreferencesKeys.sandboxOffMigrationCompleted))
    XCTAssertTrue(FileManager.default.fileExists(atPath: destinationAppSupport().appendingPathComponent("cinderdeck.db").path))
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: destinationAppSupport().appendingPathComponent("Captures/capture.png").path
      )
    )
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: libraryDirectory.appendingPathComponent("Logs/Cinderdeck/cinderdeck_2026-06-21.txt").path
      )
    )
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: destinationAppSupport().appendingPathComponent(".sandbox-off-migration-completed").path
      )
    )

    let secondResult = try makeService().runIfNeeded()

    XCTAssertFalse(secondResult.didRun)
    XCTAssertEqual(secondResult.copiedApplicationSupportItems, 0)
  }

  func testRunIfNeeded_preservesExistingUnsandboxedFilesAndPreferences() throws {
    let sourceAppSupport = sourceDataDirectory()
      .appendingPathComponent("Library/Application Support/Cinderdeck", isDirectory: true)
    try FileManager.default.createDirectory(
      at: sourceAppSupport.appendingPathComponent("Captures", isDirectory: true),
      withIntermediateDirectories: true
    )
    try Data("sandbox database".utf8).write(to: sourceAppSupport.appendingPathComponent("cinderdeck.db"))
    try Data("sandbox capture".utf8).write(to: sourceAppSupport.appendingPathComponent("Captures/capture.png"))

    try FileManager.default.createDirectory(
      at: destinationAppSupport().appendingPathComponent("Captures", isDirectory: true),
      withIntermediateDirectories: true
    )
    try Data("current database".utf8).write(to: destinationAppSupport().appendingPathComponent("cinderdeck.db"))

    let sourcePreferences = sourceDataDirectory()
      .appendingPathComponent("Library/Preferences", isDirectory: true)
      .appendingPathComponent("\(bundleIdentifier!).plist")
    try FileManager.default.createDirectory(at: sourcePreferences.deletingLastPathComponent(), withIntermediateDirectories: true)
    XCTAssertTrue(
      ([
        PreferencesKeys.historyEnabled: false,
        PreferencesKeys.screenshotFormat: "webp",
      ] as NSDictionary).write(to: sourcePreferences, atomically: true)
    )

    let destinationPreferences = libraryDirectory
      .appendingPathComponent("Preferences", isDirectory: true)
      .appendingPathComponent("\(bundleIdentifier!).plist")
    try FileManager.default.createDirectory(at: destinationPreferences.deletingLastPathComponent(), withIntermediateDirectories: true)
    XCTAssertTrue(([PreferencesKeys.historyEnabled: true] as NSDictionary).write(to: destinationPreferences, atomically: true))
    defaults.set(true, forKey: PreferencesKeys.historyEnabled)

    let result = try makeService().runIfNeeded()

    XCTAssertEqual(result.copiedApplicationSupportItems, 1)
    XCTAssertEqual(result.skippedApplicationSupportItems, 1)
    XCTAssertEqual(
      try String(contentsOf: destinationAppSupport().appendingPathComponent("cinderdeck.db")),
      "current database"
    )
    XCTAssertEqual(
      try String(contentsOf: destinationAppSupport().appendingPathComponent("Captures/capture.png")),
      "sandbox capture"
    )
    XCTAssertTrue(defaults.bool(forKey: PreferencesKeys.historyEnabled))
    XCTAssertEqual(defaults.string(forKey: PreferencesKeys.screenshotFormat), "webp")
  }

  func testRunIfNeeded_skipsWhileStillRunningSandboxed() throws {
    let result = try makeService(isRunningSandboxed: true).runIfNeeded()

    XCTAssertFalse(result.didRun)
    XCTAssertFalse(defaults.bool(forKey: PreferencesKeys.sandboxOffMigrationCompleted))
  }

  func testRunIfNeeded_marksCompletedWhenNoSandboxContainerExists() throws {
    let firstResult = try makeService().runIfNeeded()
    let secondResult = try makeService().runIfNeeded()

    XCTAssertTrue(firstResult.didRun)
    XCTAssertFalse(secondResult.didRun)
    XCTAssertTrue(defaults.bool(forKey: PreferencesKeys.sandboxOffMigrationCompleted))
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: destinationAppSupport().appendingPathComponent(".sandbox-off-migration-completed").path
      )
    )
  }

  func testRunIfNeeded_doesNotMarkCompletedWhenApplicationSupportCopyFails() throws {
    let sourceAppSupport = sourceDataDirectory()
      .appendingPathComponent("Library/Application Support/Cinderdeck", isDirectory: true)
    try FileManager.default.createDirectory(at: sourceAppSupport, withIntermediateDirectories: true)
    try Data("database".utf8).write(to: sourceAppSupport.appendingPathComponent("cinderdeck.db"))

    try FileManager.default.removeItem(at: applicationSupportDirectory)
    try Data("not a directory".utf8).write(to: applicationSupportDirectory)

    XCTAssertThrowsError(try makeService().runIfNeeded())
    XCTAssertFalse(defaults.bool(forKey: PreferencesKeys.sandboxOffMigrationCompleted))
  }

  func testSkipMigration_marksCompletedWithoutCopyingData() throws {
    // Setup: create source container with data
    let sourceAppSupport = sourceDataDirectory()
      .appendingPathComponent("Library/Application Support/Cinderdeck", isDirectory: true)
    try FileManager.default.createDirectory(at: sourceAppSupport, withIntermediateDirectories: true)
    try Data("database".utf8).write(to: sourceAppSupport.appendingPathComponent("cinderdeck.db"))

    let service = makeService()

    // Act
    try service.skipMigration()

    // Assert: migration marked complete
    XCTAssertTrue(defaults.bool(forKey: PreferencesKeys.sandboxOffMigrationCompleted))
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: destinationAppSupport()
          .appendingPathComponent(".sandbox-off-migration-completed").path
      )
    )

    // Assert: NO data copied
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: destinationAppSupport().appendingPathComponent("cinderdeck.db").path
      )
    )

    // Assert: runIfNeeded now skips
    let result = try service.runIfNeeded()
    XCTAssertFalse(result.didRun)
  }

  func testSkipMigration_preservesSourceContainerData() throws {
    let sourceAppSupport = sourceDataDirectory()
      .appendingPathComponent("Library/Application Support/Cinderdeck", isDirectory: true)
    try FileManager.default.createDirectory(at: sourceAppSupport, withIntermediateDirectories: true)
    try Data("precious data".utf8).write(to: sourceAppSupport.appendingPathComponent("cinderdeck.db"))

    try makeService().skipMigration()

    // Old data still exists
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: sourceAppSupport.appendingPathComponent("cinderdeck.db").path
      )
    )
  }

  func testRunIfNeeded_skipsUnreadableFilesAndContinues() throws {
    let sourceAppSupport = sourceDataDirectory()
      .appendingPathComponent("Library/Application Support/Cinderdeck", isDirectory: true)
    try FileManager.default.createDirectory(at: sourceAppSupport, withIntermediateDirectories: true)

    // Create two files: one readable, one not
    let readableFile = sourceAppSupport.appendingPathComponent("readable.txt")
    let unreadableFile = sourceAppSupport.appendingPathComponent("unreadable.txt")
    try Data("readable".utf8).write(to: readableFile)
    try Data("secret".utf8).write(to: unreadableFile)

    // Make one file unreadable
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o000], ofItemAtPath: unreadableFile.path
    )

    // Act
    let result = try makeService().runIfNeeded()

    // Assert: migration ran, readable file copied, unreadable skipped
    XCTAssertTrue(result.didRun)
    XCTAssertEqual(result.copiedApplicationSupportItems, 1)
    XCTAssertEqual(result.errorSkippedApplicationSupportItems, 1)
    XCTAssertTrue(
      FileManager.default.fileExists(
        atPath: destinationAppSupport().appendingPathComponent("readable.txt").path
      )
    )
    XCTAssertFalse(
      FileManager.default.fileExists(
        atPath: destinationAppSupport().appendingPathComponent("unreadable.txt").path
      )
    )

    // Cleanup: restore permissions so tearDown can delete
    try? FileManager.default.setAttributes(
      [.posixPermissions: 0o644], ofItemAtPath: unreadableFile.path
    )
  }

  func testRunIfNeeded_skipsUnreadableDirectoryAndContinues() throws {
    let sourceAppSupport = sourceDataDirectory()
      .appendingPathComponent("Library/Application Support/Cinderdeck", isDirectory: true)
    let readableSubdir = sourceAppSupport.appendingPathComponent("Captures", isDirectory: true)
    let unreadableSubdir = sourceAppSupport.appendingPathComponent("Locked", isDirectory: true)

    try FileManager.default.createDirectory(at: readableSubdir, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: unreadableSubdir, withIntermediateDirectories: true)
    try Data("capture".utf8).write(to: readableSubdir.appendingPathComponent("img.png"))
    try Data("locked".utf8).write(to: unreadableSubdir.appendingPathComponent("secret.dat"))

    // Make subdir unreadable (contentsOfDirectory will throw)
    try FileManager.default.setAttributes(
      [.posixPermissions: 0o000], ofItemAtPath: unreadableSubdir.path
    )

    let result = try makeService().runIfNeeded()

    XCTAssertTrue(result.didRun)
    XCTAssertGreaterThanOrEqual(result.copiedApplicationSupportItems, 1)
    XCTAssertGreaterThanOrEqual(result.errorSkippedApplicationSupportItems, 1)

    // Cleanup
    try? FileManager.default.setAttributes(
      [.posixPermissions: 0o755], ofItemAtPath: unreadableSubdir.path
    )
  }

  private func makeService(isRunningSandboxed: Bool = false) -> SandboxOffDataMigrationService {
    SandboxOffDataMigrationService {
      SandboxOffDataMigrationService.Configuration(
        bundleIdentifier: self.bundleIdentifier,
        homeDirectory: self.homeDirectory,
        applicationSupportDirectory: self.applicationSupportDirectory,
        libraryDirectory: self.libraryDirectory,
        userDefaults: self.defaults,
        fileManager: .default,
        isRunningSandboxed: isRunningSandboxed
      )
    }
  }

  private func sourceDataDirectory() -> URL {
    homeDirectory
      .appendingPathComponent("Library/Containers", isDirectory: true)
      .appendingPathComponent(bundleIdentifier, isDirectory: true)
      .appendingPathComponent("Data", isDirectory: true)
  }

  private func destinationAppSupport() -> URL {
    applicationSupportDirectory.appendingPathComponent("Cinderdeck", isDirectory: true)
  }
}

