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
    try await Task.detached(priority: .utility) {
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent("snapzy-command-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      defer { try? FileManager.default.removeItem(at: folder) }
      let output = folder.appendingPathComponent("out")
      let error = folder.appendingPathComponent("err")
      let outFD = open(output.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
      guard outFD >= 0 else { throw StackError.message("Cannot create command output") }
      defer { close(outFD) }
      let errFD = open(error.path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
      guard errFD >= 0 else { throw StackError.message("Cannot create command error output") }
      defer { close(errFD) }
      var actions: posix_spawn_file_actions_t?
      var attr: posix_spawnattr_t?
      posix_spawn_file_actions_init(&actions)
      posix_spawnattr_init(&attr)
      defer { posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attr) }
      posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0)
      posix_spawn_file_actions_adddup2(&actions, outFD, STDOUT_FILENO)
      posix_spawn_file_actions_adddup2(&actions, errFD, STDERR_FILENO)
      if let directory { posix_spawn_file_actions_addchdir_np(&actions, directory.path) }
      posix_spawnattr_setpgroup(&attr, 0)
      posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT))
      let args = ([executable] + arguments).map { value in value.withCString { strdup($0) } }
      let vars = environment.map { strdup("\($0.key)=\($0.value)") }
      defer { args.forEach { free($0) }; vars.forEach { free($0) } }
      var argv = args + [nil], envp = vars + [nil]
      var pid: pid_t = 0
      let spawned = posix_spawn(&pid, executable, &actions, &attr, &argv, &envp)
      guard spawned == 0 else { throw StackError.message(String(cString: strerror(spawned))) }
      var status: Int32 = 0
      let deadline = Date().addingTimeInterval(timeout)
      while waitpid(pid, &status, WNOHANG) == 0 {
        if Date() >= deadline || Task.isCancelled {
          kill(-pid, SIGKILL)
          waitpid(pid, &status, 0)
          throw StackError.message("Command timed out after \(Int(timeout)) seconds")
        }
        try? await Task.sleep(nanoseconds: 25_000_000)
      }
      let code = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
      func read(_ url: URL) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        return try handle.read(upToCount: 8 * 1024 * 1024) ?? Data()
      }
      return StackCommandResult(status: code, output: try read(output), error: try read(error))
    }.value
  }
}
