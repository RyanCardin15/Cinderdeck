import Foundation

nonisolated struct GitHubCLIConfiguration: Sendable {
  var executable: String
  var environment: [String: String]
  func usesEnvironmentToken(hostname: String) -> Bool {
    let keys = hostname == "github.com" || hostname.hasSuffix(".ghe.com")
      ? ["GH_TOKEN", "GITHUB_TOKEN"] : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
    return keys.contains { environment[$0]?.isEmpty == false }
  }
}

enum GitHubCLI {
  static func configuration(refresh: Bool = false) async throws -> GitHubCLIConfiguration {
    var environment = try await ShellEnvironmentResolver.shared.resolve(refresh: refresh)
    environment["GH_PROMPT_DISABLED"] = "1"
    environment["GH_PAGER"] = "cat"
    environment["GH_DEBUG"] = nil
    environment["DEBUG"] = nil
    environment["NO_COLOR"] = "1"
    environment["CLICOLOR_FORCE"] = nil
    let paths = (environment["PATH"] ?? "").split(separator: ":").map(String.init) + ["/opt/homebrew/bin", "/usr/local/bin"]
    guard let executable = paths.map({ $0 + "/gh" }).first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
      throw GitHubAccountError.missingCLI
    }
    return .init(executable: executable, environment: environment)
  }
}

nonisolated enum GitHubAccountError: LocalizedError {
  case missingCLI
  case message(String)
  var errorDescription: String? {
    switch self {
    case .missingCLI: return "Install GitHub CLI, then return here to sign in."
    case .message(let message): return message
    }
  }
}

/// Hostnames only: never accept a URL, credentials, path, port, or CLI option.
nonisolated enum GitHubHost {
  static let preferenceKey = "github.hostname"
  static func normalized(_ input: String) -> String? {
    let host = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard host.count <= 253, host.contains("."), host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({
      !$0.isEmpty && $0.count <= 63 && $0.range(of: #"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$"#, options: .regularExpression) != nil
    }) else { return nil }
    return host
  }
  static var current: String { normalized(UserDefaults.standard.string(forKey: preferenceKey) ?? "") ?? "github.com" }
}
