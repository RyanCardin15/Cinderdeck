import CryptoKit
import Darwin
import Foundation

extension StackControlService {
  private func buildSelection(_ definition: StackDefinition, serviceID: String) throws -> (WorkspaceBuildAdapterDefinition, WorkspaceRunProvenance.Selection) { try WorkspaceBuildScope.select(definition, serviceID: serviceID) }
  private func buildSourcesMatch(_ input: WorkspaceBuildPrepareInput, _ sources: [WorkspaceRunRepositorySnapshot]) -> Bool { WorkspaceBuildScope.matches(input, sources) }
  func handleIntegrationBuild(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let common: Set<String> = ["installationID", "workspaceID", "generation"]
    let allowed: Set<String>
    switch method {
    case "integration.build.describe": allowed = common.union(["serviceID"])
    case "integration.build.prepare": allowed = common.union(["serviceID", "operationKey", "expectedDefinitionHash", "expectedWorkflowHash", "expectedRepositories", "requiredTaskIDs"])
    case "integration.build.get": allowed = common.union(["receiptID", "operationKey"])
    case "integration.build.launch", "integration.build.runChecks": allowed = common.union(["receiptID", "operationKey"])
    case "integration.build.observe": allowed = common.union(["receiptID", "phase"])
    case "integration.build.finish": allowed = common.union(["receiptID", "operationKey", "cancel"])
    default: throw StackControlError(code: "unknown_method", message: "Unsupported declared build method")
    }
    guard let object = params.objectValue, Set(object.keys).isSubset(of: allowed), try JSONEncoder().encode(params).count <= 262_144,
      let installationID = params["installationID"]?.stringValue, let workspaceID = params["workspaceID"]?.stringValue,
      !workspaceID.isEmpty, workspaceID.utf8.count <= 160, let generation = params["generation"]?.intValue, generation > 0 else { throw StackControlError.invalid("Choose an exact bounded declared build context") }
    let authority = WorkspaceRunAuthority(installationID: installationID, workspaceID: workspaceID, generation: generation)
    let journal = try integrationStore()
    guard installationID == journal.installationID else { throw StackControlError(code: "installation_changed", message: "Reconnect to the saved build installation") }
    let snapshot = try await journal.snapshot(workspaceID: workspaceID, offset: 0, limit: 1)
    guard let resource = snapshot.resources.first, resource.available, resource.generation == generation else { throw StackControlError(code: "stale_binding", message: "The build workspace identity changed") }
    let file = try workspaceFile(.object(["workspace": .string(workspaceID)]))
    guard let definition = file.definition else { throw StackControlError.notFound("Build workspace definition is unavailable") }
    let store = supervisor.buildArtifacts
    if method == "integration.build.describe" {
      guard let serviceID = params["serviceID"]?.stringValue, serviceID.utf8.count <= 160 else { throw StackControlError.invalid("Choose a declared service") }
      let (adapter, selection) = try buildSelection(definition, serviceID: serviceID)
      let sources = await WorkspaceRunProvenance.capture(selection, environment: ProcessInfo.processInfo.environment)
      let clean = sources.allSatisfy { $0.complete && $0.fingerprint?.trackedCount == 0 && $0.fingerprint?.untrackedCount == 0 }
      return .object(["adapter": adapter.value(serviceID: serviceID), "definitionHash": .string(definition.fingerprint), "workflowHash": .string(WorkspaceRunProvenance.digest(definition.task(adapter.buildTaskID)!)),
        "repositories": .array(sources.map(\.value)), "detail": clean ? .null : .string("Source is dirty, changing or incomplete; pin a clean isolated checkout before building")])
    }
    if method == "integration.build.prepare" {
      let input = try params.decode(WorkspaceBuildPrepareInput.self)
      guard !input.operationKey.isEmpty, input.operationKey.utf8.count <= 160, input.expectedRepositories.count <= 16, !input.expectedRepositories.isEmpty,
        Set(input.expectedRepositories.map(\.repositoryID)).count == input.expectedRepositories.count else { throw StackControlError.invalid("Pass the immutable declared build preview tuple") }
      let (adapter, _) = try buildSelection(definition, serviceID: input.serviceID)
      guard definition.fingerprint == input.expectedDefinitionHash, WorkspaceRunProvenance.digest(definition.task(adapter.buildTaskID)!) == input.expectedWorkflowHash,
        input.requiredTaskIDs == adapter.requiredTaskIDs else { throw StackControlError(code: "stale_revision", message: "The reviewed build or check definition changed") }

      let (receipt, created) = try store.begin(input, adapter: adapter, actor: actor)
      if created { Task { [weak self] in await self?.executeDeclaredBuild(receipt.id, definition: definition) } }
      return receipt.value
    }
    let receipt: WorkspaceBuildReceipt
    if method == "integration.build.get", params["receiptID"] == nil {
      guard let key = params["operationKey"]?.stringValue, !key.isEmpty, key.utf8.count <= 160 else { throw StackControlError.invalid("Inspect by original build key or receipt ID") }
      receipt = try store.get(operationKey: key, actor: actor, authority: authority)
    } else {
      guard let id = params["receiptID"]?.stringValue, UUID(uuidString: id) != nil, method != "integration.build.get" || params["operationKey"] == nil else { throw StackControlError.invalid("Inspect exactly one saved build identity") }
      receipt = try store.get(id, actor: actor, authority: authority)
    }
    if method == "integration.build.get" { return receipt.value }
    if method == "integration.build.observe" {
      guard let phase = params["phase"]?.stringValue, ["start", "end", "check"].contains(phase) else { throw StackControlError.invalid("Choose an observation endpoint") }
      let observation = await declaredBuildObservation(receipt, definition: definition, phase: phase)
      try store.update(receipt.id) { if $0.observations.count < 64 { $0.observations.append(observation) } }
      return observation.value
    }
    guard let key = params["operationKey"]?.stringValue else { throw StackControlError.invalid("Save a durable build action key before effects") }

    let actionKind: String
    if method == "integration.build.finish" {
      guard let cancel = params["cancel"]?.boolValue else { throw StackControlError.invalid("Choose finish or cancel explicitly") }
      actionKind = cancel ? "finish:cancel" : "finish"
    } else { actionKind = method == "integration.build.launch" ? "launch" : "checks" }
    if let old = receipt.actions[key] {
      guard old == actionKind else { throw StackControlError(code: "operation_conflict", message: "This saved action has different immutable parameters") }
      return receipt.value
    }
    if method == "integration.build.finish" {
      guard let cancel = params["cancel"]?.boolValue else { throw StackControlError.invalid("Choose finish or cancel explicitly") }
      if try store.action(receipt.id, key: key, kind: cancel ? "finish:cancel" : "finish") {
        Task { [weak self] in await self?.finishDeclaredBuild(receipt.id, cancel: cancel, key: key) }
      }
      return (store.current(receipt.id) ?? receipt).value
    }
    guard definition.fingerprint == receipt.request.expectedDefinitionHash else { throw StackControlError(code: "stale_revision", message: "Build definition changed after preparation") }
    if method == "integration.build.launch" {
      guard receipt.state == "ready", receipt.artifact != nil, supervisor.runtime(workspaceID, receipt.request.serviceID).process == nil,
        !supervisor.runtime(workspaceID, receipt.request.serviceID).phase.isActive else { throw StackControlError(code: "busy", message: "Launch requires a prepared artifact and stopped declared service") }
      let (_, launchSelection) = try buildSelection(definition, serviceID: receipt.request.serviceID)
      let launchSources = await WorkspaceRunProvenance.capture(launchSelection, environment: ProcessInfo.processInfo.environment)
      guard !store.isFinishing(receipt.id), store.current(receipt.id)?.state == "ready", buildSourcesMatch(receipt.request, launchSources), supervisor.definition(workspaceID)?.fingerprint == definition.fingerprint else { throw StackControlError(code: "source_changed", message: "Pinned source changed before declared launch") }
        let launchServices = definition.serviceDependencies([receipt.request.serviceID])
      guard launchServices.allSatisfy({ definition.service($0) != nil && supervisor.runtime(workspaceID, $0).process == nil && !supervisor.runtime(workspaceID, $0).phase.isActive }) else { throw StackControlError(code: "busy", message: "Declared launch requires its exact local dependencies stopped; existing services remain owned by their original caller") }
      if try store.action(receipt.id, key: key, kind: "launch") {
        try store.update(receipt.id) { $0.state = "launching"; $0.launchServices = launchServices.sorted(); $0.launchNonce = UUID().uuidString + UUID().uuidString }
        try store.arm(receipt.id)
        Task { [weak self] in
          guard let self else { return }
          await self.supervisor.start(stack: workspaceID, services: launchServices, actor: actor)
          do {
            let launched = store.current(receipt.id)?.launch != nil
            try store.update(receipt.id) { $0.actionStates[key] = launched ? "accepted" : "unknown"; if !launched { $0.state = "unknown"; $0.detail = "The launch has no saved process birth proof. Inspect native state before cancelling." } }
          } catch { }
        }
      }
      return (store.current(receipt.id) ?? receipt).value
    }
    guard receipt.state == "running", receipt.checks.isEmpty else { throw StackControlError(code: "busy", message: "Checks require the declared launch and their original attempt") }
    if try store.action(receipt.id, key: key, kind: "checks") {
      try store.update(receipt.id) { $0.state = "checking" }
      Task { [weak self] in await self?.executeDeclaredChecks(receipt.id, definition: definition, key: key) }
    }
    return (store.current(receipt.id) ?? receipt).value
  }
  private func executeDeclaredBuild(_ id: String, definition: StackDefinition) async {
    let store = supervisor.buildArtifacts
    guard let receipt = store.current(id), receipt.state == "preparing", !store.isFinishing(id) else { return }
    do {
      let (_, selection) = try buildSelection(definition, serviceID: receipt.request.serviceID)
      let start = await WorkspaceRunProvenance.capture(selection, environment: ProcessInfo.processInfo.environment)
      guard buildSourcesMatch(receipt.request, start), supervisor.definition(definition.id)?.fingerprint == definition.fingerprint else { throw StackControlError(code: "stale_revision", message: "The clean pinned physical repository tuple changed before build admission") }
      try Task.checkCancellation()
      guard !store.isFinishing(id), store.current(id)?.state == "preparing" else { throw CancellationError() }
      try store.prepareOutput(id)
      let run = try workspaceRunner.submit(workspace: definition.id, kind: .task, definitionID: receipt.adapter.buildTaskID, actor: receipt.actor,
        environment: ["CINDERDECK_BUILD_OUTPUT_DIR": store.output(id).path, "CINDERDECK_BUILD_ID": id],
        integrationOperationID: "build:" + id, integrationAuthority: receipt.request.authority, buildReceiptID: receipt.id)
      try store.update(id) { $0.repositoriesAtStart = start; $0.buildRunID = run.id; $0.actionStates[receipt.request.operationKey] = "accepted" }
      while workspaceRunner.run(run.id)?.status.isActive == true { try await Task.sleep(nanoseconds: 100_000_000) }
      try Task.checkCancellation()
      guard let result = workspaceRunner.run(run.id), result.status == .succeeded, result.sourceProvenance?.state == "complete" else { throw StackControlError(code: "build_failed", message: "The actual named build task failed or its source proof was incomplete") }
      let end = await WorkspaceRunProvenance.capture(selection, environment: ProcessInfo.processInfo.environment)
      guard buildSourcesMatch(receipt.request, end), WorkspaceRunProvenance.assess(start: start, end: end, scopeComplete: selection.complete) == "complete" else { throw StackControlError(code: "source_changed", message: "Pinned source changed while building") }
      let root = store.directory, name = id + "/artifacts/" + receipt.adapter.artifactName
      let bytes = try await Task.detached { try WorkspaceBuildArtifactFiles.read(root: root, name: name) }.value
      let artifact = WorkspaceBuildArtifact(name: receipt.adapter.artifactName, sha256: WorkspaceBuildArtifactFiles.digest(bytes), size: bytes.count)
      guard !store.isFinishing(id), store.current(id)?.state == "preparing" else { return }
      try store.update(id) { $0.repositoriesAtEnd = end; $0.artifact = artifact; $0.state = "ready"; $0.detail = nil }
      try store.writeManifest(id)
    } catch {
      guard !store.isFinishing(id) else { return }
      try? store.update(id) {
        $0.state = "failed"; $0.detail = error.localizedDescription; $0.actionStates[receipt.request.operationKey] = $0.buildRunID == nil ? "failed" : "accepted"
      }
    }
  }
  private func executeDeclaredChecks(_ id: String, definition: StackDefinition, key: String) async {
    let store = supervisor.buildArtifacts
    guard let receipt = store.current(id), receipt.state == "checking", !store.isFinishing(id) else { return }
    do {
      for taskID in receipt.adapter.requiredTaskIDs {
        try Task.checkCancellation()
        guard !store.isFinishing(id), store.current(id)?.state == "checking" else { throw CancellationError() }
            let run = try workspaceRunner.submit(workspace: definition.id, kind: .task, definitionID: taskID, actor: receipt.actor,
          integrationOperationID: "build-check:" + id + ":" + taskID, integrationAuthority: receipt.request.authority, buildReceiptID: receipt.id)
        try store.update(id) { $0.checks.append(.init(taskID: taskID, runID: run.id, status: run.status)); $0.actionStates[key] = "accepted" }
        while workspaceRunner.run(run.id)?.status.isActive == true { try await Task.sleep(nanoseconds: 100_000_000) }
        guard let result = workspaceRunner.run(run.id) else { throw StackControlError.notFound("Saved check run is unavailable") }
        try store.update(id) { if let index = $0.checks.firstIndex(where: { $0.runID == run.id }) { $0.checks[index].status = result.status; $0.checks[index].finishedAt = result.finishedAt; $0.checks[index].outcomeHash = result.outcomeHash; $0.checks[index].buildMatched = false } }
        guard result.status == .succeeded, result.sourceProvenance?.state == "complete", WorkspaceBuildScope.observationsMatch(result.buildObservations, receipt: receipt) else { throw StackControlError(code: "check_failed", message: "Required actual checks need stable source and matched declared artifact, stamp and original process at both endpoints") }
        try store.update(id) { if let index = $0.checks.firstIndex(where: { $0.runID == run.id }) { $0.checks[index].buildMatched = true } }
      }
      guard !store.isFinishing(id), store.current(id)?.state == "checking" else { return }
      try store.update(id) { $0.state = "running"; $0.actionStates[key] = "accepted" }
      try store.writeManifest(id)
    } catch { if !store.isFinishing(id) { try? store.update(id) { $0.state = "failed"; $0.detail = error.localizedDescription; if $0.actionStates[key] != "accepted" { $0.actionStates[key] = "failed" } } } }
  }
  private func groupStopped(_ process: StackProcessIdentity) -> Bool {
    !process.matchesLiveProcess && kill(-process.pgid, 0) != 0 && errno == ESRCH
  }
  private func finishDeclaredBuild(_ id: String, cancel: Bool, key: String) async {
    let store = supervisor.buildArtifacts
    guard let receipt = store.current(id) else { return }
    do {
      let runIDs = Array(Set([receipt.buildRunID].compactMap { $0 } + receipt.checks.map(\.runID) + workspaceRunner.runs.filter {
        $0.actor.key == receipt.actorKey && $0.integrationAuthority == receipt.request.authority && ($0.integrationOperationID == "build:" + id || $0.integrationOperationID?.hasPrefix("build-check:" + id + ":") == true)
      }.map(\.id)))
      for runID in runIDs {
        if let run = workspaceRunner.run(runID), run.status.isActive {
          guard cancel else { throw StackControlError(code: "busy", message: "A build/check command is still active; finish it or explicitly cancel") }
          try await workspaceRunner.cancel(runID)
        }
      }
      if !cancel, let definition = supervisor.definition(receipt.request.workspaceID) {
        let end = await declaredBuildObservation(receipt, definition: definition, phase: "end")
        try store.update(id) { if $0.observations.count < 64 { $0.observations.append(end) } }
      }
      store.revokeLaunchTickets(id)
      // Cancel waiting/inflight launches admitted exclusively by this receipt before checking process births.
      let launchTargets = Set(receipt.launchServices ?? [])
      let safeTargets = launchTargets.filter { service in
        let current = supervisor.runtime(receipt.request.workspaceID, service).process
        return current == nil || current == store.current(id)?.ownedLaunchServices?[service]
      }
      if !safeTargets.isEmpty { await supervisor.stop(stack: receipt.request.workspaceID, services: safeTargets, actor: receipt.actor) }
      let latest = store.current(id) ?? receipt
      guard launchTargets.allSatisfy({ supervisor.runtime(receipt.request.workspaceID, $0).process == nil }) else { throw StackControlError(code: "unknown_outcome", message: "A declared service has a replacement process birth; stop it explicitly before retrying cancellation. Checkout ownership remains held.") }
      var ownedServices = latest.ownedLaunchServices ?? [:]
      if let process = receipt.launch?.process { ownedServices[receipt.request.serviceID] = process }
      for runID in runIDs { for (service, process) in workspaceRunner.run(runID)?.startedServices ?? [:] { ownedServices[service] = process } }
      for (service, process) in ownedServices {
        let active = supervisor.runtime(receipt.request.workspaceID, service).process
        guard active == nil || active == process else { throw StackControlError(code: "unknown_outcome", message: "An owned task service has a replacement birth; checkout ownership remains held") }
        if supervisor.runtime(receipt.request.workspaceID, service).process == process { await supervisor.stop(stack: receipt.request.workspaceID, services: [service], actor: receipt.actor) }
        guard groupStopped(process) else { throw StackControlError(code: "unknown_outcome", message: "An owned service process group is not proven stopped; checkout ownership remains held") }
      }
      for runID in runIDs {
        guard workspaceRunner.run(runID)?.status.isActive != true else { throw StackControlError(code: "unknown_outcome", message: "An owned check is not proven stopped") }
        for process in workspaceRunner.run(runID)?.steps.compactMap(\.executionProcess) ?? [] {
          guard groupStopped(process) else { throw StackControlError(code: "unknown_outcome", message: "An owned command process group is not proven stopped") }
        }
      }
      try store.update(id) {
        $0.state = cancel ? "cancelled" : "finalized"
        for pending in $0.actionStates.keys where $0.actionStates[pending] == "pending" { $0.actionStates[pending] = "failed" }
        $0.actionStates[key] = "accepted"
      }
      if receipt.artifact != nil { try store.writeManifest(id) }
      try store.pruneFinished()
    } catch { try? store.update(id) { $0.state = "unknown"; $0.detail = error.localizedDescription; $0.actionStates[key] = "unknown" } }
  }
  func declaredBuildObservation(_ receipt: WorkspaceBuildReceipt, definition: StackDefinition, phase: String) async -> WorkspaceBuildObservation {
    await WorkspaceBuildObservationReader.observe(receipt, definition: definition, supervisor: supervisor, phase: phase)
  }
}
