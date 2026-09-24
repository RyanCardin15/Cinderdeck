import Darwin
import Foundation
import XCTest
@testable import Cinderdeck

private actor LaneReloadGate {
  private var reads = 0
  private var pending: [Int: CheckedContinuation<Void, Never>] = [:]
  private var observers: [(Int, CheckedContinuation<Void, Never>)] = []

  func read(_ directory: URL) async throws -> [StackDefinitionFile] {
    let snapshot = try StackDefinitionLoader.loadDirectory(directory)
      + StackLaneStore.files(in: StackLaneStore.directory(for: directory))
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
    let list = try await control.handle("lane.list", params: .object(["stack": .string("shop")]), actor: codex)
    XCTAssertEqual(list.arrayValue?.count, 3)
    let alias = try await control.handle("stack.get", params: .object(["stack": .string("shop/agent/codex-1")]), actor: codex)
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
      _ = try await StackLaneStore.create(source: source, branch: "invalid", owner: codex,
        directory: supervisor.lanesDirectory, occupiedPorts: [])
      XCTFail("Accepted external readiness")
    } catch { XCTAssertTrue(error.localizedDescription.contains("localhost")) }
    XCTAssertTrue(try StackLaneStore.records(in: supervisor.lanesDirectory).isEmpty)
  }

  func testControlCreatesClaimsAndProtectsOnlyTheOwnedLane() async throws {
    try await load()
    _ = try await control.handle("claim", params: .object(["stack": .string("shop")]), actor: claude)
    let created = try await control.handle("lane.create", params: .object([
      "stack": .string("shop"), "branch": .string("agent/codex"), "start": .bool(false)]), actor: codex)
    let id = try XCTUnwrap(created["stack"]?["id"]?.stringValue)
    XCTAssertEqual(control.claims[id]?.holder, codex)
    XCTAssertEqual(control.claims["shop"]?.holder, claude)
    for method in ["stack.start", "stack.stop", "stack.restart", "lane.remove"] {
      do {
        _ = try await control.handle(method, params: .object(["stack": .string("shop/agent/codex")]), actor: claude)
        XCTFail("Ignored claim for \(method)")
      } catch { XCTAssertEqual((error as? StackControlError)?.code, "claimed") }
    }
    _ = try await control.handle("lane.remove", params: .object(["stack": .string(id)]), actor: codex)
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
    let record = try await StackLaneStore.create(source: source, branch: "multi", owner: codex,
      directory: supervisor.lanesDirectory, occupiedPorts: Set(source.services.compactMap(\.port)))
    XCTAssertEqual(record.worktrees.count, 2)
    XCTAssertEqual(Set(record.definition.services.map(\.directory)).count, 2)
    XCTAssertEqual(record.definition.services[1].dependencies, ["api"])
    for service in record.definition.services {
      XCTAssertEqual(record.definition.repo(try XCTUnwrap(service.repo))?.path, service.directory)
      let branch = try await StackLaneStore.git(["branch", "--show-current"], at: service.directory)
      XCTAssertEqual(branch, "multi")
    }
    try await StackLaneStore.remove(record)
  }

  func testFailedCreateRollsBackWorktreesAndMalformedRecordDoesNotHideBase() async throws {
    try await load()
    let subfolder = repo.appendingPathComponent("new-folder")
    try FileManager.default.createDirectory(at: subfolder, withIntermediateDirectories: true)
    try "uncommitted".write(to: subfolder.appendingPathComponent("file"), atomically: true, encoding: .utf8)
    var source = try XCTUnwrap(supervisor.definition("shop"))
    source.services[0].directory = subfolder
    do {
      _ = try await StackLaneStore.create(source: source, branch: "rollback", owner: codex,
        directory: supervisor.lanesDirectory, occupiedPorts: [])
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
    let status = try await control.handle("stack.get", params: .object(["stack": .string("shop/missing")]), actor: codex)
    XCTAssertEqual(status["id"]?.stringValue, file.id)
    XCTAssertFalse(status["issues"]?.arrayValue?.isEmpty ?? true)
    _ = try await control.handle("lane.remove", params: .object(["stack": .string("shop/missing")]), actor: codex)
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
        "stack": .string("shop"), "branch": .string("occupied"), "dirty": .string("stash")]), actor: codex)
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

  func testIncompleteJournalCannotLaunchAndOccupiedPortsAreSkipped() async throws {
    try await load()
    let file = try await supervisor.createLane(stack: "shop", branch: "journal", actor: codex)
    var record = try XCTUnwrap(StackLaneStore.records(in: supervisor.lanesDirectory).first)
    record.ready = false
    let manifest = try XCTUnwrap(record.definition.lane?.directory).appendingPathComponent("lane.json")
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
    XCTAssertTrue(lines.contains { $0.contains("/repo-1") })
    XCTAssertTrue(lines.contains(String(try XCTUnwrap(definition.service("api")?.port))))
    XCTAssertTrue(lines.contains("task-config"), "Tasks must keep their own PORT even when they share a service id")
    try await supervisor.removeLane(lane.id, actor: codex)
  }
}
