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
    XCTAssertEqual(try linked.repositoryPhysicalID(), try original.repositoryPhysicalID())
    let moved = root.appendingPathComponent("moved")
    _ = try await git(["worktree", "move", lane.path, moved.path], at: repo)
    XCTAssertEqual(try PhysicalCheckoutIdentity.resolve(moved)?.physicalID, linked.physicalID)
    XCTAssertEqual(try PhysicalCheckoutIdentity.resolve(moved)?.repositoryPhysicalID(), try original.repositoryPhysicalID())
    let nested = repo.appendingPathComponent("nested")
    try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
    XCTAssertEqual(try PhysicalCheckoutIdentity.resolve(nested)?.physicalID, original.physicalID)
    try "invalid\nsecond-line".write(to: linked.gitDirectory.appendingPathComponent("commondir"), atomically: true, encoding: .utf8)
    XCTAssertThrowsError(try linked.repositoryPhysicalID())
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
    XCTAssertTrue(try restarted.isReserved(physicalIDs: [scope]))
    XCTAssertFalse(try restarted.isReserved(physicalIDs: [String(repeating: "f", count: 64)]))
    XCTAssertThrowsError(try restarted.begin(id: "replacement", ownerID: "replacement", workspaceID: "workspace",
      kind: "git", physicalIDs: [scope], actorKey: "user"))
    XCTAssertEqual(try restarted.releaseWriter("writer", actorKey: actor, token: token).state, "released")
    XCTAssertEqual(try restarted.releaseWriter("writer", actorKey: actor, token: token).state, "released")
    _ = try restarted.begin(id: "git", ownerID: "user", workspaceID: "workspace", kind: "git", physicalIDs: [scope], actorKey: "user")
    try restarted.releaseNative("git")
    XCTAssertTrue(try restarted.list().isEmpty)
    XCTAssertFalse(try restarted.isReserved(physicalIDs: [scope]))
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
    _ = try await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "initial"], at: repo)
    let lane = root.appendingPathComponent("lane")
    _ = try await git(["worktree", "add", "-b", "lane", lane.path], at: repo)
    let defaults = UserDefaults(suiteName: "checkout-run-test-\(UUID())")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    for id in ["workspace", "alias", "linked"] {
      let checkoutRoot = id == "linked" ? lane : repo
      try """
        root = \(WorkspaceDefinitionWriter.quote(checkoutRoot.path))
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
    let physical = try XCTUnwrap(PhysicalCheckoutIdentity.resolve(repo))
    let lookupInput: JSONValue = .object(["installationID": .string(journal.installationID),
      "physicalID": .string(physical.physicalID), "repositoryPhysicalID": .string(try physical.repositoryPhysicalID()), "physicalIDs": .array([.string(physical.physicalID)]), "sharedRefs": .bool(false)])
    let lookup = try await control.handleIntegration("integration.checkout.contexts", params: lookupInput, actor: actor)
    XCTAssertEqual(lookup["installationID"], .string(journal.installationID))
    XCTAssertEqual(lookup["runtimeEpoch"], .string(journal.runtimeEpoch))
    let contexts = try XCTUnwrap(lookup["contexts"]?.arrayValue)
    XCTAssertEqual(Set(contexts.compactMap { $0["workspaceID"]?.stringValue }), ["workspace", "alias"])
    for context in contexts {
      XCTAssertEqual(context["physicalIDs"], .array([.string(physical.physicalID)]))
      XCTAssertEqual(context["repos"], .array([.string("app")]))
      XCTAssertEqual(context["available"], .bool(true))
    }
    let shared = try await control.handleIntegration("integration.checkout.contexts", params: .object([
      "installationID": .string(journal.installationID), "physicalID": .string(physical.physicalID),
      "repositoryPhysicalID": .string(try physical.repositoryPhysicalID()), "physicalIDs": .array([.string(physical.physicalID), .string(try XCTUnwrap(PhysicalCheckoutIdentity.resolve(lane)).physicalID)]), "sharedRefs": .bool(true)]), actor: actor)
    let sharedContexts = try XCTUnwrap(shared["contexts"]?.arrayValue)
    XCTAssertEqual(Set(sharedContexts.compactMap { $0["workspaceID"]?.stringValue }), ["workspace", "alias", "linked"])
    XCTAssertEqual(Set(sharedContexts.flatMap { $0["physicalIDs"]?.arrayValue?.compactMap(\.stringValue) ?? [] }),
      [physical.physicalID, try XCTUnwrap(PhysicalCheckoutIdentity.resolve(lane)).physicalID])
    do {
      _ = try await control.handleIntegration("integration.checkout.contexts", params: .object([
        "installationID": .string("foreign"), "physicalID": .string(physical.physicalID),
        "repositoryPhysicalID": .string(try physical.repositoryPhysicalID()), "physicalIDs": .array([.string(physical.physicalID)]), "sharedRefs": .bool(false)]), actor: actor)
      XCTFail("Expected foreign installation refusal")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "installation_changed") }
    let token = String(repeating: "d", count: 64)
    let acquired = try await control.handleIntegration("integration.reservation.acquire", params: .object([
      "id": .string("writer"), "token": .string(token), "installationID": .string(journal.installationID),
      "ownerID": .string("thread"), "workspaceID": .string("workspace"), "generation": .number(Double(resource.generation)),
      "revision": .string(resource.revision), "repos": .array([.string("app")])]), actor: actor)
    XCTAssertEqual(acquired["state"], .string("held"))
    do {
      _ = try await control.handleIntegration("integration.checkout.contexts", params: lookupInput, actor: actor)
      XCTFail("Expected durable writer refusal during lookup")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "checkout_reserved") }
    XCTAssertThrowsError(try runner.submit(workspace: "alias", kind: .task, definitionID: "write")) {
      XCTAssertEqual(($0 as? StackControlError)?.code, "checkout_reserved")
    }
    var mutated = false
    do { try await supervisor.performGitChange(stack: "alias", repos: ["app"]) { mutated = true }; XCTFail("Expected reservation barrier") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "checkout_reserved") }
    XCTAssertFalse(mutated)
    XCTAssertTrue(runner.runs.isEmpty)
    XCTAssertFalse(FileManager.default.fileExists(atPath: repo.appendingPathComponent("marker").path))
    // Removing the declaration cannot erase the durable writer's physical scope.
    for id in ["workspace", "alias", "linked"] {
      try FileManager.default.moveItem(at: root.appendingPathComponent(id + ".toml"), to: root.appendingPathComponent(id + ".hidden"))
    }
    await supervisor.reloadDefinitions()
    XCTAssertTrue(supervisor.files.isEmpty)
    _ = try await control.handleIntegration("integration.snapshot", params: .object([:]), actor: actor)
    do {
      _ = try await control.handleIntegration("integration.checkout.contexts", params: lookupInput, actor: actor)
      XCTFail("A removed definition must not erase its durable writer")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "checkout_reserved") }
    for id in ["workspace", "alias", "linked"] {
      try FileManager.default.moveItem(at: root.appendingPathComponent(id + ".hidden"), to: root.appendingPathComponent(id + ".toml"))
    }
    await supervisor.reloadDefinitions()
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
