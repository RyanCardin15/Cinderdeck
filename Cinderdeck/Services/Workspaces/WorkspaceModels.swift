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
  func task(_ id: String) -> WorkspaceTaskDefinition? { tasks.first { $0.id == id } }
  func workflow(_ id: String) -> WorkspaceWorkflowDefinition? { workflows.first { $0.id == id } }
  func serviceDependencies(_ ids: Set<String>) -> Set<String> {
    var result = ids
    while true {
      let next = result.union(services.filter { result.contains($0.id) }.flatMap(\.dependencies))
      if next == result { return result }
      result = next
    }
  }
}
