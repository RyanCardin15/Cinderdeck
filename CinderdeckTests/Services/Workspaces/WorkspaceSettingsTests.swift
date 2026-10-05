import Foundation
import XCTest
@testable import Cinderdeck

final class WorkspaceSettingsTests: XCTestCase {
  func testFolderAndFileMembershipPreservesCommandsAndRejectsConflictingSave() throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let other = root.appendingPathComponent("other")
    try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
    let reference = root.appendingPathComponent("brief.md")
    try "brief".write(to: reference, atomically: true, encoding: .utf8)
    let file = root.appendingPathComponent("workspace.toml")
    let original = """
    # keep my commands
    name = "Original"
    root = \(WorkspaceDefinitionWriter.quote(root.path))
    [repos.app]
    path = "."
    lane = "shared"
    [tasks.test]
    repo = "app"
    cmd = "echo test"
    """
    try original.write(to: file, atomically: true, encoding: .utf8)
    let definition = try XCTUnwrap(StackDefinitionLoader.load(original, file: file).definition)
    let updated = try WorkspaceSettingsWriter.source(original: original, definition: definition, name: "Custom",
      folders: definition.repos + [.init(id: "other", path: other, laneMode: .shared)], files: [reference])
    XCTAssertTrue(updated.contains("# keep my commands"))
    XCTAssertTrue(updated.contains("[tasks.test]\nrepo = \"app\"\ncmd = \"echo test\""))
    try WorkspaceDefinitionWriter.saveSource(file: file, original: original, source: updated)
    let saved = try XCTUnwrap(StackDefinitionLoader.load(updated, file: file).definition)
    XCTAssertEqual(saved.name, "Custom")
    XCTAssertEqual(saved.repos.count, 2)
    XCTAssertEqual(saved.files, [reference])
    XCTAssertThrowsError(try WorkspaceDefinitionWriter.saveSource(file: file, original: original, source: updated))
    let removed = try WorkspaceSettingsWriter.source(original: updated, definition: saved, name: saved.name,
      folders: saved.repos.filter { $0.id != "app" }, files: [])
    XCTAssertNil(StackDefinitionLoader.load(removed, file: file).definition, "Referenced folders cannot be removed")
    XCTAssertTrue(FileManager.default.fileExists(atPath: reference.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: other.path))
  }

  func testWorkspaceFilesValidateAndRemapIntoLanes() throws {
    let source = "name = \"Example\"\nroot = \"/tmp/project\"\nfiles = [\"brief.md\", \"/tmp/reference.txt\"]\n"
    let definition = try XCTUnwrap(StackDefinitionLoader.load(source, file: URL(fileURLWithPath: "/tmp/example.toml"), validatePaths: false).definition)
    XCTAssertEqual(definition.files.map(\.path), ["/tmp/project/brief.md", "/tmp/reference.txt"])
    let duplicate = source.replacingOccurrences(of: "\"/tmp/reference.txt\"", with: "\"brief.md\"")
    XCTAssertNil(StackDefinitionLoader.load(duplicate, file: definition.file, validatePaths: false).definition)
    let tree = StackLaneWorktree(source: URL(fileURLWithPath: "/tmp/project"), path: URL(fileURLWithPath: "/tmp/lane/app"))
    let info = StackLaneInfo(sourceStackID: "example", name: "feature", owner: .user, createdAt: Date(), directory: URL(fileURLWithPath: "/tmp/lane"), ports: [:])
    let record = StackLaneRecord(id: "example--feature", info: info, worktrees: [tree])
    let derived = StackLaneStore.derive(record, source: definition).definition
    XCTAssertEqual(derived.files.map(\.path), ["/tmp/lane/app/brief.md", "/tmp/reference.txt"])
  }
}
