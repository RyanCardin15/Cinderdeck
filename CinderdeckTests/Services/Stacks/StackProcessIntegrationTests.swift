import Darwin
import Foundation
import XCTest
@testable import Cinderdeck

final class StackProcessIntegrationTests: XCTestCase {
  func testStopKillsEntireProcessGroup() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let process = ServiceProcess()
    let launch = StackTestSupport.simpleDefinition(root: root, command: "sleep 300 & sleep 300 & wait")
    let identity = try await process.launch(launch, environment: ProcessInfo.processInfo.environment, logURL: root.appendingPathComponent("test.log"))
    XCTAssertTrue(identity.matchesLiveProcess)
    XCTAssertEqual(getpgid(identity.pid), identity.pid)
    try await Task.sleep(nanoseconds: 100_000_000)
    try await process.stop(signal: SIGTERM, timeout: 0.3)
    XCTAssertFalse(identity.matchesLiveProcess)
    let result = try await StackCommandRunner.run("/usr/bin/pgrep", ["-g", String(identity.pgid)])
    XCTAssertEqual(result.status, 1, result.text)
  }
  func testEscalatesWhenTermIsIgnored() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let process = ServiceProcess()
    let identity = try await process.launch(StackTestSupport.simpleDefinition(root: root, command: "trap '' TERM; echo READY; while :; do sleep 1; done"),
      environment: ProcessInfo.processInfo.environment, logURL: root.appendingPathComponent("test.log"))
    try await Task.sleep(nanoseconds: 150_000_000)
    try await process.stop(signal: SIGTERM, timeout: 0.1)
    XCTAssertFalse(identity.matchesLiveProcess)
  }
  func testLogReadinessAndReattachCanStopSameGroup() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let process = ServiceProcess()
    let url = root.appendingPathComponent("test.log")
    let identity = try await process.launch(StackTestSupport.simpleDefinition(root: root, command: "sleep 0.1; echo READY; sleep 300"),
      environment: ProcessInfo.processInfo.environment, logURL: url)
    let log = LogBuffer(service: "test")
    try await log.follow(url, fromEnd: false)
    try await Task.sleep(nanoseconds: 350_000_000)
    let ready = await ReadinessProbe.check(.log("READY"), startedAt: Date(), log: log)
    XCTAssertTrue(ready)
    let adopted = ServiceProcess()
    try await adopted.reattach(identity)
    try await adopted.stop(signal: SIGTERM, timeout: 0.2)
    _ = await process.waitForExit()
    XCTAssertFalse(identity.matchesLiveProcess)
    await log.close()
  }
  func testPortHTTPReadinessAndConflictOwner() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let port = try freePort()
    let process = ServiceProcess()
    let identity = try await process.launch(StackTestSupport.simpleDefinition(root: root, command: "/usr/bin/python3 -m http.server \(port) --bind 127.0.0.1"),
      environment: ProcessInfo.processInfo.environment, logURL: root.appendingPathComponent("http.log"))
    var ready = false
    for _ in 0..<60 {
      ready = await ReadinessProbe.check(.port(port), startedAt: Date(), log: nil)
      if ready { break }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    if !ready { try? await process.stop(signal: SIGTERM, timeout: 0.2); XCTFail("HTTP fixture did not start"); return }
    let http = await ReadinessProbe.check(.http(URL(string: "http://127.0.0.1:\(port)/")!), startedAt: Date(), log: nil)
    let http404 = await ReadinessProbe.check(.http(URL(string: "http://127.0.0.1:\(port)/missing")!), startedAt: Date(), log: nil)
    let conflict = try await PortInspector.conflict(on: port)
    XCTAssertTrue(http); XCTAssertTrue(http404)
    XCTAssertEqual(conflict?.port, port)
    XCTAssertTrue(conflict?.owners.contains(where: { $0.pid == identity.pid || getpgid($0.pid) == identity.pgid }) == true)
    try await process.stop(signal: SIGTERM, timeout: 0.3)
    let remaining = try await PortInspector.conflict(on: port)
    XCTAssertNil(remaining)
  }
  func testCommandTimeoutKillsDescendantsAndCapturesLargeOutput() async throws {
    let result = try await StackCommandRunner.run("/bin/sh", ["-c", "i=0; while [ $i -lt 6000 ]; do echo log-line; i=$((i+1)); done"])
    XCTAssertEqual(result.status, 0); XCTAssertEqual(result.text.split(separator: "\n").count, 6000)
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    do {
      _ = try await StackCommandRunner.run("/bin/sh", ["-c", "echo $$ > pid; sleep 300 & wait"], directory: root, timeout: 0.2)
      XCTFail("Expected timeout")
    } catch { XCTAssertTrue(error.localizedDescription.contains("timed out")) }
    let pid = try String(contentsOf: root.appendingPathComponent("pid")).trimmingCharacters(in: .whitespacesAndNewlines)
    try await Task.sleep(nanoseconds: 200_000_000)
    let remaining = try await StackCommandRunner.run("/usr/bin/pgrep", ["-g", pid])
    XCTAssertEqual(remaining.status, 1)
  }
  func testCancellingCommandStopsItsProcessGroupBeforeTimeout() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let task = Task {
      try await StackCommandRunner.run("/bin/sh", ["-c", "echo $$ > pid; sleep 300 & wait"], directory: root, timeout: 30)
    }
    let file = root.appendingPathComponent("pid")
    let deadline = Date().addingTimeInterval(3)
    while !FileManager.default.fileExists(atPath: file.path), Date() < deadline {
      try await Task.sleep(nanoseconds: 20_000_000)
    }
    task.cancel()
    do { _ = try await task.value; XCTFail("Expected cancellation") }
    catch { XCTAssertTrue(error is CancellationError) }
    let pid = try String(contentsOf: file).trimmingCharacters(in: .whitespacesAndNewlines)
    let remaining = try await StackCommandRunner.run("/usr/bin/pgrep", ["-g", pid])
    XCTAssertEqual(remaining.status, 1)
  }
  func testWrongStartTimeCannotReattachOrSignalLiveProcess() async throws {
    let root = try StackTestSupport.temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let process = ServiceProcess()
    let identity = try await process.launch(StackTestSupport.simpleDefinition(root: root), environment: ProcessInfo.processInfo.environment, logURL: root.appendingPathComponent("test.log"))
    let reused = StackProcessIdentity(pid: identity.pid, pgid: identity.pgid, startTime: identity.startTime - 1)
    XCTAssertFalse(reused.matchesLiveProcess)
    do { try await ServiceProcess().reattach(reused); XCTFail("Should reject reused PID") } catch {}
    XCTAssertTrue(identity.matchesLiveProcess)
    try await process.stop(signal: SIGTERM, timeout: 0.3)
  }
  private func freePort() throws -> Int {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw StackError.message("socket failed") }
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let result = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    guard result == 0 else { throw StackError.message("bind failed") }
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
    return Int(UInt16(bigEndian: address.sin_port))
  }
}
