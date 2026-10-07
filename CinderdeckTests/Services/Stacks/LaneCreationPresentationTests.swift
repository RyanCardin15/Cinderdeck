import Foundation
import XCTest
@testable import Cinderdeck

@MainActor
final class LaneCreationPresentationTests: XCTestCase {
  func testSnapshotKeepsRepositoryAliasesDefaultsAndSharedFoldersAndRefreshesOnReopen() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let explicit = root.appendingPathComponent("explicit/api")
    let implicit = root.appendingPathComponent("implicit/api")
    let shared = explicit.appendingPathComponent("shared")
    for folder in [explicit, implicit] {
      try FileManager.default.createDirectory(at: folder.appendingPathComponent(".git"), withIntermediateDirectories: true)
    }
    try FileManager.default.createDirectory(at: shared, withIntermediateDirectories: true)
    let package = explicit.appendingPathComponent("package")
    try FileManager.default.createDirectory(at: package, withIntermediateDirectories: true)
    var source = StackDefinition(id: "presentation", name: "Presentation", file: root.appendingPathComponent("presentation.toml"), root: root, shell: "/bin/sh")
    source.repos = [.init(id: "api", path: package, laneFrom: "develop"), .init(id: "shared", path: shared, laneMode: .shared)]
    source.services = [.init(id: "explicit", command: "true", directory: package),
      .init(id: "implicit", command: "true", directory: implicit),
      .init(id: "shared", command: "true", repo: "shared", directory: shared)]
    let snapshot = await LaneCreationRepositories.read(source)
    XCTAssertTrue(snapshot.hasIsolatedRepositories)
    XCTAssertEqual(snapshot.repositories.map(\.id), ["api", "shared", "api-2"])
    XCTAssertEqual(snapshot.repositories[0].laneFrom, "develop")
    XCTAssertEqual(snapshot.repositories[1].laneMode, .shared)
    XCTAssertEqual(snapshot.roots["api"], explicit.resolvingSymlinksInPath())
    XCTAssertEqual(snapshot.roots["api-2"], implicit.resolvingSymlinksInPath())

