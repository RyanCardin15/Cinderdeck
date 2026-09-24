import XCTest
@testable import Cinderdeck

final class ReproAgentAPITests: XCTestCase {
  private func request(_ arguments: [String]) throws -> (method: String, params: [String: JSONValue], timeout: TimeInterval) {
    try ReproCLI.request(try ReproCLI.parse(arguments))
  }

  func testRunRecordsWorkflowOrTask() throws {
    let workflow = try request(["run", "shop", "verify", "--workflow", "--title", "Checkout", "--max=120"])
    XCTAssertEqual(workflow.method, "repro.start")
    XCTAssertEqual(workflow.params["workspace"]?.stringValue, "shop")
    XCTAssertEqual(workflow.params["workflow"]?.stringValue, "verify")
    XCTAssertNil(workflow.params["task"])
    XCTAssertEqual(workflow.params["title"]?.stringValue, "Checkout")
    XCTAssertEqual(workflow.params["max_seconds"]?.doubleValue, 120)
    XCTAssertEqual(try request(["run", "shop", "test"]).params["task"]?.stringValue, "test")
  }

  func testMarksChecksAndQueriesLogs() throws {
    let mark = try request(["mark", "Total shows $42", "--fail", "--detail", "showed $0"])
    XCTAssertEqual(mark.method, "repro.mark")
    XCTAssertEqual(mark.params["label"]?.stringValue, "Total shows $42")
    XCTAssertEqual(mark.params["outcome"]?.stringValue, "fail")
    XCTAssertEqual(mark.params["detail"]?.stringValue, "showed $0")

    let logs = try request(["logs", "ab12", "--around", "1:05", "--span", "2", "--level", "error", "--source", "api,web", "-n", "50"])
    XCTAssertEqual(logs.method, "repro.logs")
    XCTAssertEqual(logs.params["repro"]?.stringValue, "ab12")
    XCTAssertEqual(logs.params["around"]?.stringValue, "1:05")
    XCTAssertEqual(logs.params["window"]?.doubleValue, 2)
    XCTAssertEqual(logs.params["source"]?.stringsValue, ["api", "web"])
    XCTAssertEqual(logs.params["lines"]?.intValue, 50)

    XCTAssertEqual(try request(["frame", "--at", "1.5,first_error"]).params["times"]?.arrayValue?.count, 2)
    let export = try request(["export", "--dest", "~/x", "--zip", "--no-video"])
    XCTAssertEqual(export.params["destination"]?.stringValue, "~/x")
    XCTAssertEqual(export.params["zip"]?.boolValue, true)
    XCTAssertEqual(export.params["video"]?.boolValue, false)
    XCTAssertEqual(try request([]).method, "repro.status")
  }

  func testRejectsMistakes() {
    XCTAssertThrowsError(try ReproCLI.parse(["start", "--bogus"]))
    XCTAssertThrowsError(try ReproCLI.parse(["start", "--title"]))
    XCTAssertThrowsError(try request(["delete"]))
    XCTAssertThrowsError(try request(["start", "extra"]))
    XCTAssertThrowsError(try request(["run", "shop"]))
    XCTAssertThrowsError(try request(["start", "--max", "soon"]))
  }

  func testMCPToolsMapToControlMethods() throws {
    let names = StackMCPServer.toolDescriptions.compactMap { $0["name"]?.stringValue }
    XCTAssertEqual(Set(names).count, names.count, "Tool names are unique")
    for tool in ["start_repro_recording", "mark_repro", "stop_repro_recording", "cancel_repro_recording", "repro_status", "wait_for_repro",
      "list_repros", "repro_summary", "repro_logs", "repro_frame", "export_repro", "open_repro", "delete_repro"] {
      XCTAssertTrue(names.contains(tool), tool)
      let (method, _, timeout) = try StackMCPServer.request(for: tool, [:])
      XCTAssertTrue(method.hasPrefix("repro."), method)
      XCTAssertGreaterThan(timeout, 0)
    }
    XCTAssertEqual(try StackMCPServer.request(for: "wait_for_repro", ["timeout": .number(30)]).2, 90)
  }

  func testFramesBecomeImageContent() {
    let result = JSONValue.object(["frames": .array([.object([
      "imageBase64": .string("AAAA"), "time": .string("00:01.000"), "width": .number(10), "height": .number(5),
      "path": .string("/tmp/f.jpg"), "markers": .array([.object(["time": .string("00:00.500"), "label": .string("Pay"), "outcome": .string("fail")])]),
      "logs": .array([.object(["time": .string("00:00.900"), "level": .string("error"), "source": .string("api"), "text": .string("boom")])]),
    ])])])
    let content = StackMCPServer.frameContent(result)
    XCTAssertEqual(content.count, 2)
    XCTAssertEqual(content[0]["type"]?.stringValue, "image")
    XCTAssertEqual(content[0]["mimeType"]?.stringValue, "image/jpeg")
    let text = content[1]["text"]?.stringValue ?? ""
    XCTAssertTrue(text.contains("▶ Pay [FAIL]"))
    XCTAssertTrue(text.contains("ERROR api | boom"))
    XCTAssertEqual(StackMCPServer.frameContent(.object([:])).first?["type"]?.stringValue, "text")
  }

  func testAgentGuideDescribesRepros() {
    XCTAssertTrue(StackAgentGuide.mcpInstructions.contains("start_repro_recording"))
    XCTAssertTrue(StackAgentGuide.instructions(command: "cinderdeck").contains("repro run"))
  }
}
