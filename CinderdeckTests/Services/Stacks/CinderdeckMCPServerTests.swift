import Darwin
import Foundation
import XCTest
@testable import Cinderdeck

final class CinderdeckMCPServerTests: XCTestCase {
  func testEveryToolRoutesToTheAppWithAStrictSchema() throws {
    let descriptions = CinderdeckMCPServer.toolDescriptions
    let names = descriptions.compactMap { $0["name"]?.stringValue }
    XCTAssertEqual(Set(names).count, names.count, "Tool names are unique")
    for description in descriptions {
      let name = try XCTUnwrap(description["name"]?.stringValue)
      XCTAssertFalse(description["title"]?.stringValue?.isEmpty ?? true, name)
      let schema = try XCTUnwrap(description["inputSchema"])
      XCTAssertEqual(schema["additionalProperties"], .bool(false), name)
      let properties = Set(schema["properties"]?.objectValue?.keys.map { $0 } ?? [])
      for required in schema["required"]?.stringsValue ?? [] { XCTAssertTrue(properties.contains(required), "\(name).\(required)") }
      let annotations = try XCTUnwrap(description["annotations"])
      if annotations["readOnlyHint"]?.boolValue == true { XCTAssertEqual(annotations["destructiveHint"]?.boolValue, false, name) }
      let (method, _, timeout) = try CinderdeckMCPServer.request(for: name, [:])
      XCTAssertFalse(method.isEmpty, name)
      XCTAssertGreaterThan(timeout, 0, name)
    }
  }

  func testArgumentsPassThroughToTheControlAPI() throws {
    let arguments: [String: JSONValue] = ["workspace": .string("shop"), "services": .array([.string("api")]), "timeout": .number(60)]
    let start = try CinderdeckMCPServer.request(for: "start_services", arguments)
    XCTAssertEqual(start.0, "services.start")
    XCTAssertEqual(JSONValue.object(start.1), .object(arguments))
    XCTAssertEqual(start.2, 90)
    // Stopping waits as long as the app does, so a slow stop is not reported as a lost answer.
    XCTAssertEqual(try CinderdeckMCPServer.request(for: "stop_services", ["workspace": .string("shop")]).2, 210)
    let claim = try CinderdeckMCPServer.request(for: "claim_workspace", ["workspace": .string("shop"), "ttl_minutes": .number(10)])
    XCTAssertEqual(JSONValue.object(claim.1), .object(["workspace": .string("shop"), "ttlMinutes": .number(10)]))
    let ports = try CinderdeckMCPServer.request(for: "list_ports", ["external_only": .bool(true)])
    XCTAssertEqual(JSONValue.object(ports.1), .object(["external": .bool(true)]))
    XCTAssertEqual(try CinderdeckMCPServer.request(for: "list_workspaces", [:]).1["detail"], .bool(true))
    XCTAssertEqual(try CinderdeckMCPServer.request(for: "list_workspace_runs", [:]).1["limit"], .number(20))
    XCTAssertEqual(try CinderdeckMCPServer.request(for: "wait_for_workspace_run", ["run": .string("x"), "timeout": .number(30)]).2, 60)
    XCTAssertEqual(try CinderdeckMCPServer.request(for: "pull_repos", ["workspace": .string("shop"), "fetch": .bool(true)]).0, "git.fetch")
  }

  func testArgumentsAreValidatedBeforeReachingTheApp() {
    XCTAssertThrowsError(try CinderdeckMCPServer.validate("start_services", ["workspace": .string("shop"), "service": .string("api")])) { error in
      XCTAssertTrue((error as? StackControlError)?.message.contains("Unknown argument service") == true, "\(error)")
    }
    XCTAssertThrowsError(try CinderdeckMCPServer.validate("save_workspace_task", ["workspace": .string("shop")])) { error in
      XCTAssertEqual((error as? StackControlError)?.message, "Missing task for save_workspace_task")
    }
    XCTAssertThrowsError(try CinderdeckMCPServer.validate("no_such_tool", [:])) { error in
      XCTAssertEqual((error as? StackControlError)?.code, "unknown_tool")
    }
    XCTAssertNoThrow(try CinderdeckMCPServer.validate("list_workspaces", [:]))
  }

  func testProtocolVersionNegotiation() {
    XCTAssertEqual(CinderdeckMCPServer.initializeResult(.object(["protocolVersion": .string("2025-06-18")]))["protocolVersion"], .string("2025-06-18"))
    XCTAssertEqual(CinderdeckMCPServer.initializeResult(.object(["protocolVersion": .string("2099-01-01")]))["protocolVersion"],
      .string(CinderdeckMCPServer.supportedProtocolVersions[0]))
    XCTAssertEqual(CinderdeckMCPServer.initializeResult(.object([:]))["serverInfo"]?["name"], .string("cinderdeck"))
  }

