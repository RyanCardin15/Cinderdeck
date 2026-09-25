import Foundation

/// Lane lifecycle steps that span the supervisor and workspace runs: creation with
/// `[lanes] setup`, removal with `[lanes] teardown`, and pruning merged lanes.
/// The panel and the control API both go through here.
@MainActor
final class StackLaneCoordinator {
  let supervisor: StackSupervisor
  let runner: WorkspaceRunner

  init(supervisor: StackSupervisor, runner: WorkspaceRunner) {
    self.supervisor = supervisor
    self.runner = runner
  }

  struct Creation {
    var file: StackDefinitionFile
    var warnings: [String]
    var setup: StackLaneSetupState?
    var setupSucceeded: Bool { setup.map { $0.status != .failed } ?? true }
  }

  /// Creates (or adopts) a lane, then runs its setup when the workspace defines one.
  func create(stack id: String, request: StackLaneRequest, actor: StackActor, setup: Bool = true) async throws -> Creation {
    let created = try await supervisor.createLane(stack: id, request: request, actor: actor)
    var result = Creation(file: created.file, warnings: created.warnings)
    if let reference = created.file.definition?.laneSettings?.setup {
      if setup { result.setup = await runSetup(created.file.id, actor: actor) }
      else {
        let skipped = StackLaneSetupState(status: .skipped, reference: reference, detail: "Skipped at creation. Run it with lane setup.")
        supervisor.setLaneSetup(created.file.id, skipped)
        result.setup = skipped
      }
    }
    result.file = supervisor.files.first { $0.id == created.file.id } ?? result.file
    return result
  }

  /// Runs `[lanes] setup` in the lane as a normal workspace run and records the outcome.
  @discardableResult
  func runSetup(_ id: String, actor: StackActor) async -> StackLaneSetupState? {
    guard let reference = supervisor.definition(id)?.laneSettings?.setup else { return nil }
    supervisor.setLaneSetup(id, .init(status: .running, reference: reference))
    var state: StackLaneSetupState
    do {
      let run = try await runner.runAndWait(workspace: id, reference: reference, actor: actor)
      let succeeded = run.status == .succeeded
      state = .init(status: succeeded ? .succeeded : .failed, reference: reference, runID: run.id,
        detail: succeeded ? nil : (run.detail ?? run.status.label))
    } catch {
      state = .init(status: .failed, reference: reference, detail: error.localizedDescription)
    }
    supervisor.setLaneSetup(id, state)
    return state
  }

  /// Runs `[lanes] teardown` (unless the worktrees are kept), then removes the lane.
  func remove(_ id: String, actor: StackActor, options: StackLaneRemovalOptions) async throws -> StackLaneRemovalReport {
    if !options.keepWorktrees, let teardown = supervisor.definition(id)?.laneSettings?.teardown {
      // Never tear down data for a removal that will be refused anyway.
      if let record = try StackLaneStore.record(id: id, in: supervisor.lanesDirectory) {
        _ = try await StackLaneStore.check(record, others: try StackLaneStore.records(in: supervisor.lanesDirectory), options: options)
      }
      var failure: String?
      do {
        let run = try await runner.runAndWait(workspace: id, reference: teardown, actor: actor)
        if run.status != .succeeded { failure = run.detail ?? run.status.label }
      } catch { failure = error.localizedDescription }
      if let failure, !options.forceTeardown {
        throw StackControlError(code: "teardown_failed",
          message: "Teardown \(teardown) failed: \(failure). The lane was kept. Fix it, or pass force_teardown=true (CLI: --force-teardown) to remove anyway.")
      }
    }
    return try await supervisor.removeLane(id, actor: actor, options: options)
  }

  struct PruneEntry: Codable, Sendable {
    var lane: String
    var reference: String
    var reason: String
    var action: String
    var detail: String?
  }

  /// Removes lanes whose branches were merged or whose upstream branch was deleted
  /// (and, with `missing`, lanes whose worktrees are gone). Dirty lanes are reported, not removed.
  func prune(source: String?, missing: Bool, dryRun: Bool, discardIgnored: Bool, actor: StackActor,
    skip: (String) -> String? = { _ in nil }) async -> [PruneEntry] {
    let lanes = supervisor.files.filter { file in
      guard let lane = file.lane else { return false }
      return source == nil || lane.sourceStackID == source
    }
    await supervisor.refreshLaneGitStates(lanes.map(\.id))
    var entries: [PruneEntry] = []
    for file in lanes {
      guard let lane = file.lane else { continue }
      let state = supervisor.laneGitStates[file.id]
      let worktreeMissing = file.issues.contains { $0.message.hasPrefix("Lane worktree is missing") }
      let reason: String
      if state?.merged == true { reason = "merged" }
      else if state?.upstreamGone == true { reason = "upstream branch deleted" }
      else if missing && worktreeMissing { reason = "worktree missing" }
      else { continue }
      var entry = PruneEntry(lane: file.id, reference: lane.reference, reason: reason, action: dryRun ? "would remove" : "removed")
      if let blocked = skip(file.id) { entry.action = "skipped"; entry.detail = blocked; entries.append(entry); continue }
      if !dryRun {
        do { _ = try await remove(file.id, actor: actor, options: .init(discardIgnored: discardIgnored)) }
        catch { entry.action = "kept"; entry.detail = error.localizedDescription }
      }
      entries.append(entry)
    }
    return entries
  }

  /// The variables Cinderdeck and the definition set for a workspace, or one of its services.
  /// Shell variables and secret values are left out.
  func environment(stack id: String, service name: String?) throws -> [String: String] {
    guard let definition = supervisor.definition(id) else { throw StackError.message("\(id) has no valid definition") }
    let service: ServiceDefinition
    if let name {
      if let found = definition.service(name) { service = found }
      else if let task = definition.task(name) {
        service = ServiceDefinition(id: task.id, command: task.command, repo: task.repo, directory: task.directory,
          port: task.port, environment: task.environment, ports: task.ports)
      } else { throw StackControlError.notFound("Unknown service or task \(name) in \(definition.name)") }
    } else {
      service = ServiceDefinition(id: "", command: "", directory: definition.root)
    }
    var result = StackLaunchDefinition(stack: definition, service: service).environment(shell: [:], secrets: [:])
    for key in ["FORCE_COLOR", "CLICOLOR_FORCE", "PYTHONUNBUFFERED", "DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION",
      "DOTNET_WATCH_RESTART_ON_RUDE_EDIT", "SNAPZY_STACK", "SNAPZY_SERVICE"] where definition.environment[key] == nil && service.environment[key] == nil {
      result[key] = nil
    }
    if name == nil { result["CINDERDECK_SERVICE"] = nil }
    for key in definition.secrets.keys { result[key] = nil }
    return result
  }
}
