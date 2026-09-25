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
    control = StackControlService(supervisor: supervisor, claimsFile: root.appendingPathComponent("claims.json"))
  }

  override func tearDown() async throws {
    // Do not use the live control socket or persist claims in the user's profile.
    await control?.workspaceRunner.cancelAll()
    await supervisor?.stopAll()
    await supervisor?.shutdownMonitoring()
    control = nil; supervisor = nil; defaults = nil
    if let root { try? FileManager.default.removeItem(at: root) }
  }

  func testLaneEditingKeepsIdentityAndWorktreesAndHonorsClaims() async throws {
    try await load()
    let created = try await control.handle("lane.create", params: .object(["workspace": .string("shop"), "branch": .string("agent/original"),
      "start": .bool(false)]), actor: codex)
    let id = try XCTUnwrap(created["workspace"]?["id"]?.stringValue)
    let before = try XCTUnwrap(StackLaneStore.record(id: id, in: supervisor.lanesDirectory))
    let update: JSONValue = .object(["workspace": .string(id), "name": .string("agent/renamed"), "env": .object(["MODE": .string("review")])])
    do { _ = try await control.handle("lane.update", params: update, actor: claude); XCTFail("Claimed") }
    catch { XCTAssertEqual((error as? StackControlError)?.code, "claimed") }
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

  func testControlCreatesClaimsAndProtectsOnlyTheOwnedLane() async throws {
    try await load()
    _ = try await control.handle("claim", params: .object(["workspace": .string("shop")]), actor: claude)
    let created = try await control.handle("lane.create", params: .object([
      "workspace": .string("shop"), "branch": .string("agent/codex"), "start": .bool(false)]), actor: codex)
    let id = try XCTUnwrap(created["workspace"]?["id"]?.stringValue)
    XCTAssertEqual(control.claims[id]?.holder, codex)
    XCTAssertEqual(control.claims["shop"]?.holder, claude)
    for method in ["services.start", "services.stop", "services.restart", "lane.remove"] {
      do {
        _ = try await control.handle(method, params: .object(["workspace": .string("shop/agent/codex")]), actor: claude)
        XCTFail("Ignored claim for \(method)")
      } catch { XCTAssertEqual((error as? StackControlError)?.code, "claimed") }
    }
    _ = try await control.handle("lane.remove", params: .object(["workspace": .string(id)]), actor: codex)
    XCTAssertNil(control.claims[id])
    XCTAssertEqual(control.claims["shop"]?.holder, claude)
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
    control = StackControlService(supervisor: supervisor, claimsFile: root.appendingPathComponent("edit-claims.json"))
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

  // MARK: Redesigned lanes

  private func write(_ source: String, id: String = "shop") async throws {
    try source.write(to: definitions.appendingPathComponent(id + ".toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    XCTAssertNotNil(supervisor.definition(id), supervisor.files.first { $0.id == id }?.issues.map(\.message).joined(separator: "; ") ?? "missing")
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
}
