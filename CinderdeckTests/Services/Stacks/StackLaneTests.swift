import Darwin
import Foundation
import XCTest
@testable import Cinderdeck

private actor LaneReloadGate {
  private var reads = 0
  private var pending: [Int: CheckedContinuation<Void, Never>] = [:]
  private var observers: [(Int, CheckedContinuation<Void, Never>)] = []

  func read(_ directory: URL) async throws -> [StackDefinitionFile] {
    let snapshot = try StackWorkspaceResolver.load(directory)
    reads += 1
    let number = reads
    let ready = observers.filter { $0.0 <= reads }
    observers.removeAll { $0.0 <= reads }
    ready.forEach { $0.1.resume() }
    if number <= 2 { await withCheckedContinuation { pending[number] = $0 } }
    return snapshot
  }
  func waitForRead(_ number: Int) async {
    if reads >= number { return }
    await withCheckedContinuation { observers.append((number, $0)) }
  }
  func release(_ number: Int) { pending.removeValue(forKey: number)?.resume() }
}

private actor LifecycleEnvironmentGate {
  private let onEntry: @Sendable () -> Void
  private var pending: CheckedContinuation<Void, Never>?
  private var open = false
  private var notified = false
  init(onEntry: @escaping @Sendable () -> Void) { self.onEntry = onEntry }
  func block() async -> [String: String] {
    if !notified { notified = true; onEntry() }
    if !open { await withCheckedContinuation { pending = $0 } }
    return ProcessInfo.processInfo.environment
  }
  func release() { open = true; pending?.resume(); pending = nil }
}

@MainActor
final class StackLaneTests: XCTestCase {
  private var root: URL!
  private var repo: URL!
  private var definitions: URL!
  private var defaults: UserDefaults!
  private var supervisor: StackSupervisor!
  private var control: StackControlService!
  private let codex = StackActor(kind: .agent, name: "Codex", session: "lane-tests")
  private let claude = StackActor(kind: .agent, name: "Claude Code", session: "lane-tests")

