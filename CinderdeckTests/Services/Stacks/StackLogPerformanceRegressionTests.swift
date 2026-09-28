import Foundation
import XCTest
@testable import Cinderdeck

final class StackLogPerformanceRegressionTests: XCTestCase {
  func testHeapMergeAndBoundedTailMatchStableReferenceIncludingTies() {
    for serviceCount in [0, 1, 2, 3, 16, 32] {
      let buffers = (0..<serviceCount).map { service in
        (0..<(service % 5 * 13)).map { line in
          StackLogLine(service: "s\(service)", text: "\(line)", timestamp: Date(timeIntervalSince1970: Double(line / 3)))
        }
      }
      let expected = buffers.flatMap { $0 }.enumerated().sorted {
        $0.element.timestamp == $1.element.timestamp ? $0.offset < $1.offset : $0.element.timestamp < $1.element.timestamp
      }.map(\.element)
      XCTAssertEqual(LogBuffer.merged(buffers), expected)
      for limit in [-1, 0, 1, 2, 17, 200, 5000] {
        XCTAssertEqual(LogBuffer.merged(buffers, limit: limit), Array(expected.suffix(max(0, limit))), "services=\(serviceCount), limit=\(limit)")
      }
    }
  }

  func testSnapshotFiltersBeforeApplyingLimitAndHandlesClockMovingBackwards() async {
    let buffer = LogBuffer(service: "fixture", capacity: 5)
    for time in [1, 2, 3, 4, 4, 2] { await buffer.append("\(time)", at: Date(timeIntervalSince1970: Double(time))) }
    let recent = await buffer.snapshot(limit: 2, after: 3)
    XCTAssertEqual(recent.map(\.text), ["4", "4"])
    let empty = await buffer.snapshot(limit: 200, after: 4)
    XCTAssertTrue(empty.isEmpty)
    let zero = await buffer.snapshot(limit: 0)
    XCTAssertTrue(zero.isEmpty)
    let tail = await buffer.snapshot(limit: 1)
    XCTAssertEqual(tail.map(\.text), ["2"])
    await buffer.clear()
    let cleared = await buffer.snapshot(after: 0)
    XCTAssertTrue(cleared.isEmpty)
  }

  func testLiveFilterTracksAppendsEvictionsQueryChangesAndClear() {
    var filter = StackLogFilter()
    let first = StackLogLine(service: "web", text: "\u{1B}[31mERROR: café\u{1B}[0m")
    let second = StackLogLine(service: "api", text: "ready")
    let third = StackLogLine(service: "api", text: "error: timeout")
    XCTAssertEqual(filter.filter([first, second], query: "error"), [first])
    XCTAssertEqual(filter.filter([second, third], query: "error"), [third])
    XCTAssertEqual(filter.filter([second, third], query: "READY"), [second])
    XCTAssertEqual(filter.filter([first, second], query: "café"), [first])
    XCTAssertEqual(filter.filter([second, third], query: ""), [second, third])
    XCTAssertEqual(filter.filter([], query: "error"), [])
    XCTAssertEqual(filter.filter([third], query: "error"), [third])
  }

  func testPlainTextFastPathPreservesUnicodeAndMatchesParserForControls() {
    for value in ["", "Hello\tworld\n", "你好 👩🏽‍💻 café", "\u{1B}[31mred\u{1B}[0m", "a\rb\u{7}c\u{7f}",
      "\u{1B}]8;;https://example.test\u{7}link\u{1B}]8;;\u{7}"] {
      var parser = AnsiParser.State()
      XCTAssertEqual(AnsiParser.plainText(value), parser.parse(value).map(\.text).joined())
    }
  }
}
