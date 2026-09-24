import Darwin
import Foundation

/// Unix-domain socket transport for the Stacks control API. Each connection
/// carries newline-delimited JSON requests and responses. The socket file is
/// created with mode 0600 in a 0700 folder, and peers must share our user ID.
nonisolated final class StackControlSocketServer: @unchecked Sendable {
  typealias Handler = @Sendable (Data, pid_t) async -> Data
  static let maximumFrameBytes = 4 * 1024 * 1024

  private let path: String
  private let handler: Handler
  private let queue = DispatchQueue(label: "cinderdeck.stacks.control.accept")
  private var source: DispatchSourceRead?

  init(path: String, handler: @escaping Handler) {
    self.path = path
    self.handler = handler
  }

  func start() throws {
    try StackControlPaths.ensureDirectory()
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent,
      withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if FileManager.default.fileExists(atPath: path) {
      if let probe = try? StackControlSocket.connect(path: path, timeout: 0.5) {
        close(probe)
        throw StackError.message("Another Cinderdeck instance is already serving \(path)")
      }
      unlink(path)
    }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw StackControlSocket.posixError("Create control socket") }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var address = try StackControlSocket.address(path)
    let previousMask = umask(0o077)
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    umask(previousMask)
    guard bound == 0 else { close(fd); throw StackControlSocket.posixError("Bind control socket") }
    chmod(path, 0o600)
    guard listen(fd, 32) == 0 else { close(fd); unlink(path); throw StackControlSocket.posixError("Listen on control socket") }
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    source.setEventHandler { [weak self] in
      while true {
        let client = accept(fd, nil, nil)
        guard client >= 0 else { break }
        self?.serve(client)
      }
    }
    source.setCancelHandler { close(fd) }
    self.source = source
    source.resume()
  }

  func stop() {
    source?.cancel()
    source = nil
    unlink(path)
  }

  private func serve(_ fd: Int32) {
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK)
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { close(fd); return }
    var peer: pid_t = 0
    var length = socklen_t(MemoryLayout<pid_t>.size)
    if getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peer, &length) != 0 { peer = 0 }
    let handler = handler
    let thread = Thread {
      var reader = StackControlLineReader(fd: fd)
      defer { close(fd) }
      while let line = try? reader.readLine(timeout: nil) {
        guard !line.isEmpty else { continue }
        let semaphore = DispatchSemaphore(value: 0)
        let box = StackControlResultBox()
        Task.detached {
          box.data = await handler(line, peer)
          semaphore.signal()
        }
        semaphore.wait()
        var response = box.data ?? Data()
        response.append(10)
        guard StackControlSocket.write(fd, response) else { return }
      }
    }
    thread.name = "cinderdeck.stacks.control.connection"
    thread.start()
  }
}

private nonisolated final class StackControlResultBox: @unchecked Sendable {
  var data: Data?
}

nonisolated struct StackControlLineReader {
  let fd: Int32
  private var buffer = Data()
  init(fd: Int32) { self.fd = fd }

  /// Returns nil at end of stream. Throws on timeout, error or oversized frames.
  mutating func readLine(timeout: TimeInterval?) throws -> Data? {
    let deadline = timeout.map { Date().addingTimeInterval($0) }
    while true {
      if let newline = buffer.firstIndex(of: 10) {
        let line = buffer[buffer.startIndex..<newline]
        buffer.removeSubrange(buffer.startIndex...newline)
        return Data(line)
      }
      guard buffer.count < StackControlSocketServer.maximumFrameBytes else { throw StackError.message("Control message is too large") }
      if let deadline {
        let remaining = deadline.timeIntervalSinceNow
        guard remaining > 0 else { throw StackControlError(code: "timeout", message: "Timed out waiting for Cinderdeck to answer") }
        var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let ready = poll(&descriptor, 1, Int32(min(remaining, 3600) * 1000))
        if ready == 0 { throw StackControlError(code: "timeout", message: "Timed out waiting for Cinderdeck to answer") }
        if ready < 0 { if errno == EINTR { continue }; throw StackControlSocket.posixError("Wait for Cinderdeck") }
      }
      var chunk = [UInt8](repeating: 0, count: 64 * 1024)
      let count = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
      if count < 0 { if errno == EINTR { continue }; throw StackControlSocket.posixError("Read from Cinderdeck") }
      if count == 0 {
        if buffer.isEmpty { return nil }
        let line = buffer
        buffer.removeAll()
        return line
      }
      buffer.append(contentsOf: chunk[0..<count])
    }
  }
}

nonisolated enum StackControlSocket {
  static func address(_ path: String) throws -> sockaddr_un {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard bytes.count < capacity else { throw StackError.message("Socket path is too long: \(path)") }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return address
  }

  static func connect(path: String, timeout: TimeInterval) throws -> Int32 {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw posixError("Create socket") }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    var address = try Self.address(path)
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard result == 0 else {
      let error = posixError("Connect to Cinderdeck")
      close(fd)
      throw error
    }
    return fd
  }

  static func write(_ fd: Int32, _ data: Data) -> Bool {
    var offset = 0
    return data.withUnsafeBytes { raw -> Bool in
      guard let base = raw.baseAddress else { return true }
      while offset < raw.count {
        let written = Darwin.write(fd, base + offset, raw.count - offset)
        if written < 0 { if errno == EINTR { continue }; return false }
        offset += written
      }
      return true
    }
  }

  static func posixError(_ action: String) -> StackError {
    .message("\(action): \(String(cString: strerror(errno)))")
  }
}

/// A connection that failed before an answer arrived. `notSent` means the app never received
/// the request, so retrying cannot repeat an action.
nonisolated enum StackControlTransportError: Error, LocalizedError, Equatable {
  case notSent, closed
  var errorDescription: String? {
    switch self {
    case .notSent: return "Lost connection to Cinderdeck"
    case .closed: return "Cinderdeck closed the connection"
    }
  }
}

/// Synchronous client used by the `cinderdeck` command-line tool and MCP bridge.
nonisolated final class StackControlConnection {
  private let fd: Int32
  private var reader: StackControlLineReader
  private var nextID = 1
  var client: StackControlClientInfo

  init(path: String = StackControlPaths.socket.path, client: StackControlClientInfo) throws {
    fd = try StackControlSocket.connect(path: path, timeout: 2)
    reader = StackControlLineReader(fd: fd)
    self.client = client
  }
  deinit { close(fd) }

  func call(_ method: String, _ params: [String: JSONValue] = [:], timeout: TimeInterval = 60) throws -> JSONValue {
    let id = nextID
    nextID += 1
    let request = StackControlRequest(id: id, method: method, params: .object(params), client: client)
    var data = try StackControlCoding.encoder().encode(request)
    data.append(10)
    guard StackControlSocket.write(fd, data) else { throw StackControlTransportError.notSent }
    while true {
      guard let line = try reader.readLine(timeout: timeout) else { throw StackControlTransportError.closed }
      let response = try StackControlCoding.decoder().decode(StackControlResponse.self, from: line)
      guard response.id == id else { continue }
      if let error = response.error { throw error }
      return response.result ?? .null
    }
  }
}
