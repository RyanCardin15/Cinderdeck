import Foundation

@MainActor
enum WorkspaceBuildScope {
  static func select(_ definition: StackDefinition, serviceID: String) throws -> (WorkspaceBuildAdapterDefinition, WorkspaceRunProvenance.Selection) {
    guard let service = definition.service(serviceID), let adapter = service.buildAdapter,
      service.port != nil, let task = definition.task(adapter.buildTaskID), task.requiresServices.isEmpty, task.repo == service.repo, service.repo != nil,
      adapter.requiredTaskIDs.count <= 32, adapter.requiredTaskIDs.allSatisfy({ definition.task($0) != nil }) else {
      throw StackControlError(code: "unsupported_build_adapter", message: "Declare a build task, own artifact/stamp paths, check tasks and owned service port first")
    }
    let scope = WorkspaceRunProvenance.select(definition, references: ([adapter.buildTaskID] + adapter.requiredTaskIDs).map { "task:" + $0 } + ["start:" + serviceID])
    guard scope.complete, !scope.repositories.isEmpty else { throw StackControlError(code: "unsupported_checkout", message: "Declared verifier source and dependency scope is incomplete") }
    return (adapter, scope)
  }
  static func matches(_ input: WorkspaceBuildPrepareInput, _ sources: [WorkspaceRunRepositorySnapshot]) -> Bool {
    guard sources.count == input.expectedRepositories.count, sources.allSatisfy({ $0.complete && $0.fingerprint?.state == "complete" && $0.fingerprint?.trackedCount == 0 && $0.fingerprint?.untrackedCount == 0 }) else { return false }
    return input.expectedRepositories.allSatisfy { expected in sources.contains {
      $0.repositoryID == expected.repositoryID && $0.checkoutPhysicalID == expected.checkoutPhysicalID && $0.repositoryPhysicalID == expected.repositoryPhysicalID
        && $0.head == expected.head && $0.canonicalRepositoryKeys.sorted() == expected.canonicalRepositoryKeys.sorted()
    } }
  }
  static func observationsMatch(_ observations: [WorkspaceBuildObservation]?, receipt: WorkspaceBuildReceipt) -> Bool {
    guard let artifact = receipt.artifact, let observations, observations.count == 2,
      Set(observations.map(\.phase)) == Set(["start", "end"]) else { return false }
    return observations.allSatisfy {
      $0.receiptID == receipt.id && $0.workspaceID == receipt.request.workspaceID && $0.serviceID == receipt.request.serviceID && $0.state == "matched"
        && $0.artifactSHA256 == artifact.sha256 && $0.servedArtifactSHA256 == artifact.sha256 && $0.sourceUnchanged && $0.processMatched && $0.stampMatched
    }
  }
  static func lease(_ receipt: WorkspaceBuildReceipt, supervisor: StackSupervisor) throws {
    _ = try supervisor.checkoutReservations().borrowWriter(receipt.lease.id, actorKey: receipt.actorKey, token: receipt.lease.token,
      workspaceID: receipt.request.workspaceID, generation: receipt.request.generation, physicalIDs: receipt.request.expectedRepositories.map(\.checkoutPhysicalID))
  }
}
