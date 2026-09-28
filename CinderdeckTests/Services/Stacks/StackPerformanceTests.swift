import Foundation
import XCTest
@testable import Cinderdeck

/// Opt-in, repeatable workloads. Timings are observations, not flaky CI thresholds.
final class StackPerformanceTests: XCTestCase {
  func testPerformanceAudit() async throws {
    guard ProcessInfo.processInfo.environment["CINDERDECK_PERFORMANCE_AUDIT"] == "1" else {
      throw XCTSkip("Set TEST_RUNNER_CINDERDECK_PERFORMANCE_AUDIT=1 to collect timings")
    }
    var commandTimes: [Double] = []
    for _ in 0..<40 {
      let start = Date()
      let result = try await StackCommandRunner.run("/usr/bin/true", [])
      XCTAssertEqual(result.status, 0)
      commandTimes.append(Date().timeIntervalSince(start) * 1000)
    }
    report("short_command_ms", commandTimes)

    let buffers = (0..<32).map { service in
      (0..<5000).map { line in
        StackLogLine(service: "service-\(service)", text: "line \(line)",
          timestamp: Date(timeIntervalSince1970: Double(line * 32 + service)))
      }
    }
    var mergeTimes: [Double] = []
    for _ in 0..<8 {
      let start = Date()
      let merged = LogBuffer.merged(buffers)
      XCTAssertEqual(merged.count, 160_000)
      XCTAssertEqual(merged.last?.service, "service-31")
      mergeTimes.append(Date().timeIntervalSince(start) * 1000)
    }
    report("merge_32x5000_ms", mergeTimes)
    var tailTimes: [Double] = []
    for _ in 0..<40 {
      let start = Date()
      let tail = LogBuffer.merged(buffers, limit: 200)
      XCTAssertEqual(tail.count, 200)
      XCTAssertEqual(tail.last?.service, "service-31")
      tailTimes.append(Date().timeIntervalSince(start) * 1000)
    }
    report("tail_200_from_32x5000_ms", tailTimes)
    let searchLines = (0..<5000).map { StackLogLine(service: "api", text: "\u{1B}[32mrequest \($0) completed successfully\u{1B}[0m") }
    var matcher = StackLogFilter()
    _ = matcher.filter(searchLines, query: "completed")
    var uncachedTimes: [Double] = [], cachedTimes: [Double] = []
    for _ in 0..<10 {
      var start = Date()
      XCTAssertEqual(searchLines.filter { AnsiParser.plainText($0.text).localizedCaseInsensitiveContains("completed") }.count, 5000)
      uncachedTimes.append(Date().timeIntervalSince(start) * 1000)
      start = Date()
      XCTAssertEqual(matcher.filter(searchLines, query: "completed").count, 5000)
      cachedTimes.append(Date().timeIntervalSince(start) * 1000)
    }
    report("filter_5000_uncached_ms", uncachedTimes)
    report("filter_5000_cached_ms", cachedTimes)
  }

  private func report(_ name: String, _ samples: [Double]) {
    let sorted = samples.sorted()
    print("PERFORMANCE \(name) median=\(sorted[sorted.count / 2]) p95=\(sorted[min(sorted.count - 1, Int(Double(sorted.count) * 0.95))]) samples=\(samples.count)")
  }
}
