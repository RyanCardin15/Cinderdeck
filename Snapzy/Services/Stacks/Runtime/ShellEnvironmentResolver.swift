import Foundation

actor ShellEnvironmentResolver {
  static let shared = ShellEnvironmentResolver()
  private var cached: [String: [String: String]] = [:]
  private var pending: [String: Task<[String: String], Error>] = [:]

  func resolve(shell: String = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh", refresh: Bool = false) async throws -> [String: String] {
    if refresh { cached[shell] = nil }
    if let result = cached[shell] { return result }
    if let task = pending[shell] { return try await task.value }
    let task = Task<[String: String], Error> {
      var base = ProcessInfo.processInfo.environment
      base["DISABLE_AUTO_UPDATE"] = "true"
      // Marker isolates startup banners from env's first record. Values may contain newlines.
      let command = "printf '\\0SNAPZY_ENV_BEGIN\\0'; /usr/bin/env -0"
      var result = try? await StackCommandRunner.run(shell, ["-l", "-i", "-c", command], environment: base, timeout: 5)
      if result?.status != 0 {
        result = try await StackCommandRunner.run(shell, ["-l", "-c", command], environment: base, timeout: 5)
      }
      guard let result, result.status == 0 else { throw StackError.message("Could not capture the login-shell environment") }
      let records = result.text.components(separatedBy: "\0")
      guard let marker = records.firstIndex(of: "SNAPZY_ENV_BEGIN") else { throw StackError.message("Shell did not return a readable environment") }
      var environment = base
      for record in records.dropFirst(marker + 1) {
        guard let separator = record.firstIndex(of: "=") else { continue }
        let key = String(record[..<separator])
        guard !key.isEmpty else { continue }
        environment[key] = String(record[record.index(after: separator)...])
      }
      return environment
    }
    pending[shell] = task
    defer { pending[shell] = nil }
    let result = try await task.value
    cached[shell] = result
    return result
  }
}
