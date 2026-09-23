import Foundation
import XCTest
@testable import Snapzy

private actor StackRetryEnvironment {
  private var calls = 0
  func resolve() async -> [String: String] {
    calls += 1
    if calls > 1 { try? await Task.sleep(nanoseconds: 700_000_000) }
    return ProcessInfo.processInfo.environment
  }
  func count() -> Int { calls }
}

@MainActor
final class StackCrashRecoveryTests: XCTestCase {
  func testStopDuringRetryLaunchDoesNotStartAnotherProcess() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    try "shell = \"/bin/sh\"\n[services.crash]\ncmd = \"sleep 0.1; exit 7\"".write(to: root.appendingPathComponent("test.toml"), atomically: true, encoding: .utf8)
    let defaults = UserDefaults(suiteName: "SnapzyStacksTests-\(UUID().uuidString)")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    let environment = StackRetryEnvironment()
    let store = StackRunStore(pool: try DatabaseManager.openDatabase(at: root.appendingPathComponent("runs.db")).dbPool)
    let supervisor = StackSupervisor(store: store, defaults: defaults, logRoot: root.appendingPathComponent("logs"), environment: { _ in await environment.resolve() })
    await supervisor.reloadDefinitions()
    let start = Task { await supervisor.start(stack: "test") }
    let deadline = Date().addingTimeInterval(5)
    while await environment.count() < 2, Date() < deadline { try await Task.sleep(nanoseconds: 25_000_000) }
    let calls = await environment.count()
    XCTAssertEqual(calls, 2)
    await supervisor.stop(stack: "test", services: ["crash"])
    await start.value
    try await Task.sleep(nanoseconds: 900_000_000)
    XCTAssertNil(supervisor.runtime("test", "crash").process)
    XCTAssertEqual(supervisor.runtime("test", "crash").phase, .stopped)
    let events = await supervisor.events(stack: "test")
    XCTAssertEqual(events.filter { $0.kind == "started" }.count, 1)
    await supervisor.stopAll(); await supervisor.shutdownMonitoring()
  }
  func testRealCrashingProcessRestartsThreeTimesThenStops() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let source = "shell = \"/bin/sh\"\n[services.crash]\ncmd = \"sleep 0.1; echo failing; exit 7\""
    try source.write(to: root.appendingPathComponent("test.toml"), atomically: true, encoding: .utf8)
    let defaults = UserDefaults(suiteName: "SnapzyStacksTests-\(UUID().uuidString)")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    let store = StackRunStore(pool: try DatabaseManager.openDatabase(at: root.appendingPathComponent("runs.db")).dbPool)
    let supervisor = StackSupervisor(store: store, defaults: defaults, logRoot: root.appendingPathComponent("logs"), environment: { _ in ProcessInfo.processInfo.environment })
    await supervisor.reloadDefinitions()
    let start = Task { await supervisor.start(stack: "test") }
    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline {
      if supervisor.runtime("test", "crash").restartCount == 3 && supervisor.runtime("test", "crash").phase == .crashed { break }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    XCTAssertEqual(supervisor.runtime("test", "crash").restartCount, 3)
    XCTAssertEqual(supervisor.runtime("test", "crash").phase, .crashed)
    let events = await supervisor.events(stack: "test")
    XCTAssertEqual(events.filter { $0.kind == "crashed" }.count, 4)
    let records = try await store.records()
    XCTAssertTrue(records.isEmpty)
    await start.value
    await supervisor.stopAll(); await supervisor.shutdownMonitoring()
  }
}
