import Darwin
import Foundation
import XCTest
@testable import Cinderdeck

final class StackControlTests: XCTestCase {
  func testJSONValueRoundTripsAndAccessors() throws {
    let value = try StackControlCoding.decoder().decode(JSONValue.self, from: Data(#"{"stack":"demo","n":3,"wait":true,"services":["a","b"],"csv":"x, y"}"#.utf8))
    XCTAssertEqual(value["stack"]?.stringValue, "demo")
    XCTAssertEqual(value["n"]?.intValue, 3)
    XCTAssertEqual(value["wait"]?.boolValue, true)
    XCTAssertEqual(value["services"]?.stringsValue, ["a", "b"])
    XCTAssertEqual(value["csv"]?.stringsValue, ["x", "y"])
    let encoded = String(decoding: try StackControlCoding.encoder().encode(value), as: UTF8.self)
    XCTAssertTrue(encoded.contains(#""n":3"#), encoded)
    let claim = StackClaim(stackID: "demo", holder: StackActor(kind: .agent, name: "Codex", session: "e2e"), note: "tests",
      since: Date(timeIntervalSince1970: 1_000), expiresAt: Date(timeIntervalSince1970: 2_000))
    XCTAssertEqual(try JSONValue(encoding: claim).decode(StackClaim.self), claim)
  }

  func testActorKeysAndLabels() {
    let codex = StackActor(kind: .agent, name: "Codex", session: "e2e", host: "Cursor")
    XCTAssertEqual(codex.label, "Codex · e2e in Cursor")
    XCTAssertEqual(codex.key, StackActor(kind: .agent, name: "codex", session: "e2e").key)
    XCTAssertNotEqual(codex.key, StackActor(kind: .agent, name: "Codex").key)
    XCTAssertEqual(StackActor.user.label, "You")
    XCTAssertTrue(StackClaim(stackID: "x", holder: codex, since: Date(), expiresAt: Date().addingTimeInterval(-1)).isExpired)
  }

  func testCLIOptionParsing() {
    let options = StackCLI.parse(["start", "demo", "api", "--as", "Codex", "--timeout=30", "-n", "5", "--json", "-f", "--", "--literal"])
    XCTAssertEqual(options.positionals, ["start", "demo", "api", "--literal"])
    XCTAssertEqual(options["as"], "Codex")
    XCTAssertEqual(options["timeout"], "30")
    XCTAssertEqual(options["lines"], "5")
    XCTAssertTrue(options.json)
    XCTAssertTrue(options.has("follow"))
    XCTAssertNil(StackCLI.runIfRequested(["/Applications/Cinderdeck.app/Contents/MacOS/Cinderdeck"]))
    XCTAssertNil(StackCLI.runIfRequested(["/Applications/Cinderdeck.app/Contents/MacOS/Cinderdeck", "-NSDocumentRevisionsDebugMode", "YES"]))
  }

  func testAppNamesFromProcessPaths() {
    XCTAssertEqual(StackProcessInspector.appName("/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)"), "Cursor")
    XCTAssertEqual(StackProcessInspector.appName("/Applications/Visual Studio Code.app/Contents/MacOS/Electron"), "VS Code")
    XCTAssertNil(StackProcessInspector.appName("/bin/zsh"))
    let chain = StackProcessInspector.ancestry(getpid())
    XCTAssertEqual(chain.first?.pid, getpid())
  }

  func testCodexTableReplacementAndInstructionMarkers() throws {
    let config = "model = \"o3\"\n\n[mcp_servers.cinderdeck]\ncommand = \"old\"\nargs = [\"mcp\"]\n\n[mcp_servers.cinderdeck.env]\nA = \"1\"\n\n[profiles.fast]\nmodel = \"x\"\n"
    let stripped = StackAgentSetup.removingTOMLTable("mcp_servers.cinderdeck", from: config)
    XCTAssertFalse(stripped.contains("cinderdeck"))
    XCTAssertTrue(stripped.contains("[profiles.fast]"))
    XCTAssertTrue(stripped.contains("model = \"o3\""))

    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("AGENTS.md")
    try "# Mine\n\nKeep this.\n".write(to: file, atomically: true, encoding: .utf8)
    _ = try StackAgentSetup.writeInstructions(to: file, command: "/usr/local/bin/cinderdeck")
    _ = try StackAgentSetup.writeInstructions(to: file, command: "/usr/local/bin/cinderdeck")
    let text = try String(contentsOf: file, encoding: .utf8)
    XCTAssertTrue(text.hasPrefix("# Mine\n\nKeep this."))
    XCTAssertEqual(text.components(separatedBy: StackAgentSetup.beginMarker).count, 2)
    XCTAssertTrue(text.contains("cinderdeck stacks") || text.contains("/usr/local/bin/cinderdeck stacks"))
  }

  func testMCPClientNames() {
    XCTAssertEqual(StackMCPServer.displayName("cursor-vscode"), "Cursor")
    XCTAssertEqual(StackMCPServer.displayName("codex-mcp-client"), "Codex")
    XCTAssertEqual(StackMCPServer.displayName("claude-code"), "Claude Code")
    XCTAssertEqual(StackMCPServer.displayName("my-agent"), "my-agent")
  }

  func testSocketRoundTripIdentifiesPeer() throws {
    let root = URL(fileURLWithPath: "/tmp/cinderdeck-sock-\(UUID().uuidString.prefix(8))")
    defer { try? FileManager.default.removeItem(at: root) }
    let path = root.appendingPathComponent("c.sock").path
    let server = StackControlSocketServer(path: path) { data, peer in
      let request = try? StackControlCoding.decoder().decode(StackControlRequest.self, from: data)
      var response = StackControlResponse(id: request?.id ?? 0)
      if request?.method == "fail" { response.error = StackControlError(code: "claimed", message: "nope") }
      else { response.result = .object(["method": .string(request?.method ?? ""), "peer": .number(Double(peer)),
        "client": .string(request?.client?.name ?? "")]) }
      return (try? StackControlCoding.encoder().encode(response)) ?? Data()
    }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try server.start()
    defer { server.stop() }
    var info = stat()
    XCTAssertEqual(stat(path, &info), 0)
    XCTAssertEqual(info.st_mode & 0o777, 0o600)
    let connection = try StackControlConnection(path: path, client: StackControlClientInfo(name: "Tester"))
    let first = try connection.call("hello", ["x": .number(1)], timeout: 5)
    XCTAssertEqual(first["method"]?.stringValue, "hello")
    XCTAssertEqual(first["client"]?.stringValue, "Tester")
    XCTAssertEqual(first["peer"]?.intValue, Int(getpid()))
    let second = try connection.call("again", timeout: 5)
    XCTAssertEqual(second["method"]?.stringValue, "again")
    XCTAssertThrowsError(try connection.call("fail", timeout: 5)) { error in
      XCTAssertEqual((error as? StackControlError)?.code, "claimed")
    }
    let other = StackControlSocketServer(path: path) { _, _ in Data() }
    XCTAssertThrowsError(try other.start(), "A second server must not steal a live socket")
  }

  func testTailReadsLastLinesWithoutANSI() throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("svc.log")
    try (1...50).map { "\u{1B}[32mline \($0)\u{1B}[0m" }.joined(separator: "\n").appending("\n").write(to: file, atomically: true, encoding: .utf8)
    XCTAssertEqual(StackControlService.tail(file, maxLines: 3), ["line 48", "line 49", "line 50"])
  }
}
