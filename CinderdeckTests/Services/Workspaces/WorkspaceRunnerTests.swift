import Foundation
import XCTest
@testable import Cinderdeck

@MainActor
final class WorkspaceRunnerTests: XCTestCase {
  private var root: URL!
  private var supervisor: StackSupervisor!
  private var runner: WorkspaceRunner!
  private var store: WorkspaceRunStore!
  override func setUp() async throws {
    root = try StackTestSupport.temporaryDirectory()
    let defaults = UserDefaults(suiteName: "WorkspaceTests-\(UUID())")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    let pool = try DatabaseManager.openDatabase(at: root.appendingPathComponent("db")).dbPool
    supervisor = StackSupervisor(store: StackRunStore(pool: pool), defaults: defaults, logRoot: root.appendingPathComponent("services"), environment: { _ in ProcessInfo.processInfo.environment })
    store = WorkspaceRunStore(directory: root.appendingPathComponent("runs"))
    runner = WorkspaceRunner(supervisor: supervisor, store: store, environment: { _ in ProcessInfo.processInfo.environment })
    await runner.recover()
  }
  override func tearDown() async throws {
    await runner?.cancelAll()
    await supervisor?.stopAll()
    await supervisor?.shutdownMonitoring()
    if let root { try? FileManager.default.removeItem(at: root) }
    runner = nil; supervisor = nil; store = nil; root = nil
  }
  private func load(_ source: String) async throws {
    try ("root = \(WorkspaceDefinitionWriter.quote(root.path))\nshell = \"/bin/sh\"\n" + source)
      .write(to: root.appendingPathComponent("test.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    XCTAssertNotNil(supervisor.definition("test"), supervisor.files.flatMap(\.issues).map(\.message).joined(separator: "; "))
  }
  private func wait(_ id: UUID, seconds: Double = 8) async throws -> WorkspaceRun {
    let deadline = Date().addingTimeInterval(seconds)
    while runner.run(id)?.status.isActive == true && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
    let result = try XCTUnwrap(runner.run(id))
    XCTAssertFalse(result.status.isActive, "Run did not finish: \(result)")
    return result
  }
  func testShortTaskSucceedsWithExitCodeAndFinalOutputAndSurvivesReload() async throws {
    try await load("[tasks.test]\ncmd = \"printf finished\"\n")
    let run = try runner.submit(workspace: "test", kind: .task, definitionID: "test")
    let result = try await wait(run.id)
    XCTAssertEqual(result.status, .succeeded)
    XCTAssertEqual(result.steps.first?.exitCode, 0)
    XCTAssertNotNil(result.finishedAt)
    let output = await runner.output(run.id)
    XCTAssertTrue(output.map(\.text).joined().contains("finished"))
    let restored = try store.load()
    XCTAssertEqual(restored.first?.status, .succeeded)
    XCTAssertEqual(restored.first?.steps.first?.exitCode, 0)
  }
  func testWorkflowStopsAtFailureAndDoesNotExecuteLaterSteps() async throws {
    try await load("""
    [tasks.first]
    cmd = "echo first >> sequence"
    [tasks.fail]
    cmd = "echo failure; exit 7"
    [tasks.later]
    cmd = "echo later >> sequence"
    [workflows.verify]
    steps = ["task:first", "task:fail", "task:later"]
    """)
    let run = try runner.submit(workspace: "test", kind: .workflow, definitionID: "verify")
    let result = try await wait(run.id)
    XCTAssertEqual(result.status, .failed)
    XCTAssertEqual(result.steps.map(\.status), [.succeeded, .failed, .skipped])
    XCTAssertEqual(result.steps[1].exitCode, 7)
    XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("sequence")), "first\n")
  }
  func testCancelKillsDescendantsAndSkipsNextStep() async throws {
    try await load("""
    [tasks.wait]
    cmd = "echo $$ > pid; sleep 300 & wait"
    [tasks.later]
    cmd = "touch should-not-exist"
    [workflows.cancel]
    steps = ["task:wait", "task:later"]
    """)
    let run = try runner.submit(workspace: "test", kind: .workflow, definitionID: "cancel")
    let deadline = Date().addingTimeInterval(3)
    while !FileManager.default.fileExists(atPath: root.appendingPathComponent("pid").path), Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
    XCTAssertThrowsError(try runner.submit(workspace: "test", kind: .task, definitionID: "wait"))
    try await runner.cancel(run.id)
    let result = try await wait(run.id)
    XCTAssertEqual(result.status, .cancelled)
    XCTAssertEqual(result.steps.last?.status, .skipped)
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("should-not-exist").path))
    let pid = try String(contentsOf: root.appendingPathComponent("pid")).trimmingCharacters(in: .whitespacesAndNewlines)
    let remaining = try await StackCommandRunner.run("/usr/bin/pgrep", ["-g", pid])
    XCTAssertEqual(remaining.status, 1)
  }
  func testTimeoutFailsWithoutRetry() async throws {
    try await load("[tasks.slow]\ncmd = \"echo once >> count; sleep 300\"\ntimeout = 0.15\n")
    let result = try await wait(try runner.submit(workspace: "test", kind: .task, definitionID: "slow").id)
    XCTAssertEqual(result.status, .failed)
    XCTAssertTrue(result.detail?.contains("timeout") == true)
    XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("count")), "once\n")
  }
  func testWorkflowStartsDependenciesAndCleansUpOnlyNewServices() async throws {
    try await load("""
    [services.database]
    cmd = "echo READY; sleep 300"
    ready.log = "READY"
    [services.api]
    cmd = "echo READY; sleep 300"
    depends_on = ["database"]
    ready.log = "READY"
    [tasks.test]
    cmd = "echo tested"
    requires_services = ["api"]
    [workflows.test]
    steps = ["task:test"]
    cleanup_services = true
    """)
    await supervisor.start(stack: "test", services: ["database"])
    let existing = supervisor.runtime("test", "database").process
    let result = try await wait(try runner.submit(workspace: "test", kind: .workflow, definitionID: "test").id)
    XCTAssertEqual(result.status, .succeeded, result.detail ?? "")
    XCTAssertEqual(supervisor.runtime("test", "database").process, existing)
    XCTAssertNotNil(existing)
    XCTAssertNil(supervisor.runtime("test", "api").process)
  }
  func testUnhealthyDependencyDoesNotRunTask() async throws {
    try await load("""
    [services.api]
    cmd = "sleep 300"
    ready.log = "NEVER"
    ready.timeout = 0.1
    [tasks.test]
    cmd = "touch should-not-exist"
    requires_services = ["api"]
    [workflows.test]
    steps = ["task:test"]
    cleanup_services = true
    """)
    let result = try await wait(try runner.submit(workspace: "test", kind: .workflow, definitionID: "test").id)
    XCTAssertEqual(result.status, .failed)
    XCTAssertTrue(result.detail?.contains("not ready") == true)
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("should-not-exist").path))
    XCTAssertNil(supervisor.runtime("test", "api").process)
  }
  func testDefinitionEditDoesNotChangeAlreadySubmittedWorkflow() async throws {
    try await load("""
    [tasks.test]
    cmd = "sleep 0.2; echo original > result"
    [workflows.test]
    steps = ["task:test", "task:test"]
    """)
    let run = try runner.submit(workspace: "test", kind: .workflow, definitionID: "test")
    try await load("[tasks.test]\ncmd = \"echo edited > result\"\n")
    let result = try await wait(run.id)
    XCTAssertEqual(result.status, .succeeded)
    XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("result")), "original\n")
  }
  func testRecoveryStopsSavedProcessAndMarksInterrupted() async throws {
    let process = ServiceProcess()
    let identity = try await process.launch(StackTestSupport.simpleDefinition(root: root, command: "sleep 300 & wait"), environment: ProcessInfo.processInfo.environment, logURL: root.appendingPathComponent("orphan.log"))
    let saved = WorkspaceRun(workspaceID: "test", workspaceName: "Test", definitionID: "old", name: "Old", kind: .task,
      status: .running, actor: .user, steps: [.init(reference: "task:old", title: "Old", status: .running, process: identity)])
    try store.save([saved])
    let restored = WorkspaceRunner(supervisor: supervisor, store: store)
    await restored.recover()
    _ = await process.waitForExit()
    XCTAssertFalse(identity.matchesLiveProcess)
    XCTAssertEqual(restored.run(saved.id)?.status, .interrupted)
    XCTAssertFalse(restored.hasActiveRuns)
  }
  func testSuccessfulTaskCannotLeaveBackgroundChildren() async throws {
    try await load("[tasks.background]\ncmd = \"sleep 300 & echo $! > child; echo done\"\n")
    let result = try await wait(try runner.submit(workspace: "test", kind: .task, definitionID: "background").id)
    XCTAssertEqual(result.status, .succeeded)
    let child = try String(contentsOf: root.appendingPathComponent("child")).trimmingCharacters(in: .whitespacesAndNewlines)
    let pid = try XCTUnwrap(Int32(child))
    XCTAssertNil(StackProcessIdentity.startTime(pid: pid))
  }
  func testInterruptedRunIsNotReplayed() async throws {
    let saved = WorkspaceRun(workspaceID: "test", workspaceName: "Test", definitionID: "old", name: "Old task", kind: .task,
      status: .running, actor: .user, steps: [.init(reference: "task:old", title: "Old task", status: .running)])
    try store.save([saved])
    let restored = WorkspaceRunner(supervisor: supervisor, store: store)
    await restored.recover()
    XCTAssertEqual(restored.run(saved.id)?.status, .interrupted)
    XCTAssertFalse(restored.hasActiveRuns)
  }
}
