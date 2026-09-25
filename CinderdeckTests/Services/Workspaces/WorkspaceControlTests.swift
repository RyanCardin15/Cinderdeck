import Foundation
import XCTest
@testable import Cinderdeck

final class WorkspaceControlTests: XCTestCase {
  func testDefinitionCLICommandsUseTheMCPContract() throws {
    for (args, tool, params) in [
      (["create", "--name", "Shop", "--folder", "/tmp", "--id", "shop"], "create_workspace", ["name": JSONValue.string("Shop"), "folder": .string("/tmp"), "id": .string("shop")]),
      (["edit", "shop", "--name", "New Shop"], "save_workspace", ["workspace": .string("shop"), "name": .string("New Shop")]),
      (["definition", "shop"], "workspace_definition", ["workspace": .string("shop")]),
      (["remove", "shop"], "delete_workspace", ["workspace": .string("shop")]),
      (["save-service", "shop", "api", "--data", "{\"cmd\":\"npm run dev\",\"autostart\":false}"], "save_workspace_service", ["workspace": .string("shop"), "service": .string("api"), "cmd": .string("npm run dev"), "autostart": .bool(false)]),
      (["save-task", "shop", "test", "--data", "{\"cmd\":\"npm test\"}"], "save_workspace_task", ["workspace": .string("shop"), "task": .string("test"), "cmd": .string("npm test")]),
      (["save-workflow", "shop", "verify", "--data", "{\"steps\":[\"task:test\"]}"], "save_workspace_workflow", ["workspace": .string("shop"), "workflow": .string("verify"), "steps": .array([.string("task:test")])]),
      (["delete-item", "shop", "service", "api"], "delete_workspace_item", ["workspace": .string("shop"), "kind": .string("service"), "id": .string("api")]),
      (["open", "shop", "--section", "tasks"], "open_workspace", ["workspace": .string("shop"), "section": .string("tasks")]),
    ] {
      let cli = try WorkspaceCLI.request(WorkspaceCLI.parse(args))
      let mcp = try AgentToolCLI.request(name: tool, arguments: params)
      XCTAssertEqual(cli.method, mcp.0)
      XCTAssertEqual(cli.params, mcp.1)
    }
    let run = UUID().uuidString
    XCTAssertEqual(try WorkspaceCLI.request(WorkspaceCLI.parse(["logs", run, "-n", "12"])).params["lines"], .number(12))
    for args in [["list", "--force"], ["edit", "shop", "--name"], ["create", "--name", "A", "--name", "B"],
      ["logs", run, "--lines", "oops"], ["save", "shop"], ["save-service", "shop", "api", "--data", "[]"],
      ["save-service", "shop", "api", "--data", "{\"autostart\":\"false\"}"], ["save-task", "shop", "check", "--data", "{\"workspace\":\"other\"}"]] {
      XCTAssertThrowsError(try WorkspaceCLI.request(WorkspaceCLI.parse(args)), args.joined(separator: " "))
    }
  }

