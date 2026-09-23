import Foundation

nonisolated struct GitHubAccountSnapshot: Equatable, Sendable {
  var login: String?
  var hostname = "github.com"
  var cliInstalled = true
  var managedByEnvironment = false
  var message: String?
}

nonisolated struct GitHubSignInProgress: Equatable, Sendable {
  var code: String?
  var url: URL?

  static func parse(_ output: String, hostname: String = "github.com") -> Self {
    var code: String?
    var url: URL?
    for line in output.components(separatedBy: .newlines) {
      if let marker = line.range(of: "one-time code: "),
        let match = line[marker.upperBound...].range(of: #"^[A-Z0-9]{4}-[A-Z0-9]{4}\b"#, options: .regularExpression) {
        code = String(line[match])
      }
      if line.contains("Open this URL"), let range = line.range(of: "https://"),
        let candidate = URL(string: String(line[range.lowerBound...]).trimmingCharacters(in: .whitespacesAndNewlines)),
        candidate.scheme == "https", candidate.host == hostname, candidate.user == nil, candidate.password == nil,
        ["/login/device", "/login/oauth/authorize"].contains(candidate.path) {
        url = candidate
      }
    }
    if code != nil, url == nil { url = URL(string: "https://\(hostname)/login/device") }
    return .init(code: code, url: url)
  }
}

@MainActor
protocol GitHubAccountServing {
  var hostname: String { get set }
  func status() async -> GitHubAccountSnapshot
  func signIn(progress: @escaping (GitHubSignInProgress) -> Void) async throws -> String?
  func cancelSignIn()
}

/// A small in-memory buffer keeps CLI output off disk and out of diagnostics.
/// Only the device code and a validated GitHub URL are exposed to the view.
private nonisolated final class GitHubLoginOutput: @unchecked Sendable {
  private let lock = NSLock()
  private var data = Data()
  func append(_ chunk: Data) {
    lock.lock(); defer { lock.unlock() }
    data.append(chunk)
    if data.count > 32_768 { data = Data(data.suffix(32_768)) }
  }
  func text() -> String {
    lock.lock(); defer { lock.unlock() }
    return String(decoding: data, as: UTF8.self)
  }
}

@MainActor
final class GitHubAccountService: GitHubAccountServing {
  var hostname: String
  private var process: Process?
  private var signingIn = false
  private let configuration: () async throws -> GitHubCLIConfiguration
  private let viewer: (() async throws -> String)?
  private let timeout: TimeInterval
  init(hostname: String = GitHubHost.current, configuration: @escaping () async throws -> GitHubCLIConfiguration = { try await GitHubCLI.configuration(refresh: true) },
    viewer: (() async throws -> String)? = nil, timeout: TimeInterval = 900) {
    self.hostname = hostname
    self.configuration = configuration
    self.viewer = viewer
    self.timeout = timeout
  }

  func status() async -> GitHubAccountSnapshot {
    let host = hostname
    do {
      let configuration = try await configuration()
      do {
        let login: String
        if let viewer { login = try await viewer() } else { login = try await GitHubPRService(hostname: host).viewer() }
        return .init(login: login, hostname: host, managedByEnvironment: configuration.usesEnvironmentToken(hostname: host))
      } catch {
        return .init(hostname: host, managedByEnvironment: configuration.usesEnvironmentToken(hostname: host), message: "Could not verify your GitHub connection. Sign in or check your network and try again.")
      }
    } catch GitHubAccountError.missingCLI { return .init(hostname: host, cliInstalled: false) }
    catch { return .init(hostname: host, message: "Could not check GitHub CLI. Try again.") }
  }

  func signIn(progress: @escaping (GitHubSignInProgress) -> Void) async throws -> String? {
    guard !signingIn else { throw GitHubAccountError.message("Sign-in is already in progress.") }
    let host = hostname
    guard GitHubHost.normalized(host) == host else { throw GitHubAccountError.message("Enter a valid GitHub hostname.") }
    signingIn = true
    defer { signingIn = false }
    let configuration = try await configuration()
    try Task.checkCancellation()
    guard !configuration.usesEnvironmentToken(hostname: host) else {
      throw GitHubAccountError.message("An environment token controls your GitHub connection. Remove that override in your shell configuration before using browser sign-in.")
    }
    let child = Process()
    child.executableURL = URL(fileURLWithPath: configuration.executable)
    // Non-interactive web mode prints the device code and URL, then waits for
    // browser authorization. Omit --git-protocol to preserve the user's setting.
    child.arguments = ["auth", "login", "--hostname", host, "--web", "--skip-ssh-key"]
    child.environment = configuration.environment
    child.standardInput = FileHandle.nullDevice
    let pipe = Pipe()
    child.standardOutput = pipe
    child.standardError = pipe
    let output = GitHubLoginOutput()
    pipe.fileHandleForReading.readabilityHandler = { handle in
      let chunk = handle.availableData
      if !chunk.isEmpty { output.append(chunk) }
    }
    process = child
    defer {
      stop(child)
      pipe.fileHandleForReading.readabilityHandler = nil
      try? pipe.fileHandleForReading.close()
      try? pipe.fileHandleForWriting.close()
      if process === child { process = nil }
    }
    try child.run()
    let deadline = Date().addingTimeInterval(timeout)
    var previous = GitHubSignInProgress()
    while child.isRunning {
      try Task.checkCancellation()
      guard Date() < deadline else { throw GitHubAccountError.message("Sign-in expired. Start again to get a new code.") }
      let current = GitHubSignInProgress.parse(output.text(), hostname: host)
      if current != previous { previous = current; progress(current) }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    try Task.checkCancellation()
    guard child.terminationStatus == 0 else {
      throw GitHubAccountError.message("GitHub sign-in did not finish. The code may have expired or authorization was declined. Try again.")
    }
    return output.text().contains("credentials saved in plain text")
      ? "GitHub CLI could not use macOS Keychain and saved its credential in its own configuration. Check your GitHub CLI credential storage."
      : nil
  }

  func cancelSignIn() { if let process { stop(process) } }
  private func stop(_ child: Process) {
    guard child.isRunning else { return }
    child.terminate()
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      if child.isRunning { kill(child.processIdentifier, SIGKILL) }
    }
  }
}
