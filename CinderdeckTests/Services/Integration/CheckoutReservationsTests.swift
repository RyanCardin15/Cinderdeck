import Foundation
import XCTest
@testable import Cinderdeck

@MainActor
final class CheckoutReservationsTests: XCTestCase {
  private func git(_ args: [String], at root: URL) async throws -> String {
    let result = try await StackCommandRunner.run("/usr/bin/git", args, directory: root)
    guard result.status == 0 else { throw StackError.message(result.errorText) }
    return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
  }
  func testPhysicalIdentitySurvivesAliasesAndMovesButSeparatesWorktrees() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let repo = root.appendingPathComponent("repo with spaces")
    _ = try await git(["init", "-b", "main", repo.path], at: root)
    _ = try await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial"], at: repo)
    let alias = root.appendingPathComponent("alias")
    try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: repo)
    let original = try XCTUnwrap(PhysicalCheckoutIdentity.resolve(repo))
    XCTAssertEqual(try PhysicalCheckoutIdentity.resolve(alias), original)
    let attributes = try FileManager.default.attributesOfItem(atPath: original.gitDirectory.path)
    let device = try XCTUnwrap(attributes[.systemNumber] as? NSNumber)
    let inode = try XCTUnwrap(attributes[.systemFileNumber] as? NSNumber)
    XCTAssertEqual(original.physicalID, PhysicalCheckoutIdentity.digest("\(device.uint64Value):\(inode.uint64Value)"))
    let lane = root.appendingPathComponent("lane")
    _ = try await git(["worktree", "add", "-b", "feature/test", lane.path], at: repo)
    let linked = try XCTUnwrap(PhysicalCheckoutIdentity.resolve(lane))
    XCTAssertNotEqual(linked.physicalID, original.physicalID)
    let moved = root.appendingPathComponent("moved")
    _ = try await git(["worktree", "move", lane.path, moved.path], at: repo)
    XCTAssertEqual(try PhysicalCheckoutIdentity.resolve(moved)?.physicalID, linked.physicalID)
    let nested = repo.appendingPathComponent("nested")
    try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
    XCTAssertEqual(try PhysicalCheckoutIdentity.resolve(nested)?.physicalID, original.physicalID)
  }
  func testDurableScopeConflictTokenAuthorityAndUncertainRestart() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try CheckoutReservations(directory: root)
    let scope = String(repeating: "a", count: 64)
    let token = String(repeating: "b", count: 64)
    let actor = "deckhand#thread"
    let first = try store.begin(id: "writer", ownerID: "thread", workspaceID: "workspace", generation: 7,
      kind: "writer", physicalIDs: [scope], actorKey: actor, token: token)
    XCTAssertEqual(first, try store.begin(id: "writer", ownerID: "thread", workspaceID: "workspace", generation: 7,
      kind: "writer", physicalIDs: [scope, scope], actorKey: actor, token: token))
    for kind in ["writer", "run", "git", "lifecycle"] {
      XCTAssertThrowsError(try store.begin(id: "alias-\(kind)", ownerID: "other", workspaceID: "alias",
        kind: kind, physicalIDs: [scope], actorKey: "other", token: kind == "writer" ? token : nil)) {
        XCTAssertEqual(($0 as? StackControlError)?.code, "checkout_reserved")
      }
    }
    XCTAssertThrowsError(try store.get("writer", actorKey: actor, token: String(repeating: "c", count: 64)))
    XCTAssertThrowsError(try store.releaseWriter("writer", actorKey: "other", token: token))
    XCTAssertThrowsError(try store.releaseNative("writer"))
    let restarted = try CheckoutReservations(directory: root)
    XCTAssertEqual(try restarted.get("writer", actorKey: actor, token: token).state, "uncertain")
    XCTAssertThrowsError(try restarted.begin(id: "replacement", ownerID: "replacement", workspaceID: "workspace",
      kind: "git", physicalIDs: [scope], actorKey: "user"))
    XCTAssertEqual(try restarted.releaseWriter("writer", actorKey: actor, token: token).state, "released")
    XCTAssertEqual(try restarted.releaseWriter("writer", actorKey: actor, token: token).state, "released")
    _ = try restarted.begin(id: "git", ownerID: "user", workspaceID: "workspace", kind: "git", physicalIDs: [scope], actorKey: "user")
    try restarted.releaseNative("git")
    XCTAssertTrue(try restarted.list().isEmpty)
    XCTAssertThrowsError(try restarted.list(limit: 101))
    let attributes = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("checkout-reservations.sqlite").path)
    XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    let bytes = try Data(contentsOf: root.appendingPathComponent("checkout-reservations.sqlite"))
    XCTAssertNil(bytes.range(of: Data(token.utf8)))
  }
  func testWriterBlocksActualNativeRunAndGitBeforeEffectsAndReleaseAllowsRun() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let repo = root.appendingPathComponent("repo")
    _ = try await git(["init", "-b", "main", repo.path], at: root)
    let defaults = UserDefaults(suiteName: "checkout-run-test-\(UUID())")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    for id in ["workspace", "alias"] {
      try """
        root = \(WorkspaceDefinitionWriter.quote(repo.path))
        shell = "/bin/sh"
        [repos.app]
        path = "."
        [tasks.write]
        cmd = "printf done > marker"
        """.write(to: root.appendingPathComponent(id + ".toml"), atomically: true, encoding: .utf8)
    }
    let supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("logs"), environment: { _ in ProcessInfo.processInfo.environment })
    await supervisor.reloadDefinitions()
    let runner = WorkspaceRunner(supervisor: supervisor, store: .init(directory: root.appendingPathComponent("runs")), environment: { _ in ProcessInfo.processInfo.environment })
    await runner.recover()
    let control = StackControlService(supervisor: supervisor, runner: runner, claimsFile: root.appendingPathComponent("claims.json"), integrationDirectory: root.appendingPathComponent("integration"))
    let actor = StackActor(kind: .agent, name: "Deckhand", session: "thread")
    let journal = try control.integrationStore()
    let snapshot = try await control.handleIntegration("integration.snapshot", params: .object([:]), actor: actor)
    let resources = try StackControlCoding.decoder().decode(IntegrationSnapshot.self, from: StackControlCoding.encoder().encode(snapshot))
    let resource = try XCTUnwrap(resources.resources.first { $0.workspaceID == "workspace" })
    let token = String(repeating: "d", count: 64)
    let acquired = try await control.handleIntegration("integration.reservation.acquire", params: .object([
      "id": .string("writer"), "token": .string(token), "installationID": .string(journal.installationID),
      "ownerID": .string("thread"), "workspaceID": .string("workspace"), "generation": .number(Double(resource.generation)),
      "revision": .string(resource.revision), "repos": .array([.string("app")])]), actor: actor)
    XCTAssertEqual(acquired["state"], .string("held"))
    XCTAssertThrowsError(try runner.submit(workspace: "alias", kind: .task, definitionID: "write")) {
      XCTAssertEqual(($0 as? StackControlError)?.code, "checkout_reserved")
    }
    var mutated = false
    do { try await supervisor.performGitChange(stack: "alias", repos: ["app"]) { mutated = true }; XCTFail("Expected reservation barrier") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "checkout_reserved") }
    XCTAssertFalse(mutated)
    XCTAssertTrue(runner.runs.isEmpty)
    XCTAssertFalse(FileManager.default.fileExists(atPath: repo.appendingPathComponent("marker").path))
    _ = try await control.handleIntegration("integration.reservation.release", params: .object([
      "installationID": .string(journal.installationID), "id": .string("writer"), "token": .string(token)]), actor: actor)
    let run = try runner.submit(workspace: "alias", kind: .task, definitionID: "write")
    let deadline = Date().addingTimeInterval(8)
    while runner.run(run.id)?.status.isActive == true, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
    XCTAssertEqual(runner.run(run.id)?.status, .succeeded)
    XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent("marker"), encoding: .utf8), "done")
    XCTAssertTrue(try supervisor.checkoutReservations().list().isEmpty)
    await runner.cancelAll()
    await supervisor.shutdownMonitoring()
  }
}
