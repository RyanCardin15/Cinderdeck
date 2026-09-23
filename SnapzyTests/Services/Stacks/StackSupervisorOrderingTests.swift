import Foundation
import XCTest
@testable import Snapzy

private actor StackFakeTimeline {
  var events: [String] = []
  var nextPID: Int32 = 60000
  func record(_ event: String) { events.append(event) }
  func snapshot() -> [String] { events }
  func allocate() -> Int32 { nextPID += 1; return nextPID }
}

private actor StackFakeProcess: ProcessLaunching {
  let timeline: StackFakeTimeline
  var service = ""
  var process: StackProcessIdentity?
  var result: StackProcessExit?
  var continuation: CheckedContinuation<StackProcessExit, Never>?
  init(timeline: StackFakeTimeline) { self.timeline = timeline }
  func launch(_ definition: StackLaunchDefinition, environment: [String: String], logURL: URL) async throws -> StackProcessIdentity {
    service = definition.service.id
    await timeline.record("start:\(service)")
    try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: logURL)
    let pid = await timeline.allocate()
    let identity = StackProcessIdentity(pid: pid, pgid: pid, startTime: Date().timeIntervalSince1970)
    process = identity
    return identity
  }
  func reattach(_ identity: StackProcessIdentity) { process = identity }
  func identity() -> StackProcessIdentity? { process }
  func waitForExit() async -> StackProcessExit {
    if let result { return result }
    return await withCheckedContinuation { continuation = $0 }
  }
  func stop(signal: Int32, timeout: TimeInterval) async throws {
    await timeline.record("stop:\(service)")
    let exit = StackProcessExit(code: 0)
    result = exit; process = nil; continuation?.resume(returning: exit); continuation = nil
  }
}

