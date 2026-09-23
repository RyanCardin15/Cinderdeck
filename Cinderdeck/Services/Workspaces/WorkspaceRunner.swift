import Combine
import Foundation

/// One finite run per workspace. Definitions are captured at submission; edits affect the next run.
@MainActor
final class WorkspaceRunner: ObservableObject {
  static let shared = WorkspaceRunner(supervisor: .shared, store: .init(directory: WorkspaceRunStore.defaultDirectory))
  @Published private(set) var runs: [WorkspaceRun] = []
  @Published private(set) var storageError: String?
  @Published private(set) var recovering = false
  let supervisor: StackSupervisor
  let store: WorkspaceRunStore
  private let secrets: any StackSecretsStoring
  private let environment: @Sendable (String) async throws -> [String: String]
  private var workers: [UUID: Task<Void, Never>] = [:]
  private var processes: [UUID: ServiceProcess] = [:]
  private var buffers: [UUID: LogBuffer] = [:]
  private var recovered = false

  init(supervisor: StackSupervisor, store: WorkspaceRunStore, secrets: any StackSecretsStoring = StackSecretsStore(),
    environment: @escaping @Sendable (String) async throws -> [String: String] = { try await ShellEnvironmentResolver.shared.resolve(shell: $0) }) {
    self.supervisor = supervisor; self.store = store; self.secrets = secrets; self.environment = environment
    supervisor.activeWorkspaceRun = { [weak self] id in self?.activeRun(id) != nil }
    do { runs = try store.load() } catch { storageError = "Could not read run history: \(error.localizedDescription)" }
  }
  var hasActiveRuns: Bool { runs.contains { $0.status.isActive } || !processes.isEmpty }
  func activeRun(_ workspace: String) -> WorkspaceRun? { runs.first { $0.workspaceID == workspace && $0.status.isActive } }
  func run(_ id: UUID) -> WorkspaceRun? { runs.first { $0.id == id } }

  /// A finite command cannot recover its original exit code after app death. Never replay it.
  func recover() async {
    guard !recovered, !recovering else { return }
    recovering = true
    defer { recovering = false; recovered = true }
    for saved in runs where saved.status.isActive {
      var failure: String?
      for step in saved.steps {
        guard let identity = step.process, identity.matchesLiveProcess else { continue }
        let process = ServiceProcess()
        do {
          try await process.reattach(identity)
          try await process.stop(signal: SIGTERM, timeout: 2)
        } catch { processes[saved.id] = process; failure = error.localizedDescription }
      }
      if saved.cleanupServices { await cleanup(saved.id) }
      change(saved.id) {
        $0.status = failure == nil ? .interrupted : .cancelling
        $0.finishedAt = failure == nil ? Date() : nil
        $0.detail = failure.map { "Recovery could not stop a command: \($0). Cancel this run to retry." }
          ?? "Cinderdeck closed during this run. The command was stopped; rerun explicitly."
        for i in $0.steps.indices where $0.steps[i].status.isActive {
          $0.steps[i].status = failure == nil ? .interrupted : .cancelling
          $0.steps[i].finishedAt = failure == nil ? Date() : nil
        }
      }
    }
  }

  @discardableResult
  func submit(workspace id: String, kind: WorkspaceRunKind, definitionID: String, actor: StackActor = .user) throws -> WorkspaceRun {
    guard recovered && !recovering else { throw StackError.message("Run recovery is still in progress") }
    if let storageError { throw StackError.message(storageError) }
    guard activeRun(id) == nil else { throw StackError.message("A task or workflow is already running in this workspace") }
    guard !supervisor.isBootstrapping, supervisor.states[id]?.operation == nil,
      let workspace = supervisor.definition(id) else { throw StackError.message("Workspace is unavailable or busy") }
    let references: [String], name: String, cleanupServices: Bool
    switch kind {
    case .task:
      guard let task = workspace.task(definitionID) else { throw StackError.message("Unknown task: \(definitionID)") }
      references = ["task:" + task.id]; name = task.name; cleanupServices = false
    case .workflow:
      guard let workflow = workspace.workflow(definitionID) else { throw StackError.message("Unknown workflow: \(definitionID)") }
      references = workflow.steps; name = workflow.name; cleanupServices = workflow.cleanupServices
    }
    let steps = references.map { reference -> WorkspaceRunStep in
      let parts = reference.split(separator: ":").map(String.init)
      let task = parts.first == "task" ? workspace.task(parts.last ?? "") : nil
      return WorkspaceRunStep(reference: reference, title: task?.name ?? reference.replacingOccurrences(of: ":", with: " "),
        command: task?.command, directory: task?.directory.path)
    }
    let run = WorkspaceRun(workspaceID: id, workspaceName: workspace.name, definitionID: definitionID,
      name: name, kind: kind, actor: actor, steps: steps, cleanupServices: cleanupServices)
    // Persist before launching anything. Corrupt/unwritable history never silently loses ownership.
    try store.save([run] + runs)
    runs.insert(run, at: 0)
    workers[run.id] = Task { [weak self] in await self?.execute(run.id, workspace: workspace) }
    return run
  }

