import Darwin
import Foundation

nonisolated struct StackProcessIdentity: Codable, Equatable, Sendable {
  let pid: Int32
  let pgid: Int32
  let startTime: Double

  static func startTime(pid: Int32) -> Double? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0,
      info.kp_proc.p_stat != SZOMB else { return nil }
    let start = info.kp_proc.p_un.__p_starttime
    return Double(start.tv_sec) + Double(start.tv_usec) / 1_000_000
  }

  var matchesLiveProcess: Bool {
    pid > 1 && pgid == pid && Self.startTime(pid: pid) == startTime && getpgid(pid) == pgid
  }
}

nonisolated struct StackProcessExit: Sendable {
  /// nil for an adopted process: the kernel only gives exit status to its parent.
  let code: Int32?
  var failed: Bool { code != 0 }
}

nonisolated protocol ProcessLaunching: Sendable {
  func launch(_ definition: StackLaunchDefinition, environment: [String: String], logURL: URL) async throws -> StackProcessIdentity
  func reattach(_ identity: StackProcessIdentity) async throws
  func waitForExit() async -> StackProcessExit
  func stop(signal: Int32, timeout: TimeInterval) async throws
  func identity() async -> StackProcessIdentity?
}