    try FileManager.default.removeItem(at: implicit.appendingPathComponent(".git"))
    XCTAssertEqual(snapshot.repositories.count, 3, "Editing the sheet uses its existing snapshot")
    let reopened = await LaneCreationRepositories.read(source)
    XCTAssertEqual(reopened.repositories.map(\.id), ["api", "shared"], "A new presentation discovers fresh filesystem state")
  }

  func testCreationReportsReadyOnlyAfterCheckoutAndFilesExist() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let repo = root.appendingPathComponent("repo")
    _ = try await StackLaneStore.git(["init", "-b", "main", repo.path], at: root)
    try "tracked".write(to: repo.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    _ = try await StackLaneStore.git(["add", "."], at: repo)
    _ = try await StackLaneStore.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"], at: repo)
    _ = try await StackLaneStore.git(["update-ref", "refs/remotes/origin/main", "HEAD"], at: repo)
    _ = try await StackLaneStore.git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], at: repo)
    let branches = try await LaneBranchReader.shared.branches(at: repo)
    XCTAssertEqual(branches.map(\.reference), ["refs/heads/main", "refs/remotes/origin/main"])
    XCTAssertEqual(branches.map(\.displayName), ["main", "origin/main"])
    let canonicalRepo = repo.resolvingSymlinksInPath()
    var source = StackDefinition(id: "progress", name: "Progress", file: root.appendingPathComponent("definitions/progress.toml"), root: repo, shell: "/bin/sh")
    source.repos = [.init(id: "repo", path: repo, laneFrom: "main")]
    let definitions = root.appendingPathComponent("definitions/.lanes")
    var events: [StackLaneCreationProgress] = []
    let creation = try await StackLaneStore.create(source: source, request: .init(branch: "progress-fixture"), owner: .user,
      directory: definitions, worktreeRoot: root.appendingPathComponent("worktrees"), occupiedPorts: []) { event in
        events.append(event)
        if case .repositoryReady = event {
          do {
            let journal = try XCTUnwrap(StackLaneStore.records(in: definitions).first)
            XCTAssertEqual(journal.ready, false, "Repository completion is not whole-lane completion")
            XCTAssertTrue(FileManager.default.fileExists(atPath: journal.worktrees[0].path.appendingPathComponent("tracked.txt").path))
          } catch { XCTFail(error.localizedDescription) }
        }
      }
    XCTAssertEqual(events, [.checkingRepositories, .preparingWorktrees([canonicalRepo]), .checkingOut(canonicalRepo),
      .repositoryReady(canonicalRepo), .copyingFiles, .savingLane])
    XCTAssertEqual(creation.record.ready, true)
  }

  func testReviewedCreationForwardsProgressThroughWorkspaceLoadAndSetup() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let repo = root.appendingPathComponent("repo")
    _ = try await StackLaneStore.git(["init", "-b", "main", repo.path], at: root)
    _ = try await StackLaneStore.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], at: repo)
    let definitions = root.appendingPathComponent("definitions")
    try FileManager.default.createDirectory(at: definitions, withIntermediateDirectories: true)
    try """
    name = "Progress"
    root = "\(repo.path)"
    shell = "/bin/sh"
    [repos.app]
    path = "\(repo.path)"
    [tasks.prepare]
    repo = "app"
    cmd = "printf ready > setup-finished.txt"
    [lanes]
    setup = "task:prepare"
    """.write(to: definitions.appendingPathComponent("progress.toml"), atomically: true, encoding: .utf8)
    let suite = "LaneCreationPresentationTests-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set(definitions.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(root.appendingPathComponent("worktrees").path, forKey: PreferencesKeys.stacksLanesDirectory)
    let supervisor = StackSupervisor(store: nil, defaults: defaults, logRoot: root.appendingPathComponent("logs"),
      environment: { _ in ProcessInfo.processInfo.environment })
    let control = StackControlService(supervisor: supervisor)
    var events: [StackLaneCreationProgress] = []
    control.laneCreationPresenter = { _, options, create in
      var approved = options
      approved.request.branch = "reviewed-progress"
      approved.progress = { events.append($0) }
      return try await create(approved)
    }
    do {
      await supervisor.reloadDefinitions()
      await control.workspaceRunner.recover()
      let result = try await control.handle("lane.create", params: .object(["workspace": .string("progress"), "start": .bool(false)]), actor: .user)
      XCTAssertEqual(result["setup"]?["status"]?.stringValue, "succeeded", result["setup"]?["detail"]?.stringValue ?? "No setup detail")
      let lane = try XCTUnwrap(supervisor.definition(result["workspace"]?["id"]?.stringValue ?? ""))
      XCTAssertTrue(FileManager.default.fileExists(atPath: lane.root.appendingPathComponent("setup-finished.txt").path))
      XCTAssertEqual(events.first, .loadingWorkspace)
      XCTAssertEqual(events.suffix(3), [.savingLane, .loadingWorkspace, .runningSetup("task:prepare")])
      await control.workspaceRunner.cancelAll()
      await supervisor.shutdownMonitoring()
    } catch {
      await control.workspaceRunner.cancelAll()
      await supervisor.shutdownMonitoring()
      throw error
    }
  }

  func testProgressRetainsConcurrentRepositoryStatesDuringSubmodulesAndSetup() {
    let a = URL(fileURLWithPath: "/fixture/a"), b = URL(fileURLWithPath: "/fixture/b")
    var state = LaneCreationProgressState()
    state.receive(.preparingWorktrees([a, b]))
    state.receive(.checkingOut(a)); state.receive(.checkingOut(b))
    state.receive(.repositoryReady(b)); state.receive(.updatingSubmodules(a))
    XCTAssertEqual(state.repositories[b], "Ready")
    XCTAssertEqual(state.repositories[a], "Initializing submodules…")
    XCTAssertTrue(state.label.contains("1 of 2"))
    state.receive(.repositoryReady(a)); state.receive(.repositoryReady(a))
    XCTAssertTrue(state.label.contains("2 of 2"), "Repeated reports must not overcount completion")
    state.receive(.runningSetup("task:prepare"))
    XCTAssertTrue(state.label.contains("task:prepare"))
    XCTAssertEqual(state.repositories[b], "Ready", "Setup does not erase repository progress")
  }
}