  func cancel(_ id: UUID) async throws {
    guard let run = run(id), run.status.isActive || processes[id] != nil else { return }
    change(id) { $0.status = .cancelling }
    workers[id]?.cancel()
    if let process = processes[id] { try await process.stop(signal: SIGTERM, timeout: 2) }
    if let worker = workers[id] { await worker.value }
    else {
      processes[id] = nil
      if run.cleanupServices { await cleanup(id) }
      change(id) { $0.status = .cancelled; $0.finishedAt = Date(); $0.detail = "Cancelled" }
    }
  }
  func cancelAll() async {
    for run in runs where run.status.isActive { do { try await cancel(run.id) } catch { storageError = error.localizedDescription } }
  }

  private func execute(_ id: UUID, workspace: StackDefinition) async {
    var outcome: WorkspaceRunStatus = .succeeded
    var detail: String?
    change(id) { $0.status = .running }
    if let initial = run(id) {
      for index in initial.steps.indices {
        do {
          try Task.checkCancellation()
          change(id) { $0.steps[index].status = .running; $0.steps[index].startedAt = Date() }
          let reference = initial.steps[index].reference.split(separator: ":").map(String.init)
          switch reference[0] {
          case "task":
            guard let task = workspace.task(reference[1]) else { throw StackError.message("Task no longer exists") }
            try await ensureServices(Set(task.requiresServices), workspace: workspace, runID: id)
            try Task.checkCancellation()
            try await executeTask(task, workspace: workspace, runID: id, stepIndex: index)
          case "start": try await ensureServices([reference[1]], workspace: workspace, runID: id)
          case "stop":
            await supervisor.stop(stack: workspace.id, services: [reference[1]], actor: initial.actor)
            if supervisor.runtime(workspace.id, reference[1]).process != nil { throw StackError.message("Could not stop \(reference[1])") }
          default: throw StackError.message("Unsupported workflow step")
          }
          try Task.checkCancellation()
          change(id) { $0.steps[index].status = .succeeded; $0.steps[index].finishedAt = Date() }
        } catch {
          outcome = Task.isCancelled ? .cancelled : .failed
          detail = Task.isCancelled ? "Cancelled" : error.localizedDescription
          change(id) {
            $0.steps[index].status = outcome; $0.steps[index].detail = detail; $0.steps[index].finishedAt = Date()
            for next in $0.steps.indices where next > index { $0.steps[next].status = .skipped }
          }
          break
        }
      }
    }
    if run(id)?.cleanupServices == true {
      await cleanup(id)
      if let saved = run(id), saved.startedServices.contains(where: { supervisor.runtime(saved.workspaceID, $0.key).process == $0.value }) {
        outcome = .failed; detail = "The run finished, but some services could not be stopped. Review their status in Services."
      }
    }
    if let process = processes[id] {
      do { try await process.stop(signal: SIGTERM, timeout: 2); processes[id] = nil }
      catch { outcome = .cancelling; detail = "Could not stop the command. Cancel to retry: \(error.localizedDescription)" }
    }
    change(id) { $0.status = outcome; $0.detail = detail; $0.finishedAt = outcome.isActive ? nil : Date() }
    workers[id] = nil
    prune()
  }

  private func ensureServices(_ requested: Set<String>, workspace: StackDefinition, runID: UUID) async throws {
    guard !requested.isEmpty else { return }
    try Task.checkCancellation()
    guard supervisor.states[workspace.id]?.operation == nil else { throw StackError.message("Services are busy; try again when the current operation finishes") }
    guard supervisor.definition(workspace.id) == workspace else {
      throw StackError.message("Workspace definition changed during this run. Review the changes and run again before starting services.")
    }
    let required = workspace.serviceDependencies(requested)
    let starting = required.filter { !supervisor.runtime(workspace.id, $0).phase.isActive && supervisor.runtime(workspace.id, $0).process == nil }
    // Journal ownership as soon as each launch publishes its identity, including during readiness waits.
    let ownership = supervisor.$states.sink { [weak self] states in
      guard let self else { return }
      for service in starting {
        if let identity = states[workspace.id]?.services[service]?.process,
          self.run(runID)?.startedServices[service] != identity {
          self.change(runID) { $0.startedServices[service] = identity }
        }
      }
    }
    defer { ownership.cancel() }
    await supervisor.start(stack: workspace.id, services: required, actor: run(runID)?.actor)
    // Cancel pending launches before collecting ownership; none may escape a cancelled start.
    if Task.isCancelled { await supervisor.stop(stack: workspace.id, services: starting, actor: run(runID)?.actor) }
    for service in starting {
      if let identity = supervisor.runtime(workspace.id, service).process { change(runID) { $0.startedServices[service] = identity } }
    }
    try Task.checkCancellation()
    for service in required.sorted() where supervisor.runtime(workspace.id, service).phase != .ready {
      let state = supervisor.runtime(workspace.id, service)
      throw StackError.message("\(service) is not ready: \(state.detail ?? state.phase.label). Remaining steps were skipped.")
    }
  }

