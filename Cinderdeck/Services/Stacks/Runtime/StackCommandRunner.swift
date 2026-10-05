import Foundation

nonisolated struct StackCommandResult: Sendable {
  let status: Int32
  let output: Data
  let error: Data
  var text: String { String(decoding: output, as: UTF8.self) }
  var errorText: String { String(decoding: error, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) }
}

/// Short, bounded commands use private files, never undrained pipes. Each call has
/// its own group so a timed-out shell or credential helper cannot keep running.
nonisolated enum StackCommandRunner {
  static func run(_ executable: String, _ arguments: [String], directory: URL? = nil,
    environment: [String: String] = ProcessInfo.processInfo.environment, timeout: TimeInterval = 60
  ) async throws -> StackCommandResult {
    let task = Task.detached(priority: .utility) {
      try Task.checkCancellation()
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cinderdeck-command-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      defer { try? FileManager.default.removeItem(at: folder) }
      let output = folder.appendingPathComponent("out")
      let error = folder.appendingPathComponent("err")
      let outFD = open(output.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
      guard outFD >= 0 else { throw StackError.message("Cannot create command output: \(String(cString: strerror(errno)))") }
      defer { close(outFD) }
      let errFD = open(error.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
      guard errFD >= 0 else { throw StackError.message("Cannot create command error output: \(String(cString: strerror(errno)))") }
      defer { close(errFD) }
      var actions: posix_spawn_file_actions_t?
      var attr: posix_spawnattr_t?
      func checked(_ result: Int32, _ operation: String) throws {
        guard result == 0 else { throw StackError.message("\(operation): \(String(cString: strerror(result)))") }
      }
      try checked(posix_spawn_file_actions_init(&actions), "Initialize command file actions")
      defer { posix_spawn_file_actions_destroy(&actions) }
      try checked(posix_spawnattr_init(&attr), "Initialize command attributes")
      defer { posix_spawnattr_destroy(&attr) }
      try checked(posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0), "Redirect command input")
      try checked(posix_spawn_file_actions_adddup2(&actions, outFD, STDOUT_FILENO), "Redirect command output")
      try checked(posix_spawn_file_actions_adddup2(&actions, errFD, STDERR_FILENO), "Redirect command error output")
      if let directory { try checked(posix_spawn_file_actions_addchdir_np(&actions, directory.path), "Set command directory") }
      try checked(posix_spawnattr_setpgroup(&attr, 0), "Set command process group")
      // GUI/test hosts may ignore or block signals. Commands need normal shell
      // semantics, including a truthful signal exit status and working SIGPIPE.
      var mask = sigset_t(), defaults = sigset_t()
      sigemptyset(&mask); sigemptyset(&defaults)
      for signal in [SIGINT, SIGTERM, SIGHUP, SIGPIPE, SIGQUIT] { sigaddset(&defaults, signal) }
      try checked(posix_spawnattr_setsigmask(&attr, &mask), "Set command signal mask")
      try checked(posix_spawnattr_setsigdefault(&attr, &defaults), "Set command default signals")
      try checked(posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)), "Set command spawn flags")
      let args = ([executable] + arguments).map { value in value.withCString { strdup($0) } }
      let vars = environment.map { strdup("\($0.key)=\($0.value)") }
      defer { args.forEach { free($0) }; vars.forEach { free($0) } }
      var argv = args + [nil], envp = vars + [nil]
      var pid: pid_t = 0
      let spawned = posix_spawn(&pid, executable, &actions, &attr, &argv, &envp)
      guard spawned == 0 else { throw StackError.message(String(cString: strerror(spawned))) }
      let status = try await StackCommandExit(pid: pid).wait(timeout: timeout)
      let code = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
      func read(_ fd: Int32) throws -> Data {
        // Reuse the descriptor we already own instead of opening the file again
        // while other commands and framework work compete for descriptors.
        // pread leaves the child's shared file offset alone.
        let limit = 8 * 1024 * 1024
        var data = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while data.count < limit {
          let count = chunk.withUnsafeMutableBytes {
            pread(fd, $0.baseAddress, min($0.count, limit - data.count), off_t(data.count))
          }
          if count < 0 {
            if errno == EINTR { continue }
            throw StackError.message("Cannot read command output: \(String(cString: strerror(errno)))")
          }
          if count == 0 { break }
          data.append(contentsOf: chunk[..<count])
        }
        return data
      }
      return StackCommandResult(status: code, output: try read(outFD), error: try read(errFD))
    }
    return try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }
}

/// Kernel exit notification avoids a 25 ms latency floor and 40 wakeups/second
/// for every command. All completion paths share one queue and reap exactly once.
private nonisolated final class StackCommandExit: @unchecked Sendable {
  private let pid: pid_t
  private let queue = DispatchQueue(label: "cinderdeck.command.exit", qos: .utility)
  private var source: DispatchSourceProcess?
  private var timer: DispatchSourceTimer?
  private var continuation: CheckedContinuation<Int32, Error>?
  private var cancelled = false

  init(pid: pid_t) { self.pid = pid }

  func wait(timeout: TimeInterval) async throws -> Int32 {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        queue.async { self.begin(continuation, timeout: timeout) }
      }
    } onCancel: {
      self.queue.async {
        self.cancelled = true
        if self.continuation != nil { self.terminate(CancellationError()) }
      }
    }
  }

  private func begin(_ continuation: CheckedContinuation<Int32, Error>, timeout: TimeInterval) {
    self.continuation = continuation
    if cancelled { terminate(CancellationError()); return }
    if reap(blocking: false) { return }
    let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
    source.setEventHandler { [weak self] in _ = self?.reap(blocking: true) }
    self.source = source
    source.resume()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + max(0, timeout))
    timer.setEventHandler { [weak self] in
      guard let self, self.continuation != nil else { return }
      if !self.reap(blocking: false) {
        self.terminate(StackError.message("Command timed out after \(Int(timeout)) seconds"))
      }
    }
    self.timer = timer
    timer.resume()
  }

  @discardableResult
  private func reap(blocking: Bool) -> Bool {
    guard continuation != nil else { return true }
    var status: Int32 = 0
    var result: pid_t
    repeat { result = waitpid(pid, &status, blocking ? 0 : WNOHANG) } while result < 0 && errno == EINTR
    if result == 0 { return false }
    if result < 0 { finish(.failure(StackError.message("Wait for command: \(String(cString: strerror(errno)))"))) }
    else { finish(.success(status)) }
    return true
  }

  private func terminate(_ error: Error) {
    guard continuation != nil else { return }
    // The leader has not been reaped, so its PID/group cannot have been reused.
    kill(-pid, SIGKILL)
    var status: Int32 = 0
    while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
    finish(.failure(error))
  }

  private func finish(_ result: Result<Int32, Error>) {
    let waiter = continuation
    continuation = nil
    source?.cancel(); source = nil
    timer?.cancel(); timer = nil
    waiter?.resume(with: result)
  }
}
