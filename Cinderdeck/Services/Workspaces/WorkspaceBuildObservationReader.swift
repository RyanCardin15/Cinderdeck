import Darwin
import Foundation

@MainActor
enum WorkspaceBuildObservationReader {
  static func observe(_ receipt: WorkspaceBuildReceipt, definition: StackDefinition, supervisor: StackSupervisor, phase: String) async -> WorkspaceBuildObservation {
    var observation = WorkspaceBuildObservation(receiptID: receipt.id, workspaceID: receipt.request.workspaceID, serviceID: receipt.request.serviceID, phase: phase)
    observation.artifactSHA256 = receipt.artifact?.sha256
    do {
      guard definition.fingerprint == receipt.request.expectedDefinitionHash, let artifact = receipt.artifact, let launch = receipt.launch, let nonce = receipt.launchNonce,
        let service = definition.service(receipt.request.serviceID), service.buildAdapter == receipt.adapter, let port = service.port,
        supervisor.runtime(definition.id, service.id).process == launch.process, launch.process.matchesLiveProcess else { throw StackControlError(code: "build_unknown", message: "Declared build, definition or original service birth is unavailable") }
      let (_, selection) = try WorkspaceBuildScope.select(definition, serviceID: service.id)
      let before = await WorkspaceRunProvenance.capture(selection, environment: ProcessInfo.processInfo.environment)
      guard WorkspaceBuildScope.matches(receipt.request, before), WorkspaceRunProvenance.assess(start: receipt.repositoriesAtEnd, end: before, scopeComplete: selection.complete) == "complete" else { throw StackControlError(code: "source_changed", message: "Source no longer matches the newly produced artifact receipt") }
      guard let owners = try await PortInspector.conflict(on: port)?.owners, !owners.isEmpty,
        owners.allSatisfy({ $0.startTime != nil && getpgid($0.pid) == launch.process.pgid && StackProcessIdentity.startTime(pid: $0.pid) == $0.startTime }) else { throw StackControlError(code: "build_unknown", message: "The declared loopback listener is not owned by the original service group") }
      observation.serviceURL = "http://127.0.0.1:\(port)"
      let stamp = try await WorkspaceBuildHTTP.fetch(port: port, path: receipt.adapter.stampPath, maximum: 16_384)
      guard let object = try JSONSerialization.jsonObject(with: stamp) as? [String: Any], object["schemaVersion"] as? Int == 1,
        object["buildID"] as? String == receipt.id, object["artifactSHA256"] as? String == artifact.sha256, object["launchNonce"] as? String == nonce else { throw StackControlError(code: "stamp_changed", message: "The served stamp does not match the prepared artifact and actual launch nonce") }
      observation.stampMatched = true
      let served = try await WorkspaceBuildHTTP.fetch(port: port, path: receipt.adapter.servedArtifactPath, maximum: WorkspaceBuildArtifactFiles.maximumBytes)
      observation.servedArtifactSHA256 = WorkspaceBuildArtifactFiles.digest(served)
      guard served.count == artifact.size, observation.servedArtifactSHA256 == artifact.sha256 else { throw StackControlError(code: "artifact_changed", message: "Actual served bytes do not match the prepared artifact") }
      let root = supervisor.buildArtifacts.directory, name = receipt.id + "/artifacts/" + receipt.adapter.artifactName
      let disk = try await Task.detached { try WorkspaceBuildArtifactFiles.read(root: root, name: name) }.value
      guard disk.count == artifact.size, WorkspaceBuildArtifactFiles.digest(disk) == artifact.sha256 else { throw StackControlError(code: "artifact_changed", message: "The private prepared artifact changed after launch") }
      let after = await WorkspaceRunProvenance.capture(selection, environment: ProcessInfo.processInfo.environment)
      guard WorkspaceBuildScope.matches(receipt.request, after), WorkspaceRunProvenance.assess(start: before, end: after, scopeComplete: selection.complete) == "complete" else { throw StackControlError(code: "source_changed", message: "Source changed while reading declared build evidence") }
      guard supervisor.runtime(definition.id, service.id).process == launch.process, launch.process.matchesLiveProcess,
        let finalOwners = try await PortInspector.conflict(on: port)?.owners, finalOwners == owners else { throw StackControlError(code: "stamp_changed", message: "Service birth or port owner changed during observation") }
      observation.sourceUnchanged = true; observation.processMatched = true; observation.state = "matched"
      observation.detail = "Declared artifact bytes and build stamp matched this build and service launch; application behavior is not covered by this claim."
    } catch {
      let code = (error as? StackControlError)?.code
      observation.state = ["artifact_changed", "source_changed", "stamp_changed"].contains(code ?? "") ? "changed" : "unknown"
      observation.detail = error.localizedDescription
    }
    observation.observedAt = Date()
    return observation
  }
}
