import Foundation

/// Services stay alive. Tasks have a meaningful exit status. Workflows sequence both.
nonisolated struct WorkspaceTaskDefinition: Codable, Equatable, Identifiable, Sendable {
  let id: String
  var name: String
  var command: String
  var repo: String?
  var directory: URL
  var environment: [String: String] = [:]
  var requiresServices: [String] = []
  var timeout: TimeInterval = 600
  /// Ports a task's own server listens on. Lanes assign their own values.
  var port: Int?
  var ports: [String: Int] = [:]
  var raw: StackRawValues?

  var allPorts: [String: Int] {
    var result = ports
    if let port { result[""] = port }
    return result
  }
}

extension WorkspaceTaskDefinition {
  nonisolated enum CodingKeys: String, CodingKey {
    case id, name, command, repo, directory, environment, requiresServices, timeout, port, ports, raw
  }
  nonisolated init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    command = try c.decode(String.self, forKey: .command)
    repo = try c.decodeIfPresent(String.self, forKey: .repo)
    directory = try c.decode(URL.self, forKey: .directory)
    environment = try c.decodeIfPresent([String: String].self, forKey: .environment) ?? [:]
    requiresServices = try c.decodeIfPresent([String].self, forKey: .requiresServices) ?? []
    timeout = try c.decodeIfPresent(TimeInterval.self, forKey: .timeout) ?? 600
    port = try c.decodeIfPresent(Int.self, forKey: .port)
    ports = try c.decodeIfPresent([String: Int].self, forKey: .ports) ?? [:]
    raw = try c.decodeIfPresent(StackRawValues.self, forKey: .raw)
  }
}

nonisolated struct WorkspaceWorkflowDefinition: Codable, Equatable, Identifiable, Sendable {
  let id: String
  var name: String
  /// Explicit references: task:test, start:api, stop:api. Runs in listed order.
  var steps: [String]
  var cleanupServices = false
}

nonisolated enum WorkspaceRunKind: String, Codable, CaseIterable, Sendable { case task, workflow }
nonisolated enum WorkspaceRunStatus: String, Codable, Sendable {
  case queued, running, cancelling, succeeded, failed, cancelled, interrupted, skipped
  var isActive: Bool { [.queued, .running, .cancelling].contains(self) }
  var label: String { rawValue.capitalized }
}

nonisolated struct WorkspaceRunStep: Codable, Equatable, Identifiable, Sendable {
  var id = UUID()
  var reference: String
  var title: String
  var command: String?
  var directory: String?
  var status: WorkspaceRunStatus = .queued
  var startedAt: Date?
  var finishedAt: Date?
  var exitCode: Int32?
  var detail: String?
  var process: StackProcessIdentity?
}

nonisolated struct WorkspaceRun: Codable, Equatable, Identifiable, Sendable {
  var id = UUID()
  var workspaceID: String
  var workspaceName: String
  var definitionID: String
  var name: String
  var kind: WorkspaceRunKind
  var status: WorkspaceRunStatus = .queued
  var createdAt = Date()
  var finishedAt: Date?
  var actor: StackActor
  var steps: [WorkspaceRunStep]
  var detail: String?
  var cleanupServices = false
  var startedServices: [String: StackProcessIdentity] = [:]
  var duration: TimeInterval { (finishedAt ?? Date()).timeIntervalSince(createdAt) }
}

extension StackDefinition {
  nonisolated func task(_ id: String) -> WorkspaceTaskDefinition? { tasks.first { $0.id == id } }
  nonisolated func workflow(_ id: String) -> WorkspaceWorkflowDefinition? { workflows.first { $0.id == id } }
  nonisolated func serviceDependencies(_ ids: Set<String>) -> Set<String> {
    var result = ids
    while true {
      let next = result.union(services.filter { result.contains($0.id) }.flatMap(\.dependencies))
      if next == result { return result }
      result = next
    }
  }
}
