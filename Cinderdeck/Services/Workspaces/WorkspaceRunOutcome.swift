import CryptoKit
import Foundation

nonisolated struct WorkspaceRunAuthority: Codable, Equatable, Sendable {
  let installationID: String
  let workspaceID: String
  let generation: Int
}
nonisolated enum WorkspaceRunOutcome {
  struct Step: Encodable {
    let id: UUID; let reference: String; let status: WorkspaceRunStatus
    let exitCode: Int32?; let detail: String?; let command: String?; let directory: String?
    let definitionHash: String?; let startedAt: Date?; let finishedAt: Date?
  }
  struct Outcome: Encodable {
    let id: UUID; let workspaceID: String; let authority: WorkspaceRunAuthority?
    let status: WorkspaceRunStatus; let finishedAt: Date?; let detail: String?
    let definitionHash: String?; let workflowHash: String?; let steps: [Step]
  }
  // Exact persisted outcomes, including every step. No logs or repeated source payloads are read.
  static func digest(_ run: WorkspaceRun) -> String {
    WorkspaceRunProvenance.digest(Outcome(id: run.id, workspaceID: run.workspaceID, authority: run.integrationAuthority,
      status: run.status, finishedAt: run.finishedAt, detail: run.detail,
      definitionHash: run.sourceProvenance?.definitionHash, workflowHash: run.sourceProvenance?.workflowHash,
      steps: run.steps.map { Step(id: $0.id, reference: $0.reference, status: $0.status, exitCode: $0.exitCode,
        detail: $0.detail, command: $0.command, directory: $0.directory, definitionHash: $0.definitionHash,
        startedAt: $0.startedAt, finishedAt: $0.finishedAt) }))
  }
  static func resolves(_ successor: WorkspaceRun, failure: WorkspaceRun, authority: WorkspaceRunAuthority) -> Bool {
    guard [.failed, .interrupted].contains(failure.status), successor.status == .succeeded,
      successor.rerunOfID == failure.id, successor.finishedAt != nil,
      !successor.steps.isEmpty, successor.steps.allSatisfy({ $0.status == .succeeded && ($0.exitCode == nil || $0.exitCode == 0) }),
      failure.workspaceID == authority.workspaceID, successor.workspaceID == authority.workspaceID,
      failure.integrationAuthority == authority, successor.integrationAuthority == authority,
      let old = failure.sourceProvenance, let fresh = successor.sourceProvenance,
      !old.definitionHash.isEmpty, !old.workflowHash.isEmpty else { return false }
    return old.definitionHash == fresh.definitionHash && old.workflowHash == fresh.workflowHash
  }
}