  override func setUp() async throws {
    root = try StackTestSupport.temporaryDirectory()
    repo = root.appendingPathComponent("shop")
    definitions = root.appendingPathComponent("stacks")
    try FileManager.default.createDirectory(at: definitions, withIntermediateDirectories: true)
    _ = try await StackLaneStore.git(["init", "-b", "main", "shop"], at: root)
    _ = try await StackLaneStore.git(["config", "user.name", "Lane Tests"], at: repo)
    _ = try await StackLaneStore.git(["config", "user.email", "lanes@example.test"], at: repo)
    try "original\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    try ".env\n".write(to: repo.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
    try """
    import http.server, os, json
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps(dict(cwd=os.getcwd(), port=os.environ['PORT'], api=os.environ.get('CINDERDECK_PORT_API'), web=os.environ.get('CINDERDECK_PORT_WEB'), lane=os.environ.get('CINDERDECK_LANE'))).encode())
    http.server.HTTPServer(('127.0.0.1', int(os.environ['PORT'])), Handler).serve_forever()
    """.write(to: repo.appendingPathComponent("server.py"), atomically: true, encoding: .utf8)
    _ = try await StackLaneStore.git(["add", "."], at: repo)
    _ = try await StackLaneStore.git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"], at: repo)
    defaults = UserDefaults(suiteName: "CinderdeckLaneTests-\(UUID().uuidString)")!
    defaults.set(definitions.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(root.appendingPathComponent("worktrees").path, forKey: PreferencesKeys.stacksLanesDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    let pool = try DatabaseManager.openDatabase(at: root.appendingPathComponent("runs.db")).dbPool
    supervisor = StackSupervisor(store: StackRunStore(pool: pool), defaults: defaults,
      logRoot: root.appendingPathComponent("logs"), environment: { _ in ProcessInfo.processInfo.environment })
    control = StackControlService(supervisor: supervisor)
  }

  override func tearDown() async throws {
    // Do not use the live control socket or persist claims in the user's profile.
    await control?.workspaceRunner.cancelAll()
    await supervisor?.stopAll()
    await supervisor?.shutdownMonitoring()
    control = nil; supervisor = nil; defaults = nil
    if let root { try? FileManager.default.removeItem(at: root) }
  }


  private func durableLane(_ method: String, workspace: String, arguments: [String: JSONValue] = [:]) async throws -> IntegrationOperationReceipt {
    // Newly configured worktrees publish their first real Git status asynchronously.
    // Review the ready context rather than issuing setup against its Loading state.
    let readinessDeadline = Date().addingTimeInterval(5)
    while supervisor.definition(workspace)?.repos.contains(where: { supervisor.gitMonitor.statuses[$0.path] == nil }) == true {
      guard Date() < readinessDeadline else { throw StackError.message("Git checkout context did not become ready") }
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    let projection = try await control.handle("integration.snapshot", params: .object(["workspaceID": .string(workspace)]), actor: codex).decode(IntegrationSnapshot.self)
    let resource = try XCTUnwrap(projection.resources.first)
    var values = arguments; values["workspace"] = .string(workspace)
    let input = IntegrationOperationInput(operationKey: UUID().uuidString, installationID: projection.installationID,
      workspaceID: workspace, generation: resource.generation, revision: resource.revision, method: method, arguments: .object(values))
    let submitted = try await control.handle("integration.operation.submit", params: JSONValue(encoding: input), actor: codex).decode(IntegrationOperationReceipt.self)
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
      let terminal = try await control.handle("integration.operation.get", params: .object(["installationID": .string(projection.installationID), "operationKey": .string(input.operationKey)]), actor: codex).decode(IntegrationOperationReceipt.self)
      if !["pending", "running"].contains(terminal.state) {
        XCTAssertEqual(terminal.id, submitted.id)
        let duplicate = try await control.handle("integration.operation.submit", params: JSONValue(encoding: input), actor: codex).decode(IntegrationOperationReceipt.self)
        XCTAssertEqual(duplicate.id, terminal.id)
        XCTAssertEqual(duplicate.state, terminal.state, "Exact intent remains idempotent after setup or lane deletion changes the resource")
        return terminal
      }
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    throw StackError.message("Durable lane operation did not finish")
  }

  func testDurableLifecycleRoutesSetupReleaseAdoptionAndMissingCleanupThroughNativeOwner() async throws {
    try await load()
    control.laneCreationPresenter = { _, _, _ in
      XCTFail("Durable tool creation and adoption must not present a sheet")
      throw StackControlError(code: "cancelled", message: "Unexpected sheet")
    }
    let source = try String(contentsOf: definitions.appendingPathComponent("shop.toml"))
    try await write(source + """

    [tasks.prepare]
    repo = "app"
    cmd = "true"
    [tasks.teardown]
    repo = "app"
    cmd = "true"
    [lanes]
    setup = "task:prepare"
    teardown = "task:teardown"
    """)
    await control.workspaceRunner.recover()
    let created = try await durableLane("lane.create", workspace: "shop", arguments: ["branch": .string("durable-owned"), "start": .bool(false), "setup": .bool(false)])
    XCTAssertEqual(created.state, "succeeded")
    let id = try XCTUnwrap(created.result?["workspace"]?["id"]?.stringValue)
    let laneRoot = try XCTUnwrap(supervisor.definition(id)?.root)
    let setup = try await durableLane("lane.setup", workspace: id)
    XCTAssertEqual(setup.state, "succeeded", setup.error?.localizedDescription ?? "No native error")
    XCTAssertEqual(setup.result?["setup"]?["status"]?.stringValue, "succeeded")
    XCTAssertEqual(try StackLaneStore.record(id: id, in: supervisor.lanesDirectory)?.setup?.integrationOperationID, setup.id)
    let released = try await durableLane("lane.release", workspace: id)
    XCTAssertEqual(released.state, "succeeded")
    XCTAssertEqual(released.result?["released"]?.stringValue, id)
    XCTAssertTrue(FileManager.default.fileExists(atPath: laneRoot.path))
    let adopted = try await durableLane("lane.adopt", workspace: "shop", arguments: ["path": .string(laneRoot.path), "start": .bool(false), "setup": .bool(false)])
    XCTAssertEqual(adopted.state, "succeeded")
    let adoptedID = try XCTUnwrap(adopted.result?["workspace"]?["id"]?.stringValue)
    XCTAssertEqual(try StackLaneStore.record(id: adoptedID, in: supervisor.lanesDirectory)?.integrationOperationID, adopted.id)
    let adoptedRemoval = try await durableLane("lane.remove", workspace: adoptedID)
    XCTAssertEqual(adoptedRemoval.state, "succeeded")
    XCTAssertTrue(FileManager.default.fileExists(atPath: laneRoot.path), "Adopted checkout stays on disk")
    let missing = try await durableLane("lane.create", workspace: "shop", arguments: ["branch": .string("durable-missing"), "start": .bool(false), "setup": .bool(false)])
    let missingID = try XCTUnwrap(missing.result?["workspace"]?["id"]?.stringValue)
    let missingRoot = try XCTUnwrap(supervisor.definition(missingID)?.root)
    let physical = try XCTUnwrap(PhysicalCheckoutIdentity.resolve(missingRoot))
    try FileManager.default.removeItem(at: missingRoot)
    await supervisor.reloadDefinitions()
    XCTAssertNil(supervisor.definition(missingID))
    let removed = try await durableLane("lane.remove", workspace: missingID)
    XCTAssertEqual(removed.state, "succeeded")
    XCTAssertEqual(removed.result?["removed"]?.stringValue, missingID)
    XCTAssertFalse(FileManager.default.fileExists(atPath: physical.gitDirectory.path))
  }

  func testInterruptedLifecycleInspectsOnlyItsOwnSetupAndNeverInfersRemovalSuccess() async throws {
    try await load()
    let source = try String(contentsOf: definitions.appendingPathComponent("shop.toml"))
    try await write(source + """

    [tasks.prepare]
    repo = "app"
    cmd = "touch must-not-replay"
    [lanes]
    setup = "task:prepare"
    """)
    let kept = try await supervisor.createLane(stack: "shop", branch: "interrupted-setup", actor: codex)
    let removed = try await supervisor.createLane(stack: "shop", branch: "interrupted-remove", actor: codex)
    let keptRoot = try XCTUnwrap(kept.definition?.root)
    let journal = try control.integrationStore()
    let operations = try IntegrationOperations(directory: control.integrationDirectory)
    func intent(_ key: String, _ method: String, _ workspace: String) async throws -> IntegrationOperationInput {
      let projection = try await control.handle("integration.snapshot", params: .object(["workspaceID": .string(workspace)]), actor: codex).decode(IntegrationSnapshot.self)
      let resource = try XCTUnwrap(projection.resources.first)
      return IntegrationOperationInput(operationKey: key, installationID: journal.installationID, workspaceID: workspace,
        generation: resource.generation, revision: resource.revision, method: method, arguments: .object(["workspace": .string(workspace)]))
    }
    let setup = try await intent("interrupted-setup", "lane.setup", kept.id)
    let unrelated = try await intent("unrelated-setup", "lane.setup", kept.id)
    let removal = try await intent("interrupted-remove", "lane.remove", removed.id)
    let setupReceipt = try await operations.begin(setup, actor: codex).0
    for input in [setup, unrelated, removal] {
      _ = try await operations.begin(input, actor: codex)
      _ = try await operations.transition(key: input.operationKey, actor: codex, state: "running")
    }
    // Persist a controlled interrupted setup boundary, then simulate a separate
    // cleanup. Record absence must not be attributed as this removal's success.
    supervisor.setLaneSetup(kept.id, .init(status: .running, reference: "task:prepare", integrationOperationID: setupReceipt.id))
    try await supervisor.removeLane(removed.id, actor: codex)
    for input in [setup, unrelated, removal] {
      let inspected = try await control.handle("integration.operation.get", params: .object(["installationID": .string(journal.installationID), "operationKey": .string(input.operationKey)]), actor: codex).decode(IntegrationOperationReceipt.self)
      XCTAssertEqual(inspected.state, "unknown_outcome")
      if input.operationKey == setup.operationKey {
        XCTAssertEqual(inspected.result?["setup"]?["integrationOperationID"]?.stringValue, setupReceipt.id)
        XCTAssertEqual(inspected.result?["setup"]?["status"]?.stringValue, "running")
      } else if input.operationKey == unrelated.operationKey { XCTAssertNil(inspected.result) }
      else { XCTAssertEqual(inspected.result?["resourceAvailable"]?.boolValue, false) }
      let duplicate = try await control.handle("integration.operation.submit", params: JSONValue(encoding: input), actor: codex).decode(IntegrationOperationReceipt.self)
      XCTAssertEqual(duplicate.id, inspected.id)
      XCTAssertEqual(duplicate.state, "unknown_outcome")
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: keptRoot.path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: keptRoot.appendingPathComponent("must-not-replay").path))
    XCTAssertTrue(control.workspaceRunner.runs.isEmpty)
  }


  func testTeardownFinishesBeforeRemovalAndPersistsItsAttribution() async throws {
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [tasks.drop]
    cmd = "true"
    [lanes]
    teardown = "task:drop"
    """)
    let lane = try await supervisor.createLane(stack: "shop", branch: "borrowed-teardown", actor: codex)
    let entered = expectation(description: "teardown entered its environment boundary")
    let gate = LifecycleEnvironmentGate(onEntry: { entered.fulfill() })
    let runs = WorkspaceRunStore(directory: root.appendingPathComponent("borrowed-runs"))
    let runner = WorkspaceRunner(supervisor: supervisor, store: runs, environment: { _ in await gate.block() })
    await runner.recover()
    control = StackControlService(supervisor: supervisor, runner: runner)
    let removal = Task { try await self.control.handle("lane.remove", params: .object(["workspace": .string(lane.id)]), actor: self.codex) }
    defer { Task { await gate.release(); _ = try? await removal.value } }
    await fulfillment(of: [entered], timeout: 8)
    let run = try XCTUnwrap(runner.activeRun(lane.id))
    XCTAssertEqual(run.actor, codex)
    XCTAssertNotNil(supervisor.definition(lane.id))
    await gate.release()
    _ = try await removal.value
    XCTAssertNil(supervisor.definition(lane.id))
    XCTAssertEqual(try runs.load().first?.status, .succeeded)
  }

  func testRemovalKeepsUnstoppedTeardownEvenWithForcedTeardown() async throws {
    try await load()
    let lane = try await supervisor.createLane(stack: "shop", branch: "unstopped-teardown", actor: codex)
    var stillActive = false
    supervisor.activeWorkspaceRun = { id in id == lane.id && stillActive }
    do {
      _ = try await supervisor.removeLane(lane.id, actor: codex, options: .init(forceTeardown: true)) { stillActive = true }
      XCTFail("Removed a worktree while teardown remained active")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "teardown_active") }
    XCTAssertNotNil(supervisor.definition(lane.id))
    XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(lane.definition?.root).path))
    XCTAssertFalse(supervisor.isRemovingLane(lane.id))
    stillActive = false
    try await supervisor.removeLane(lane.id, actor: codex)
  }

  func testDefaultLongBranchNameRemainsSupportedAndCanBeRenamed() async throws {
    try await load()
    let branch = "agent/" + String(repeating: "long-name", count: 15)
    let created = try await durableLane("lane.create", workspace: "shop", arguments: [
      "branch": .string(branch), "setup": .bool(false), "start": .bool(false)
    ])
    XCTAssertEqual(created.state, "succeeded")
    let id = try XCTUnwrap(created.result?["workspace"]?["id"]?.stringValue)
    XCTAssertEqual(supervisor.definition(id)?.lane?.name, branch)
    let renamed = try await durableLane("lane.update", workspace: id, arguments: [
      "name": .string("Short display name"), "expectedName": .string(branch)
    ])
    XCTAssertEqual(renamed.state, "succeeded")
    XCTAssertEqual(supervisor.definition(id)?.lane?.name, "Short display name")
  }

  func testNamedLaneAndDurableRenameWhileRunningKeepRuntimeIdentity() async throws {
    try await load()
    let created = try await durableLane("lane.create", workspace: "shop", arguments: [
      "branch": .string("agent/naming"), "name": .string("Search polish"), "setup": .bool(false), "start": .bool(false)
    ])
    XCTAssertEqual(created.state, "succeeded")
    let id = try XCTUnwrap(created.result?["workspace"]?["id"]?.stringValue)
    let before = try XCTUnwrap(StackLaneStore.record(id: id, in: supervisor.lanesDirectory))
    XCTAssertEqual(before.info.name, "Search polish")
    XCTAssertEqual(before.worktrees.first?.branch, "agent/naming")
    await supervisor.start(stack: id)
    XCTAssertTrue(supervisor.states[id]?.isActive == true)
    XCTAssertFalse(supervisor.definitionChanged(id))
    let renamed = try await durableLane("lane.update", workspace: id, arguments: [
      "name": .string("Search results"), "expectedName": .string("Search polish")
    ])
    XCTAssertEqual(renamed.state, "succeeded")
    let after = try XCTUnwrap(StackLaneStore.record(id: id, in: supervisor.lanesDirectory))
    XCTAssertEqual(after.info.name, "Search results")
    XCTAssertEqual(after.info.ports, before.info.ports)
    XCTAssertEqual(after.info.effectiveSlug, before.info.effectiveSlug)
    XCTAssertEqual(after.info.directory, before.info.directory)
    XCTAssertEqual(after.worktrees, before.worktrees)
    XCTAssertTrue(supervisor.states[id]?.isActive == true)
    XCTAssertFalse(supervisor.definitionChanged(id), "Display names do not require a process restart")
    do {
      _ = try await control.handle("lane.update", params: .object([
        "workspace": .string(id), "name": .string("Stale overwrite"), "expectedName": .string("Search polish")
      ]), actor: claude)
      XCTFail("Stale name should be refused")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "stale_revision") }
    XCTAssertEqual(try StackLaneStore.record(id: id, in: supervisor.lanesDirectory)?.info.name, "Search results")
    await supervisor.stop(stack: id)
  }

  func testLaneEditingKeepsIdentityAndWorktreesAcrossAgents() async throws {
    try await load()
    let created = try await control.handle("lane.create", params: .object(["workspace": .string("shop"), "branch": .string("agent/original"),
      "start": .bool(false)]), actor: codex)
    let id = try XCTUnwrap(created["workspace"]?["id"]?.stringValue)
    let before = try XCTUnwrap(StackLaneStore.record(id: id, in: supervisor.lanesDirectory))
    let update: JSONValue = .object(["workspace": .string(id), "name": .string("agent/renamed"), "env": .object(["MODE": .string("review")])])
    _ = try await control.handle("lane.update", params: update, actor: claude)
    _ = try await control.handle("lane.update", params: update, actor: codex)
    let after = try XCTUnwrap(StackLaneStore.record(id: id, in: supervisor.lanesDirectory))
    XCTAssertEqual(after.id, before.id)
    XCTAssertEqual(after.info.directory, before.info.directory)
    XCTAssertEqual(after.info.ports, before.info.ports)
    XCTAssertEqual(after.info.effectiveSlug, before.info.effectiveSlug)
    XCTAssertEqual(after.worktrees, before.worktrees)
    XCTAssertEqual(after.info.environment, ["MODE": "review"])
    XCTAssertEqual(after.info.reference, "shop/agent/renamed")
    let resolved = try control.workspaceFile(.object(["workspace": .string("shop/agent/renamed")]))
    XCTAssertEqual(resolved.id, id)
    _ = try await control.handle("lane.update", params: .object(["workspace": .string(id), "env": .object([:])]), actor: codex)
    XCTAssertEqual(try StackLaneStore.record(id: id, in: supervisor.lanesDirectory)?.info.environment, [:])
    do { _ = try await control.handle("workspace.delete", params: .object(["workspace": .string("shop")]), actor: codex); XCTFail("Has lanes") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "in_use") }
    await supervisor.start(stack: id)
    do { _ = try await control.handle("lane.update", params: update, actor: codex); XCTFail("Running") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "busy") }
    await supervisor.stop(stack: id)
    _ = try await control.handle("lane.remove", params: .object(["workspace": .string(id)]), actor: codex)
    XCTAssertTrue(FileManager.default.fileExists(atPath: repo.appendingPathComponent("tracked.txt").path))
  }

  func testLaneEditRejectsDuplicateNamesAndInvalidEnvironmentWithoutWriting() async throws {
    try await load()
    let first = try await supervisor.createLane(stack: "shop", branch: "one", actor: codex)
    _ = try await supervisor.createLane(stack: "shop", branch: "two", actor: codex)
    let manifest = StackLaneStore.manifest(id: first.id, in: supervisor.lanesDirectory)
    let before = try Data(contentsOf: manifest)
    for fields: [String: JSONValue] in [["name": .string("two")], ["name": .string("")], ["env": .object(["INVALID-NAME": .string("value")])], [:]] {
      var params = fields; params["workspace"] = .string(first.id)
      do { _ = try await control.handle("lane.update", params: .object(params), actor: codex); XCTFail("Invalid") }
      catch { XCTAssertEqual((error as? StackControlError)?.code, "invalid_params") }
      XCTAssertEqual(try Data(contentsOf: manifest), before)
    }
  }

  func testAttachOrphanPreservesIdentityWorktreesPortsAndSelection() async throws {
    try await load()
    let file = try await supervisor.createLane(stack: "shop", branch: "orphan", actor: codex)
    try StackLaneStore.update(id: file.id, in: supervisor.lanesDirectory) { $0.info.sourceStackID = "missing" }
    await supervisor.reloadDefinitions()
    let before = try XCTUnwrap(StackLaneStore.record(id: file.id, in: supervisor.lanesDirectory))
    let model = StacksViewModel(supervisor: supervisor)
    model.select("shop")
    model.attachLane(file)
    XCTAssertEqual(model.laneAttachment?.id, file.id)
    XCTAssertEqual(model.selectedStackID, "shop")
    XCTAssertTrue(model.hasAuxiliaryUI)
    model.laneAttachment = nil
    model.select(file.id)

    try await control.attachLane(file.id, to: "shop", actor: codex)
    await supervisor.reloadDefinitions()
    let after = try XCTUnwrap(StackLaneStore.record(id: file.id, in: supervisor.lanesDirectory))
    XCTAssertEqual(after.id, before.id)
    XCTAssertEqual(after.worktrees, before.worktrees)
    XCTAssertEqual(after.info.directory, before.info.directory)
    XCTAssertEqual(after.info.ports, before.info.ports)
    XCTAssertEqual(after.info.owner, before.info.owner)
    XCTAssertEqual(after.info.sourceStackID, "shop")
    XCTAssertEqual(model.selectedStackID, file.id)
    XCTAssertEqual(model.selectedWorkspaceID, "shop")
    XCTAssertFalse(model.workspaceNavigation.isUnattached(file.id))
    XCTAssertNotNil(supervisor.definition(file.id))
    model.attachLane(file)
    XCTAssertNil(model.laneAttachment, "A stale context menu must not attach an already attached lane")
    try await supervisor.removeLane(file.id, actor: codex)
  }

  func testAttachmentRejectsUnrelatedWorkspacesAndActiveRunsWithoutWriting() async throws {
    try await load()
    let file = try await supervisor.createLane(stack: "shop", branch: "orphan", actor: codex)
    try StackLaneStore.update(id: file.id, in: supervisor.lanesDirectory) { $0.info.sourceStackID = "missing" }
    try WorkspaceDefinitionWriter.createWorkspace(name: "Other", root: root.path, id: "other", directory: definitions)
    await supervisor.reloadDefinitions()
    let manifest = StackLaneStore.manifest(id: file.id, in: supervisor.lanesDirectory)
    let before = try Data(contentsOf: manifest)
    for target in ["other", "absent", file.id] {
      do { try await control.attachLane(file.id, to: target, actor: codex); XCTFail("Attached to \(target)") } catch {}
      XCTAssertEqual(try Data(contentsOf: manifest), before)
    }
    supervisor.activeWorkspaceRun = { $0 == file.id }
    do { try await control.attachLane(file.id, to: "shop", actor: codex); XCTFail("Changed busy lane") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "busy") }
    XCTAssertEqual(try Data(contentsOf: manifest), before)
    supervisor.activeWorkspaceRun = nil
    try await supervisor.removeLane(file.id, actor: codex)
  }

  func testStandaloneOrphanMembershipSurvivesReloadAndDeletionKeepsProject() async throws {
    try await load()
    let project = supervisor.lanesDirectory.appendingPathComponent("legacy/repo")
    try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
    let marker = project.appendingPathComponent("keep.txt")
    try "work".write(to: marker, atomically: true, encoding: .utf8)
    try WorkspaceDefinitionWriter.createWorkspace(name: "Legacy", root: project.path, id: "legacy", directory: definitions)
    await supervisor.reloadDefinitions()
    XCTAssertTrue(WorkspaceNavigation(files: supervisor.files, lanesDirectory: supervisor.lanesDirectory).isUnattached("legacy"))
    try await control.attachLane("legacy", to: "shop", actor: codex)
    let reloaded = try StackWorkspaceResolver.load(definitions)
    let navigation = WorkspaceNavigation(files: reloaded, lanesDirectory: supervisor.lanesDirectory)
    XCTAssertEqual(navigation.workspaceID(for: "legacy"), "shop")
    XCTAssertFalse(navigation.isUnattached("legacy"))
    XCTAssertEqual(reloaded.first { $0.id == "legacy" }?.definition?.root.path, project.path)
    do {
      _ = try await control.handleWorkspaceLifecycle("workspace.delete", params: .object(["workspace": .string("shop")]), actor: codex)
      XCTFail("Deleted a workspace with an attached lane definition")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "in_use") }
    try await control.removeLaneEntry("legacy", actor: codex)
    XCTAssertFalse(supervisor.files.contains { $0.id == "legacy" })
    XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), "work")
  }

  func testUnreadableLaneDeletionKeepsWorktreeAndRejectsOriginalWorkspace() async throws {
    try await load()
    let manifest = StackLaneStore.manifest(id: "broken", in: supervisor.lanesDirectory)
    try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "broken json".write(to: manifest, atomically: true, encoding: .utf8)
    let marker = manifest.deletingLastPathComponent().appendingPathComponent("keep.txt")
    try "work".write(to: marker, atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    let model = StacksViewModel(supervisor: supervisor)
    let file = try XCTUnwrap(supervisor.files.first { $0.id == "broken" })
    model.deleteLane(file)
    XCTAssertEqual(model.laneRemoval?.id, "broken")
    do { try await control.attachLane("broken", to: "shop", actor: codex); XCTFail("Attached unreadable lane") } catch {}
    XCTAssertEqual(try String(contentsOf: manifest, encoding: .utf8), "broken json")
    try await control.removeLaneEntry("broken", actor: codex)
    XCTAssertFalse(supervisor.files.contains { $0.id == "broken" })
    XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), "work")
    do { try await control.removeLaneEntry("shop", actor: codex); XCTFail("Removed original workspace") } catch {}
    XCTAssertNotNil(supervisor.definition("shop"))
  }

  private func load(twoServices: Bool = false) async throws {
    let first = try StackLaneStore.availablePort(excluding: [])
    let second = try StackLaneStore.availablePort(excluding: [first])
    var source = """
    name = "Shop"
    root = "\(repo.path)"
    shell = "/bin/sh"
    [repos.app]
    path = "."
    [services.api]
    repo = "app"
    cmd = "/usr/bin/python3 server.py"
    port = \(first)
    ready.http = "http://127.0.0.1:\(first)/health?q=1"
    ready.timeout = 8
    restart = "no"
    env.PORT = "\(first)"
    """
    if twoServices {
      source += """

      [services.web]
      repo = "app"
      cmd = "/usr/bin/python3 server.py"
      port = \(second)
      ready.port = \(second)
      ready.timeout = 8
      restart = "no"
      depends_on = ["api"]
      env.PORT = "\(second)"
      """
    }
    try source.write(to: definitions.appendingPathComponent("shop.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    XCTAssertNotNil(supervisor.definition("shop"))
  }

  private func response(_ definition: StackDefinition, service: String = "api") async throws -> JSONValue {
    let port = try XCTUnwrap(definition.service(service)?.port)
    let (data, _) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(port)/health")!)
    return try JSONDecoder().decode(JSONValue.self, from: data)
  }

  func testThreeParallelStacksUseSeparateWorktreesPortsAndEnvironment() async throws {
    try await load(twoServices: true)
    await supervisor.start(stack: "shop", actor: .user)
    let originalPID = try XCTUnwrap(supervisor.runtime("shop", "api").process)
    let source = try XCTUnwrap(supervisor.definition("shop"))
    // Dirty work stays in the original checkout and is not copied or stashed.
    try "unsaved\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    let codexFile = try await supervisor.createLane(stack: "shop", branch: "agent/codex-1", actor: codex)
    let claudeFile = try await supervisor.createLane(stack: "shop", branch: "agent/claude-2", actor: claude)
    let codexStack = try XCTUnwrap(codexFile.definition), claudeStack = try XCTUnwrap(claudeFile.definition)
    await supervisor.start(stack: codexFile.id, actor: codex)
    await supervisor.start(stack: claudeFile.id, actor: claude)
    XCTAssertEqual(supervisor.runningCount, 3)
    XCTAssertEqual(Set([source, codexStack, claudeStack].flatMap { $0.services.compactMap(\.port) }).count, 6)
    for lane in [codexStack, claudeStack] {
      for service in lane.services {
        XCTAssertEqual(supervisor.runtime(lane.id, service.id).phase, .ready)
        let body = try await response(lane, service: service.id)
        XCTAssertEqual(body["port"]?.intValue, service.port)
        XCTAssertEqual(body["api"]?.intValue, lane.service("api")?.port)
        XCTAssertEqual(body["web"]?.intValue, lane.service("web")?.port)
        XCTAssertEqual(body["lane"]?.stringValue, lane.lane?.name)
        let cwd = URL(fileURLWithPath: try XCTUnwrap(body["cwd"]?.stringValue))
        XCTAssertEqual(StackLaneStore.relative(cwd, to: service.directory), "")
      }
      XCTAssertEqual(try String(contentsOf: lane.root.appendingPathComponent("tracked.txt")), "original\n")
    }
    XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent("tracked.txt")), "unsaved\n")
    let branch = try await StackLaneStore.git(["branch", "--show-current"], at: repo)
    XCTAssertEqual(branch, "main")
    await supervisor.reloadDefinitions()
    XCTAssertEqual(supervisor.definition(codexFile.id)?.lane?.ports, codexStack.lane?.ports)
    XCTAssertFalse(supervisor.definitionChanged(codexFile.id))
    let list = try await control.handle("lane.list", params: .object(["workspace": .string("shop")]), actor: codex)
    XCTAssertEqual(list.arrayValue?.count, 3)
    let alias = try await control.handle("services.status", params: .object(["workspace": .string("shop/agent/codex-1")]), actor: codex)
    XCTAssertEqual(alias["id"]?.stringValue, codexFile.id)
    try await supervisor.removeLane(codexFile.id, actor: codex)
    XCTAssertNil(supervisor.definition(codexFile.id))
    XCTAssertEqual(supervisor.runtime("shop", "api").process, originalPID)
    XCTAssertTrue(originalPID.matchesLiveProcess)
    let other = try await response(claudeStack)
    XCTAssertEqual(other["lane"]?.stringValue, "agent/claude-2")
    let keptBranch = try await StackLaneStore.git(["rev-parse", "refs/heads/agent/codex-1"], at: repo)
    XCTAssertFalse(keptBranch.isEmpty)
  }

  func testExistingBranchDuplicateAndCheckedOutBranchAreSafe() async throws {
    try await load()
    _ = try await StackLaneStore.git(["branch", "existing"], at: repo)
    let lane = try await supervisor.createLane(stack: "shop", branch: "existing", actor: codex)
    for name in ["existing", "main", "../escape", "-bad", "bad name", "HEAD"] {
      do { _ = try await supervisor.createLane(stack: "shop", branch: name, actor: claude); XCTFail("Accepted \(name)") }
      catch { XCTAssertFalse(error.localizedDescription.isEmpty) }
    }
    XCTAssertNotNil(supervisor.definition(lane.id))
    XCTAssertEqual(try StackLaneStore.records(in: supervisor.lanesDirectory).count, 1)
  }

  func testRemovalRefusesLocalAndIgnoredFilesAndOriginalStack() async throws {
    try await load()
    let lane = try await supervisor.createLane(stack: "shop", branch: "dirty", actor: codex)
    let path = try XCTUnwrap(lane.definition?.root)
    for filename in ["untracked.txt", ".env", "tracked.txt"] {
      let file = path.appendingPathComponent(filename)
      let before = try? Data(contentsOf: file)
      try "keep me".write(to: file, atomically: true, encoding: .utf8)
      do { try await supervisor.removeLane(lane.id, actor: codex); XCTFail("Deleted \(filename)") } catch {}
      XCTAssertEqual(try String(contentsOf: file), "keep me")
      if let before { try before.write(to: file) } else { try FileManager.default.removeItem(at: file) }
    }
    do { try await supervisor.removeLane("shop", actor: codex); XCTFail("Removed source") } catch {}
    try await supervisor.removeLane(lane.id, actor: codex)
    XCTAssertTrue(FileManager.default.fileExists(atPath: repo.path))
  }

  func testEnvironmentAssignmentsWinOverSecretsAndNamesNormalize() async throws {
    try await load()
    let lane = try await supervisor.createLane(stack: "shop", branch: "env", actor: codex)
    let stack = try XCTUnwrap(lane.definition), service = try XCTUnwrap(stack.service("api"))
    let environment = StackLaunchDefinition(stack: stack, service: service).environment(shell: ["PORT": "1"],
      secrets: ["PORT": "2", "CINDERDECK_PORT_API": "3"])
    XCTAssertEqual(environment["PORT"], service.port.map(String.init))
    XCTAssertEqual(environment["CINDERDECK_PORT_API"], service.port.map(String.init))
    XCTAssertEqual(StackLaneInfo.portVariable("my-api"), "CINDERDECK_PORT_MY_API")
  }

  func testInvalidReadinessFailsBeforeCreatingWorktrees() async throws {
    try await load()
    var source = try XCTUnwrap(supervisor.definition("shop"))
    source.services[0].readiness = .http(URL(string: "https://example.com/health")!)
    do {
      _ = try await StackLaneStore.create(source: source, request: .init(branch: "invalid"), owner: codex,
        directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: [])
      XCTFail("Accepted external readiness")
    } catch { XCTAssertTrue(error.localizedDescription.contains("localhost")) }
    XCTAssertTrue(try StackLaneStore.records(in: supervisor.lanesDirectory).isEmpty)
  }

  func testDurableCreationUsesOrdinaryLanePath() async throws {
    try await load()
    let receipt = try await durableLane("lane.create", workspace: "shop", arguments: [
      "branch": .string("managed-handoff"), "setup": .bool(false), "start": .bool(false)
    ])
    XCTAssertEqual(receipt.state, "succeeded")
    let id = try XCTUnwrap(receipt.result?["workspace"]?["id"]?.stringValue)
    await supervisor.refreshLaneGitStates([id])
    let projection = try await control.handle("integration.snapshot", params: .object(["workspaceID": .string(id)]), actor: claude).decode(IntegrationSnapshot.self)
    let resource = try XCTUnwrap(projection.resources.first)
    XCTAssertEqual(resource.workspaceID, id)
    XCTAssertTrue(resource.available)
  }

  func testDurableAdoptionRetainsFilesWithoutStartingServices() async throws {
    try await load()
    let external = root.appendingPathComponent("managed-adoption")
    _ = try await StackLaneStore.git(["worktree", "add", "-b", "managed-adoption", external.path], at: repo)
    let arguments: [String: JSONValue] = ["path": .string(external.path), "name": .string("Managed adoption"),
      "setup": .bool(false), "start": .bool(false)]
    let receipt = try await durableLane("lane.adopt", workspace: "shop", arguments: arguments)
    XCTAssertEqual(receipt.state, "succeeded")
    let id = try XCTUnwrap(receipt.result?["workspace"]?["id"]?.stringValue)
    let file = try XCTUnwrap(supervisor.definition(id))
    XCTAssertTrue(file.services.allSatisfy { supervisor.runtime(id, $0.id).phase == .stopped })
    await supervisor.refreshLaneGitStates([id])
    let projection = try await control.handle("integration.snapshot", params: .object(["workspaceID": .string(id)]), actor: claude).decode(IntegrationSnapshot.self)
    XCTAssertEqual(projection.resources.first?.workspaceID, id)
    XCTAssertTrue(FileManager.default.fileExists(atPath: external.path))
  }

  func testLaneProcessesAndPortsSurviveSupervisorRelaunch() async throws {
    try await load()
    let file = try await supervisor.createLane(stack: "shop", branch: "recover", actor: codex)
    await supervisor.start(stack: file.id, actor: codex)
    let identity = try XCTUnwrap(supervisor.runtime(file.id, "api").process)
    let ports = file.definition?.lane?.ports
    await supervisor.prepareToLeaveRunning()
    let pool = try DatabaseManager.openDatabase(at: root.appendingPathComponent("runs.db")).dbPool
    supervisor = StackSupervisor(store: StackRunStore(pool: pool), defaults: defaults,
      logRoot: root.appendingPathComponent("logs"), environment: { _ in ProcessInfo.processInfo.environment })
    await supervisor.bootstrap()
    XCTAssertEqual(supervisor.runtime(file.id, "api").process, identity)
    XCTAssertEqual(supervisor.runtime(file.id, "api").owner, codex)
    XCTAssertEqual(supervisor.definition(file.id)?.lane?.ports, ports)
    let body = try await response(XCTUnwrap(supervisor.definition(file.id)))
    XCTAssertEqual(body["lane"]?.stringValue, "recover")
  }



  func testMultipleRepositoriesMapEveryDirectoryAndKeepDependencies() async throws {
    try await load(twoServices: true)
    let other = root.appendingPathComponent("other")
    _ = try await StackLaneStore.git(["clone", repo.path, other.path], at: root)
    var source = try XCTUnwrap(supervisor.definition("shop"))
    source.root = root
    source.repos.append(.init(id: "other", path: other))
    source.services[1].repo = "other"; source.services[1].directory = other
    let record = try await StackLaneStore.create(source: source, request: .init(branch: "multi"), owner: codex,
      directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: Set(source.services.compactMap(\.port))).record
    let definition = StackLaneStore.derive(record, source: source).definition
    XCTAssertEqual(record.worktrees.count, 2)
    XCTAssertEqual(Set(record.worktrees.map { $0.path.lastPathComponent }), ["shop", "other"])
    XCTAssertEqual(Set(definition.services.map(\.directory)).count, 2)
    XCTAssertEqual(definition.services[1].dependencies, ["api"])
    for service in definition.services {
      XCTAssertEqual(definition.repo(try XCTUnwrap(service.repo))?.path, service.directory)
      let branch = try await StackLaneStore.git(["branch", "--show-current"], at: service.directory)
      XCTAssertEqual(branch, "multi")
    }
    _ = try await StackLaneStore.remove(record, in: supervisor.lanesDirectory, others: [], options: .init())
  }

  func testDiscoveredMultiRepositoryWorkspaceCreatesAndRunsLaneInEveryCorrectFolder() async throws {
    let other = root.appendingPathComponent("other", isDirectory: true)
    _ = try await StackLaneStore.git(["clone", repo.path, other.path], at: root)
    for path in [repo!, other] {
      try "test:\n\t@pwd\n".write(to: path.appendingPathComponent("Makefile"), atomically: true, encoding: .utf8)
      _ = try await StackLaneStore.git(["add", "Makefile"], at: path)
      _ = try await StackLaneStore.git(["-c", "commit.gpgsign=false", "-c", "user.name=Lane Tests", "-c", "user.email=lanes@example.test", "commit", "-m", "add test task"], at: path)
    }
    let docs = root.appendingPathComponent("docs", isDirectory: true)
    try FileManager.default.createDirectory(at: docs, withIntermediateDirectories: true)
    try "test:\n\t@pwd\n".write(to: docs.appendingPathComponent("Makefile"), atomically: true, encoding: .utf8)
    let scan = try WorkspaceDiscovery.discover(root: repo, additionalFolders: [other, docs])
    let components = try WorkspaceSetupModel.components(root: scan.root, commands: scan.commands, repositories: scan.repositories)
    let file = try WorkspaceDefinitionWriter.createWorkspace(name: "Suite", root: scan.root.path, directory: definitions, components: components)
    let source = try XCTUnwrap(StackDefinitionLoader.load(String(contentsOf: file), file: file).definition)
    let record = try await StackLaneStore.create(source: source, request: .init(branch: "discovered-suite"), owner: codex,
      directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: []).record
    defer { try? FileManager.default.removeItem(at: record.info.directory) }
    let lane = StackLaneStore.derive(record, source: source).definition
    XCTAssertEqual(record.worktrees.count, 2)
    XCTAssertEqual(lane.tasks.count, 3)
    for task in lane.tasks {
      let result = try await StackCommandRunner.run("/bin/sh", ["-c", task.command], directory: task.directory,
        environment: ProcessInfo.processInfo.environment, timeout: 10)
      XCTAssertEqual(result.status, 0)
      XCTAssertTrue(StackLaneStore.samePath(URL(fileURLWithPath: result.text.trimmingCharacters(in: .whitespacesAndNewlines)), task.directory), "Task must run in its configured physical folder")
      if source.repo(try XCTUnwrap(task.repo))?.laneMode == .shared { XCTAssertEqual(task.directory, docs) }
      else {
        XCTAssertTrue(record.worktrees.contains { $0.path == task.directory })
        let branch = try await StackLaneStore.git(["branch", "--show-current"], at: task.directory)
        XCTAssertEqual(branch, "discovered-suite")
      }
    }
    _ = try await StackLaneStore.remove(record, in: supervisor.lanesDirectory, others: [], options: .init())
  }

  func testSharedNestedRepositoryTaskKeepsOriginalFolderInOuterLane() async throws {
    try await load()
    let inner = repo.appendingPathComponent("inner", isDirectory: true)
    try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
    var source = try XCTUnwrap(supervisor.definition("shop"))
    source.repos.append(.init(id: "inner", path: inner, laneMode: .shared))
    source.tasks = [.init(id: "shared-test", name: "Shared tests", command: "pwd", repo: "inner", directory: inner)]
    let tree = StackLaneWorktree(source: repo, path: root.appendingPathComponent("lane/shop"))
    let info = StackLaneInfo(sourceStackID: source.id, name: "shared", owner: codex, createdAt: Date(), directory: root.appendingPathComponent("lane"), ports: [:])
    let record = StackLaneRecord(id: "shared-lane", info: info, worktrees: [tree])
    let lane = StackLaneStore.derive(record, source: source).definition
    XCTAssertEqual(lane.tasks.first?.directory, inner)
    XCTAssertEqual(lane.repo("inner")?.path, inner)
  }

  func testFailedCreateRollsBackWorktreesAndMalformedRecordDoesNotHideBase() async throws {
    try await load()
    let subfolder = repo.appendingPathComponent("new-folder")
    try FileManager.default.createDirectory(at: subfolder, withIntermediateDirectories: true)
    try "uncommitted".write(to: subfolder.appendingPathComponent("file"), atomically: true, encoding: .utf8)
    var source = try XCTUnwrap(supervisor.definition("shop"))
    source.services[0].directory = subfolder
    do {
      _ = try await StackLaneStore.create(source: source, request: .init(branch: "rollback"), owner: codex,
        directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: [])
      XCTFail("Accepted a folder absent on the lane branch")
    } catch { XCTAssertTrue(error.localizedDescription.contains("folder is missing")) }
    XCTAssertTrue(try StackLaneStore.records(in: supervisor.lanesDirectory).isEmpty)
    let trees = try await StackLaneStore.git(["worktree", "list", "--porcelain"], at: repo)
    XCTAssertEqual(trees.components(separatedBy: "worktree ").count, 2)
    XCTAssertEqual(try String(contentsOf: subfolder.appendingPathComponent("file")), "uncommitted")
    let damaged = supervisor.lanesDirectory.appendingPathComponent("damaged")
    try FileManager.default.createDirectory(at: damaged, withIntermediateDirectories: true)
    try "broken".write(to: damaged.appendingPathComponent("lane.json"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    XCTAssertNotNil(supervisor.definition("shop"))
    XCTAssertTrue(supervisor.files.first { $0.id == "damaged" }?.issues.contains { $0.severity == .error } == true)
  }

  func testMissingRegisteredWorktreeCleansOnlyItsRegistration() async throws {
    try await load()
    let missing = try await supervisor.createLane(stack: "shop", branch: "missing-owned", actor: codex)
    let neighbour = try await supervisor.createLane(stack: "shop", branch: "retained-neighbour", actor: codex)
    let missingRoot = try XCTUnwrap(missing.definition?.root)
    let physical = try XCTUnwrap(PhysicalCheckoutIdentity.resolve(missingRoot))
    try FileManager.default.removeItem(at: missingRoot)
    await supervisor.reloadDefinitions()
    let before = try XCTUnwrap(StackLaneStore.record(id: missing.id, in: supervisor.lanesDirectory))
    XCTAssertTrue(before.worktrees.allSatisfy { $0.managed })
    XCTAssertFalse(FileManager.default.fileExists(atPath: missingRoot.path))
    let report = try await supervisor.removeLane(missing.id, actor: codex, options: .init())
    XCTAssertNil(try StackLaneStore.record(id: missing.id, in: supervisor.lanesDirectory))
    XCTAssertFalse(FileManager.default.fileExists(atPath: physical.gitDirectory.path), "Registration remains; removed=\(report.removedWorktrees), kept=\(report.keptWorktrees), trees=\(before.worktrees)")
    let neighbourRoot = try XCTUnwrap(neighbour.definition?.root)
    XCTAssertTrue(FileManager.default.fileExists(atPath: neighbourRoot.path))
    XCTAssertNotNil(supervisor.definition(neighbour.id))
    let inventory = try await StackLaneStore.git(["worktree", "list", "--porcelain", "-z"], at: repo, trim: false)
    XCTAssertFalse(inventory.contains(missingRoot.path), "Missing path: \(missingRoot.path); inventory: \(inventory)")
    XCTAssertTrue(inventory.contains(neighbourRoot.path))
  }
  func testMissingWorktreeKeepsItsAliasAndCanBeRemoved() async throws {
    try await load()
    let file = try await supervisor.createLane(stack: "shop", branch: "missing", actor: codex)
    let record = try XCTUnwrap(StackLaneStore.records(in: supervisor.lanesDirectory).first)
    let tree = try XCTUnwrap(record.worktrees.first)
    _ = try await StackLaneStore.git(["worktree", "remove", tree.path.path], at: tree.source)
    await supervisor.reloadDefinitions()
    let status = try await control.handle("services.status", params: .object(["workspace": .string("shop/missing")]), actor: codex)
    XCTAssertEqual(status["id"]?.stringValue, file.id)
    XCTAssertFalse(status["issues"]?.arrayValue?.isEmpty ?? true)
    _ = try await control.handle("lane.remove", params: .object(["workspace": .string("shop/missing")]), actor: codex)
    XCTAssertNil(supervisor.files.first { $0.id == file.id })
  }

  func testMalformedSiblingDoesNotPreventRemovingHealthyLane() async throws {
    try await load()
    let lane = try await supervisor.createLane(stack: "shop", branch: "healthy", actor: codex)
    let damaged = supervisor.lanesDirectory.appendingPathComponent("damaged")
    try FileManager.default.createDirectory(at: damaged, withIntermediateDirectories: true)
    let manifest = damaged.appendingPathComponent("lane.json")
    try "broken".write(to: manifest, atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    try await supervisor.removeLane(lane.id, actor: codex)
    XCTAssertNil(supervisor.files.first { $0.id == lane.id })
    XCTAssertEqual(try String(contentsOf: manifest), "broken")
    XCTAssertNotNil(supervisor.definition("shop"))
    XCTAssertTrue(supervisor.files.first { $0.id == "damaged" }?.issues.contains { $0.severity == .error } == true)
  }

  func testSwitchToAnotherLanesBranchDoesNotStopServicesOrStashChanges() async throws {
    try await load()
    await supervisor.start(stack: "shop", actor: codex)
    let original = try XCTUnwrap(supervisor.runtime("shop", "api").process)
    let lane = try await supervisor.createLane(stack: "shop", branch: "occupied", actor: claude)
    await supervisor.start(stack: lane.id, actor: claude)
    let sibling = try XCTUnwrap(supervisor.runtime(lane.id, "api").process)
    try "keep my edits".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    do {
      _ = try await control.handle("git.switch", params: .object([
        "workspace": .string("shop"), "branch": .string("occupied"), "dirty": .string("stash")]), actor: codex)
      XCTFail("Switched to another lane's branch")
    } catch { XCTAssertTrue(error.localizedDescription.contains("already checked out")) }
    XCTAssertEqual(supervisor.runtime("shop", "api").process, original)
    XCTAssertTrue(original.matchesLiveProcess)
    XCTAssertEqual(supervisor.runtime(lane.id, "api").process, sibling)
    XCTAssertTrue(sibling.matchesLiveProcess)
    XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent("tracked.txt")), "keep my edits")
    let stashes = try await StackLaneStore.git(["stash", "list"], at: repo)
    XCTAssertTrue(stashes.isEmpty)
  }

  func testTasksOnlyWorkspaceCreatesAnIsolatedLane() async throws {
    let source = """
    root = "\(repo.path)"
    shell = "/bin/sh"
    [tasks.check]
    cmd = "pwd"
    """
    try source.write(to: definitions.appendingPathComponent("shop.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    let file = try await supervisor.createLane(stack: "shop", branch: "tasks-only", actor: codex)
    let lane = try XCTUnwrap(file.definition)
    XCTAssertTrue(lane.services.isEmpty)
    XCTAssertEqual(lane.lane?.ports, [:])
    XCTAssertEqual(lane.tasks.first?.directory, lane.root)
    XCTAssertNotEqual(lane.root, repo)
    let branch = try await StackLaneStore.git(["branch", "--show-current"], at: lane.root)
    XCTAssertEqual(branch, "tasks-only")
    try await supervisor.removeLane(file.id, actor: codex)
  }

  func testOverlappingReloadWaitsUntilLatestDefinitionsArePublished() async throws {
    try await load()
    await supervisor.shutdownMonitoring()
    let gate = LaneReloadGate()
    supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("reload-logs"),
      loadFiles: { try await gate.read($0) })
    var firstFinished = false
    var firstName: String?
    let first = Task {
      await supervisor.reloadDefinitions()
      firstName = supervisor.definition("shop")?.name
      firstFinished = true
    }
    await gate.waitForRead(1)
    let file = definitions.appendingPathComponent("shop.toml")
    try String(contentsOf: file).replacingOccurrences(of: "name = \"Shop\"", with: "name = \"Latest Shop\"")
      .write(to: file, atomically: true, encoding: .utf8)
    let secondStarted = expectation(description: "Concurrent watcher reload requested")
    let second = Task {
      secondStarted.fulfill()
      await supervisor.reloadDefinitions()
    }
    await fulfillment(of: [secondStarted], timeout: 2)
    await gate.release(1)
    await gate.waitForRead(2)
    try await Task.sleep(nanoseconds: 100_000_000)
    XCTAssertFalse(firstFinished, "A superseded reload must wait until the newest snapshot is published")
    await gate.release(2)
    await first.value
    await second.value
    XCTAssertEqual(firstName, "Latest Shop")
    XCTAssertEqual(supervisor.definition("shop")?.name, "Latest Shop")
  }

  func testDefinitionEditBlocksStartsUntilTheNewSnapshotLoads() async throws {
    try await load()
    await supervisor.shutdownMonitoring()
    let gate = LaneReloadGate()
    supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("edit-logs"),
      loadFiles: { try await gate.read($0) })
    control = StackControlService(supervisor: supervisor)
    let initial = Task { await supervisor.reloadDefinitions() }
    await gate.waitForRead(1)
    await gate.release(1)
    await initial.value
    let edit = Task {
      try await control.handle("workspace.save", params: .object(["workspace": .string("shop"), "name": .string("Updated Shop")]), actor: codex)
    }
    await gate.waitForRead(2)
    XCTAssertEqual(supervisor.states["shop"]?.operation, "Updating definition")
    do {
      _ = try await control.handle("services.start", params: .object(["workspace": .string("shop")]), actor: codex)
      XCTFail("Started from stale definition")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "busy") }
    await gate.release(2)
    _ = try await edit.value
    XCTAssertNil(supervisor.states["shop"]?.operation)
    XCTAssertEqual(supervisor.definition("shop")?.name, "Updated Shop")
  }

  func testIncompleteJournalCannotLaunchAndOccupiedPortsAreSkipped() async throws {
    try await load()
    let file = try await supervisor.createLane(stack: "shop", branch: "journal", actor: codex)
    var record = try XCTUnwrap(StackLaneStore.records(in: supervisor.lanesDirectory).first)
    record.ready = false
    let manifest = StackLaneStore.manifest(id: record.id, in: supervisor.lanesDirectory)
    try StackControlCoding.encoder().encode(record).write(to: manifest, options: .atomic)
    await supervisor.reloadDefinitions()
    XCTAssertNil(supervisor.definition(file.id))
    XCTAssertNotNil(supervisor.files.first { $0.id == file.id }?.lane)
    await supervisor.start(stack: file.id, actor: codex)
    XCTAssertNil(supervisor.runtime(file.id, "api").process)
    try await supervisor.removeLane(file.id, actor: codex)

    let port = try StackLaneStore.availablePort(excluding: [])
    let listener = socket(AF_INET, SOCK_STREAM, 0)
    XCTAssertGreaterThanOrEqual(listener, 0)
    defer { close(listener) }
    var address = sockaddr_in(); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET); address.sin_port = UInt16(port).bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    XCTAssertEqual(bound, 0)
    XCTAssertNotEqual(try StackLaneStore.availablePort(excluding: []), port)
    XCTAssertNotEqual(try StackLaneStore.availablePort(excluding: [port + 1]), port + 1)
  }

  func testWorkspaceWorkflowRunsInLaneAndPreventsRemovalWhileActive() async throws {
    try await load()
    let file = definitions.appendingPathComponent("shop.toml")
    let source = try String(contentsOf: file) + """

    [tasks.api]
    repo = "app"
    cmd = "echo $PWD; echo $CINDERDECK_PORT_API; echo $PORT; sleep 0.5"
    env.PORT = "task-config"
    requires_services = ["api"]
    [workflows.verify]
    steps = ["task:api"]
    """
    try source.write(to: file, atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    let lane = try await supervisor.createLane(stack: "shop", branch: "workflow", actor: codex)
    let definition = try XCTUnwrap(lane.definition)
    XCTAssertEqual(definition.task("api")?.directory, definition.service("api")?.directory)
    XCTAssertEqual(definition.workflow("verify")?.steps, ["task:api"])
    let restored = try StackControlCoding.decoder().decode(StackDefinition.self,
      from: StackControlCoding.encoder().encode(definition))
    XCTAssertEqual(restored, definition)
    let runner = try XCTUnwrap(control?.workspaceRunner)
    await runner.recover()
    let run = try runner.submit(workspace: lane.id, kind: .workflow, definitionID: "verify", actor: codex)
    do { try await supervisor.removeLane(lane.id, actor: codex); XCTFail("Removed lane during active workflow") }
    catch { XCTAssertTrue(error.localizedDescription.contains("workflow")) }
    let deadline = Date().addingTimeInterval(15)
    while runner.run(run.id)?.status.isActive == true, Date() < deadline {
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    XCTAssertEqual(runner.run(run.id)?.status, .succeeded)
    XCTAssertEqual(supervisor.runtime(lane.id, "api").phase, .ready)
    let lines = await runner.output(run.id).map(\.text)
    XCTAssertTrue(lines.contains { $0.contains("/shop/workflow/shop") }, "Worktrees live in <lanes>/<workspace>/<slug>/<repo folder>")
    XCTAssertTrue(lines.contains(String(try XCTUnwrap(definition.service("api")?.port))))
    XCTAssertTrue(lines.contains("task-config"), "Tasks must keep their own PORT even when they share a service id")
    try await supervisor.removeLane(lane.id, actor: codex)
  }

  // MARK: Bounded multi-repository creation

  private func gatedRepositories(_ count: Int) async throws -> (StackDefinition, [URL]) {
    var source = StackDefinition(id: "parallel", name: "Parallel", file: definitions.appendingPathComponent("parallel.toml"), root: root, shell: "/bin/sh")
    var gates: [URL] = []
    for index in 0..<count {
      let path = root.appendingPathComponent("parallel-\(index)")
      _ = try await StackLaneStore.git(["clone", repo.path, path.path], at: root)
      let gate = root.appendingPathComponent("gate-\(index)")
      try FileManager.default.createDirectory(at: gate, withIntermediateDirectories: true)
      let hook = path.appendingPathComponent(".git/hooks/post-checkout")
      try """
      #!/bin/sh
      touch '\(gate.appendingPathComponent("started").path)'
      while [ ! -f '\(gate.appendingPathComponent("release").path)' ]; do sleep 0.01; done
      """.write(to: hook, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: hook.path)
      gates.append(gate)
      source.repos.append(.init(id: "repo\(index)", path: path, laneFrom: "main"))
    }
    return (source, gates)
  }

  private func releaseGates(_ gates: [URL]) {
    for gate in gates { FileManager.default.createFile(atPath: gate.appendingPathComponent("release").path, contents: Data()) }
  }

  func testIndependentCheckoutsOverlapWithAtMostFourWorkers() async throws {
    let (source, gates) = try await gatedRepositories(6)
    defer { releaseGates(gates) }
    let directory = supervisor.lanesDirectory, worktreeRoot = supervisor.worktreeRoot
    let creation = Task { try await StackLaneStore.create(source: source, request: .init(branch: "bounded"), owner: codex,
      directory: directory, worktreeRoot: worktreeRoot, occupiedPorts: []) }
    let deadline = Date().addingTimeInterval(10)
    while gates.prefix(4).contains(where: { !FileManager.default.fileExists(atPath: $0.appendingPathComponent("started").path) }), Date() < deadline {
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTAssertTrue(gates.prefix(4).allSatisfy { FileManager.default.fileExists(atPath: $0.appendingPathComponent("started").path) }, "Independent checkouts must overlap")
    XCTAssertTrue(gates.suffix(2).allSatisfy { !FileManager.default.fileExists(atPath: $0.appendingPathComponent("started").path) }, "Never start more than four checkouts")
    releaseGates(gates)
    let result = try await creation.value
    XCTAssertEqual(result.record.worktrees.count, 6)
    XCTAssertEqual(result.record.ready, true)
  }

  func testCancellationDrainsCheckoutWorkersBeforeRollback() async throws {
    let (source, gates) = try await gatedRepositories(4)
    defer { releaseGates(gates) }
    let directory = supervisor.lanesDirectory, worktreeRoot = supervisor.worktreeRoot
    let creation = Task { try await StackLaneStore.create(source: source, request: .init(branch: "cancel-workers"), owner: codex,
      directory: directory, worktreeRoot: worktreeRoot, occupiedPorts: []) }
    let deadline = Date().addingTimeInterval(10)
    while gates.contains(where: { !FileManager.default.fileExists(atPath: $0.appendingPathComponent("started").path) }), Date() < deadline {
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTAssertTrue(gates.allSatisfy { FileManager.default.fileExists(atPath: $0.appendingPathComponent("started").path) })
    creation.cancel()
    do { _ = try await creation.value; XCTFail("Expected cancellation") } catch {}
    releaseGates(gates)
    XCTAssertTrue(try StackLaneStore.records(in: directory).isEmpty)
    for repo in source.repos {
      let checkouts = try await StackLaneStore.checkouts(repo.path)
      XCTAssertEqual(checkouts.count, 1)
      let branch = try await StackLaneStore.git(["branch", "--show-current"], at: repo.path)
      XCTAssertEqual(branch, "main")
    }
  }

  func testParallelFailureRetainsChangedPartialWorktreeAndCleansOtherDestinations() async throws {
    let (source, gates) = try await gatedRepositories(4)
    releaseGates(gates)
    let hook = source.repos[0].path.appendingPathComponent(".git/hooks/post-checkout")
    try "#!/bin/sh\nprintf 'keep me' > user-added.txt\nexit 1\n".write(to: hook, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: hook.path)
    do {
      _ = try await StackLaneStore.create(source: source, request: .init(branch: "partial"), owner: codex,
        directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: [])
      XCTFail("Expected checkout hook failure")
    } catch { XCTAssertTrue(error.localizedDescription.contains("recovery record kept"), error.localizedDescription) }
    let record = try XCTUnwrap(StackLaneStore.records(in: supervisor.lanesDirectory).first)
    XCTAssertEqual(record.ready, false)
    XCTAssertEqual(try String(contentsOf: record.worktrees[0].path.appendingPathComponent("user-added.txt"), encoding: .utf8), "keep me")
    for tree in record.worktrees.dropFirst() { XCTAssertFalse(FileManager.default.fileExists(atPath: tree.path.path)) }
  }

  // MARK: Redesigned lanes

  func testToolCreationExecutesRequestedChoicesWithoutPresentingTheManualSheet() async throws {
    try await load()
    control.laneCreationPresenter = { _, _, _ in
      XCTFail("CLI and MCP requests must execute without a modal, including user-attributed calls")
      throw StackControlError(code: "cancelled", message: "Unexpected sheet")
    }
    let result = try await control.handle("lane.create", params: .object([
      "workspace": .string("shop"), "name": .string("Review context"),
      "repositoryModes": .object(["app": .string("reference")]),
      "start": .bool(false), "setup": .bool(false),
    ]), actor: codex)
    XCTAssertEqual(result["workspace"]?["lane"]?["name"]?.stringValue, "Review context")
    XCTAssertNil(result["creationReviewed"])
    let reference = try XCTUnwrap(StackLaneStore.records(in: supervisor.lanesDirectory).first)
    XCTAssertEqual(reference.info.repositoryModes, ["app": .reference])
    XCTAssertTrue(reference.worktrees.isEmpty)

    let named = try await control.handle("lane.create", params: .object([
      "workspace": .string("shop"), "name": .string("Search polish"),
      "repositoryRefs": .object(["app": .string("main")]),
      "start": .bool(false), "setup": .bool(false),
    ]), actor: .user)
    let namedID = try XCTUnwrap(named["workspace"]?["id"]?.stringValue)
    let namedRecord = try XCTUnwrap(StackLaneStore.record(id: namedID, in: supervisor.lanesDirectory))
    XCTAssertEqual(namedRecord.info.name, "Search polish")
    XCTAssertTrue(namedRecord.worktrees.first?.branch?.hasPrefix("codex/search-polish-") == true)
    let head = try await StackLaneStore.git(["rev-parse", "main"], at: repo)
    XCTAssertEqual(namedRecord.info.repositoryRefs, ["app": head])
    let primaryBranch = try await StackLaneStore.git(["branch", "--show-current"], at: repo)
    XCTAssertEqual(primaryBranch, "main")

    for number in 1...2 {
      let result = try await control.handle("lane.create", params: .object([
        "workspace": .string("shop"), "start": .bool(false), "setup": .bool(false),
      ]), actor: codex)
      let id = try XCTUnwrap(result["workspace"]?["id"]?.stringValue)
      let record = try XCTUnwrap(StackLaneStore.record(id: id, in: supervisor.lanesDirectory))
      XCTAssertEqual(record.info.name, "Lane \(number)")
      XCTAssertTrue(record.worktrees.first?.branch?.hasPrefix("codex/lane-\(number)-") == true)
    }
    let receipt = try await durableLane("lane.create", workspace: "shop", arguments: [
      "branch": .string("codex/managed-direct"), "start": .bool(false), "setup": .bool(false),
    ])
    XCTAssertEqual(receipt.state, "succeeded", receipt.error?.localizedDescription ?? "")
    XCTAssertEqual(try StackLaneStore.records(in: supervisor.lanesDirectory).count, 5,
      "Durable retries must reuse the lane instead of creating another")
  }

  func testFourRepositoryDefaultsAndOneOffOverridesPinTheCorrectCommits() async throws {
    var source = StackDefinition(id: "suite", name: "Suite", file: definitions.appendingPathComponent("suite.toml"), root: root, shell: "/bin/sh")
    var mainHeads: [String: String] = [:]
    var developHeads: [String: String] = [:]
    for index in 0..<4 {
      let id = "repo\(index)"
      let path = root.appendingPathComponent(id)
      _ = try await StackLaneStore.git(["clone", repo.path, path.path], at: root)
      mainHeads[id] = try await StackLaneStore.git(["rev-parse", "HEAD"], at: path)
      _ = try await StackLaneStore.git(["checkout", "-b", "develop"], at: path)
      try "develop \(index)".write(to: path.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
      try await commitAll("develop", at: path)
      developHeads[id] = try await StackLaneStore.git(["rev-parse", "HEAD"], at: path)
      source.repos.append(.init(id: id, path: path, laneFrom: index == 3 ? "develop" : "main"))
    }
    let first = try await StackLaneStore.create(source: source, request: .init(branch: "defaults"), owner: codex,
      directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: [])
    XCTAssertEqual(first.record.info.repositoryRefs, ["repo0": mainHeads["repo0"]!, "repo1": mainHeads["repo1"]!, "repo2": mainHeads["repo2"]!, "repo3": developHeads["repo3"]!])
    var override = StackLaneRequest(branch: "one-off")
    override.repositoryRefs = ["repo0": "develop", "repo3": "main"]
    let second = try await StackLaneStore.create(source: source, request: override, owner: codex,
      directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: [])
    XCTAssertEqual(second.record.info.repositoryRefs["repo0"], developHeads["repo0"])
    XCTAssertEqual(second.record.info.repositoryRefs["repo3"], mainHeads["repo3"])
    XCTAssertEqual(source.repo("repo0")?.laneFrom, "main")
    XCTAssertEqual(source.repo("repo3")?.laneFrom, "develop")
    for path in source.repos.map(\.path) {
      let branch = try await StackLaneStore.git(["branch", "--show-current"], at: path)
      XCTAssertEqual(branch, "develop", "Creating a lane must not switch the current workspace")
    }
  }

  func testManualCreationReviewsTheProposedNameBeforeEffectsAndCancellationCreatesNothing() async throws {
    try await load()
    control.laneCreationPresenter = { source, options, create in
      XCTAssertEqual(source.id, "shop")
      XCTAssertEqual(options.request.name, "Agent proposal")
      XCTAssertTrue(options.request.branch.isEmpty, "A display name must not become the proposed Git branch")
      XCTAssertTrue(try StackLaneStore.records(in: self.supervisor.lanesDirectory).isEmpty)
      var approved = options
      approved.request.name = "Reviewed name"
      approved.request.branch = "reviewed"
      approved.request.repositoryRefs = ["app": "main"]
      return try await create(approved)
    }
    let result = try await control.presentLaneCreation(params: .object(["workspace": .string("shop"), "name": .string("Agent proposal"), "start": .bool(false), "setup": .bool(false)]))
    XCTAssertEqual(result["workspace"]?["lane"]?["name"]?.stringValue, "Reviewed name")
    XCTAssertEqual(result["creationReviewed"]?.boolValue, true)
    XCTAssertEqual(result["createdBranch"]?.stringValue, "reviewed")
    control.laneCreationPresenter = { _, _, _ in throw StackControlError(code: "cancelled", message: "Cancelled") }
    do {
      _ = try await control.presentLaneCreation(params: .object(["workspace": .string("shop"), "branch": .string("cancelled")]))
      XCTFail("Expected cancellation")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "cancelled") }
    XCTAssertEqual(try StackLaneStore.records(in: supervisor.lanesDirectory).count, 1)
    let cancelled = try await StackLaneStore.git(["branch", "--list", "cancelled"], at: repo)
    XCTAssertTrue(cancelled.isEmpty)
  }

  private func write(_ source: String, id: String = "shop") async throws {
    try source.write(to: definitions.appendingPathComponent(id + ".toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    XCTAssertNotNil(supervisor.definition(id), supervisor.files.first { $0.id == id }?.issues.map(\.message).joined(separator: "; ") ?? "missing")
  }

  func testPinnedReviewerCreationUsesInspectedHeadsWithoutOpeningTheGeneralLaneSheet() async throws {
    try await load()
    let head = try await StackLaneStore.git(["rev-parse", "HEAD"], at: repo)
    control.laneCreationPresenter = { _, _, _ in
      XCTFail("An inspected reviewer must not ask for different base revisions")
      throw StackControlError(code: "cancelled", message: "Unexpected sheet")
    }
    let arguments: JSONValue = .object([
      "workspace": .string("shop"), "branch": .string("review/pinned"),
      "repositoryRefs": .object(["app": .string(head)]),
      "reviewer": .bool(true), "start": .bool(false), "setup": .bool(false),
    ])
    do {
      _ = try await control.handle("lane.create", params: arguments, actor: codex)
      XCTFail("Reviewer creation must use a durable integration operation")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "invalid_params") }
    XCTAssertTrue(try StackLaneStore.records(in: supervisor.lanesDirectory).isEmpty)
    let result = try await control.handle("lane.create", params: arguments, actor: codex, operationID: "review-operation")
    let records = try StackLaneStore.records(in: supervisor.lanesDirectory)
    XCTAssertEqual(records.count, 1)
    XCTAssertEqual(records.first?.info.repositoryRefs, ["app": head])
    XCTAssertEqual(result["creationReviewed"]?.boolValue, true)
    let reviewerPath = try XCTUnwrap(records.first?.worktrees.first?.path)
    let reviewerHead = try await StackLaneStore.git(["rev-parse", "HEAD"], at: reviewerPath)
    XCTAssertEqual(reviewerHead, head)
  }

  private func laneDefinition(_ stack: String, _ branch: String, _ actor: StackActor) async throws -> StackDefinition {
    let file = try await supervisor.createLane(stack: stack, branch: branch, actor: actor)
    return try XCTUnwrap(file.definition)
  }

  private func commitAll(_ message: String, at path: URL) async throws {
    _ = try await StackLaneStore.git(["add", "-A"], at: path)
    _ = try await StackLaneStore.git(["-c", "commit.gpgsign=false", "-c", "user.name=Lane Tests", "-c", "user.email=lanes@example.test",
      "commit", "-m", message], at: path)
  }

  private func environment(_ stack: StackDefinition, _ service: String) throws -> [String: String] {
    StackLaunchDefinition(stack: stack, service: try XCTUnwrap(stack.service(service))).environment(shell: [:], secrets: [:])
  }

  /// A bare `origin` with main pushed and origin/HEAD set.
  private func addOrigin() async throws -> URL {
    let remote = root.appendingPathComponent("origin.git")
    _ = try await StackLaneStore.git(["init", "--bare", "-b", "main", remote.path], at: root)
    _ = try await StackLaneStore.git(["remote", "add", "origin", remote.path], at: repo)
    _ = try await StackLaneStore.git(["push", "-u", "origin", "main"], at: repo)
    _ = try await StackLaneStore.git(["remote", "set-head", "origin", "main"], at: repo)
    return remote
  }

  func testRepositoryStartRevisionsPinIndependentCommitsAndPersistWithoutChangingSources() async throws {
    try await load(twoServices: true)
    let other = root.appendingPathComponent("other")
    _ = try await StackLaneStore.git(["clone", repo.path, other.path], at: root)
    let appStart = try await StackLaneStore.git(["rev-parse", "HEAD"], at: repo)
    try "new app commit\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    try await commitAll("new app commit", at: repo)
    let appHead = try await StackLaneStore.git(["rev-parse", "HEAD"], at: repo)
    try "independent api commit\n".write(to: other.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    try await commitAll("independent api commit", at: other)
    let apiHead = try await StackLaneStore.git(["rev-parse", "HEAD"], at: other)
    var source = try XCTUnwrap(supervisor.definition("shop"))
    source.root = root; source.repos.append(.init(id: "other", path: other))
    source.services[1].repo = "other"; source.services[1].directory = other
    var request = StackLaneRequest(branch: "explicit-starts")
    request.repositoryRefs = ["app": appStart, "other": "main"]
    let record = try await StackLaneStore.create(source: source, request: request, owner: codex,
      directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: Set(source.services.compactMap(\.port))).record
    let app = try XCTUnwrap(record.worktrees.first { StackLaneStore.samePath($0.source, repo) })
    let api = try XCTUnwrap(record.worktrees.first { StackLaneStore.samePath($0.source, other) })
    let appActual = try await StackLaneStore.git(["rev-parse", "HEAD"], at: app.path)
    let apiActual = try await StackLaneStore.git(["rev-parse", "HEAD"], at: api.path)
    XCTAssertEqual(appActual, appStart); XCTAssertEqual(apiActual, apiHead)
    XCTAssertEqual(record.info.repositoryRefs, ["app": appStart, "other": apiHead])
    let saved = try XCTUnwrap(StackLaneStore.records(in: supervisor.lanesDirectory).first)
    XCTAssertEqual(saved.info.repositoryRefs, record.info.repositoryRefs)
    let appSourceAfter = try await StackLaneStore.git(["rev-parse", "HEAD"], at: repo)
    let apiSourceAfter = try await StackLaneStore.git(["rev-parse", "HEAD"], at: other)
    XCTAssertEqual(appSourceAfter, appHead); XCTAssertEqual(apiSourceAfter, apiHead)
    _ = try await StackLaneStore.remove(record, in: supervisor.lanesDirectory, others: [], options: .init())
  }

  func testRepositoryStartRevisionsRejectInvalidSharedOrConflictingAliasesBeforeEffects() async throws {
    try await load()
    let baseline = try await StackLaneStore.git(["rev-parse", "HEAD"], at: repo)
    try "later\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    try await commitAll("later", at: repo)
    var source = try XCTUnwrap(supervisor.definition("shop"))
    source.repos.append(.init(id: "alias", path: repo))
    var shared = RepoDefinition(id: "shared", path: repo); shared.laneMode = .shared
    // A shared alias would make the whole physical root shared. Check that case
    // separately rather than hiding the conflicting isolated alias case.
    for refs in [["missing": "HEAD"], ["app": "missing-ref"], ["app": baseline, "alias": "HEAD"], ["app": "-HEAD"]] {
      var request = StackLaneRequest(branch: "must-not-create")
      request.repositoryRefs = refs
      do {
        _ = try await StackLaneStore.create(source: source, request: request, owner: codex,
          directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: [])
        XCTFail("Accepted invalid repository starts")
      } catch {}
      XCTAssertTrue(try StackLaneStore.records(in: supervisor.lanesDirectory).isEmpty)
      let branches = try await StackLaneStore.git(["branch", "--list", "must-not-create"], at: repo)
      XCTAssertTrue(branches.isEmpty)
    }
    source.repos.append(shared)
    var sharedRequest = StackLaneRequest(branch: "shared-refused"); sharedRequest.repositoryRefs = ["shared": "HEAD"]
    do {
      _ = try await StackLaneStore.create(source: source, request: sharedRequest, owner: codex,
        directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: [])
      XCTFail("Accepted a shared repository start")
    } catch {}
    XCTAssertTrue(try StackLaneStore.records(in: supervisor.lanesDirectory).isEmpty)
  }

  func testExplicitRepositoryStartOverridesRemoteInferenceAndRefusesExistingLocalBranch() async throws {
    try await load()
    _ = try await addOrigin()
    let remoteHead = try await StackLaneStore.git(["rev-parse", "HEAD"], at: repo)
    _ = try await StackLaneStore.git(["update-ref", "refs/remotes/origin/pinned", remoteHead], at: repo)
    try "explicit head\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    try await commitAll("explicit head", at: repo)
    let explicitHead = try await StackLaneStore.git(["rev-parse", "HEAD"], at: repo)
    var request = StackLaneRequest(branch: "pinned"); request.repositoryRefs = ["app": "main"]
    let source = try XCTUnwrap(supervisor.definition("shop"))
    let record = try await StackLaneStore.create(source: source, request: request, owner: codex,
      directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: []).record
    let actual = try await StackLaneStore.git(["rev-parse", "HEAD"], at: record.worktrees[0].path)
    XCTAssertEqual(actual, explicitHead); XCTAssertNotEqual(actual, remoteHead)
    let upstream = try await StackLaneStore.gitResult(["rev-parse", "--abbrev-ref", "pinned@{upstream}"], at: record.worktrees[0].path)
    XCTAssertNotEqual(upstream.status, 0)
    _ = try await StackLaneStore.remove(record, in: supervisor.lanesDirectory, others: [], options: .init())
    request.repositoryRefs = ["app": remoteHead]
    do {
      _ = try await StackLaneStore.create(source: source, request: request, owner: codex,
        directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: [])
      XCTFail("Moved an existing local branch")
    } catch { XCTAssertTrue(error.localizedDescription.contains("already exists")) }
    let unchanged = try await StackLaneStore.git(["rev-parse", "pinned"], at: repo)
    XCTAssertEqual(unchanged, explicitHead)
    XCTAssertTrue(try StackLaneStore.records(in: supervisor.lanesDirectory).isEmpty)
  }

  func testDurableRepositoryStartRefsAreTypedAndCreateAtThePinnedCommit() async throws {
    try await load()
    let baseline = try await StackLaneStore.git(["rev-parse", "HEAD"], at: repo)
    let receipt = try await durableLane("lane.create", workspace: "shop", arguments: ["branch": .string("durable-start"),
      "repositoryRefs": .object(["app": .string(baseline)]), "start": .bool(false), "setup": .bool(false)])
    XCTAssertEqual(receipt.state, "succeeded")
    let id = try XCTUnwrap(receipt.result?["workspace"]?["id"]?.stringValue)
    let record = try XCTUnwrap(StackLaneStore.records(in: supervisor.lanesDirectory).first { $0.id == id })
    XCTAssertEqual(record.info.repositoryRefs, ["app": baseline])
    let count = try StackLaneStore.records(in: supervisor.lanesDirectory).count
    for refs in [JSONValue.array([]), .object(["app": .number(1)]), .object(["app": .string(String(repeating: "x", count: 201))])] {
      do {
        _ = try await durableLane("lane.create", workspace: "shop", arguments: ["branch": .string("invalid-ref"), "repositoryRefs": refs, "start": .bool(false)])
        XCTFail("Accepted invalid typed repository starts")
      } catch {}
      XCTAssertEqual(try StackLaneStore.records(in: supervisor.lanesDirectory).count, count)
    }
    for refs in [["app": "missing-start"], ["unknown": "HEAD"], ["app": baseline]] {
      let failed = try await durableLane("lane.create", workspace: "shop", arguments: ["branch": .string(refs["app"] == baseline ? "durable-start" : "semantic-refused"),
        "repositoryRefs": .object(refs.mapValues(JSONValue.string)), "start": .bool(false), "setup": .bool(false)])
      XCTAssertEqual(failed.state, "failed", "A rejected start before effects has a definitive receipt")
      XCTAssertEqual(failed.error?.code, "invalid_params")
      XCTAssertEqual(try StackLaneStore.records(in: supervisor.lanesDirectory).count, count)
    }
    try await supervisor.removeLane(id, actor: codex)
  }

  func testReviewLaneCreatesOnlyOneOfFourWorktreesAndKeepsReferencesAfterReload() async throws {
    try await load()
    var source = try XCTUnwrap(supervisor.definition("shop"))
    var references: [URL] = []
    for id in ["api", "mobile", "docs"] {
      let path = root.appendingPathComponent(id)
      _ = try await StackLaneStore.git(["clone", repo.path, path.path], at: root)
      references.append(path)
      source.repos.append(.init(id: id, path: path, laneFrom: "does-not-exist"))
      source.services.append(.init(id: id, command: "true", repo: id, directory: path, port: 4000 + references.count))
      source.tasks.append(.init(id: id, name: id, command: "pwd", directory: path))
    }
    var request = StackLaneRequest(branch: "review-one")
    request.repositoryModes = ["app": .worktree, "api": .reference, "mobile": .reference, "docs": .reference]
    request.repositoryRefs = ["app": "HEAD"]
    let original = source
    let record = try await StackLaneStore.create(source: source, request: request, owner: codex,
      directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: []).record
    XCTAssertEqual(record.worktrees.count, 1)
    XCTAssertEqual(source, original, "Per-lane choices must not edit workspace defaults")
    let saved = try XCTUnwrap(StackLaneStore.record(id: record.id, in: supervisor.lanesDirectory))
    XCTAssertEqual(saved.info.repositoryModes, request.repositoryModes)
    let lane = StackLaneStore.derive(saved, source: source)
    XCTAssertTrue(lane.issues.isEmpty, "Intentional references must not be reported as missing worktrees")
    XCTAssertEqual(lane.definition.repos.count, 4)
    XCTAssertEqual(Set(lane.definition.links.map(\.id)), ["api", "mobile", "docs"])
    for (id, path) in zip(["api", "mobile", "docs"], references) {
      XCTAssertEqual(lane.definition.repo(id)?.path, path)
      XCTAssertEqual(lane.definition.repo(id)?.laneMode, .shared)
      XCTAssertEqual(lane.definition.tasks.first { $0.id == id }?.directory, path)
      let branches = try await StackLaneStore.git(["branch", "--list", "review-one"], at: path)
      XCTAssertTrue(branches.isEmpty, "A reference must not get a lane branch")
      let trees = try await StackLaneStore.checkouts(path)
      XCTAssertEqual(trees.count, 1)
    }
    // Later workspace-default changes do not replace the saved lane choices.
    source.repos[0].laneMode = .shared
    XCTAssertNotEqual(StackLaneStore.derive(saved, source: source).definition.repo("app")?.path, repo)
    _ = try await StackLaneStore.remove(saved, in: supervisor.lanesDirectory, others: [], options: .init())
    for path in references { XCTAssertTrue(FileManager.default.fileExists(atPath: path.path)) }
  }

  func testLaneCanOverrideSharedDefaultToWorktreeAndUseImplicitRepositoryAsReference() async throws {
    try await load()
    var source = try XCTUnwrap(supervisor.definition("shop"))
    source.repos[0].laneMode = .shared
    let implicit = root.appendingPathComponent("implicit")
    _ = try await StackLaneStore.git(["clone", repo.path, implicit.path], at: root)
    source.tasks.append(.init(id: "implicit", name: "Implicit", command: "pwd", directory: implicit))
    var request = StackLaneRequest(branch: "override-shared")
    request.repositoryModes = ["app": .worktree]
    request.referenceRoots = [implicit]
    let record = try await StackLaneStore.create(source: source, request: request, owner: codex,
      directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: []).record
    XCTAssertEqual(record.worktrees.count, 1)
    let lane = StackLaneStore.derive(record, source: source).definition
    XCTAssertNotEqual(lane.repo("app")?.path, repo)
    XCTAssertEqual(lane.repo("implicit")?.path, implicit.resolvingSymlinksInPath())
    XCTAssertEqual(lane.tasks.first { $0.id == "implicit" }?.directory, implicit)
    _ = try await StackLaneStore.remove(record, in: supervisor.lanesDirectory, others: [], options: .init())
  }

  func testDurableReferenceOnlyLaneDoesNotCreateBranchesOrWorktrees() async throws {
    try await load()
    let receipt = try await durableLane("lane.create", workspace: "shop", arguments: ["branch": .string("context-only"),
      "repositoryModes": .object(["app": .string("reference")]), "start": .bool(false), "setup": .bool(false)])
    XCTAssertEqual(receipt.state, "succeeded", receipt.error?.message ?? "")
    let id = try XCTUnwrap(receipt.result?["workspace"]?["id"]?.stringValue)
    let record = try XCTUnwrap(StackLaneStore.record(id: id, in: supervisor.lanesDirectory))
    XCTAssertTrue(record.worktrees.isEmpty)
    await supervisor.reloadDefinitions()
    let lane = try XCTUnwrap(supervisor.definition(id))
    XCTAssertEqual(lane.repo("app")?.path.path, repo.path)
    XCTAssertEqual(lane.root.path, repo.path)
    XCTAssertTrue(lane.services.isEmpty)
    XCTAssertEqual(lane.links.map(\.id), ["api"])
    let branches = try await StackLaneStore.git(["branch", "--list", "context-only"], at: repo)
    XCTAssertTrue(branches.isEmpty)
    try await supervisor.removeLane(id, actor: codex)
    XCTAssertTrue(FileManager.default.fileExists(atPath: repo.path))
  }

  func testRepositoryModesRefuseInvalidAliasesAndReferenceStartsBeforeEffects() async throws {
    try await load()
    let source = try XCTUnwrap(supervisor.definition("shop"))
    for modes in [JSONValue.array([]), .object(["app": .string("shared")]), .object(["unknown": .string("reference")]), .object(["app": .bool(true)])] {
      do {
        _ = try await control.handle("lane.create", params: .object(["workspace": .string("shop"), "branch": .string("refused"),
          "repositoryModes": modes, "start": .bool(false), "setup": .bool(false)]), actor: codex)
        XCTFail("Accepted invalid checkout choices")
      } catch {}
    }
    var request = StackLaneRequest(branch: "refused")
    request.repositoryModes = ["app": .reference]; request.repositoryRefs = ["app": "HEAD"]
    do {
      _ = try await StackLaneStore.create(source: source, request: request, owner: codex,
        directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: [])
      XCTFail("Accepted a revision for a reference")
    } catch { XCTAssertTrue(error is StackLaneStore.StartRevisionRefusal) }
    var aliases = source
    aliases.repos.append(.init(id: "alias", path: repo))
    request.repositoryRefs = [:]; request.repositoryModes = ["app": .worktree, "alias": .reference]
    do {
      _ = try await StackLaneStore.create(source: aliases, request: request, owner: codex,
        directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: [])
      XCTFail("Accepted conflicting alias modes")
    } catch { XCTAssertTrue(error.localizedDescription.contains("aliases")) }
    XCTAssertTrue(try StackLaneStore.records(in: supervisor.lanesDirectory).isEmpty)
  }

  func testAdoptionCanReferenceOtherRepositoriesWithoutCreatingTheirBranches() async throws {
    try await load()
    var source = try XCTUnwrap(supervisor.definition("shop"))
    let other = root.appendingPathComponent("other")
    _ = try await StackLaneStore.git(["clone", repo.path, other.path], at: root)
    source.repos.append(.init(id: "other", path: other))
    let external = root.appendingPathComponent("external")
    _ = try await StackLaneStore.git(["worktree", "add", "-b", "adopt-one", external.path], at: repo)
    var request = StackLaneRequest(branch: "", adoptPath: external)
    request.repositoryModes = ["app": .worktree, "other": .reference]
    let record = try await StackLaneStore.create(source: source, request: request, owner: codex,
      directory: supervisor.lanesDirectory, worktreeRoot: supervisor.worktreeRoot, occupiedPorts: []).record
    XCTAssertEqual(record.worktrees.count, 1)
    XCTAssertEqual(record.worktrees.first?.path, external.resolvingSymlinksInPath())
    XCTAssertEqual(record.worktrees.first?.managed, false)
    let branches = try await StackLaneStore.git(["branch", "--list", "adopt-one"], at: other)
    XCTAssertTrue(branches.isEmpty)
    XCTAssertEqual(StackLaneStore.derive(record, source: source).definition.repo("other")?.path, other)
    _ = try await StackLaneStore.remove(record, in: supervisor.lanesDirectory, others: [], options: .init())
    XCTAssertTrue(FileManager.default.fileExists(atPath: external.path))
  }

  func testRemoteOnlyBranchIsTrackedAndNewBranchesStartAtFrom() async throws {
    try await load()
    let remote = try await addOrigin()
    let other = root.appendingPathComponent("elsewhere")
    _ = try await StackLaneStore.git(["clone", remote.path, other.path], at: root)
    _ = try await StackLaneStore.git(["switch", "-c", "feature/pr"], at: other)
    try "from the pull request\n".write(to: other.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    try await commitAll("PR work", at: other)
    _ = try await StackLaneStore.git(["push", "-u", "origin", "feature/pr"], at: other)
    let remoteTip = try await StackLaneStore.git(["rev-parse", "HEAD"], at: other)
    _ = try await StackLaneStore.git(["fetch", "origin"], at: repo)
    _ = try await StackLaneStore.git(["tag", "v1"], at: repo)
    try "later\n".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    try await commitAll("later on main", at: repo)

    let review = try await laneDefinition("shop", "feature/pr", codex)
    let tip = try await StackLaneStore.git(["rev-parse", "HEAD"], at: review.root)
    XCTAssertEqual(tip, remoteTip, "A branch only on the remote is checked out as it is there")
    let upstream = try await StackLaneStore.git(["rev-parse", "--abbrev-ref", "feature/pr@{upstream}"], at: review.root)
    XCTAssertEqual(upstream, "origin/feature/pr")

    let file = try await supervisor.createLane(stack: "shop", request: .init(branch: "from-tag", from: "v1"), actor: codex).file
    let lane = try XCTUnwrap(file.definition)
    let start = try await StackLaneStore.git(["rev-parse", "HEAD"], at: lane.root)
    let tag = try await StackLaneStore.git(["rev-parse", "v1^{commit}"], at: repo)
    XCTAssertEqual(start, tag)
    XCTAssertEqual(lane.lane?.from, "v1")
    do { _ = try await supervisor.createLane(stack: "shop", request: .init(branch: "bad-start", from: "no-such-ref"), actor: codex); XCTFail("Accepted a missing start point") }
    catch { XCTAssertTrue(error.localizedDescription.contains("no-such-ref"), error.localizedDescription) }
  }

  func testEnvironmentContractTemplatesAndPortsOnlyForServicesWithPorts() async throws {
    let port = try StackLaneStore.availablePort(excluding: [])
    try await write("""
    name = "Shop"
    root = "\(repo.path)"
    shell = "/bin/sh"
    [env]
    DATABASE = "shop{{lane.ident:+_}}{{lane.ident}}"
    [services.api]
    cmd = "/usr/bin/python3 server.py"
    port = \(port)
    ready.http = "{{url.api}}/health"
    [services.worker]
    cmd = "sleep 60"
    env.API_URL = "{{url.api}}"
    env.SLUG = "{{lane.slug:-main}}"
    """)
    let base = try XCTUnwrap(supervisor.definition("shop"))
    XCTAssertEqual(base.service("api")?.readiness, .http(URL(string: "http://localhost:\(port)/health")!))
    let api = try environment(base, "api")
    XCTAssertEqual(api["PORT"], String(port), "The original checkout gets PORT too")
    XCTAssertEqual(api["CINDERDECK_PORT_API"], String(port))
    XCTAssertEqual(api["CINDERDECK_URL_API"], "http://localhost:\(port)")
    XCTAssertEqual(api["DATABASE"], "shop")
    XCTAssertNil(api["CINDERDECK_LANE"])
    XCTAssertNil(api["COMPOSE_PROJECT_NAME"])
    let worker = try environment(base, "worker")
    XCTAssertEqual(worker["API_URL"], "http://localhost:\(port)")
    XCTAssertEqual(worker["SLUG"], "main")
    XCTAssertNil(worker["PORT"])

    let file = try await supervisor.createLane(stack: "shop", branch: "agent/Env-Lane", actor: codex)
    let lane = try XCTUnwrap(file.definition)
    let assigned = try XCTUnwrap(lane.service("api")?.port)
    XCTAssertNil(lane.service("worker")?.port, "Services without a port get none in lanes")
    XCTAssertEqual(lane.lane?.ports.keys.sorted(), ["api"])
    XCTAssertEqual(assigned % StackLaneStore.blockSize, 0, "A lane's ports start a block")
    XCTAssertEqual(lane.service("api")?.readiness, .http(URL(string: "http://localhost:\(assigned)/health")!))
    XCTAssertEqual(lane.lane?.effectiveSlug, "agent-env-lane")
    XCTAssertEqual(lane.lane?.directory, supervisor.worktreeRoot.appendingPathComponent("shop/agent-env-lane"))
    XCTAssertEqual(lane.root, lane.lane?.directory.appendingPathComponent("shop", isDirectory: true))
    let laneWorker = try environment(lane, "worker")
    XCTAssertNil(laneWorker["PORT"])
    XCTAssertEqual(laneWorker["API_URL"], "http://localhost:\(assigned)", "Templates resolve to the lane's own ports")
    XCTAssertEqual(laneWorker["SLUG"], "agent-env-lane")
    XCTAssertEqual(laneWorker["DATABASE"], "shop_agent_env_lane")
    XCTAssertEqual(laneWorker["COMPOSE_PROJECT_NAME"], "shop-agent-env-lane")
    XCTAssertEqual(laneWorker["CINDERDECK_LANE_DIR"], lane.lane?.directory.path)
    XCTAssertEqual(laneWorker["CINDERDECK_PORT_API"], String(assigned))
    let exported = try control.lanes.environment(stack: file.id, service: nil)
    XCTAssertEqual(exported["CINDERDECK_URL_API"], "http://localhost:\(assigned)")
    XCTAssertNil(exported["FORCE_COLOR"])
    let listed = try await control.handle("lane.env", params: .object(["workspace": .string("shop/agent/Env-Lane"), "service": .string("api")]), actor: codex)
    XCTAssertEqual(listed["environment"]?["PORT"]?.stringValue, String(assigned))
  }

  func testConcurrentCreatesQueueInsteadOfFailing() async throws {
    try await load()
    async let first = supervisor.createLane(stack: "shop", branch: "agent/one", actor: codex)
    async let second = supervisor.createLane(stack: "shop", branch: "agent/two", actor: claude)
    async let third = supervisor.createLane(stack: "shop", branch: "agent/three", actor: codex)
    let lanes = try await [first, second, third].compactMap(\.definition)
    XCTAssertEqual(lanes.count, 3)
    let blocks = Set(lanes.compactMap { $0.service("api")?.port }.map { $0 / StackLaneStore.blockSize })
    XCTAssertEqual(blocks.count, 3, "Each lane gets its own block of ports")
  }

  func testLanesFolderInsideARepositoryIsRefused() async throws {
    try await load()
    defaults.set(repo.appendingPathComponent(".lanes").path, forKey: PreferencesKeys.stacksLanesDirectory)
    do { _ = try await supervisor.createLane(stack: "shop", branch: "nested", actor: codex); XCTFail("Created worktrees inside the source repository") }
    catch { XCTAssertTrue(error.localizedDescription.contains("inside the repository"), error.localizedDescription) }
    XCTAssertTrue(try StackLaneStore.records(in: supervisor.lanesDirectory).isEmpty)
  }

  func testLanesFollowSourceEditsAndNewServicesGetPortsInTheirBlock() async throws {
    try await load()
    let file = try await supervisor.createLane(stack: "shop", branch: "follow", actor: codex)
    let apiPort = try XCTUnwrap(file.definition?.service("api")?.port)
    let second = try StackLaneStore.availablePort(excluding: [apiPort])
    let source = definitions.appendingPathComponent("shop.toml")
    try (String(contentsOf: source) + """

    [services.web]
    cmd = "/usr/bin/python3 server.py"
    port = \(second)
    env.GREETING = "hello"
    """).write(to: source, atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    let lane = try XCTUnwrap(supervisor.definition(file.id))
    let web = try XCTUnwrap(lane.service("web"), "Source edits reach existing lanes")
    XCTAssertEqual(web.environment["GREETING"], "hello")
    XCTAssertEqual(web.port.map { $0 / StackLaneStore.blockSize }, apiPort / StackLaneStore.blockSize)
    XCTAssertEqual(lane.service("api")?.port, apiPort, "Existing assignments are kept")
    XCTAssertEqual(try StackLaneStore.record(id: file.id, in: supervisor.lanesDirectory)?.info.ports["web"], web.port)
  }

  func testVersionOneRecordsLoadPinnedAndCanBeUnpinned() async throws {
    try await load()
    let file = try await supervisor.createLane(stack: "shop", branch: "legacy", actor: codex)
    var saved = try XCTUnwrap(file.definition)
    saved.name = "Saved snapshot"
    let record = try XCTUnwrap(try StackLaneStore.record(id: file.id, in: supervisor.lanesDirectory))
    struct Legacy: Encodable { let definition: StackDefinition; let worktrees: [StackLaneWorktree]; let ready: Bool }
    try StackControlCoding.encoder().encode(Legacy(definition: saved, worktrees: record.worktrees, ready: true))
      .write(to: StackLaneStore.manifest(id: file.id, in: supervisor.lanesDirectory), options: .atomic)
    await supervisor.reloadDefinitions()
    let pinned = try XCTUnwrap(supervisor.files.first { $0.id == file.id })
    XCTAssertEqual(pinned.definition?.name, "Saved snapshot")
    XCTAssertEqual(pinned.lane?.pinned, true)
    XCTAssertTrue(pinned.issues.contains { $0.message.contains("Unpin") })
    _ = try await control.handle("lane.unpin", params: .object(["workspace": .string(file.id)]), actor: codex)
    let followed = try XCTUnwrap(supervisor.definition(file.id))
    XCTAssertEqual(followed.name, "Shop · legacy")
    XCTAssertEqual(followed.lane?.pinned, false)
    XCTAssertEqual(followed.service("api")?.port, saved.service("api")?.port)
  }

  func testCopiedFilesAndIgnoredFilesOnRemoval() async throws {
    try "node_modules/\n.env\n".write(to: repo.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
    try await commitAll("ignore dependencies", at: repo)
    try "SECRET=base\n".write(to: repo.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
    let port = try StackLaneStore.availablePort(excluding: [])
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [services.api]
    cmd = "/usr/bin/python3 server.py"
    port = \(port)
    [lanes]
    copy = [".env", "missing/*.env"]
    """)
    let file = try await supervisor.createLane(stack: "shop", branch: "deps", actor: codex)
    let lane = try XCTUnwrap(file.definition)
    XCTAssertEqual(try String(contentsOf: lane.root.appendingPathComponent(".env")), "SECRET=base\n")
    // An unchanged copy is removed without asking.
    let clean = try await supervisor.removeLane(file.id, actor: codex, options: .init())
    XCTAssertTrue(clean.ignored.isEmpty)
    XCTAssertFalse(FileManager.default.fileExists(atPath: lane.root.path))

    let second = try await laneDefinition("shop", "deps-2", codex)
    let modules = second.root.appendingPathComponent("node_modules/pkg")
    try FileManager.default.createDirectory(at: modules, withIntermediateDirectories: true)
    try "module.exports = 1".write(to: modules.appendingPathComponent("index.js"), atomically: true, encoding: .utf8)
    try "SECRET=changed\n".write(to: second.root.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
    let id = try XCTUnwrap(second.lane.map { _ in second.id })
    do { try await supervisor.removeLane(id, actor: codex); XCTFail("Deleted ignored files without asking") }
    catch {
      XCTAssertEqual((error as? StackControlError)?.code, "ignored_files")
      XCTAssertTrue(error.localizedDescription.contains("node_modules"))
      XCTAssertTrue(error.localizedDescription.contains("changed after Cinderdeck copied it"))
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: modules.path))
    XCTAssertEqual(supervisor.runtime(id, "api").phase, .stopped)
    let report = try await supervisor.removeLane(id, actor: codex, options: .init(discardIgnored: true, deleteLogs: true))
    XCTAssertTrue(report.ignored.contains { $0.path.hasSuffix("node_modules") })
    XCTAssertFalse(FileManager.default.fileExists(atPath: second.root.path))
    let kept = try await StackLaneStore.git(["rev-parse", "--verify", "refs/heads/deps-2"], at: repo)
    XCTAssertFalse(kept.isEmpty)
  }

  func testSetupRunsBeforeStartAndTeardownGuardsRemoval() async throws {
    let port = try StackLaneStore.availablePort(excluding: [])
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [services.api]
    cmd = "/usr/bin/python3 server.py"
    port = \(port)
    ready.http = "{{url.api}}/health"
    ready.timeout = 8
    [tasks.install]
    cmd = "test -n \\"$FAIL_SETUP\\" && exit 4; touch \\"$CINDERDECK_LANE_DIR/installed\\""
    [tasks.drop]
    cmd = "test -f \\"$CINDERDECK_LANE_DIR/allow-teardown\\""
    [lanes]
    setup = "task:install"
    teardown = "task:drop"
    """)
    await control.workspaceRunner.recover()
    let created = try await control.handle("lane.create", params: .object(["workspace": .string("shop"), "branch": .string("setup")]), actor: codex)
    XCTAssertEqual(created["setup"]?["status"]?.stringValue, "succeeded")
    let file = try XCTUnwrap(supervisor.files.first { $0.lane?.name == "setup" })
    let directory = try XCTUnwrap(file.lane?.directory)
    XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("installed").path))
    XCTAssertEqual(supervisor.runtime(file.id, "api").phase, .ready)
    XCTAssertEqual(supervisor.files.first { $0.id == file.id }?.laneSetup?.status, .succeeded)

    let failed = try await control.handle("lane.create", params: .object(["workspace": .string("shop"), "branch": .string("setup-fails"),
      "env": .object(["FAIL_SETUP": .string("1")])]), actor: codex)
    XCTAssertEqual(failed["setup"]?["status"]?.stringValue, "failed")
    XCTAssertNotNil(failed["note"])
    let broken = try XCTUnwrap(supervisor.files.first { $0.lane?.name == "setup-fails" })
    XCTAssertEqual(supervisor.runtime(broken.id, "api").phase, .stopped, "Services do not start after a failed setup")

    do {
      _ = try await control.handle("lane.remove", params: .object(["workspace": .string("shop/setup")]), actor: codex)
      XCTFail("Removed despite a failing teardown")
    } catch { XCTAssertEqual((error as? StackControlError)?.code, "teardown_failed") }
    XCTAssertNotNil(supervisor.definition(file.id))
    try "".write(to: directory.appendingPathComponent("allow-teardown"), atomically: true, encoding: .utf8)
    _ = try await control.handle("lane.remove", params: .object(["workspace": .string("shop/setup")]), actor: codex)
    XCTAssertNil(supervisor.files.first { $0.id == file.id })
    _ = try await control.handle("lane.remove", params: .object(["workspace": .string("shop/setup-fails"), "force_teardown": .bool(true)]), actor: codex)
  }


  func testBindWarningWhenACommandIgnoresItsPort() async throws {
    let fixed = try StackLaneStore.availablePort(excluding: [])
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [services.api]
    cmd = "PORT=\(fixed) exec /usr/bin/python3 server.py"
    port = \(fixed)
    restart = "no"
    """)
    let file = try await supervisor.createLane(stack: "shop", branch: "ignores-port", actor: codex)
    await supervisor.start(stack: file.id, actor: codex)
    let deadline = Date().addingTimeInterval(10)
    while supervisor.runtime(file.id, "api").bindWarning == nil, Date() < deadline { try await Task.sleep(nanoseconds: 200_000_000) }
    let warning = try XCTUnwrap(supervisor.runtime(file.id, "api").bindWarning)
    XCTAssertTrue(warning.contains(String(fixed)) && warning.contains("ignores $PORT"), warning)
    let snapshot = control.stackSnapshot(try XCTUnwrap(supervisor.files.first { $0.id == file.id }))
    XCTAssertEqual(snapshot.services.first?.bindWarning, warning)
  }

