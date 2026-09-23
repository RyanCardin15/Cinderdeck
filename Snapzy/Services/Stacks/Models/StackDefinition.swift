import CryptoKit
import Foundation

typealias StackID = String

nonisolated struct RepoDefinition: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let path: URL
}

nonisolated enum StackReadiness: Codable, Equatable, Sendable {
  case alive
  case port(Int)
  case http(URL)
  case log(String)
}

nonisolated struct ServiceDefinition: Codable, Equatable, Identifiable, Sendable {
  let id: String
  var command: String
  var repo: String?
  var directory: URL
  var dependencies: [String] = []
  var port: Int?
  var readiness: StackReadiness = .alive
  var readyTimeout: TimeInterval = 90
  var environment: [String: String] = [:]
  var restartOnFailure = true
  var stopSignal: Int32 = SIGTERM
  var stopTimeout: TimeInterval = 10
  var autostart = true
}

nonisolated struct StackDefinition: Codable, Equatable, Identifiable, Sendable {
  let id: StackID
  var name: String
  let file: URL
  var root: URL
  var shell: String
  var restartOnBranchChange = true
  var environment: [String: String] = [:]
  var secrets: [String: String] = [:]
  var repos: [RepoDefinition] = []
  var services: [ServiceDefinition] = []

  var fingerprint: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return SHA256.hash(data: (try? encoder.encode(self)) ?? Data()).map { String(format: "%02x", $0) }.joined()
  }

  func service(_ id: String) -> ServiceDefinition? { services.first { $0.id == id } }
  func repo(_ id: String) -> RepoDefinition? { repos.first { $0.id == id } }

  /// Deterministic Kahn layers. Disabled services remain in the graph for manual starts.
  func dependencyLayers() throws -> [[String]] {
    var remaining = Dictionary(uniqueKeysWithValues: services.map { ($0.id, Set($0.dependencies)) })
    var layers: [[String]] = []
    while !remaining.isEmpty {
      let ready = remaining.filter { $0.value.isEmpty }.keys.sorted()
      guard !ready.isEmpty else { throw StackError.message("Dependency cycle: \(remaining.keys.sorted().joined(separator: ", "))") }
      layers.append(ready)
      for id in ready { remaining.removeValue(forKey: id) }
      for id in remaining.keys { remaining[id]?.subtract(ready) }
    }
    return layers
  }

  func affectedServices(repos ids: Set<String>) -> Set<String> {
    Set(services.filter { $0.repo.map(ids.contains) ?? false }.map(\.id))
  }

  func includingDependents(of ids: Set<String>) -> Set<String> {
    var result = ids
    while true {
      let next = result.union(services.filter { !result.isDisjoint(with: $0.dependencies) }.map(\.id))
      if next == result { return result }
      result = next
    }
  }
}

nonisolated struct StackDefinitionIssue: Identifiable, Equatable, Sendable {
  enum Severity: String, Sendable { case warning, error }
  let severity: Severity
  let message: String
  var id: String { severity.rawValue + message }
}

nonisolated struct StackDefinitionFile: Identifiable, Equatable, Sendable {
  let id: StackID
  let file: URL
  var definition: StackDefinition?
  var issues: [StackDefinitionIssue] = []
  var name: String { definition?.name ?? file.deletingPathExtension().lastPathComponent }
}

nonisolated enum StackError: LocalizedError {
  case message(String)
  var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

nonisolated struct StackLaunchDefinition: Codable, Equatable, Sendable {
  let stack: StackDefinition
  let service: ServiceDefinition

  func environment(shell: [String: String], secrets: [String: String]) -> [String: String] {
    var result = shell.merging(stack.environment) { _, value in value }
      .merging(service.environment) { _, value in value }
      .merging(secrets) { _, value in value }
    result["FORCE_COLOR"] = "1"
    result["CLICOLOR_FORCE"] = "1"
    result["PYTHONUNBUFFERED"] = "1"
    result["DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION"] = "1"
    if result["DOTNET_WATCH_RESTART_ON_RUDE_EDIT"] == nil { result["DOTNET_WATCH_RESTART_ON_RUDE_EDIT"] = "1" }
    result["SNAPZY_STACK"] = stack.id
    result["SNAPZY_SERVICE"] = service.id
    return result
  }
}
