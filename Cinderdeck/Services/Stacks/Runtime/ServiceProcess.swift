import Darwin
import Foundation

/// Owns one process group. No pipes or parent-death signal: children can outlive Cinderdeck.
actor ServiceProcess: ProcessLaunching {
  private var process: StackProcessIdentity?
  private var exitSource: DispatchSourceProcess?
  private var exitResult: StackProcessExit?
  private var exitWaiters: [CheckedContinuation<StackProcessExit, Never>] = []
  private var isChild = false

  func identity() -> StackProcessIdentity? { process }

  func launch(_ definition: StackLaunchDefinition, environment: [String: String], logURL: URL) throws -> StackProcessIdentity {
    guard process == nil else { throw StackError.message("This service already owns a process") }
    try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700])
    let fd = open(logURL.path, O_WRONLY | O_CREAT | O_TRUNC | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw posixError("Open log") }
    defer { close(fd) }
    var actions: posix_spawn_file_actions_t?
    var attributes: posix_spawnattr_t?
    try checked(posix_spawn_file_actions_init(&actions))
    defer { posix_spawn_file_actions_destroy(&actions) }
    try checked(posix_spawnattr_init(&attributes))
    defer { posix_spawnattr_destroy(&attributes) }
    try checked(posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, "/dev/null", O_RDONLY, 0))
    try checked(posix_spawn_file_actions_adddup2(&actions, fd, STDOUT_FILENO))
    try checked(posix_spawn_file_actions_adddup2(&actions, fd, STDERR_FILENO))
    try checked(posix_spawn_file_actions_addchdir_np(&actions, definition.service.directory.path))
    try checked(posix_spawnattr_setpgroup(&attributes, 0))
    // Reset inherited masks/dispositions, including SIGPIPE ignored by many GUI runtimes.
    var empty = sigset_t()
    var defaults = sigset_t()
    sigemptyset(&empty)
    sigemptyset(&defaults)
    for signal in [SIGINT, SIGTERM, SIGHUP, SIGPIPE, SIGQUIT] { sigaddset(&defaults, signal) }
    try checked(posix_spawnattr_setsigmask(&attributes, &empty))
    try checked(posix_spawnattr_setsigdefault(&attributes, &defaults))
    try checked(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)))
    let arguments = [definition.stack.shell, "-c", definition.service.command].map { value in value.withCString { strdup($0) } }
    let variables = environment.sorted { $0.key < $1.key }.map { strdup("\($0.key)=\($0.value)") }
    defer { arguments.forEach { free($0) }; variables.forEach { free($0) } }
    var argv = arguments + [nil]
    var envp = variables + [nil]
    var pid: pid_t = 0
    let result = posix_spawn(&pid, definition.stack.shell, &actions, &attributes, &argv, &envp)
    try checked(result)
    // Query immediately, before an exit source reaps a short-lived child.
    guard let started = StackProcessIdentity.startTime(pid: pid, includingExited: true) else {
      kill(-pid, SIGKILL)
      var status: Int32 = 0
      waitpid(pid, &status, 0)
      throw StackError.message("Service exited before its process identity could be recorded")
    }
    let identity = StackProcessIdentity(pid: pid, pgid: pid, startTime: started)
    process = identity
    isChild = true
    watch(identity)
    return identity
  }

  func reattach(_ identity: StackProcessIdentity) throws {
    guard identity.matchesLiveProcess else { throw StackError.message("Saved process has exited or its PID was reused") }
    process = identity
    isChild = false
    watch(identity)
  }

  private func watch(_ identity: StackProcessIdentity) {
    exitResult = nil
    let source = DispatchSource.makeProcessSource(identifier: identity.pid, eventMask: .exit, queue: .global(qos: .utility))
    source.setEventHandler { [weak self] in Task { await self?.didExit() } }
    exitSource = source
    source.resume()
  }

  private func didExit() {
    guard exitResult == nil, let process else { return }
    var status: Int32 = 0
    let reaped = isChild ? waitpid(process.pid, &status, WNOHANG) : -1
    let code: Int32? = reaped > 0 ? ((status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)) : nil
    let result = StackProcessExit(code: code)
    exitResult = result
    exitSource?.cancel()
    exitSource = nil
    for waiter in exitWaiters { waiter.resume(returning: result) }
    exitWaiters.removeAll()
  }

  func waitForExit() async -> StackProcessExit {
    if let exitResult { return exitResult }
    return await withCheckedContinuation { exitWaiters.append($0) }
  }

  func stop(signal: Int32, timeout: TimeInterval) async throws {
    guard let process else { return }
    // An owned, exited leader may leave children in its group. If its PID has been
    // reused we must never signal that group. An existing group prevents PGID reuse.
    if let current = StackProcessIdentity.startTime(pid: process.pid), current != process.startTime {
      throw StackError.message("Process identity changed; refusing to signal a reused PID")
    }
    guard process.pgid > 1, process.pgid == process.pid else { throw StackError.message("Invalid saved process group") }
    if kill(-process.pgid, signal) != 0 && errno != ESRCH { throw posixError("Stop process group") }
    let deadline = Date().addingTimeInterval(timeout)
    while kill(-process.pgid, 0) == 0 && Date() < deadline {
      try? await Task.sleep(nanoseconds: 50_000_000)
      // Reap promptly so a zombie leader doesn't make a dead group appear live.
      if StackProcessIdentity.startTime(pid: process.pid) == nil { didExit() }
    }
    if kill(-process.pgid, 0) == 0 {
      if kill(-process.pgid, SIGKILL) != 0 && errno != ESRCH { throw posixError("Kill process group") }
      let escalationDeadline = Date().addingTimeInterval(2)
      while kill(-process.pgid, 0) == 0 && Date() < escalationDeadline {
        try? await Task.sleep(nanoseconds: 50_000_000)
        if StackProcessIdentity.startTime(pid: process.pid) == nil { didExit() }
      }
      if kill(-process.pgid, 0) == 0 { throw StackError.message("Process group \(process.pgid) is still exiting; try Stop again") }
    }
    didExit()
    self.process = nil
  }

  private func checked(_ code: Int32) throws {
    if code != 0 { throw StackError.message(String(cString: strerror(code))) }
  }
  private func posixError(_ action: String) -> StackError { .message("\(action): \(String(cString: strerror(errno)))") }
}