  func testFullDefinitionFileAndLaneEditParsing() throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("workspace.toml")
    let source = "name = \"Shop\"\nroot = \"/tmp\"\n"
    try source.write(to: file, atomically: true, encoding: .utf8)
    let saved = try WorkspaceCLI.request(WorkspaceCLI.parse(["save", "shop", "--file", file.path, "--revision", "abc"]))
    XCTAssertEqual(saved.method, "workspace.save")
    XCTAssertEqual(saved.params["source"], .string(source))
    XCTAssertEqual(saved.params["revision"], .string("abc"))
    let options = try AgentToolCLI.parse(["shop/test", "--name", "new", "--env", "MODE=review", "--env", "EMPTY="],
      valued: ["name", "env"], flags: ["clear-env"], repeated: ["env"])
    let lane = try AgentToolCLI.laneEditRequest(options)
    XCTAssertEqual(lane.0, "lane.update")
    XCTAssertEqual(lane.1["env"], .object(["MODE": .string("review"), "EMPTY": .string("")]))
    var invalid = options; invalid.flags.insert("clear-env")
    XCTAssertThrowsError(try AgentToolCLI.laneEditRequest(invalid))
  }
  func testCLIAndMCPAgreeOnTaskWorkflowStatusAndCancelRoutes() throws {
    let run = UUID().uuidString
    for (args, tool, params) in [
      (["task", "demo", "test"], "run_workspace_task", ["workspace": JSONValue.string("demo"), "task": .string("test")]),
      (["workflow", "demo", "verify"], "run_workspace_workflow", ["workspace": .string("demo"), "workflow": .string("verify")]),
      (["status", run], "workspace_run_status", ["run": .string(run)]),
      (["cancel", run], "cancel_workspace_run", ["run": .string(run)]),
      (["logs", run], "workspace_run_logs", ["run": .string(run)]),
    ] {
      let cli = try WorkspaceCLI.request(StackCLI.parse(args))
      let mcp = try CinderdeckMCPServer.request(for: tool, params)
      XCTAssertEqual(cli.method, mcp.0)
      XCTAssertEqual(JSONValue.object(cli.params), JSONValue.object(mcp.1))
    }
    for args in [["task", "demo"], ["cancel", "bad"], ["workflow", "demo", "verify", "--timeout", "nan"], ["list", "extra"]] {
      XCTAssertThrowsError(try WorkspaceCLI.request(StackCLI.parse(args)))
    }
  }

  func testCLIRejectsUnknownAndMissingOptions() throws {
    for args in [["list", "--unknown"], ["task", "demo", "test", "--as"], ["logs", UUID().uuidString, "--lines"]] {
      XCTAssertThrowsError(try WorkspaceCLI.parse(args))
    }
  }

  @MainActor
  func testAgentCanDiscoverRunInspectAndCancelWithClaimsEnforced() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let defaults = UserDefaults(suiteName: "WorkspaceControl-\(UUID())")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    let supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("logs"))
    let runner = WorkspaceRunner(supervisor: supervisor, store: .init(directory: root.appendingPathComponent("runs")), environment: { _ in ProcessInfo.processInfo.environment })
    await runner.recover()
    try "[tasks.wait]\ncmd = \"echo hello; sleep 300\"\n[workflows.verify]\nsteps = [\"task:wait\"]\n".write(to: root.appendingPathComponent("demo.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    let control = StackControlService(supervisor: supervisor, runner: runner, claimsFile: root.appendingPathComponent("claims.json"))
    let actor = StackActor(kind: .agent, name: "Test Agent", session: "unit")
    let other = StackActor(kind: .agent, name: "Other Agent")
    let listed = try await control.handle("workspace.list", params: .object([:]), actor: actor)
    XCTAssertEqual(listed.arrayValue?.first?["tasks"]?.stringsValue, ["wait"])
    _ = try await control.handle("claim", params: .object(["workspace": .string("demo")]), actor: actor)
    let params: JSONValue = .object(["workspace": .string("demo"), "task": .string("wait")])
    do { _ = try await control.handle("workspace.task.run", params: params, actor: other); XCTFail("Expected claim refusal") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "claimed") }
    let started = try await control.handle("workspace.task.run", params: params, actor: actor).decode(WorkspaceRun.self)
    XCTAssertEqual(started.actor, actor)
    let query: JSONValue = .object(["run": .string(started.id.uuidString)])
    do { _ = try await control.handle("workspace.run.cancel", params: query, actor: other); XCTFail("Expected claim refusal") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "claimed") }
    _ = try await control.handle("workspace.run.cancel", params: query, actor: actor)
    let result = try await control.handle("workspace.run.get", params: query, actor: actor).decode(WorkspaceRun.self)
    XCTAssertEqual(result.status, .cancelled)
    control.release(stack: "demo")
    await runner.cancelAll()
    await supervisor.shutdownMonitoring()
  }

  func testWorkspaceDeepLinksDoNotExecuteCommands() {
    for path in ["workspaces", "workspace", "open/workspaces"] {
      XCTAssertEqual(CinderdeckDeepLinkAction(url: URL(string: "cinderdeck://" + path)!), .workspaces)
    }
    XCTAssertNil(CinderdeckDeepLinkAction(url: URL(string: "cinderdeck://workspace/task/test")!))
  }
}
