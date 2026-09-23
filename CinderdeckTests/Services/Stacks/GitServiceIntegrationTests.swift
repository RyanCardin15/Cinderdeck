import Darwin
import Foundation
import XCTest
@testable import Cinderdeck

@MainActor
final class GitServiceIntegrationTests: XCTestCase {
  private var root: URL!
  private var seed: URL!
  private var clone: URL!
  private var git: GitService!
  override func setUp() async throws {
    root = try StackTestSupport.temporaryDirectory()
    seed = root.appendingPathComponent("seed"); clone = root.appendingPathComponent("clone")
    git = GitService()
    _ = try await run(["init", "--bare", "remote.git"], at: root)
    _ = try await run(["init", "-b", "main", "seed"], at: root)
    try await configure(seed)
    try "initial\n".write(to: seed.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    _ = try await run(["add", "."], at: seed)
    _ = try await run(["commit", "-m", "initial"], at: seed)
    _ = try await run(["remote", "add", "origin", root.appendingPathComponent("remote.git").path], at: seed)
    _ = try await run(["branch", "feat/remote-only"], at: seed)
    _ = try await run(["push", "-u", "origin", "main", "feat/remote-only"], at: seed)
    _ = try await run(["clone", "--branch", "main", root.appendingPathComponent("remote.git").path, "clone"], at: root)
    try await configure(clone)
    _ = try await run(["branch", "feat/local"], at: clone)
  }
  override func tearDown() async throws {
    if let root { try? FileManager.default.removeItem(at: root) }
    git = nil
  }
  func testLocalAndRemoteTrackingSwitchWithStashAndPop() async throws {
    let branches = try await git.branches(at: clone)
    XCTAssertFalse(branches.contains { $0.reference.hasSuffix("origin/HEAD") })
    let local = try XCTUnwrap(branches.first { $0.name == "feat/local" && !$0.isRemote })
    try await git.switchBranch(local, at: clone, dirty: .requireClean)
    var status = try await git.status(at: clone)
    XCTAssertEqual(status.branch, "feat/local")
    try "unsaved\n".write(to: clone.appendingPathComponent("new.txt"), atomically: true, encoding: .utf8)
    let remote = try XCTUnwrap(branches.first { $0.name == "feat/remote-only" && $0.isRemote })
    try await git.switchBranch(remote, at: clone, dirty: .stash)
    status = try await git.status(at: clone)
    XCTAssertEqual(status.branch, "feat/remote-only"); XCTAssertEqual(status.upstream, "origin/feat/remote-only")
    XCTAssertFalse(status.isDirty)
    let stashes = try await git.stashes(at: clone)
    XCTAssertEqual(stashes.count, 1)
    try await git.applyStash(stashes[0], at: clone, drop: false)
    XCTAssertEqual(try String(contentsOf: clone.appendingPathComponent("new.txt")), "unsaved\n")
    let remaining = try await git.stashes(at: clone)
    XCTAssertTrue(remaining.isEmpty)
    let recent = try await git.recentBranches(at: clone)
    XCTAssertEqual(recent.first, "feat/remote-only")
  }
  func testMergeInProgressBlocksSwitchAndKeepsChanges() async throws {
    let oid = try await run(["rev-parse", "HEAD"], at: clone).trimmingCharacters(in: .whitespacesAndNewlines)
    try (oid + "\n").write(to: clone.appendingPathComponent(".git/MERGE_HEAD"), atomically: true, encoding: .utf8)
    let branch = GitBranch(name: "feat/local", reference: "refs/heads/feat/local", isRemote: false)
    do { try await git.switchBranch(branch, at: clone, dirty: .stash); XCTFail("Expected merge block") }
    catch { XCTAssertTrue(error.localizedDescription.contains("Merge in progress")) }
    let status = try await git.status(at: clone)
    XCTAssertEqual(status.branch, "main")
  }
  func testRequireCleanRefusesNewChangesAndCarryPreservesThem() async throws {
    try "changed\n".write(to: clone.appendingPathComponent("tracked.txt"), atomically: true, encoding: .utf8)
    let branch = GitBranch(name: "feat/local", reference: "refs/heads/feat/local", isRemote: false)
    do { try await git.switchBranch(branch, at: clone, dirty: .requireClean); XCTFail("Expected dirty block") }
    catch { XCTAssertTrue(error.localizedDescription.contains("Working tree changed")) }
    try await git.switchBranch(branch, at: clone, dirty: .carry)
    XCTAssertEqual(try String(contentsOf: clone.appendingPathComponent("tracked.txt")), "changed\n")
    let status = try await git.status(at: clone)
    XCTAssertEqual(status.branch, "feat/local"); XCTAssertTrue(status.isDirty)
  }
  func testFetchAndFastForwardOnlyPullRejectDivergence() async throws {
    try "remote\n".write(to: seed.appendingPathComponent("remote.txt"), atomically: true, encoding: .utf8)
    _ = try await run(["add", "."], at: seed); _ = try await run(["commit", "-m", "remote"], at: seed)
    _ = try await run(["push"], at: seed)
    try "local\n".write(to: clone.appendingPathComponent("local.txt"), atomically: true, encoding: .utf8)
    _ = try await run(["add", "."], at: clone); _ = try await run(["commit", "-m", "local"], at: clone)
    try await git.fetch(at: clone)
    let status = try await git.status(at: clone)
    XCTAssertEqual(status.ahead, 1); XCTAssertEqual(status.behind, 1)
    do { try await git.pull(at: clone); XCTFail("Should reject a divergent pull") }
    catch { XCTAssertTrue(error.localizedDescription.contains("Diverged")) }
    let after = try await git.status(at: clone)
    XCTAssertEqual(after.oid, status.oid)
  }
  func testWorktreeDirectoriesAndExternalBranchWatcher() async throws {
    let worktree = root.appendingPathComponent("worktree")
    _ = try await run(["worktree", "add", "-b", "linked", worktree.path], at: clone)
    let dirs = try await git.gitDirectories(at: worktree)
    XCTAssertEqual(dirs.count, 2); XCTAssertNotEqual(dirs[0], dirs[1])
    let monitor = GitStatusMonitor(git: git)
    monitor.configure([.init(id: "linked", path: worktree)])
    for _ in 0..<50 where monitor.statuses[worktree]?.branch != "linked" { try await Task.sleep(nanoseconds: 100_000_000) }
    try await Task.sleep(nanoseconds: 300_000_000)
    _ = try await run(["switch", "-c", "external-change"], at: worktree)
    for _ in 0..<40 where monitor.statuses[worktree]?.branch != "external-change" { try await Task.sleep(nanoseconds: 100_000_000) }
    XCTAssertEqual(monitor.statuses[worktree]?.branch, "external-change")
    monitor.stop()
  }
  func testLargeRepositoryMonitoringLeavesGitHubRequestsUsable() async throws {
    let oid = try await run(["rev-parse", "HEAD"], at: clone).trimmingCharacters(in: .whitespacesAndNewlines)
    let refs = clone.appendingPathComponent(".git/refs/remotes/origin/team")
    try FileManager.default.createDirectory(at: refs, withIntermediateDirectories: true)
    for index in 0..<400 {
      try Data("\(oid)\n".utf8).write(to: refs.appendingPathComponent("branch-\(index)"))
    }
    let before = (0..<1024).filter { fcntl(Int32($0), F_GETFD) >= 0 }.count
    let monitor = GitStatusMonitor(git: git)
    monitor.configure([.init(id: "large", path: clone)])
    defer { monitor.stop() }
    for _ in 0..<50 where monitor.statuses[clone]?.branch != "main" {
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    try await Task.sleep(nanoseconds: 300_000_000)
    XCTAssertEqual(monitor.statuses[clone]?.branch, "main")
    let after = (0..<1024).filter { fcntl(Int32($0), F_GETFD) >= 0 }.count
    XCTAssertLessThan(after - before, 20)

    // Use the real GitHub file/spawn transport, but never contact GitHub.
    let cli = root.appendingPathComponent("fake-gh")
    try """
      #!/bin/sh
      while [ "$#" -gt 0 ]; do
        if [ "$1" = "--input" ]; then
          test -s "$2" || exit 1
          /usr/bin/grep -q 'viewer' "$2" || exit 2
          printf '%s' '{"data":{"viewer":{"login":"fixture-user"}}}'
          exit 0
        fi
        shift
      done
      exit 3
      """.write(to: cli, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cli.path)
    let service = GitHubPRService(configuration: {
      .init(executable: cli.path, environment: ProcessInfo.processInfo.environment)
    })
    let login = try await service.viewer()
    XCTAssertEqual(login, "fixture-user")
  }
  func testStashDropResolvesOIDAfterReordering() async throws {
    try "first\n".write(to: clone.appendingPathComponent("first.txt"), atomically: true, encoding: .utf8)
    let branch = GitBranch(name: "feat/local", reference: "refs/heads/feat/local", isRemote: false)
    try await git.switchBranch(branch, at: clone, dirty: .stash)
    let list = try await git.stashes(at: clone)
    let first = try XCTUnwrap(list.first)
    try "second\n".write(to: clone.appendingPathComponent("second.txt"), atomically: true, encoding: .utf8)
    _ = try await run(["stash", "push", "-u", "-m", "user stash"], at: clone)
    try await git.applyStash(first, at: clone, drop: true)
    let remaining = try await run(["stash", "list"], at: clone)
    XCTAssertTrue(remaining.contains("user stash")); XCTAssertFalse(remaining.contains("cinderdeck:"))
  }
  private func configure(_ directory: URL) async throws {
    for (key, value) in [("user.name", "Cinderdeck Test"), ("user.email", "cinderdeck-test@example.invalid"), ("commit.gpgsign", "false"), ("core.hooksPath", "/dev/null")] {
      _ = try await run(["config", key, value], at: directory)
    }
  }
  private func run(_ args: [String], at directory: URL) async throws -> String {
    let result = try await StackCommandRunner.run("/usr/bin/git", args, directory: directory)
    guard result.status == 0 else { throw StackError.message(result.errorText) }
    return result.text
  }
}
