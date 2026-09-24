import Foundation
import XCTest
@testable import Cinderdeck

/// Agent edits to workspace definitions and waiting for runs, through the same control API the MCP server uses.
@MainActor
final class WorkspaceDefinitionControlTests: XCTestCase {
  private var root: URL!
  private var supervisor: StackSupervisor!
  private var runner: WorkspaceRunner!
  private var control: StackControlService!
  private let agent = StackActor(kind: .agent, name: "Test Agent", session: "unit")

  override func setUp() async throws {
    root = try StackTestSupport.temporaryDirectory()
    let defaults = UserDefaults(suiteName: "WorkspaceDefinitionControl-\(UUID())")!
    defaults.set(root.appendingPathComponent("stacks").path, forKey: PreferencesKeys.stacksDirectory)
    supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("logs"))
    runner = WorkspaceRunner(supervisor: supervisor, store: .init(directory: root.appendingPathComponent("runs")),
      environment: { _ in ProcessInfo.processInfo.environment })
    await runner.recover()
    control = StackControlService(supervisor: supervisor, runner: runner, claimsFile: root.appendingPathComponent("claims.json"))
  }

  override func tearDown() async throws {
    await runner.cancelAll()
    await supervisor.shutdownMonitoring()
    try? FileManager.default.removeItem(at: root)
  }

  private func call(_ method: String, _ params: [String: JSONValue], as actor: StackActor? = nil) async throws -> JSONValue {
    try await control.handle(method, params: .object(params), actor: actor ?? agent)
  }

  private func source(_ id: String) throws -> String {
    try String(contentsOf: supervisor.definitionsDirectory.appendingPathComponent(id + ".toml"), encoding: .utf8)
  }

  func testAgentBuildsAWorkspaceFromScratch() async throws {
    let project = root.appendingPathComponent("project")
    try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
    let created = try await call("workspace.create", ["name": .string("My Shop"), "folder": .string(project.path)])
    XCTAssertEqual(created["created"], .string("my-shop"))
    XCTAssertNotNil(supervisor.definition("my-shop"))
    do { _ = try await call("workspace.create", ["name": .string("My Shop"), "folder": .string(project.path)]); XCTFail("Duplicate") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "invalid_definition") }

    _ = try await call("workspace.service.save", ["workspace": .string("My Shop"), "service": .string("api"),
      "cmd": .string("python3 -m http.server $PORT"), "port": .number(4100), "env": .object(["MODE": .string("dev")])])
    var service = try XCTUnwrap(supervisor.definition("my-shop")?.service("api"))
    XCTAssertEqual(service.readiness, .port(4100), "A new service with a port waits for it")
    XCTAssertEqual(service.directory.standardizedFileURL, project.standardizedFileURL)
    XCTAssertNil(service.repo, "Not a Git working tree")
    // A partial update keeps everything else.
    _ = try await call("workspace.service.save", ["workspace": .string("my-shop"), "service": .string("api"), "cmd": .string("npm run dev"),
      "ready": .string("log:listening on \\d+")])
    service = try XCTUnwrap(supervisor.definition("my-shop")?.service("api"))
    XCTAssertEqual(service.command, "npm run dev")
    XCTAssertEqual(service.port, 4100)
    XCTAssertEqual(service.environment, ["MODE": "dev"])
    XCTAssertEqual(service.readiness, .log("listening on \\d+"))

    _ = try await call("workspace.task.save", ["workspace": .string("my-shop"), "task": .string("test"), "name": .string("Tests"),
      "cmd": .string("echo ok"), "requires_services": .array([.string("api")]), "timeout": .number(120)])
    let task = try XCTUnwrap(supervisor.definition("my-shop")?.task("test"))
    XCTAssertEqual(task.name, "Tests")
    XCTAssertEqual(task.requiresServices, ["api"])
    XCTAssertEqual(task.timeout, 120)
    let saved = try await call("workspace.workflow.save", ["workspace": .string("my-shop"), "workflow": .string("verify"),
      "steps": .string("start:api, task:test"), "cleanup_services": .bool(true)])
    XCTAssertEqual(saved["saved"], .string("workflows.verify"))
    XCTAssertEqual(supervisor.definition("my-shop")?.workflow("verify")?.steps, ["start:api", "task:test"])

    // Invalid references are refused and leave the file untouched.
    let before = try source("my-shop")
    do {
      _ = try await call("workspace.workflow.save", ["workspace": .string("my-shop"), "workflow": .string("broken"), "steps": .array([.string("task:missing")])])
      XCTFail("Unknown task")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "invalid_definition") }
    do { _ = try await call("workspace.item.delete", ["workspace": .string("my-shop"), "kind": .string("task"), "id": .string("test")]); XCTFail("Referenced") }
    catch { XCTAssertTrue((error as? StackControlError)?.message.contains("Update references") == true, "\(error)") }
    XCTAssertEqual(try source("my-shop"), before)

    _ = try await call("workspace.item.delete", ["workspace": .string("my-shop"), "kind": .string("workflow"), "id": .string("verify")])
    _ = try await call("workspace.item.delete", ["workspace": .string("my-shop"), "kind": .string("task"), "id": .string("test")])
    XCTAssertTrue(supervisor.definition("my-shop")?.tasks.isEmpty == true)
    XCTAssertFalse(try source("my-shop").contains("[tasks.test]"))
  }

  func testServiceMovesToTasksAndClaimsProtectEdits() async throws {
    try FileManager.default.createDirectory(at: supervisor.definitionsDirectory, withIntermediateDirectories: true)
    try "name = \"Demo\"\nroot = \"\(root.path)\"\n\n# keep me\n[services.build]\ncmd = \"make\"\nenv.CI = \"1\"\n"
      .write(to: supervisor.definitionsDirectory.appendingPathComponent("demo.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    let other = StackActor(kind: .agent, name: "Other Agent")
    _ = try await call("claim", ["workspace": .string("demo")], as: other)
    do { _ = try await call("workspace.task.save", ["workspace": .string("demo"), "task": .string("build"), "from_service": .string("build")]); XCTFail("Claimed") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "claimed") }
    _ = try await call("workspace.task.save", ["workspace": .string("demo"), "task": .string("build"), "from_service": .string("build"), "force": .bool(true)])
    let definition = try XCTUnwrap(supervisor.definition("demo"))
    XCTAssertNil(definition.service("build"))
    XCTAssertEqual(definition.task("build")?.command, "make")
    XCTAssertEqual(definition.task("build")?.environment, ["CI": "1"])
    XCTAssertTrue(try source("demo").contains("# keep me"))
  }

  func testWaitReturnsTheResultAndFailingOutput() async throws {
    try FileManager.default.createDirectory(at: supervisor.definitionsDirectory, withIntermediateDirectories: true)
    try "[tasks.pass]\ncmd = \"echo fine\"\n[tasks.fail]\ncmd = \"echo broken; exit 3\"\n"
      .write(to: supervisor.definitionsDirectory.appendingPathComponent("demo.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    let passed = try await call("workspace.task.run", ["workspace": .string("demo"), "task": .string("pass")]).decode(WorkspaceRun.self)
    let passResult = try await call("workspace.run.wait", ["run": .string(passed.id.uuidString), "timeout": .number(30)])
    XCTAssertEqual(passResult["finished"], .bool(true))
    XCTAssertEqual(passResult["run"]?["status"], .string("succeeded"))
    XCTAssertNil(passResult["lastLines"])

    let failed = try await call("workspace.task.run", ["workspace": .string("demo"), "task": .string("fail")]).decode(WorkspaceRun.self)
    let failResult = try await call("workspace.run.wait", ["run": .string(failed.id.uuidString), "timeout": .number(30)])
    XCTAssertEqual(failResult["run"]?["status"], .string("failed"))
    XCTAssertTrue(failResult["lastLines"]?.stringsValue?.contains("broken") == true, "\(failResult)")

    // Runs are found by workspace name as well as id, and limited.
    let runs = try await call("workspace.runs", ["workspace": .string("demo"), "limit": .number(1)])
    XCTAssertEqual(runs.arrayValue?.count, 1)
    XCTAssertEqual(runs.arrayValue?.first?["id"], .string(failed.id.uuidString))
  }
}