  func testWorkspaceListIsCompact() throws {
    let snapshot = StackSnapshot(id: "shop", name: "Shop", file: "/tmp/shop.toml", state: "Running", operation: nil, definitionChanged: true,
      issues: [], claim: nil, services: [StackServiceSnapshot(name: "api", phase: "ready", status: "Ready", ready: true, pid: 42, pgid: 42, port: 3000,
        url: "http://localhost:3000", startedAt: nil, restarts: 0, detail: nil, owner: nil, repo: nil, branch: "main", cwd: "/tmp",
        command: "npm run dev", dependsOn: [], autostart: true, logFile: "/tmp/api.log")], repos: [])
    let listed: JSONValue = .array([.object(["id": .string("shop"), "name": .string("Shop"), "tasks": .array([.string("test")]),
      "workflows": .array([]), "issues": .array([]), "activeRun": .null, "status": try JSONValue(encoding: snapshot)])])
    let text = CinderdeckMCPServer.render("list_workspaces", listed)
    XCTAssertFalse(text.contains("\n"), "One line of JSON")
    let parsed = try StackControlCoding.decoder().decode(JSONValue.self, from: Data(text.utf8))
    let workspace = try XCTUnwrap(parsed.arrayValue?.first)
    XCTAssertEqual(workspace["tasks"]?.stringsValue, ["test"])
    XCTAssertNil(workspace["workflows"])
    XCTAssertEqual(workspace["services"]?.arrayValue?.first?["url"], .string("http://localhost:3000"))
    XCTAssertNil(workspace["services"]?.arrayValue?.first?["command"], "Details stay in workspace_details")
    XCTAssertNotNil(workspace["definitionChanged"])
    XCTAssertTrue(CinderdeckMCPServer.render("list_workspaces", .array([])).contains("create_workspace"))
  }

  func testSessionAnswersPingsDuringCallsAndDropsCancelledResponses() throws {
    let root = URL(fileURLWithPath: "/tmp/cinderdeck-mcp-\(UUID().uuidString.prefix(8))")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let path = root.appendingPathComponent("c.sock").path
    let server = StackControlSocketServer(path: path) { data, _ in
      let request = try? StackControlCoding.decoder().decode(StackControlRequest.self, from: data)
      if request?.method == "workspace.run.wait" { try? await Task.sleep(nanoseconds: 600_000_000) }
      let response = StackControlResponse(id: request?.id ?? 0, result: .object(["method": .string(request?.method ?? ""),
        "client": .string(request?.client?.name ?? ""), "run": request?.params?["run"] ?? .null]))
      return (try? StackControlCoding.encoder().encode(response)) ?? Data()
    }
    try server.start()
    defer { server.stop() }
    setenv("CINDERDECK_STACKS_SOCKET", path, 1)
    defer { unsetenv("CINDERDECK_STACKS_SOCKET") }

    let output = OutputLines()
    let session = MCPSession(name: nil, session: nil, cwd: "/", write: { output.append($0) })
    session.receive(#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"claude-code"}}}"#)
    session.receive(#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wait_for_workspace_run","arguments":{"run":"first"}}}"#)
    session.receive(#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#)
    session.receive(#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"wait_for_workspace_run","arguments":{"run":"second"}}}"#)
    session.receive(#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":4}}"#)
    session.receive(#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_workspaces","arguments":{"bogus":1}}}"#)
    session.receive(#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
    session.receive("not json")
    session.finish()

    let responses = try output.values.map { try StackControlCoding.decoder().decode(JSONValue.self, from: $0) }
    let ids = responses.map { $0["id"] ?? .null }
    XCTAssertFalse(ids.contains(.number(4)), "A cancelled call is not answered")
    let ping = try XCTUnwrap(ids.firstIndex(of: .number(3)))
    let slow = try XCTUnwrap(ids.firstIndex(of: .number(2)))
    XCTAssertLessThan(ping, slow, "Pings are answered while a long call runs")
    let call = try XCTUnwrap(responses[slow]["result"]?["content"]?.arrayValue?.first?["text"]?.stringValue)
    let result = try StackControlCoding.decoder().decode(JSONValue.self, from: Data(call.utf8))
    XCTAssertEqual(result["method"], .string("workspace.run.wait"))
    XCTAssertEqual(result["client"], .string("Claude Code"))
    XCTAssertEqual(result["run"], .string("first"))
    let invalid = try XCTUnwrap(responses.first { $0["id"] == .number(5) })
    XCTAssertEqual(invalid["result"]?["isError"], .bool(true))
    XCTAssertTrue(invalid["result"]?["content"]?.arrayValue?.first?["text"]?.stringValue?.contains("Unknown argument bogus for list_workspaces") == true)
    XCTAssertTrue(responses.contains { $0["error"]?["code"] == .number(-32700) })
    XCTAssertEqual(responses.count, 5, "Notifications get no response")
  }
}

private nonisolated final class OutputLines: @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [Data] = []
  func append(_ data: Data) {
    lock.withLock { lines += data.split(separator: 10).map { Data($0) } }
  }
  var values: [Data] { lock.withLock { lines } }
}
