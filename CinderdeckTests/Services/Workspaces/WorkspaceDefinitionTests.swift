import Foundation
import XCTest
@testable import Cinderdeck

final class WorkspaceDefinitionTests: XCTestCase {
  private let file = URL(fileURLWithPath: "/tmp/demo.toml")
  func testEmptyWorkspaceAndStarterTemplateAreValid() {
    XCTAssertNotNil(StackDefinitionLoader.load("name = \"New workspace\"", file: file).definition)
    XCTAssertNotNil(StackDefinitionLoader.load(StackDefinitionLoader.template, file: file).definition)
  }
  func testServiceConversionPreservesCommandAndRejectsDependentReferences() throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("test.toml")
    let source = "[services.test]\ncmd = \"echo test\"\n"
    let replacement = WorkspaceDefinitionWriter.task(.init(id: "test", name: "Tests", command: "echo test", directory: root))
    try source.write(to: file, atomically: true, encoding: .utf8)
    try WorkspaceDefinitionWriter.convertService(file: file, original: source, service: "test", taskSection: "tasks.test", replacement: replacement)
    let converted = try XCTUnwrap(StackDefinitionLoader.load(String(contentsOf: file), file: file).definition)
    XCTAssertTrue(converted.services.isEmpty)
    XCTAssertEqual(converted.tasks.first?.command, "echo test")
    let dependent = source + "[services.other]\ncmd = \"sleep 300\"\ndepends_on = [\"test\"]\n"
    try dependent.write(to: file, atomically: true, encoding: .utf8)
    XCTAssertThrowsError(try WorkspaceDefinitionWriter.convertService(file: file, original: dependent, service: "test", taskSection: "tasks.test", replacement: replacement))
    XCTAssertEqual(try String(contentsOf: file), dependent)
  }
  func testTasksOnlyWorkspaceAndWorkflowValidation() throws {
    let source = """
    root = "/tmp"
    [tasks.test]
    cmd = "echo test"
    env.MODE = "test"
    [workflows.verify]
    steps = ["task:test", "task:test"]
    cleanup_services = true
    """
    let loaded = StackDefinitionLoader.load(source, file: file)
    let workspace = try XCTUnwrap(loaded.definition)
    XCTAssertTrue(workspace.services.isEmpty)
    XCTAssertEqual(workspace.tasks.first?.environment["MODE"], "test")
    XCTAssertEqual(workspace.workflows.first?.steps.count, 2)
    for bad in ["task:missing", "start:missing", "workflow:verify", "test", "task:"] {
      XCTAssertNil(StackDefinitionLoader.load(source.replacingOccurrences(of: "task:test", with: bad), file: file).definition, bad)
    }
  }
  func testRejectsInvalidTaskParameters() {
    for parameter in ["timeout = 0", "timeout = -1", "timeout = 3601", "requires_services = [\"missing\"]", "repo = \"missing\""] {
      XCTAssertNil(StackDefinitionLoader.load("[tasks.test]\ncmd = \"true\"\n" + parameter, file: file).definition, parameter)
    }
  }
  func testLegacySavedDefinitionDecodesWithEmptyComponents() throws {
    let definition = StackTestSupport.simpleDefinition(root: URL(fileURLWithPath: "/tmp")).stack
    let data = try JSONEncoder().encode(definition)
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    object.removeValue(forKey: "tasks"); object.removeValue(forKey: "workflows")
    let decoded = try JSONDecoder().decode(StackDefinition.self, from: JSONSerialization.data(withJSONObject: object))
    XCTAssertEqual(decoded.services, definition.services)
    XCTAssertTrue(decoded.tasks.isEmpty)
  }
  func testQuotedAndSpacedComponentHeadersAreReplaced() throws {
    let source = "[tasks . \"test\"]\ncmd = \"old\"\n[tasks.\"test\".env]\nMODE = \"old\"\n[services.api]\ncmd = \"sleep 300\"\n"
    let updated = try WorkspaceDefinitionWriter.replacing(source, section: "tasks.test", with: "[tasks.test]\ncmd = \"new\"")
    let definition = try XCTUnwrap(StackDefinitionLoader.load(updated, file: file).definition)
    XCTAssertEqual(definition.tasks.count, 1)
    XCTAssertEqual(definition.tasks.first?.command, "new")
    XCTAssertTrue(definition.tasks.first?.environment.isEmpty == true)
    XCTAssertEqual(definition.services.count, 1)
  }
  func testComponentEditPreservesOtherTablesAndRejectsStaleSave() throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("test.toml")
    let source = "# keep me\n[services.api]\ncmd = \"sleep 300\"\n[tasks.test]\ncmd = \"old\"\n[tasks.test.env]\nMODE = \"old\"\n[workflows.verify]\nsteps = [\"task:test\"]\n"
    let replacement = WorkspaceDefinitionWriter.task(.init(id: "test", name: "Tests", command: "printf 'hello\\n'", directory: root))
    let updated = try WorkspaceDefinitionWriter.replacing(source, section: "tasks.test", with: replacement)
    XCTAssertTrue(updated.contains("# keep me"))
    XCTAssertTrue(updated.contains("[services.api]"))
    XCTAssertTrue(updated.contains("[workflows.verify]"))
    XCTAssertFalse(updated.contains("MODE"))
    XCTAssertNotNil(StackDefinitionLoader.load(updated, file: file).definition)
    try source.write(to: file, atomically: true, encoding: .utf8)
    try WorkspaceDefinitionWriter.save(file: file, original: source, section: "tasks.test", replacement: replacement)
    XCTAssertThrowsError(try WorkspaceDefinitionWriter.save(file: file, original: source, section: "tasks.test", replacement: replacement))
  }
}
