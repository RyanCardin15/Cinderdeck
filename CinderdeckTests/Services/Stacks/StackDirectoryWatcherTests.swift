import Darwin
import Foundation
import XCTest
@testable import Cinderdeck

private actor DirectoryChangeCounter {
  private var count = 0
  func increment() { count += 1 }
  func value() -> Int { count }
}

final class StackDirectoryWatcherTests: XCTestCase {
  func testLargeRefTreeDoesNotConsumeOneDescriptorPerFile() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let refs = root.appendingPathComponent("refs/remotes/origin/team")
    try FileManager.default.createDirectory(at: refs, withIntermediateDirectories: true)
    for index in 0..<400 { try Data("ref\n".utf8).write(to: refs.appendingPathComponent("branch-\(index)")) }
    let before = descriptorCount()
    let watcher = try StackDirectoryWatcher(directories: [root, root], onChange: {})
    defer { watcher.stop() }
    try await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertLessThan(descriptorCount() - before, 20)
    // Exercise the same atomic write and command-output path used by PR reads.
    let request = root.appendingPathComponent("request.json")
    let payload = Data(#"{"query":"viewer"}"#.utf8)
    try payload.write(to: request, options: .atomic)
    let result = try await StackCommandRunner.run("/bin/cat", [request.path])
    XCTAssertEqual(result.status, 0)
    XCTAssertEqual(result.output, payload)
  }

  func testNestedInPlaceAtomicAndNewDirectoryChangesAndStop() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let folder = root.appendingPathComponent("logs/refs/remotes/origin")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let file = folder.appendingPathComponent("main")
    try Data("old\n".utf8).write(to: file)
    let counter = DirectoryChangeCounter()
    let watcher = try StackDirectoryWatcher(directories: [root], delay: 0.05) {
      Task { await counter.increment() }
    }
    defer { watcher.stop() }
    for atomic in [false, true] {
      let previous = await counter.value()
      try Data(UUID().uuidString.utf8).write(to: file, options: atomic ? .atomic : [])
      try await waitForChange(counter, after: previous)
    }
    let previous = await counter.value()
    let nested = folder.appendingPathComponent("new/team/branch")
    try FileManager.default.createDirectory(at: nested.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("new\n".utf8).write(to: nested)
    try await waitForChange(counter, after: previous)
    watcher.stop()
    try await Task.sleep(nanoseconds: 200_000_000)
    let stopped = await counter.value()
    try Data("after stop\n".utf8).write(to: file)
    try await Task.sleep(nanoseconds: 250_000_000)
    let afterStop = await counter.value()
    XCTAssertEqual(afterStop, stopped)
  }

  func testRepeatedLogFollowAndCloseDoesNotLeakOrCloseCommandDescriptors() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let file = root.appendingPathComponent("service.log")
    try Data("ready\n".utf8).write(to: file)
    let before = descriptorCount()
    let buffer = LogBuffer(service: "fixture")
    for _ in 0..<50 {
      try await buffer.follow(file, fromEnd: false)
      await buffer.close()
      let result = try await StackCommandRunner.run("/bin/sh", ["-c", "printf output; printf error >&2"])
      XCTAssertEqual(result.status, 0)
      XCTAssertEqual(result.text, "output")
      XCTAssertEqual(result.errorText, "error")
    }
    try await Task.sleep(nanoseconds: 200_000_000)
    XCTAssertLessThan(descriptorCount() - before, 10)
  }

  private func waitForChange(_ counter: DirectoryChangeCounter, after previous: Int) async throws {
    let deadline = Date().addingTimeInterval(5)
    while await counter.value() <= previous, Date() < deadline {
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    let current = await counter.value()
    XCTAssertGreaterThan(current, previous)
  }

  private func descriptorCount() -> Int {
    (0..<1024).filter { fcntl(Int32($0), F_GETFD) >= 0 }.count
  }
}
