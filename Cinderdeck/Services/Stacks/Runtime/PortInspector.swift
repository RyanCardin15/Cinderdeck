import Darwin
import Foundation

nonisolated struct StackPortOwner: Equatable, Sendable, Identifiable {
  let pid: Int32
  let name: String
  let startTime: Double?
  var id: Int32 { pid }
}

nonisolated struct StackPortConflict: Equatable, Sendable {
  let port: Int
  let owners: [StackPortOwner]
  var description: String {
    "Port \(port) is in use" + (owners.isEmpty ? "." : " by " + owners.map { "\($0.name) (PID \($0.pid))" }.joined(separator: ", ") + ".")
  }
}

nonisolated enum PortInspector {
  static func isListening(_ port: Int) async -> Bool {
    await Task.detached(priority: .utility) {
      guard (1...65535).contains(port) else { return false }
      let fd = socket(AF_INET, SOCK_STREAM, 0)
      guard fd >= 0 else { return false }
      defer { close(fd) }
      _ = fcntl(fd, F_SETFL, O_NONBLOCK)
      var address = sockaddr_in()
      address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      address.sin_family = sa_family_t(AF_INET)
      address.sin_port = UInt16(port).bigEndian
      address.sin_addr.s_addr = inet_addr("127.0.0.1")
      let result = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
      }
      if result == 0 { return true }
      guard errno == EINPROGRESS else { return false }
      var descriptor = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
      guard poll(&descriptor, 1, 250) > 0 else { return false }
      var error: Int32 = 0
      var length = socklen_t(MemoryLayout<Int32>.size)
      return getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) == 0 && error == 0
    }.value
  }

  /// TCP ports a process group listens on.
  static func listeningPorts(processGroup: Int32) async -> Set<Int> {
    guard processGroup > 1, let result = try? await StackCommandRunner.run("/usr/sbin/lsof",
      ["-nP", "-a", "-g", String(processGroup), "-iTCP", "-sTCP:LISTEN", "-Fn"], timeout: 5) else { return [] }
    var ports = Set<Int>()
    for line in result.text.split(separator: "\n") where line.first == "n" {
      if let colon = line.lastIndex(of: ":"), let port = Int(line[line.index(after: colon)...]) { ports.insert(port) }
    }
    return ports
  }

  static func conflict(on port: Int) async throws -> StackPortConflict? {
    let result = try await StackCommandRunner.run("/usr/sbin/lsof", ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpc"], timeout: 5)
    var owners: [StackPortOwner] = []
    var pid: Int32?
    for line in result.text.split(separator: "\n") {
      if line.first == "p" { pid = Int32(line.dropFirst()) }
      if line.first == "c", let pid {
        owners.append(.init(pid: pid, name: String(line.dropFirst()), startTime: StackProcessIdentity.startTime(pid: pid)))
      }
    }
    if !owners.isEmpty { return .init(port: port, owners: owners) }
    if await isListening(port) { return .init(port: port, owners: owners) }
    return nil
  }

  /// Only invoked after the user confirms the displayed owners. Revalidate before
  /// each signal so a delayed confirmation never kills a replacement listener.
  static func terminate(_ conflict: StackPortConflict) async throws {
    guard !conflict.owners.isEmpty else { throw StackError.message("Cannot identify this port's owner. Stop it in a terminal.") }
    for owner in conflict.owners {
      guard let start = owner.startTime, StackProcessIdentity.startTime(pid: owner.pid) == start,
        owner.pid > 1, owner.pid != getpid() else { throw StackError.message("Port owner changed. Refresh and try again.") }
      if kill(owner.pid, SIGTERM) != 0 && errno != ESRCH { throw StackError.message("Could not stop \(owner.name)") }
    }
    try? await Task.sleep(nanoseconds: 1_000_000_000)
    for owner in conflict.owners where StackProcessIdentity.startTime(pid: owner.pid) == owner.startTime {
      if kill(owner.pid, SIGKILL) != 0 && errno != ESRCH { throw StackError.message("Could not kill \(owner.name)") }
    }
    try? await Task.sleep(nanoseconds: 200_000_000)
    if try await self.conflict(on: conflict.port) != nil { throw StackError.message("Port \(conflict.port) is still occupied") }
  }
}
