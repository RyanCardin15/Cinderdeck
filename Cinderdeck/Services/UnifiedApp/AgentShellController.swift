import AppKit
import Combine
import Darwin
import Foundation

/// Cinderdeck remains the application. AgentShell is one captured, supervised child.
@MainActor
final class AgentShellController: ObservableObject {
  static let shared = AgentShellController()
  enum Phase: String { case absent, idle, starting, running, closing, exited, failed }

  @Published private(set) var phase = Phase.idle
  @Published private(set) var ready = false
  @Published private(set) var lastError: String?
  private var process: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var installationID: String?
  private var uiToken: String?
  private var stopping = false
  private var quitRequested = false
  private var pendingRoute: AgentShellMessage?

  var running: Bool { process?.isRunning == true }
  var available: Bool { (try? executableURL()) != nil }
  var configured: Bool {
    ProcessInfo.processInfo.environment["CINDERDECK_AGENT_SHELL_PATH"].map { !$0.isEmpty } == true ||
      Bundle.main.url(forResource: "AgentShell", withExtension: "app") != nil
  }

  private func executableURL() throws -> URL? {
    let environment = ProcessInfo.processInfo.environment
    let requested: URL?
    if let override = environment["CINDERDECK_AGENT_SHELL_PATH"], !override.isEmpty {
      guard override.hasPrefix("/"), override.utf8.count <= 4096, !override.contains("\0") else {
        throw StackControlError.invalid("AgentShell override must be an absolute executable path")
      }
      let source = URL(fileURLWithPath: override).resolvingSymlinksInPath()
      requested = source.pathExtension == "app" ? source.appendingPathComponent("Contents/MacOS/AgentShell") : source
    } else {
      requested = Bundle.main.url(forResource: "AgentShell", withExtension: "app")?.appendingPathComponent("Contents/MacOS/AgentShell")
    }
    guard let requested else { return nil }
    let url = requested.resolvingSymlinksInPath()
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    let owner = (attributes[.ownerAccountID] as? NSNumber)?.uint32Value
    let permissions = (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
    guard attributes[.type] as? FileAttributeType == .typeRegular,
      FileManager.default.isExecutableFile(atPath: url.path), owner == getuid() || owner == 0,
      permissions & 0o022 == 0 else {
      throw StackControlError.invalid("AgentShell must be a trusted local executable")
    }
    return url
  }

  @discardableResult
  func startIfAvailable() -> Bool {
    if running { return true }
    do {
      guard let executable = try executableURL() else { phase = .absent; return false }
      guard StackControlService.shared.isServing else {
        throw StackControlError(code: "host_unavailable", message: "The native workspace control service is unavailable")
      }
      let journal = try StackControlService.shared.integrationStore()
      let token = UUID().uuidString + UUID().uuidString
      let child = Process(), stdin = Pipe(), stdout = Pipe()
      guard fcntl(stdin.fileHandleForWriting.fileDescriptor, F_SETNOSIGPIPE, 1) != -1 else {
        throw StackControlError(code: "host_unavailable", message: "Could not establish the agent window control pipe")
      }
      child.executableURL = executable
      child.currentDirectoryURL = executable.deletingLastPathComponent()
      var environment = ProcessInfo.processInfo.environment
      environment["CINDERDECK_NATIVE_HOST"] = "1"
      environment["CINDERDECK_NATIVE_SOCKET_PATH"] = StackControlPaths.socket.path
      environment["CINDERDECK_NATIVE_INSTALLATION_ID"] = journal.installationID
      environment["CINDERDECK_NATIVE_UI_TOKEN"] = token
      environment["DECKHAND_CINDERDECK_SOCKET"] = StackControlPaths.socket.path
      environment["DECKHAND_CINDERDECK_STATE"] = StackControlPaths.state.path
      #if DEBUG
      let channel = "development"
      #else
      let channel = "release"
      #endif
      environment["CINDERDECK_NATIVE_CHANNEL"] = channel
      environment["DECKHAND_CINDERDECK_CHANNEL"] = channel
      let runtimeDirectory = StackControlPaths.directory.appendingPathComponent("AgentRuntime", isDirectory: true)
      let profileDirectory = runtimeDirectory.appendingPathComponent("Profile", isDirectory: true)
      try FileManager.default.createDirectory(at: profileDirectory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
      environment["DECKHAND_HOME"] = runtimeDirectory.path
      environment["DECKHAND_PROFILE_ROOT"] = profileDirectory.path
      child.environment = environment
      child.standardInput = stdin
      child.standardOutput = stdout
      child.standardError = FileHandle.nullDevice
      let framer = AgentShellOutputFramer { [weak self, weak child] line in
        let controller = self, owner = child
        Task { @MainActor in
          guard let controller, let owner, controller.process === owner else { return }
          controller.receive(line)
        }
      }
      stdout.fileHandleForReading.readabilityHandler = { handle in
        let data = handle.availableData
        if data.isEmpty { handle.readabilityHandler = nil }
        else { framer.consume(data) }
      }
      child.terminationHandler = { [weak self] child in
        let controller = self
        Task { @MainActor in controller?.didExit(child) }
      }
      process = child
      input = stdin.fileHandleForWriting
      output = stdout.fileHandleForReading
      installationID = journal.installationID
      uiToken = token
      ready = false; stopping = false; quitRequested = false; lastError = nil; phase = .starting
      do { try child.run() }
      catch { cleanup(); throw error }
      // Do not retain unused parent copies of the child's pipe endpoints.
      try? stdin.fileHandleForReading.close()
      try? stdout.fileHandleForWriting.close()
      DiagnosticLogger.shared.log(.info, .lifecycle, "Unified agent window started", context: ["pid": String(child.processIdentifier)])
      return true
    } catch {
      phase = .failed
      lastError = "The unified agent window could not start. \(error.localizedDescription)"
      DiagnosticLogger.shared.log(.warning, .lifecycle, "Unified agent window could not start")
      return false
    }
  }

  /// Returns true only when this is a unified build. A configured failure is not a fallback.
  @discardableResult
  func show(workspaceID: String? = nil, section: String? = nil) -> Bool {
    do {
      guard try executableURL() != nil else { return false }
      if let workspaceID {
        guard workspaceID.utf8.count <= 512,
          !StackControlService.shared.isServing || StackSupervisor.shared.files.contains(where: { $0.id == workspaceID }) else {
          throw StackControlError(code: "resource_missing", message: "The requested workspace is unavailable")
        }
      }
      let sections: Set<String> = ["overview", "agents", "services", "tasks", "workflows", "lane-map", "runs", "recordings"]
      guard section.map({ sections.contains($0) }) ?? true else { throw StackControlError.invalid("Unknown workspace section") }
      pendingRoute = AgentShellMessage(type: "route", workspaceID: workspaceID, section: section)
      // Deep links can arrive while the native supervisor is still bootstrapping.
      // The coordinator starts the shell once its authoritative socket is ready.
      guard StackControlService.shared.isServing else { return true }
      guard startIfAvailable() else { throw StackControlError(code: "host_unavailable", message: lastError ?? "The agent window is unavailable") }
      if ready { try flushRoute() }
      return true
    } catch {
      let alert = NSAlert()
      alert.messageText = "The unified workspace window is unavailable"
      alert.informativeText = error.localizedDescription
      alert.runModal()
      return true
    }
  }

  /// Return from a native auxiliary tool without changing its saved route.
  func activateOwnedWindow() {
    guard running, ready, !stopping else { return }
    try? send(AgentShellMessage(type: "activate"))
  }

  private func send(_ message: AgentShellMessage) throws {
    guard let input, running else { throw StackControlError(code: "host_unavailable", message: "The agent window is not running") }
    var data = try JSONEncoder().encode(message)
    guard data.count < 16_384 else { throw StackControlError.invalid("Agent window request exceeds its limit") }
    data.append(10)
    try input.write(contentsOf: data)
  }

  private func flushRoute() throws {
    if let pendingRoute {
      if let workspaceID = pendingRoute.workspaceID,
        !StackSupervisor.shared.files.contains(where: { $0.id == workspaceID }) {
        self.pendingRoute = nil
        throw StackControlError(code: "resource_missing", message: "The requested workspace is unavailable")
      }
      try send(pendingRoute); self.pendingRoute = nil
    }
    try send(AgentShellMessage(type: "activate"))
  }

  private func receive(_ line: Data) {
    if line == Data("CINDERDECK_AGENT_SHELL_READY".utf8) {
      guard !stopping else { return }
      ready = true; phase = .running
      do { try flushRoute() }
      catch {
        lastError = "The agent window could not receive its route."
        let alert = NSAlert(); alert.messageText = "The workspace could not open"; alert.informativeText = error.localizedDescription; alert.runModal()
      }
      return
    }
    if line == Data("CINDERDECK_AGENT_SHELL_QUIT_REQUEST".utf8) {
      guard !stopping, !quitRequested else { return }
      quitRequested = true
      // terminateLater enters AppKit's nested event loop. Calling it inside the
      // stdout MainActor task keeps that task active and blocks the asynchronous
      // shutdown task that must reply. Start termination from the AppKit queue.
      DispatchQueue.main.async { [weak self] in
        NSApp.terminate(nil)
        // A cancelled native quit must allow a subsequent explicit Quit request.
        self?.quitRequested = false
      }
      return
    }
    let prefix = Data("CINDERDECK_AGENT_SHELL_UI_REQUEST ".utf8)
    guard !stopping, ready, line.starts(with: prefix) else { return }
    do { try AgentShellNativeUI.open(AgentShellUIRequest.decode(Data(line.dropFirst(prefix.count)))) }
    catch {
      let alert = NSAlert(); alert.messageText = "Native action is unavailable"; alert.informativeText = error.localizedDescription; alert.runModal()
    }
  }

  private func didExit(_ child: Process) {
    guard process === child else { return }
    let expected = stopping
    cleanup()
    phase = expected || child.terminationStatus == 0 ? .exited : .failed
    if !expected && child.terminationStatus != 0 { lastError = "The agent window exited. Reopen Workspaces to reconnect to its saved conversations." }
    DiagnosticLogger.shared.log(.info, .lifecycle, "Unified agent window exited", context: ["status": String(child.terminationStatus)])
  }

  private func cleanup() {
    output?.readabilityHandler = nil
    try? input?.close(); try? output?.close()
    input = nil; output = nil; process = nil; ready = false; uiToken = nil
  }

  /// No kill by name or PID discovery. The child settles its own backend pool before exit.
  func stopForTermination() async -> Bool {
    guard let child = process, child.isRunning else { return true }
    stopping = true; phase = .closing
    do { try send(AgentShellMessage(type: "quit")) }
    catch { try? input?.close(); input = nil }
    while child.isRunning {
      let deadline = ContinuousClock.now.advanced(by: .seconds(20))
      while child.isRunning && ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(100))
      }
      if !child.isRunning { break }
      let alert = NSAlert()
      alert.messageText = "Agent sessions are still closing"
      alert.informativeText = "Wait for the agent runtime to finish shutting down, or keep Cinderdeck open to inspect it. Writer ownership is not released by force."
      alert.addButton(withTitle: "Keep waiting"); alert.addButton(withTitle: "Keep Cinderdeck open")
      if alert.runModal() != .alertFirstButtonReturn { return false }
    }
    return true
  }

  func closeInputOnTermination() { try? input?.close(); input = nil }

  func authorizesUI(token: String) -> Bool { running && ready && !stopping && token == uiToken }

  func status() -> JSONValue {
    .object(["available": .bool(available), "running": .bool(running), "ready": .bool(ready), "phase": .string(phase.rawValue),
      "pid": process.map { .number(Double($0.processIdentifier)) } ?? .null,
      "installationID": installationID.map(JSONValue.string) ?? .null])
  }
}
