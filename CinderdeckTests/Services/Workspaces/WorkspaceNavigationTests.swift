import Foundation
import XCTest
@testable import Cinderdeck

private actor WorkspaceNavigationFiles {
  var files: [StackDefinitionFile]
  init(_ files: [StackDefinitionFile]) { self.files = files }
  func read() -> [StackDefinitionFile] { files }
  func remove(_ id: String) { files.removeAll { $0.id == id } }
}

@MainActor
final class WorkspaceNavigationTests: XCTestCase {
  private let directory = URL(fileURLWithPath: "/tmp/workspace-navigation/stacks")
  private var lanesDirectory: URL { StackLaneStore.directory(for: directory) }

  private func workspace(_ id: String, name: String? = nil, root: URL? = nil) -> StackDefinitionFile {
    let file = directory.appendingPathComponent(id + ".toml")
    return .init(id: id, file: file, definition: .init(id: id, name: name ?? id, file: file,
      root: root ?? URL(fileURLWithPath: "/tmp/projects/\(id)"), shell: "/bin/sh"))
  }

  private func lane(_ id: String, source: String = "bridge", name: String = "test/bridge-import-stream") -> StackDefinitionFile {
    let folder = lanesDirectory.appendingPathComponent(id)
    var file = workspace(id, name: "Bridge · \(name)", root: folder.appendingPathComponent("repo-0"))
    file.definition?.lane = .init(sourceStackID: source, name: name, owner: .user,
      createdAt: Date(), directory: folder, ports: [:])
    return file
  }

  func testWorkspacesExcludeLanesAndDefinitionsInsideTheirWorktrees() {
    let branch = lane("bridge-lane")
    let extra = workspace("excel", name: "Bridge import stream · Excel origin",
      root: branch.definition!.root.appendingPathComponent("excel"))
    let files = [extra, workspace("bridge"), workspace("vision"), workspace("monolith"), branch]
    let navigation = WorkspaceNavigation(files: files, lanesDirectory: lanesDirectory)

    XCTAssertEqual(navigation.workspaces.map(\.id), ["bridge", "vision", "monolith"])
    XCTAssertEqual(navigation.lanes(for: "bridge").map(\.id), ["excel", "bridge-lane"])
    XCTAssertEqual(navigation.workspaceID(for: "excel"), "bridge")
    XCTAssertEqual(navigation.workspaceID(for: "bridge-lane"), "bridge")
    XCTAssertTrue(navigation.unattachedLanes.isEmpty)
    XCTAssertNil(navigation.workspaceID(for: nil))
    XCTAssertNil(navigation.workspaceID(for: "missing"))
  }

  func testMembershipUsesLaneMetadataAndPathBoundariesInsteadOfNames() {
    var branch = lane("lane-1", name: "renamed")
    branch.definition?.root = URL(fileURLWithPath: "/custom/worktree")
    let similar = workspace("ordinary", name: "Bridge · looks-like-a-lane",
      root: URL(fileURLWithPath: lanesDirectory.path + "-archive/project"))
    let navigation = WorkspaceNavigation(files: [branch, similar, workspace("bridge")], lanesDirectory: lanesDirectory)

    XCTAssertEqual(navigation.workspaces.map(\.id), ["ordinary", "bridge"])
    XCTAssertEqual(navigation.lanes(for: "bridge").map(\.id), ["lane-1"])
    XCTAssertEqual(navigation.workspaceID(for: "ordinary"), "ordinary")
  }

  func testInvalidLaneKeepsItsSourceAssociation() {
    var broken = lane("broken")
    broken.savedLane = broken.lane
    broken.definition = nil
    broken.issues = [.init(severity: .error, message: "Lane worktree is missing")]
    let navigation = WorkspaceNavigation(files: [broken, workspace("bridge")], lanesDirectory: lanesDirectory)

    XCTAssertEqual(navigation.workspaces.map(\.id), ["bridge"])
    XCTAssertEqual(navigation.lanes(for: "bridge").map(\.id), ["broken"])
    XCTAssertTrue(navigation.unattachedLanes.isEmpty)
  }

  func testOrphanedAndUnreadableLanesRemainAccessibleSeparately() {
    let unreadable = StackDefinitionFile(id: "damaged",
      file: lanesDirectory.appendingPathComponent("damaged/lane.json"),
      issues: [.init(severity: .error, message: "Cannot read lane record")])
    let orphan = lane("orphan", source: "deleted")
    let folder = workspace("extra", root: lanesDirectory.appendingPathComponent("missing/repo-0"))
    let navigation = WorkspaceNavigation(files: [unreadable, orphan, folder, workspace("bridge")], lanesDirectory: lanesDirectory)

    XCTAssertEqual(navigation.workspaces.map(\.id), ["bridge"])
    XCTAssertEqual(navigation.unattachedLanes.map(\.id), ["damaged", "orphan", "extra"])
    XCTAssertTrue(navigation.lanes(for: "bridge").isEmpty)
  }

  func testInvalidSourceWorkspaceStaysVisibleAndKeepsItsLanes() {
    var source = workspace("bridge")
    source.definition = nil
    source.issues = [.init(severity: .error, message: "Invalid definition")]
    let navigation = WorkspaceNavigation(files: [source, lane("branch")], lanesDirectory: lanesDirectory)

    XCTAssertEqual(navigation.workspaces.map(\.id), ["bridge"])
    XCTAssertEqual(navigation.lanes(for: "bridge").map(\.id), ["branch"])
    XCTAssertTrue(navigation.unattachedLanes.isEmpty)
  }

  func testLaneInspectionSurvivesReloadAndRemovalReturnsToSource() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let suite = "WorkspaceNavigationTests-\(UUID())"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    let fixture = WorkspaceNavigationFiles([lane("branch"), workspace("other"), workspace("bridge")])
    let supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("logs"),
      loadFiles: { _ in await fixture.read() })
    let model = StacksViewModel(supervisor: supervisor)
    await supervisor.reloadDefinitions()
    XCTAssertEqual(model.selectedStackID, "other", "Initial selection should be a source workspace")

    model.select("branch")
    model.selectService("api")
    XCTAssertEqual(model.selectedFile?.lane?.name, "test/bridge-import-stream")
    XCTAssertEqual(model.selectedWorkspaceID, "bridge")
    await supervisor.reloadDefinitions()
    XCTAssertEqual(model.selectedStackID, "branch", "Reload must preserve an inspected lane")

    await fixture.remove("branch")
    await supervisor.reloadDefinitions()
    XCTAssertEqual(model.selectedStackID, "bridge", "Removing a lane should return to its source, not the first workspace")
    XCTAssertNil(model.selectedServiceID)
    XCTAssertNotNil(supervisor.definition("bridge"))
    await supervisor.shutdownMonitoring()
  }
}