  private func executeTask(_ task: WorkspaceTaskDefinition, workspace: StackDefinition, runID: UUID, stepIndex: Int) async throws {
    let shell = try await environment(workspace.shell)
    try Task.checkCancellation()
    var values: [String: String] = [:]
    for (variable, name) in workspace.secrets { values[variable] = try secrets.read(name) }
    let service = ServiceDefinition(id: task.id, command: task.command, repo: task.repo,
      directory: task.directory, environment: task.environment, restartOnFailure: false)
    let launch = StackLaunchDefinition(stack: workspace, service: service)
    var env = launch.environment(shell: shell, secrets: values)
    env["CINDERDECK_WORKSPACE"] = workspace.id; env["CINDERDECK_TASK"] = task.id; env["CINDERDECK_RUN"] = runID.uuidString
    guard let step = run(runID)?.steps[stepIndex] else { throw CancellationError() }
    let process = ServiceProcess()
    processes[runID] = process
    let url = store.logURL(runID, step.id)
    let identity = try await process.launch(launch, environment: env, logURL: url)
    change(runID) { $0.steps[stepIndex].process = identity }
    if let storageError { try await process.stop(signal: SIGTERM, timeout: 2); throw StackError.message(storageError) }
    if Task.isCancelled { try await process.stop(signal: SIGTERM, timeout: 2); throw CancellationError() }
    let buffer = LogBuffer(service: task.id)
    buffers[step.id] = buffer
    try await buffer.follow(url, fromEnd: false)
    var timedOut = false
    let timeout = Task { @MainActor in
      do { try await Task.sleep(nanoseconds: UInt64(task.timeout * 1_000_000_000)) } catch { return }
      timedOut = true
      do { try await process.stop(signal: SIGTERM, timeout: 2) }
      catch { change(runID) { $0.detail = "Timeout cleanup failed: \(error.localizedDescription)" } }
    }
    let result = await process.waitForExit()
    timeout.cancel()
    await timeout.value
    // Tasks must not leave children behind, including after a successful shell exit.
    try await process.stop(signal: SIGTERM, timeout: 2)
    processes[runID] = nil
    await buffer.finish()
    await buffer.close()
    buffers[step.id] = nil
    change(runID) { $0.steps[stepIndex].exitCode = result.code; $0.steps[stepIndex].process = nil }
    try Task.checkCancellation()
    if timedOut { throw StackError.message("Task exceeded its \(task.timeout)-second timeout") }
    guard result.code == 0 else { throw StackError.message("Task exited with status \(result.code.map(String.init) ?? "unknown")") }
  }

  private func cleanup(_ id: UUID) async {
    guard let saved = run(id) else { return }
    let owned = Set(saved.startedServices.compactMap { service, identity in
      supervisor.runtime(saved.workspaceID, service).process == identity ? service : nil
    })
    if !owned.isEmpty { await supervisor.stop(stack: saved.workspaceID, services: owned, actor: saved.actor) }
  }

  func output(_ runID: UUID, stepID: UUID? = nil) async -> [StackLogLine] {
    guard let run = run(runID) else { return [] }
    var result: [StackLogLine] = []
    for step in run.steps where stepID == nil || step.id == stepID {
      if let buffer = buffers[step.id] { result += await buffer.snapshot() }
      else {
        let url = store.logURL(runID, step.id)
        let text = await Task.detached {
          guard let handle = try? FileHandle(forReadingFrom: url) else { return "" }
          defer { try? handle.close() }
          let size = (try? handle.seekToEnd()) ?? 0
          try? handle.seek(toOffset: size > 512 * 1024 ? size - 512 * 1024 : 0)
          return String(decoding: (try? handle.readToEnd()) ?? Data(), as: UTF8.self)
        }.value
        result += text.split(separator: "\n", omittingEmptySubsequences: false).filter { !$0.isEmpty }
          .suffix(LogBuffer.capacity).map { StackLogLine(service: step.title, text: String($0), timestamp: step.startedAt ?? run.createdAt) }
      }
    }
    return Array(result.suffix(LogBuffer.capacity))
  }

  private func change(_ id: UUID, _ mutation: (inout WorkspaceRun) -> Void) {
    guard let i = runs.firstIndex(where: { $0.id == id }) else { return }
    mutation(&runs[i])
    do { try store.save(runs) } catch { storageError = "Could not save run history: \(error.localizedDescription)" }
  }
  private func prune() {
    let completed = runs.filter { !$0.status.isActive }
    let removed = completed.dropFirst(100)
    guard !removed.isEmpty else { return }
    let ids = Set(removed.map(\.id))
    let retained = runs.filter { !ids.contains($0.id) }
    do {
      try store.save(retained); runs = retained
      for id in ids { try store.removeLogs(id) }
    } catch { storageError = error.localizedDescription }
  }
}
