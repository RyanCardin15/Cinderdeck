import Foundation
import XCTest
@testable import Cinderdeck

@MainActor
final class WorkspaceRunProvenanceTests: XCTestCase {
  private func workspace(root: URL) -> StackDefinition {
    var workspace = StackDefinition(id: "fixture", name: "Fixture", file: root.appendingPathComponent("workspace.toml"), root: root, shell: "/bin/sh")
    workspace.repos = [RepoDefinition(id: "app", path: root.appendingPathComponent("app")), RepoDefinition(id: "unrelated", path: root.appendingPathComponent("unrelated"))]
    workspace.tasks = [.init(id: "test", name: "Test", command: "test command", repo: "app", directory: root.appendingPathComponent("app"))]
    return workspace
  }
  func testTaskScopeExcludesUnrelatedDeclaredRepositoriesAndUnknownDependenciesStayUnknown() {
    var workspace = workspace(root: URL(fileURLWithPath: "/tmp/scoped-provenance"))
    let selection = WorkspaceRunProvenance.select(workspace, references: ["task:test"])
    XCTAssertTrue(selection.complete); XCTAssertEqual(selection.repositories.map(\.id), ["app"])
    workspace.tasks[0].requiresServices = ["external-shared-service"]
    let unknown = WorkspaceRunProvenance.select(workspace, references: ["task:test"])
    XCTAssertFalse(unknown.complete); XCTAssertEqual(unknown.repositories.map(\.id), ["app"])
    XCTAssertFalse(WorkspaceRunProvenance.select(workspace, references: ["task:missing"]).complete)
  }
  func testDefinitionAndTaskDigestsChangeWhenTheExactSubmittedCommandChanges() {
    var workspace = workspace(root: URL(fileURLWithPath: "/tmp/scoped-provenance"))
    let definition = workspace.fingerprint, task = WorkspaceRunProvenance.digest(workspace.tasks[0])
    workspace.tasks[0].command = "different command"
    XCTAssertNotEqual(definition, workspace.fingerprint)
    XCTAssertNotEqual(task, WorkspaceRunProvenance.digest(workspace.tasks[0]))
  }
  func testRealCaptureDetectsUntrackedFixtureContentChangeWithTheSameHeadAndDirtyPaths() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let app = root.appendingPathComponent("app")
    try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
    _ = try await StackLaneStore.git(["init", "-b", "main"], at: app)
    try Data(".env.private\n".utf8).write(to: app.appendingPathComponent(".gitignore"))
    _ = try await StackLaneStore.git(["add", ".gitignore"], at: app)
    _ = try await StackLaneStore.git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"], at: app)
    try Data("one".utf8).write(to: app.appendingPathComponent("fixture.json"))
    try Data("ignored".utf8).write(to: app.appendingPathComponent(".env.private"))
    let selection = WorkspaceRunProvenance.select(workspace(root: root), references: ["task:test"])
    let before = await WorkspaceRunProvenance.capture(selection, environment: ProcessInfo.processInfo.environment)
    XCTAssertEqual(before.count, 1); XCTAssertTrue(try XCTUnwrap(before.first).complete)
    XCTAssertEqual(before.first?.fingerprint?.untrackedCount, 1)
    let stable = await WorkspaceRunProvenance.capture(selection, environment: ProcessInfo.processInfo.environment)
    XCTAssertEqual(WorkspaceRunProvenance.assess(start: before, end: stable, scopeComplete: selection.complete), "complete")
    try Data("two".utf8).write(to: app.appendingPathComponent("fixture.json"))
    let after = await WorkspaceRunProvenance.capture(selection, environment: ProcessInfo.processInfo.environment)
    XCTAssertEqual(before.first?.head, after.first?.head)
    XCTAssertNotEqual(before.first?.fingerprint?.hash, after.first?.fingerprint?.hash)
    XCTAssertEqual(WorkspaceRunProvenance.assess(start: before, end: after, scopeComplete: selection.complete), "changed")
    XCTAssertEqual(WorkspaceRunProvenance.assess(start: before, end: after, scopeComplete: false), "unknown")
  }
  func testPersistedRunProvenanceRetainsExactHashesAndNeverClaimsServedBuildProof() throws {
    let workspace = workspace(root: URL(fileURLWithPath: "/tmp/scoped-provenance"))
    var run = WorkspaceRun(workspaceID: workspace.id, workspaceName: workspace.name, definitionID: "test", name: "Test", kind: .task, actor: .user, steps: [])
    run.sourceProvenance = .init(schemaVersion: 1, definitionHash: workspace.fingerprint, workflowHash: WorkspaceRunProvenance.digest(workspace.tasks[0]))
    run.sourceProvenance?.state = "unknown"
    let restored = try JSONDecoder().decode(WorkspaceRun.self, from: JSONEncoder().encode(run))
    XCTAssertEqual(restored.sourceProvenance?.definitionHash, run.sourceProvenance?.definitionHash)
    XCTAssertEqual(restored.sourceProvenance?.workflowHash, run.sourceProvenance?.workflowHash)
    XCTAssertEqual(restored.sourceProvenance?.buildState, "unknown")
    XCTAssertEqual(restored.sourceProvenance?.value["buildState"]?.stringValue, "unknown")
  }
}
