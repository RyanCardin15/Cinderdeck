import Foundation
import XCTest
@testable import Cinderdeck

/// Real disposable repositories; timings are observations, never CI thresholds.
final class StackLaneCreationPerformanceTests: XCTestCase {
  func testModalRepositoryDiscoveryPerformance() async throws {
    guard ProcessInfo.processInfo.environment["CINDERDECK_LANE_PERFORMANCE_AUDIT"] == "1" else {
      throw XCTSkip("Set TEST_RUNNER_CINDERDECK_LANE_PERFORMANCE_AUDIT=1 to collect timings")
    }
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    var source = StackDefinition(id: "modal", name: "Modal", file: root.appendingPathComponent("modal.toml"), root: root, shell: "/bin/sh")
    for repoIndex in 0..<4 {
      let repo = root.appendingPathComponent("repo-\(repoIndex)")
      try FileManager.default.createDirectory(at: repo.appendingPathComponent(".git"), withIntermediateDirectories: true)
      source.repos.append(.init(id: "repo\(repoIndex)", path: repo))
      for command in 0..<16 {
        let folder = repo.appendingPathComponent("packages/\(command)/src")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        source.services.append(.init(id: "service-\(repoIndex)-\(command)", command: "true", directory: folder))
        source.tasks.append(.init(id: "task-\(repoIndex)-\(command)", name: "Fixture", command: "true", directory: folder))
      }
    }
    // The former body rediscovered the display list, empty state and button
    // eligibility on each edit. This measures discovery only, not frame pacing.
    var samples: [Double] = []
    for _ in 0..<10 {
      let start = Date()
      let implicit = WorkspaceSetupModel.laneRepositories(in: source).filter { candidate in
        !source.repos.contains { WorkspaceDiscovery.repositoryRoot(containing: $0.path) == candidate.path }
      }
      XCTAssertTrue(implicit.isEmpty)
      XCTAssertFalse(WorkspaceSetupModel.laneRepositories(in: source).isEmpty)
      XCTAssertFalse(WorkspaceSetupModel.laneRepositories(in: source).isEmpty)
      samples.append(Date().timeIntervalSince(start) * 1000)
    }
    let start = Date()
    let snapshot = await LaneCreationRepositories.read(source)
    let snapshotMS = Date().timeIntervalSince(start) * 1000
    XCTAssertEqual(snapshot.repositories.count, 4)
    XCTAssertTrue(snapshot.hasIsolatedRepositories)
    print("LANE_MODAL_DISCOVERY repos=4 services=64 tasks=64 legacy_per_edit_median_ms=\(samples.sorted()[5]) one_time_snapshot_ms=\(snapshotMS)")
  }

  func testMultiRepositoryCreationPerformance() async throws {
    guard ProcessInfo.processInfo.environment["CINDERDECK_LANE_PERFORMANCE_AUDIT"] == "1" else {
      throw XCTSkip("Set TEST_RUNNER_CINDERDECK_LANE_PERFORMANCE_AUDIT=1 to collect timings")
    }
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    var source = StackDefinition(id: "benchmark", name: "Benchmark", file: root.appendingPathComponent("definitions/benchmark.toml"), root: root, shell: "/bin/sh")
    let count = Int(ProcessInfo.processInfo.environment["CINDERDECK_LANE_PERFORMANCE_FILES"] ?? "2500") ?? 2500
    let payload = String(repeating: "Lane fixture content.\n", count: 64)
    for index in 0..<4 {
      let repo = root.appendingPathComponent("repo-\(index)")
      _ = try await StackLaneStore.git(["init", "-b", "main", repo.path], at: root)
      for folder in 0..<25 {
        try FileManager.default.createDirectory(at: repo.appendingPathComponent("src/\(folder)"), withIntermediateDirectories: true)
      }
      for file in 0..<count {
        try payload.write(to: repo.appendingPathComponent("src/\(file % 25)/file-\(file).txt"), atomically: false, encoding: .utf8)
      }
      _ = try await StackLaneStore.git(["add", "."], at: repo)
      _ = try await StackLaneStore.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"], at: repo)
      source.repos.append(.init(id: "repo\(index)", path: repo, laneFrom: "main"))
    }
    var samples: [Double] = []
    for sample in 0..<5 {
      let start = Date()
      let creation = try await StackLaneStore.create(source: source, request: .init(branch: "benchmark-\(sample)"), owner: .user,
        directory: root.appendingPathComponent("definitions/.lanes"), worktreeRoot: root.appendingPathComponent("worktrees"), occupiedPorts: [])
      samples.append(Date().timeIntervalSince(start) * 1000)
      XCTAssertEqual(creation.record.worktrees.count, 4)
      XCTAssertEqual(creation.record.ready, true)
      for tree in creation.record.worktrees {
        let head = try await StackLaneStore.git(["rev-parse", "HEAD"], at: tree.path)
        XCTAssertEqual(head, tree.baseCommit)
        let branch = try await StackLaneStore.git(["branch", "--show-current"], at: tree.source)
        XCTAssertEqual(branch, "main")
      }
    }
    let sorted = samples.sorted()
    print("LANE_PERFORMANCE repos=4 files_per_repo=\(count) median_ms=\(sorted[2]) max_ms=\(sorted.last!) samples=\(samples)")
  }
}