@MainActor
final class StackSupervisorOrderingTests: XCTestCase {
  private var root: URL!
  private var defaults: UserDefaults!
  private var supervisor: StackSupervisor!
  private var timeline: StackFakeTimeline!
  override func setUp() async throws {
    root = try StackTestSupport.temporaryDirectory()
    defaults = UserDefaults(suiteName: "SnapzyStacksTests-\(UUID().uuidString)")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    timeline = StackFakeTimeline()
    let pool = try DatabaseManager.openDatabase(at: root.appendingPathComponent("runs.db")).dbPool
    let timeline = timeline!
    supervisor = StackSupervisor(store: StackRunStore(pool: pool), defaults: defaults,
      logRoot: root.appendingPathComponent("logs"), makeProcess: { StackFakeProcess(timeline: timeline) },
      environment: { _ in [:] }, inspectPort: { port in port == 12345 ? .init(port: port, owners: [.init(pid: 99999, name: "fixture", startTime: 1)]) : nil }, probe: { readiness, started, _ in
        switch readiness {
        case .log("slow"): return Date().timeIntervalSince(started) > 1.3
        case .log("never"): return false
        default: return true
        }
      })
  }
  override func tearDown() async throws {
    await supervisor?.stopAll()
    await supervisor?.shutdownMonitoring()
    if let root { try? FileManager.default.removeItem(at: root) }
    supervisor = nil; defaults = nil; root = nil
  }
  private func load(_ source: String) async throws {
    try source.write(to: root.appendingPathComponent("test.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    XCTAssertNotNil(supervisor.definition("test"), supervisor.files.flatMap(\.issues).map(\.message).joined())
  }
  func testIndependentStartsAndDependentsDontWaitForUnrelatedSlowService() async throws {
    try await load("""
      [services.a]
      cmd = "a"
      [services.b]
      cmd = "b"
      depends_on = ["a"]
      [services.slow]
      cmd = "slow"
      ready.log = "slow"
      """)
    let task = Task { await supervisor.start(stack: "test") }
    try await Task.sleep(nanoseconds: 600_000_000)
    XCTAssertEqual(supervisor.runtime("test", "b").phase, .ready)
    XCTAssertEqual(supervisor.runtime("test", "slow").phase, .starting)
    await task.value
    await supervisor.stop(stack: "test")
    let events = await timeline.snapshot()
    XCTAssertLessThan(events.firstIndex(of: "start:a")!, events.firstIndex(of: "start:b")!)
    XCTAssertLessThan(events.firstIndex(of: "stop:b")!, events.firstIndex(of: "stop:a")!)
  }
  func testTimeoutUnhealthyStillUnblocksDependent() async throws {
    try await load("""
      [services.a]
      cmd = "a"
      ready.log = "never"
      ready.timeout = 0.1
      [services.b]
      cmd = "b"
      depends_on = ["a"]
      """)
    await supervisor.start(stack: "test")
    XCTAssertEqual(supervisor.runtime("test", "a").phase, .unhealthy)
    XCTAssertEqual(supervisor.runtime("test", "b").phase, .ready)
  }
  func testOptionalDependencyWaitsThenManualStartWakesDependent() async throws {
    try await load("""
      [services.a]
      cmd = "a"
      autostart = false
      [services.b]
      cmd = "b"
      depends_on = ["a"]
      """)
    await supervisor.start(stack: "test")
    XCTAssertEqual(supervisor.runtime("test", "a").phase, .stopped)
    XCTAssertEqual(supervisor.runtime("test", "b").phase, .waiting)
    await supervisor.start(stack: "test", services: ["a"])
    try await Task.sleep(nanoseconds: 350_000_000)
    XCTAssertEqual(supervisor.runtime("test", "b").phase, .ready)
  }
  func testFailedCheckoutRestartsOnlyAffectedRunningServices() async throws {
    try await load("""
      [repos.repo]
      path = "."
      [services.api]
      cmd = "api"
      repo = "repo"
      [services.worker]
      cmd = "worker"
      repo = "repo"
      autostart = false
      [services.other]
      cmd = "other"
      """)
    await supervisor.start(stack: "test")
    do {
      try await supervisor.performGitChange(stack: "test", repos: ["repo"]) { throw StackError.message("checkout failed") }
      XCTFail("Expected failure")
    } catch { XCTAssertEqual(error.localizedDescription, "checkout failed") }
    let events = await timeline.snapshot()
    XCTAssertEqual(events.filter { $0 == "start:api" }.count, 2)
    XCTAssertEqual(events.filter { $0 == "start:other" }.count, 1)
    XCTAssertFalse(events.contains("start:worker"))
    XCTAssertEqual(supervisor.runtime("test", "api").phase, .ready)
  }
  func testSharedProjectRestartsAcrossStacksAndKeepsUnrelatedService() async throws {
    try await load("[repos.shared]\npath = \".\"\n[services.api]\ncmd = \"api\"\nrepo = \"shared\"\n[services.unrelated]\ncmd = \"other\"")
    try "[repos.same-folder]\npath = \".\"\n[services.worker]\ncmd = \"worker\"\nrepo = \"same-folder\"".write(to: root.appendingPathComponent("other.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    await supervisor.start(stack: "test")
    await supervisor.start(stack: "other")
    try await supervisor.performGitChange(stack: "test", repos: ["shared"], eventDetail: "main → feature") {
      XCTAssertNil(self.supervisor.runtime("test", "api").process)
      XCTAssertNil(self.supervisor.runtime("other", "worker").process)
      XCTAssertNotNil(self.supervisor.runtime("test", "unrelated").process)
    }
    let events = await timeline.snapshot()
    XCTAssertEqual(events.filter { $0 == "start:api" }.count, 2)
    XCTAssertEqual(events.filter { $0 == "start:worker" }.count, 2)
    XCTAssertEqual(events.filter { $0 == "start:unrelated" }.count, 1)
    let activity = await supervisor.events(stack: "other")
    XCTAssertTrue(activity.contains { $0.kind == "branchSwitched" && $0.detail == "main → feature" })
  }
  func testReloadKeepsOldLaunchDefinitionAndStopWorksAfterFileRemoval() async throws {
    try await load("[services.app]\ncmd = \"first\"")
    await supervisor.start(stack: "test")
    try await load("[services.app]\ncmd = \"second\"")
    XCTAssertTrue(supervisor.definitionChanged("test"))
    XCTAssertEqual(supervisor.runtime("test", "app").launchDefinition?.service.command, "first")
    try FileManager.default.removeItem(at: root.appendingPathComponent("test.toml"))
    await supervisor.reloadDefinitions()
    XCTAssertNotNil(supervisor.files.first { $0.id == "test" })
    await supervisor.stop(stack: "test")
    XCTAssertFalse(supervisor.hasRunningServices)
  }
  func testStopDuringReadinessDoesNotRestartOrLaunchDependent() async throws {
    try await load("[services.a]\ncmd = \"a\"\nready.log = \"slow\"\n[services.b]\ncmd = \"b\"\ndepends_on = [\"a\"]")
    let start = Task { await supervisor.start(stack: "test") }
    try await Task.sleep(nanoseconds: 200_000_000)
    await supervisor.stop(stack: "test")
    await start.value
    XCTAssertFalse(supervisor.hasRunningServices)
    let events = await timeline.snapshot()
    XCTAssertFalse(events.contains("start:b"))
  }
  func testLeaveRunningCancelsPendingDependentsAndRetainsRecordedProcess() async throws {
    try await load("[services.a]\ncmd = \"a\"\nready.log = \"slow\"\n[services.b]\ncmd = \"b\"\ndepends_on = [\"a\"]")
    let start = Task { await supervisor.start(stack: "test") }
    try await Task.sleep(nanoseconds: 150_000_000)
    let identity = supervisor.runtime("test", "a").process
    XCTAssertNotNil(identity)
    await supervisor.prepareToLeaveRunning()
    await start.value
    XCTAssertEqual(supervisor.runtime("test", "a").process, identity)
    XCTAssertNil(supervisor.runtime("test", "b").process)
    XCTAssertEqual(supervisor.runtime("test", "b").phase, .stopped)
    let events = await timeline.snapshot()
    XCTAssertFalse(events.contains("stop:a"))
    XCTAssertFalse(events.contains("start:b"))
  }
  func testRestartPolicyBackoffAndRollingWindow() {
    var policy = StackRestartPolicy()
    let now = Date()
    XCTAssertEqual(policy.delay(now: now), 1)
    XCTAssertEqual(policy.delay(now: now.addingTimeInterval(1)), 2)
    XCTAssertEqual(policy.delay(now: now.addingTimeInterval(3)), 4)
    XCTAssertNil(policy.delay(now: now.addingTimeInterval(7)))
    XCTAssertEqual(policy.delay(now: now.addingTimeInterval(64)), 1)
  }

  func testPortConflictDoesNotSpawnAndShowsOwner() async throws {
    try await load("[services.app]\ncmd = \"app\"\nport = 12345")
    await supervisor.start(stack: "test")
    XCTAssertEqual(supervisor.runtime("test", "app").phase, .crashed)
    XCTAssertEqual(supervisor.runtime("test", "app").conflict?.owners.first?.name, "fixture")
    let events = await timeline.snapshot()
    XCTAssertTrue(events.isEmpty)
  }

  func testStoppingOneStartingServiceDoesNotCancelSibling() async throws {
    try await load("[services.a]\ncmd = \"a\"\nready.log = \"slow\"\n[services.b]\ncmd = \"b\"\nready.log = \"slow\"")
    let start = Task { await supervisor.start(stack: "test") }
    try await Task.sleep(nanoseconds: 250_000_000)
    await supervisor.stop(stack: "test", services: ["a"])
    await start.value
    XCTAssertEqual(supervisor.runtime("test", "a").phase, .stopped)
    XCTAssertEqual(supervisor.runtime("test", "b").phase, .ready)
  }
}
