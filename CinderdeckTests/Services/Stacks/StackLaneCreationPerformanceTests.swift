import Foundation
import XCTest
@testable import Cinderdeck

/// Real disposable repositories; timings are observations, never CI thresholds.
final class StackLaneCreationPerformanceTests: XCTestCase {
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