  func testSharedServiceRunsOnceInTheOriginalCheckout() async throws {
    let db = try StackLaneStore.availablePort(excluding: [])
    let api = try StackLaneStore.availablePort(excluding: [db])
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [services.db]
    cmd = "/usr/bin/python3 server.py"
    port = \(db)
    ready.port = \(db)
    lane = "shared"
    restart = "no"
    [services.api]
    cmd = "/usr/bin/python3 server.py"
    port = \(api)
    ready.port = \(api)
    depends_on = ["db"]
    env.DB_URL = "{{url.db}}"
    restart = "no"
    """)
    let file = try await supervisor.createLane(stack: "shop", branch: "uses-db", actor: codex)
    let lane = try XCTUnwrap(file.definition)
    XCTAssertNil(lane.service("db"))
    XCTAssertEqual(lane.link("db")?.port, db)
    XCTAssertEqual(lane.lane?.ports.keys.sorted(), ["api"])
    let env = try environment(lane, "api")
    XCTAssertEqual(env["DB_URL"], "http://localhost:\(db)")
    XCTAssertEqual(env["CINDERDECK_PORT_DB"], String(db))
    await supervisor.start(stack: file.id, actor: codex)
    XCTAssertEqual(supervisor.runtime("shop", "db").phase, .ready, "Starting the lane starts the shared service where it lives")
    XCTAssertEqual(supervisor.runtime(file.id, "api").phase, .ready)
    XCTAssertNil(supervisor.states[file.id]?.services["db"])
    XCTAssertEqual(supervisor.dependents(of: "shop"), [file.id])
    do { _ = try await control.handle("services.stop", params: .object(["workspace": .string("shop")]), actor: claude); XCTFail("Stopped a service lanes use") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "in_use") }
    await supervisor.stop(stack: file.id, actor: codex)
    XCTAssertEqual(supervisor.runtime("shop", "db").phase, .ready, "Stopping a lane leaves shared services running")
    let snapshot = control.stackSnapshot(try XCTUnwrap(supervisor.files.first { $0.id == file.id }))
    XCTAssertEqual(snapshot.services.first { $0.name == "db" }?.sharedFrom, "shop")
    XCTAssertEqual(snapshot.laneStatus?.shared, ["db"])
  }

  func testAdoptedWorktreesAreNeverDeleted() async throws {
    try await load()
    let external = root.appendingPathComponent("agent-worktree")
    _ = try await StackLaneStore.git(["worktree", "add", "-b", "agent/own", external.path], at: repo)
    let adopted = try await control.handle("lane.adopt", params: .object(["workspace": .string("shop"), "path": .string(external.path), "start": .bool(false)]), actor: codex)
    let id = try XCTUnwrap(adopted["workspace"]?["id"]?.stringValue)
    let lane = try XCTUnwrap(supervisor.definition(id))
    XCTAssertEqual(lane.lane?.name, "agent/own")
    XCTAssertEqual(lane.lane?.adopted, true)
    XCTAssertEqual(StackLaneStore.relative(lane.root, to: external), "")
    XCTAssertNotEqual(lane.service("api")?.port, supervisor.definition("shop")?.service("api")?.port)
    try "work in progress".write(to: external.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    _ = try await control.handle("lane.remove", params: .object(["workspace": .string(id)]), actor: codex)
    XCTAssertEqual(try String(contentsOf: external.appendingPathComponent("tracked.txt")), "work in progress")
    XCTAssertNil(supervisor.files.first { $0.id == id })

    // Adopting from inside the worktree, then releasing, keeps it too.
    let again = try await supervisor.adoptLane(stack: "shop", path: external.appendingPathComponent("."), name: "mine", actor: codex)
    XCTAssertEqual(again.file.lane?.name, "mine")
    _ = try await control.handle("lane.release", params: .object(["workspace": .string("shop/mine")]), actor: codex)
    XCTAssertTrue(FileManager.default.fileExists(atPath: external.appendingPathComponent("tracked.txt").path))
    do { _ = try await supervisor.adoptLane(stack: "shop", path: repo, name: nil, actor: codex); XCTFail("Adopted the original checkout") }
    catch { XCTAssertTrue(error.localizedDescription.contains("original checkout")) }
  }

  func testDetachedAgentWorktreeCanRunAndReleaseWithoutResettingChanges() async throws {
    try await load()
    let external = root.appendingPathComponent("detached-agent")
    _ = try await StackLaneStore.git(["worktree", "add", "--detach", external.path], at: repo)
    try "work in progress".write(to: external.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    let result = try await control.handle("lane.adopt", params: .object(["workspace": .string("shop"),
      "name": .string("Detached review"), "path": .string(external.path)]), actor: codex)
    let id = try XCTUnwrap(result["workspace"]?["id"]?.stringValue)
    XCTAssertEqual(supervisor.runtime(id, "api").phase, .ready)
    let body = try await response(try XCTUnwrap(supervisor.definition(id)))
    XCTAssertEqual(body["lane"]?.stringValue, "Detached review")
    XCTAssertTrue(StackLaneStore.samePath(URL(fileURLWithPath: try XCTUnwrap(body["cwd"]?.stringValue)), external))
    _ = try await control.handle("lane.release", params: .object(["workspace": .string(id)]), actor: codex)
    let branch = try await StackLaneStore.git(["branch", "--show-current"], at: external)
    XCTAssertEqual(branch, "")
    XCTAssertEqual(try String(contentsOf: external.appendingPathComponent("tracked.txt")), "work in progress")
    XCTAssertEqual(supervisor.runtime(id, "api").phase, .stopped)
  }

  func testWorkspacesSharingARepositoryShareOneWorktree() async throws {
    try await load()
    let port = try StackLaneStore.availablePort(excluding: Set(supervisor.definition("shop")?.services.compactMap(\.port) ?? []))
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [services.web]
    cmd = "/usr/bin/python3 server.py"
    port = \(port)
    """, id: "shopweb")
    let first = try await laneDefinition("shop", "together", codex)
    let second = try await laneDefinition("shopweb", "together", claude)
    XCTAssertEqual(StackLaneStore.relative(first.root, to: second.root), "")
    try await supervisor.removeLane(first.id, actor: codex)
    XCTAssertTrue(FileManager.default.fileExists(atPath: second.root.path), "Another lane still uses the worktree")
    try await supervisor.removeLane(second.id, actor: claude)
    XCTAssertFalse(FileManager.default.fileExists(atPath: second.root.path))
  }

  func testSharedAdoptedWorktreeStaysExternalAfterItsFirstLaneIsRemoved() async throws {
    try await load()
    try await write("""
    root = "\(repo.path)"
    [tasks.check]
    cmd = "pwd"
    """, id: "review")
    let external = root.appendingPathComponent("agent-own")
    _ = try await StackLaneStore.git(["worktree", "add", "-b", "agent/own", external.path], at: repo)
    let adopted = try await supervisor.adoptLane(stack: "shop", path: external, name: nil, actor: codex)
    let borrowed = try await supervisor.createLane(stack: "review", branch: "agent/own", actor: claude)
    XCTAssertEqual(borrowed.lane?.adopted, true)
    XCTAssertEqual(borrowed.laneWorktrees.first?.managed, false)
    try await supervisor.removeLane(adopted.file.id, actor: codex)
    try await supervisor.removeLane(borrowed.id, actor: claude)
    XCTAssertTrue(FileManager.default.fileExists(atPath: external.appendingPathComponent("tracked.txt").path))
  }

  func testSharedWorktreeKeepsCopiedFileMetadataUntilTheLastLaneIsRemoved() async throws {
    try "SECRET=base\n".write(to: repo.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
    for id in ["shop", "review"] {
      try await write("""
      root = "\(repo.path)"
      [tasks.check]
      cmd = "pwd"
      [lanes]
      copy = [".env"]
      """, id: id)
    }
    let first = try await supervisor.createLane(stack: "shop", branch: "shared-copy", actor: codex)
    let second = try await supervisor.createLane(stack: "review", branch: "shared-copy", actor: claude)
    try await supervisor.removeLane(first.id, actor: codex)
    try await supervisor.removeLane(second.id, actor: claude)
    XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(second.definition?.root).path))
    XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent(".env")), "SECRET=base\n")
  }

  func testReleaseProtectsAWorktreeStillReferencedByAnotherLane() async throws {
    try await load()
    try await write("""
    root = "\(repo.path)"
    [tasks.check]
    cmd = "pwd"
    """, id: "review")
    let first = try await supervisor.createLane(stack: "shop", branch: "keep-working", actor: codex)
    let second = try await supervisor.createLane(stack: "review", branch: "keep-working", actor: claude)
    _ = try await supervisor.removeLane(first.id, actor: codex, options: .init(keepWorktrees: true))
    try await supervisor.removeLane(second.id, actor: claude)
    XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(first.definition?.root).path))
  }

  func testUntrackedCopiesAndLinksCanBeRemovedWithoutDeletingTheirSource() async throws {
    try "config".write(to: repo.appendingPathComponent("local.config"), atomically: true, encoding: .utf8)
    try "linked".write(to: repo.appendingPathComponent("local.link"), atomically: true, encoding: .utf8)
    try await write("""
    root = "\(repo.path)"
    [tasks.check]
    cmd = "pwd"
    [lanes]
    copy = ["local.config"]
    link = ["local.link"]
    """)
    let file = try await supervisor.createLane(stack: "shop", branch: "local-config", actor: codex)
    try await supervisor.removeLane(file.id, actor: codex)
    XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent("local.config")), "config")
    XCTAssertEqual(try String(contentsOf: repo.appendingPathComponent("local.link")), "linked")
  }

  func testCopiedDirectoriesAndReplacedLinksRequireExplicitDiscard() async throws {
    try "cache/\n.env\n".write(to: repo.appendingPathComponent(".gitignore"), atomically: true, encoding: .utf8)
    try await commitAll("ignore copied cache", at: repo)
    let cache = repo.appendingPathComponent("cache")
    try FileManager.default.createDirectory(at: cache, withIntermediateDirectories: true)
    try "base".write(to: cache.appendingPathComponent("notes.txt"), atomically: true, encoding: .utf8)
    try "base".write(to: repo.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
    try await write("""
    root = "\(repo.path)"
    [tasks.check]
    cmd = "pwd"
    [lanes]
    copy = ["cache"]
    link = [".env"]
    """)
    let file = try await supervisor.createLane(stack: "shop", branch: "changed-copies", actor: codex)
    let path = try XCTUnwrap(file.definition?.root)
    try "keep notes".write(to: path.appendingPathComponent("cache/notes.txt"), atomically: true, encoding: .utf8)
    try FileManager.default.removeItem(at: path.appendingPathComponent(".env"))
    try "keep env".write(to: path.appendingPathComponent(".env"), atomically: true, encoding: .utf8)
    do { try await supervisor.removeLane(file.id, actor: codex); XCTFail("Lost changed copies") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "ignored_files") }
    XCTAssertEqual(try String(contentsOf: path.appendingPathComponent("cache/notes.txt")), "keep notes")
    XCTAssertEqual(try String(contentsOf: path.appendingPathComponent(".env")), "keep env")
    _ = try await supervisor.removeLane(file.id, actor: codex, options: .init(discardIgnored: true))
    XCTAssertEqual(try String(contentsOf: cache.appendingPathComponent("notes.txt")), "base")
  }

  func testRemovalStopsServicesBeforeTeardownAndProtectsRunningDependents() async throws {
    let port = try StackLaneStore.availablePort(excluding: [])
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [services.api]
    cmd = "/usr/bin/python3 server.py"
    port = \(port)
    ready.port = \(port)
    restart = "no"
    [tasks.drop]
    cmd = "/usr/bin/python3 -c \\"import socket,os; s=socket.socket(); assert s.connect_ex(('127.0.0.1',int(os.environ['CINDERDECK_PORT_API']))) != 0\\"; test $? -eq 0 && touch {{lane.dir}}/torn-down"
    [lanes]
    teardown = "task:drop"
    """, id: "backend")
    try await write("""
    root = "\(repo.path)"
    [services.web]
    cmd = "sleep 300"
    depends_on = ["backend:api"]
    restart = "no"
    """, id: "front")
    let backend = try await supervisor.createLane(stack: "backend", branch: "feature", actor: codex)
    let front = try await supervisor.createLane(stack: "front", branch: "feature", actor: claude)
    await control.workspaceRunner.recover()
    await supervisor.start(stack: front.id, actor: claude)
    let process = try XCTUnwrap(supervisor.runtime(backend.id, "api").process)
    let marker = try XCTUnwrap(backend.lane?.directory).appendingPathComponent("torn-down")
    do { _ = try await control.lanes.remove(backend.id, actor: codex, options: .init()); XCTFail("Removed a lane still in use") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "in_use") }
    XCTAssertEqual(supervisor.runtime(backend.id, "api").process, process)
    XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
    await supervisor.stop(stack: front.id, actor: claude)
    _ = try await control.lanes.remove(backend.id, actor: codex, options: .init())
    XCTAssertTrue(FileManager.default.fileExists(atPath: marker.path), "Teardown ran after its service stopped")
  }

  func testAdoptionUsesTheWorktreeBranchForOtherRepositoriesEvenWithACustomName() async throws {
    try await load()
    let other = root.appendingPathComponent("other")
    _ = try await StackLaneStore.git(["init", "-b", "main", other.path], at: root)
    _ = try await StackLaneStore.git(["config", "user.name", "Lane Tests"], at: other)
    _ = try await StackLaneStore.git(["config", "user.email", "lanes@example.test"], at: other)
    try "base".write(to: other.appendingPathComponent("version.txt"), atomically: true, encoding: .utf8)
    try await commitAll("base", at: other)
    _ = try await StackLaneStore.git(["checkout", "-b", "feature/actual"], at: other)
    try "feature".write(to: other.appendingPathComponent("version.txt"), atomically: true, encoding: .utf8)
    try await commitAll("feature", at: other)
    _ = try await StackLaneStore.git(["checkout", "main"], at: other)
    try await write("""
    root = "\(repo.path)"
    [repos.app]
    path = "."
    [repos.other]
    path = "\(other.path)"
    [tasks.check]
    repo = "other"
    cmd = "pwd"
    """)
    let external = root.appendingPathComponent("agent-own")
    _ = try await StackLaneStore.git(["worktree", "add", "-b", "feature/actual", external.path], at: repo)
    let result = try await supervisor.adoptLane(stack: "shop", path: external, name: "Review feature", actor: codex)
    let lane = try XCTUnwrap(result.file.definition)
    XCTAssertEqual(lane.lane?.name, "Review feature")
    let checkout = try XCTUnwrap(lane.repo("other")?.path)
    let branch = try await StackLaneStore.git(["branch", "--show-current"], at: checkout)
    XCTAssertEqual(branch, "feature/actual")
    XCTAssertEqual(try String(contentsOf: checkout.appendingPathComponent("version.txt")), "feature")
  }

  func testCrossWorkspaceDependenciesPreferTheSameBranchLane() async throws {
    let backendPort = try StackLaneStore.availablePort(excluding: [])
    let webPort = try StackLaneStore.availablePort(excluding: [backendPort])
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [services.api]
    cmd = "/usr/bin/python3 server.py"
    port = \(backendPort)
    ready.port = \(backendPort)
    restart = "no"
    """, id: "backend")
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [services.web]
    cmd = "/usr/bin/python3 server.py"
    port = \(webPort)
    ready.port = \(webPort)
    depends_on = ["backend:api"]
    env.API = "{{url.backend:api}}"
    restart = "no"
    """, id: "front")
    let base = try XCTUnwrap(supervisor.definition("front"))
    XCTAssertEqual(try environment(base, "web")["API"], "http://localhost:\(backendPort)")
    XCTAssertEqual(base.link("backend:api")?.stack, "backend")
    await supervisor.start(stack: "front", actor: .user)
    XCTAssertEqual(supervisor.runtime("backend", "api").phase, .ready, "Starting a workspace starts services it depends on elsewhere")
    XCTAssertEqual(supervisor.runtime("front", "web").phase, .ready)
    await supervisor.stop(stack: "front", actor: .user)
    await supervisor.stop(stack: "backend", actor: .user)

    let backendLane = try await laneDefinition("backend", "feature", codex)
    let frontLane = try await laneDefinition("front", "feature", codex)
    let lanePort = try XCTUnwrap(backendLane.service("api")?.port)
    XCTAssertEqual(try environment(frontLane, "web")["API"], "http://localhost:\(lanePort)")
    XCTAssertEqual(frontLane.link("backend:api")?.stack, backendLane.id)
    let other = try await laneDefinition("front", "solo", codex)
    XCTAssertEqual(try environment(other, "web")["API"], "http://localhost:\(backendPort)", "Without a matching lane, the original checkout is used")
  }

  func testNamedPortsAndTaskPortsAreAssignedInLanes() async throws {
    let web = try StackLaneStore.availablePort(excluding: [])
    let hmr = try StackLaneStore.availablePort(excluding: [web])
    let storybook = try StackLaneStore.availablePort(excluding: [web, hmr])
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [services.web]
    cmd = "/usr/bin/python3 server.py --hmr {{port.web.hmr}}"
    port = \(web)
    ports.hmr = \(hmr)
    ready.port = "hmr"
    [tasks.stories]
    cmd = "echo $PORT $CINDERDECK_TASK_PORT_STORYBOOK"
    ports.storybook = \(storybook)
    """)
    let base = try XCTUnwrap(supervisor.definition("shop"))
    XCTAssertEqual(base.service("web")?.readiness, .port(hmr))
    XCTAssertEqual(base.service("web")?.command, "/usr/bin/python3 server.py --hmr \(hmr)")
    XCTAssertEqual(try environment(base, "web")["CINDERDECK_PORT_WEB_HMR"], String(hmr))
    let lane = try await laneDefinition("shop", "ports", codex)
    let service = try XCTUnwrap(lane.service("web"))
    let laneHMR = try XCTUnwrap(service.ports["hmr"])
    XCTAssertNotEqual(laneHMR, hmr)
    XCTAssertEqual(service.readiness, .port(laneHMR))
    XCTAssertEqual(service.command, "/usr/bin/python3 server.py --hmr \(laneHMR)")
    XCTAssertEqual(try environment(lane, "web")["CINDERDECK_PORT_WEB_HMR"], String(laneHMR))
    XCTAssertNotNil(lane.task("stories")?.ports["storybook"])
    XCTAssertNotEqual(lane.task("stories")?.ports["storybook"], storybook)
    XCTAssertEqual(Set(lane.lane?.ports.keys.map { $0 } ?? []), ["web", "web.hmr", "task:stories.storybook"])
    // A saved service keeps its templates when written back.
    let written = WorkspaceDefinitionWriter.service(try XCTUnwrap(base.service("web")), base: repo)
    XCTAssertTrue(written.contains("{{port.web.hmr}}") && written.contains("ports.hmr = \(hmr)") && written.contains("ready.port = \"hmr\""), written)
  }

  func testMergedLanesAreDetectedAndPruned() async throws {
    try await load()
    _ = try await addOrigin()
    let open = try await laneDefinition("shop", "open", codex)
    let done = try await laneDefinition("shop", "done", codex)
    try "merged work\n".write(to: done.root.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    try await commitAll("finish", at: done.root)
    try "still open\n".write(to: open.root.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    try await commitAll("wip", at: open.root)
    _ = try await StackLaneStore.git(["merge", "--ff-only", "done"], at: repo)
    _ = try await StackLaneStore.git(["push", "origin", "main"], at: repo)
    await supervisor.refreshLaneGitStates()
    XCTAssertEqual(supervisor.laneGitStates[done.id]?.merged, true)
    XCTAssertEqual(supervisor.laneGitStates[open.id]?.merged, false)
    XCTAssertEqual(supervisor.laneGitStates[open.id]?.unpushed, 1)
    let preview = try await control.handle("lane.prune", params: .object(["dry_run": .bool(true)]), actor: codex)
    XCTAssertEqual(preview.arrayValue?.compactMap { $0["lane"]?.stringValue }, [done.id])
    XCTAssertNotNil(supervisor.definition(done.id))
    let pruned = try await control.handle("lane.prune", params: .object(["workspace": .string("shop")]), actor: codex)
    XCTAssertEqual(pruned.arrayValue?.first?["action"]?.stringValue, "removed")
    XCTAssertNil(supervisor.files.first { $0.id == done.id })
    XCTAssertNotNil(supervisor.definition(open.id))
  }

  func testLaneHostnamesAndLogAgeOut() async throws {
    let port = try StackLaneStore.availablePort(excluding: [])
    try await write("""
    root = "\(repo.path)"
    shell = "/bin/sh"
    [services.api]
    cmd = "/usr/bin/python3 server.py"
    port = \(port)
    ready.http = "{{url.api}}/health"
    [lanes]
    hosts = true
    """, id: "Shop_App")
    XCTAssertEqual(supervisor.definition("Shop_App")?.host, "localhost")
    let lane = try await laneDefinition("Shop_App", "agent/hosts", codex)
    XCTAssertEqual(lane.host, "agent-hosts.shop-app.localhost")
    let assigned = try XCTUnwrap(lane.service("api")?.port)
    XCTAssertEqual(lane.service("api")?.readiness, .http(URL(string: "http://agent-hosts.shop-app.localhost:\(assigned)/health")!))
    let env = try environment(lane, "api")
    XCTAssertEqual(env["CINDERDECK_HOST"], "agent-hosts.shop-app.localhost")
    XCTAssertEqual(env["CINDERDECK_URL_API"], "http://agent-hosts.shop-app.localhost:\(assigned)")
    await supervisor.start(stack: lane.id, actor: codex)
    XCTAssertEqual(supervisor.runtime(lane.id, "api").phase, .ready, "Readiness reaches *.localhost through loopback")

    let logs = root.appendingPathComponent("logs")
    let stale = logs.appendingPathComponent("shop--lane-old"), current = logs.appendingPathComponent(lane.id)
    try FileManager.default.createDirectory(at: stale, withIntermediateDirectories: true)
    try "old".write(to: stale.appendingPathComponent("api.log"), atomically: true, encoding: .utf8)
    let old = Date().addingTimeInterval(-20 * 86400)
    try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: stale.appendingPathComponent("api.log").path)
    try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: stale.path)
    await supervisor.sweepLaneLogs()
    XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: current.path))
  }
  func testAgentsShareLaneWithoutClaimsAndLegacyOwnershipDoesNotBlockWork() async throws {
    try await load()
    let legacy = root.appendingPathComponent("claims.json")
    try Data("legacy agent ownership".utf8).write(to: legacy)
    let integration = supervisor.logDirectory.appendingPathComponent("Integration")
    try FileManager.default.createDirectory(at: integration, withIntermediateDirectories: true)
    let oldStore = integration.appendingPathComponent("checkout-reservations.sqlite")
    try Data("retired reservation store".utf8).write(to: oldStore)
    let created = try await control.handle("lane.create", params: .object([
      "workspace": .string("shop"), "branch": .string("shared-agents"), "start": .bool(false)
    ]), actor: codex)
    let id = try XCTUnwrap(created["workspace"]?["id"]?.stringValue)
    XCTAssertNil(created["workspace"]?["claim"])
    _ = try await control.handle("lane.update", params: .object([
      "workspace": .string(id), "name": .string("edited-by-another-agent")
    ]), actor: claude)
    var changed = false
    try await supervisor.performGitChange(stack: id, repos: ["app"]) { changed = true }
    XCTAssertTrue(changed)
    _ = try await control.handle("lane.remove", params: .object(["workspace": .string(id)]), actor: claude)
    XCTAssertNil(supervisor.definition(id))
    XCTAssertEqual(try Data(contentsOf: legacy), Data("legacy agent ownership".utf8))
    XCTAssertEqual(try Data(contentsOf: oldStore), Data("retired reservation store".utf8))
    for method in ["claim", "release", "integration.reservation.list"] {
      do { _ = try await control.handle(method, params: .object(["workspace": .string("shop")]), actor: codex); XCTFail("Retired method accepted") }
      catch { XCTAssertEqual((error as? StackControlError)?.code, "unknown_method") }
    }
  }

}
