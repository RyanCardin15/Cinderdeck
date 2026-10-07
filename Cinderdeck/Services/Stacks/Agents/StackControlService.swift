import Combine
import Darwin
import Foundation

/// Serves the workspace control API to agents and the `cinderdeck` CLI, keeps
/// `state.json` current.
@MainActor
final class StackControlService: ObservableObject {
  static let shared: StackControlService = {
    let service = StackControlService(supervisor: .shared, runner: .shared)
    service.laneCreationPresenter = { source, options, create in
      try await LaneCreationWindowController.shared.present(source: source, options: options, create: create)
    }
    return service
  }()

  /// Used only by the explicit manual creation entry point. Tool requests never present UI.
  var laneCreationPresenter: ((StackDefinition, LaneCreationOptions,
    @escaping @MainActor (LaneCreationOptions) async throws -> JSONValue) async throws -> JSONValue)?

  @Published private(set) var serverError: String?
  @Published private(set) var isServing = false
  let supervisor: StackSupervisor
  private var server: StackControlSocketServer?
  private var subscriptions = Set<AnyCancellable>()
  private var started = false
  private let prViews: PRViewControlService
  private lazy var prBrowser = PRBrowserControlService(views: prViews)
  let workspaceRunner: WorkspaceRunner
  let lanes: StackLaneCoordinator
  var integrationOperations: IntegrationOperations?
  var integrationJournal: IntegrationJournal?
  lazy var linkedWork = IntegrationLinkedWorkStore(directory: integrationDirectory.appendingPathComponent("LinkedWork", isDirectory: true))
  var integrationProjectionRevision: UInt64 = 0
  let integrationDirectory: URL

  init(supervisor: StackSupervisor, prViews: PRViewControlService? = nil, runner: WorkspaceRunner? = nil, integrationDirectory: URL? = nil) {
    self.supervisor = supervisor
    self.integrationDirectory = integrationDirectory ?? supervisor.logDirectory.appendingPathComponent("Integration", isDirectory: true)
    self.workspaceRunner = runner ?? WorkspaceRunner(supervisor: supervisor, store: .init(directory: supervisor.logDirectory.appendingPathComponent("Runs")))
    self.lanes = StackLaneCoordinator(supervisor: supervisor, runner: self.workspaceRunner)
    self.prViews = prViews ?? PRViewControlService()
  }

  // MARK: Lifecycle

  func start() {
    guard !started else { return }
    started = true
    let server = StackControlSocketServer(path: StackControlPaths.socket.path) { [weak self] data, peer in
      guard let self else { return Data() }
      return await self.respond(to: data, peer: peer)
    }
    do {
      try server.start()
      self.server = server
      isServing = true
      serverError = nil
    } catch {
      serverError = error.localizedDescription
      DiagnosticLogger.shared.log(.warning, .system, "Control socket unavailable: \(error.localizedDescription)")
    }
    Publishers.Merge3(
      supervisor.$states.map { _ in () },
      supervisor.$files.map { _ in () },
      supervisor.gitMonitor.$statuses.map { _ in () }
    )
    .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
    .sink { [weak self] _ in self?.writeState() }
    .store(in: &subscriptions)
    writeState()
  }

  func stop() {
    server?.stop()
    server = nil
    isServing = false
    subscriptions.removeAll()
    writeState(appRunning: false)
  }

  // MARK: Snapshots

  func snapshot(appRunning: Bool = true) -> StacksSnapshot {
    StacksSnapshot(updatedAt: Date(), appRunning: appRunning, appPID: getpid(),
      socket: StackControlPaths.socket.path,
      workspacesDirectory: supervisor.definitionsDirectory.path,
      logsDirectory: supervisor.logDirectory.path,
      workspaces: supervisor.files.map { stackSnapshot($0) })
  }

  func stackSnapshot(_ file: StackDefinitionFile) -> StackSnapshot {
    let state = supervisor.states[file.id] ?? .init()
    var services = file.definition?.services ?? []
    for runtime in state.services.values {
      if let service = runtime.launchDefinition?.service, !services.contains(where: { $0.id == service.id }) { services.append(service) }
    }
    let repos = file.definition.map { definition in
      definition.repos.isEmpty ? [RepoDefinition(id: "workspace", path: definition.root, laneMode: .shared)] : definition.repos
    } ?? []
    let host = file.definition?.host ?? "localhost"
    var snapshot = StackSnapshot(
      id: file.id, name: file.name, file: file.file.path, state: state.label, operation: state.operation,
      definitionChanged: supervisor.definitionChanged(file.id),
      issues: file.issues.map { "\($0.severity.rawValue): \($0.message)" },
      services: services.map { service in
        let runtime = state.services[service.id] ?? .init()
        let port = service.port ?? { if case .port(let port) = service.readiness { return port }; return nil }()
        let repo = service.repo.flatMap { id in (runtime.launchDefinition?.stack ?? file.definition)?.repo(id) }
        return StackServiceSnapshot(
          name: service.id, phase: runtime.phase.rawValue, status: runtime.phase.label,
          ready: runtime.phase == .ready, pid: runtime.process?.pid, pgid: runtime.process?.pgid,
          port: port, url: port.map { "http://\(host):\($0)" }, startedAt: runtime.startedAt,
          restarts: runtime.restartCount, detail: runtime.detail, owner: runtime.owner,
          repo: service.repo, branch: repo.flatMap { supervisor.gitMonitor.statuses[$0.path]?.branchLabel },
          cwd: service.directory.path, command: service.command, dependsOn: service.dependencies,
          autostart: service.autostart, logFile: supervisor.logURL(stack: file.id, service: service.id).path,
          ports: service.ports.isEmpty ? nil : service.ports, bindWarning: runtime.bindWarning)
      } + (file.definition?.links.filter { !$0.isExternal } ?? []).map { link in
        // Shared services appear with the state of the instance the lane uses.
        let runtime = supervisor.runtime(link.stack, link.service)
        return StackServiceSnapshot(name: link.id, phase: runtime.phase.rawValue, status: runtime.phase.label + " (shared)",
          ready: runtime.phase == .ready, pid: runtime.process?.pid, pgid: runtime.process?.pgid, port: link.port,
          url: link.port.map { "http://\(link.host):\($0)" }, startedAt: runtime.startedAt, restarts: runtime.restartCount,
          detail: runtime.detail, owner: runtime.owner, repo: nil, branch: nil, cwd: nil, command: nil, dependsOn: [],
          autostart: false, logFile: supervisor.logURL(stack: link.stack, service: link.service).path,
          ports: link.ports.isEmpty ? nil : link.ports, sharedFrom: link.stack, sharedServiceID: link.service)
      },
      repos: repos.map { repo in
        let status = supervisor.gitMonitor.statuses[repo.path] ?? GitRepoStatus(branch: "Loading…")
        let checkout = try? PhysicalCheckoutIdentity.resolve(repo.path)
        return StackRepoSnapshot(physicalID: checkout?.physicalID,
          repositoryPhysicalID: try? checkout?.repositoryPhysicalID(), id: repo.id, path: repo.path.path, branch: status.branchLabel, dirty: status.isDirty,
          changedFiles: status.changedFiles, ahead: status.ahead, behind: status.behind, upstream: status.upstream,
          operation: status.operation, error: status.error)
      }, lane: file.lane)
    snapshot.root = file.definition?.root.path
    snapshot.files = file.definition?.files.map(\.path)
    if let lane = file.lane {
      let git = supervisor.laneGitStates[file.id]
      var urls: [String: String] = [:]
      for service in file.definition?.services ?? [] { if let port = service.port { urls[service.id] = "http://\(host):\(port)" } }
      snapshot.laneStatus = StackLaneStatusSnapshot(slug: lane.effectiveSlug, directory: lane.directory.path, pinned: lane.pinned,
        adopted: lane.adopted, setup: file.laneSetup, merged: git?.merged, upstreamGone: git?.upstreamGone, unpushed: git?.unpushed,
        worktrees: file.laneWorktrees, shared: (file.definition?.links ?? []).filter(\.shared).map(\.id), urls: urls)
    }
    if let links = file.definition?.links, !links.isEmpty { snapshot.links = links }
    return snapshot
  }

  private func writeState(appRunning: Bool = true) {
    publishIntegrationProjection()
    do {
      try StackControlPaths.ensureDirectory()
      let data = try StackControlCoding.encoder(pretty: true).encode(snapshot(appRunning: appRunning))
      try data.write(to: StackControlPaths.state, options: .atomic)
    } catch {
      DiagnosticLogger.shared.log(.warning, .system, "Could not write stacks state: \(error.localizedDescription)")
    }
  }

  // MARK: Requests

  private func respond(to data: Data, peer: pid_t) async -> Data {
    let request: StackControlRequest
    do { request = try StackControlCoding.decoder().decode(StackControlRequest.self, from: data) }
    catch {
      let response = StackControlResponse(id: 0, result: nil, error: .invalid("Malformed request: \(error.localizedDescription)"))
      return (try? StackControlCoding.encoder().encode(response)) ?? Data()
    }
    var response = StackControlResponse(id: request.id)
    do {
      let actor = resolveActor(for: request.client, peer: peer)
      response.result = try await handle(request.method, params: request.params ?? .object([:]), actor: actor)
    } catch let error as StackControlError {
      response.error = error
    } catch {
      response.error = StackControlError(code: "failed", message: error.localizedDescription)
    }
    return (try? StackControlCoding.encoder().encode(response)) ?? Data()
  }

  private func resolveActor(for client: StackControlClientInfo?, peer: pid_t) -> StackActor {
    let description = peer > 0 ? StackProcessInspector.describe(peer) : (host: nil, tty: nil, parents: [])
    let supplied = client?.name?.trimmingCharacters(in: .whitespacesAndNewlines)
    let name = (supplied?.isEmpty == false ? supplied : nil) ?? description.host ?? "Agent"
    return StackActor(kind: .agent, name: String(name.prefix(60)), session: client?.session.map { String($0.prefix(60)) },
      host: description.host, pid: peer > 0 ? peer : nil, tty: description.tty, cwd: client?.cwd)
  }

  func handle(_ method: String, params: JSONValue, actor: StackActor, operationID: String? = nil) async throws -> JSONValue {
    if method.hasPrefix("integration.ui.") { return try handleUnifiedUI(method, params: params, actor: actor) }
    if method.hasPrefix("integration.") { return try await handleIntegration(method, params: params, actor: actor) }
    if method.hasPrefix("workspace.") { return try await handleWorkspace(method, params: params, actor: actor) }
    if method == "prs.browser" { return try await prBrowser.handle(params: params) }
    if method.hasPrefix("prs.views.") { return try await prViews.handle(method, params: params) }
    if method.hasPrefix("repro.") { return try await handleRepro(method, params: params, actor: actor) }
    switch method {
    case "ping":
      return try JSONValue(encoding: [
        "ok": "true", "pid": String(getpid()),
        "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
        "socket": StackControlPaths.socket.path, "you": actor.label,
      ])
    case "snapshot":
      return try JSONValue(encoding: snapshot())
    case "services.status":
      let file = try workspaceFile(params)
      return try JSONValue(encoding: stackSnapshot(file))
    case "runs.start", "runs.cancel", "runs.rerun", "definition.apply": return try await handleRunOperation(method, params: params, actor: actor, operationID: operationID)
    case "services.start": return try await start(params, actor: actor)
    case "services.stop": return try await stop(params, actor: actor)
    case "services.restart": return try await restart(params, actor: actor)
    case "lane.list":
      let source = try params["workspace"].map { _ in try workspaceFile(params) }
      let sourceID = source?.lane?.sourceStackID ?? source?.id
      let files = supervisor.files.filter { sourceID == nil || $0.id == sourceID || $0.lane?.sourceStackID == sourceID }
      await supervisor.refreshLaneGitStates(files.filter { $0.lane != nil }.map(\.id))
      return try JSONValue(encoding: files.map { stackSnapshot($0) })
    case "lane.create", "lane.adopt": return try await createLane(params, adopt: method == "lane.adopt", actor: actor, operationID: operationID)
    case "lane.update": return try await updateLane(params, actor: actor)
    case "lane.remove", "lane.release":
      let file = try laneFile(params)

      let options = StackLaneRemovalOptions(discardIgnored: params["discard_ignored"]?.boolValue == true,
        keepWorktrees: method == "lane.release", deleteLogs: params["delete_logs"]?.boolValue == true,
        forceTeardown: params["force_teardown"]?.boolValue == true)
      let report = try await lanes.remove(file.id, actor: actor, options: options)

      var result: [String: JSONValue] = [method == "lane.release" ? "released" : "removed": .string(file.id)]
      if let encoded = try? JSONValue(encoding: report) { result["report"] = encoded }
      return .object(result)
    case "lane.setup":
      let file = try laneFile(params)

      try requireIdle(file)
      guard file.definition?.laneSettings?.setup != nil else {
        throw StackControlError.invalid("\(file.lane?.sourceStackID ?? file.id) has no [lanes] setup. Add setup = \"task:<id>\" or \"workflow:<id>\".")
      }
      let state = await lanes.runSetup(file.id, actor: actor, operationID: operationID)
      let refreshed = supervisor.files.first { $0.id == file.id } ?? file
      return .object(["setup": (try? JSONValue(encoding: state)) ?? .null, "workspace": (try? JSONValue(encoding: stackSnapshot(refreshed))) ?? .null])
    case "lane.unpin":
      let file = try laneFile(params)

      try await supervisor.unpinLane(file.id, actor: actor)
      let refreshed = supervisor.files.first { $0.id == file.id } ?? file
      return .object(["workspace": (try? JSONValue(encoding: stackSnapshot(refreshed))) ?? .null])
    case "lane.env":
      let file = try workspaceFile(params)
      let environment = try lanes.environment(stack: file.id, service: params["service"]?.stringValue)
      return .object(["workspace": .string(file.id), "environment": .object(environment.mapValues(JSONValue.string))])
    case "lane.prune":
      let source = try params["workspace"].map { _ in try workspaceFile(params) }
      let entries = await lanes.prune(source: source.map { $0.lane?.sourceStackID ?? $0.id }, missing: params["missing"]?.boolValue == true,
        dryRun: params["dry_run"]?.boolValue == true, discardIgnored: params["discard_ignored"]?.boolValue == true, actor: actor)
      return try JSONValue(encoding: entries)
    case "logs": return try await logs(params)
    case "events":
      let file = try workspaceFile(params)
      let events = await supervisor.events(stack: file.id, limit: params["limit"]?.intValue ?? 40)
      return .array(events.map { event in
        var object: [String: JSONValue] = ["kind": .string(event.kind), "at": .string(ISO8601DateFormatter().string(from: event.occurredAt))]
        if let service = event.serviceName { object["service"] = .string(service) }
        if let detail = event.detail { object["detail"] = .string(detail) }
        if let actor = event.actor { object["by"] = .string(actor) }
        return .object(object)
      })
    case "ports": return try await ports(params)
    case "port.kill": return try await killPort(params, actor: actor)
    case "git.status":
      let file = try workspaceFile(params)
      for repo in file.definition?.repos ?? [] { await supervisor.gitMonitor.refresh(repo.path) }
      return try JSONValue(encoding: stackSnapshot(file).repos)
    case "git.branches": return try await branches(params)
    case "git.switch": return try await switchBranch(params, actor: actor)
    case "git.fetch", "git.pull": return try await fetchOrPull(params, pull: method == "git.pull", actor: actor)
    case "validate": return try validate(params)
    case "reload":
      await supervisor.reloadDefinitions()
      return try JSONValue(encoding: snapshot())
    case "paths":
      return .object([
        "socket": .string(StackControlPaths.socket.path), "state": .string(StackControlPaths.state.path),
        "workspacesDirectory": .string(supervisor.definitionsDirectory.path), "logsDirectory": .string(supervisor.logDirectory.path),
        "template": .string(StackAgentGuide.template),
      ])
    default:
      throw StackControlError(code: "unknown_method", message: "Unknown method \(method)")
    }
  }

  // MARK: Stack actions

  /// Resolves `workspace` by id, name, lane reference (<workspace>/<name>), or unique prefix.
  func workspaceFile(_ params: JSONValue) throws -> StackDefinitionFile {
    guard let query = params["workspace"]?.stringValue?.trimmingCharacters(in: .whitespaces), !query.isEmpty else {
      if supervisor.files.count == 1, let only = supervisor.files.first { return only }
      throw StackControlError.invalid("Pass workspace (id or name). Workspaces: " + supervisor.files.map(\.id).joined(separator: ", "))
    }
    let files = supervisor.files
    if let exact = files.first(where: { $0.id == query }) { return exact }
    if let lane = files.first(where: { $0.lane?.reference == query }) { return lane }
    if let named = files.first(where: { $0.name.caseInsensitiveCompare(query) == .orderedSame || $0.id.caseInsensitiveCompare(query) == .orderedSame }) { return named }
    let prefixed = files.filter { $0.id.lowercased().hasPrefix(query.lowercased()) || $0.name.lowercased().hasPrefix(query.lowercased()) }
    if prefixed.count == 1 { return prefixed[0] }
    throw StackControlError.notFound("No workspace matches \"\(query)\". Workspaces: " + files.map(\.id).joined(separator: ", "))
  }

  /// A lane by id or <workspace>/<name>; the original checkout is refused.
  private func laneFile(_ params: JSONValue) throws -> StackDefinitionFile {
    let file = try workspaceFile(params)
    guard file.lane != nil else {
      throw StackControlError.invalid("\(file.name) is an original checkout, not a lane. Pass a lane id or <workspace>/<name> (see list_lanes).")
    }
    return file
  }

  /// Manual New lane actions opt into the sheet; socket, CLI and MCP creation execute directly.
  func presentLaneCreation(params: JSONValue, actor: StackActor = .user) async throws -> JSONValue {
    try await createLane(params, adopt: false, actor: actor, presentSheet: true)
  }

  private func createLane(_ params: JSONValue, adopt: Bool, actor: StackActor, operationID: String? = nil,
    presentSheet: Bool = false) async throws -> JSONValue {
    let source = try workspaceFile(params)
    guard source.lane == nil else { throw StackControlError.invalid("Create lanes from the original workspace, not from lane \(source.name).") }
    var request = StackLaneRequest(branch: params["branch"]?.stringValue ?? (adopt ? params["name"]?.stringValue : nil) ?? "")
    request.name = params["name"]?.stringValue
    request.integrationOperationID = operationID
    if let modes = params["repositoryModes"] {
      guard let values = modes.objectValue, values.count <= 64 else {
        throw StackControlError.invalid("repositoryModes must map repository IDs to worktree or reference")
      }
      for (id, value) in values {
        guard source.definition?.repo(id) != nil, let text = value.stringValue,
          let mode = StackLaneRepositoryMode(rawValue: text) else {
          throw StackControlError.invalid("repositoryModes.\(id) must select a workspace repository as worktree or reference")
        }
        request.repositoryModes[id] = mode
      }
    }
    if adopt {
      let path = params["path"]?.stringValue ?? actor.cwd
      guard let path, !path.isEmpty else { throw StackControlError.invalid("Pass path: the worktree to adopt") }
      request.adoptPath = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
    } else if request.branch.isEmpty && !presentSheet {
      if request.name == nil {
        let existing = try StackLaneStore.records(in: supervisor.lanesDirectory)
          .filter { $0.info.sourceStackID == source.id }.map { $0.info.name }
        var number = 1
        while existing.contains(where: { $0.caseInsensitiveCompare("Lane \(number)") == .orderedSame }) { number += 1 }
        request.name = "Lane \(number)"
      }
      request.branch = "codex/" + StackLaneInfo.slug(for: request.name!) + "-" + UUID().uuidString.prefix(6).lowercased()
    }
    if let refs = params["repositoryRefs"] {
      guard !adopt, let values = refs.objectValue, values.count <= 64 else {
        throw StackControlError.invalid("repositoryRefs must map repository IDs to start revisions for lane creation")
      }
      for (id, value) in values {
        guard let ref = value.stringValue else { throw StackControlError.invalid("repositoryRefs.\(id) must be a string") }
        request.repositoryRefs[id] = ref
      }
    }
    request.from = params["from"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    if let values = params["env"]?.objectValue {
      for (key, value) in values {
        guard let text = value.stringValue else { throw StackControlError.invalid("env.\(key) must be a string") }
        request.environment[key] = text
      }
    }
    request.copy = params["copy"]?.stringsValue ?? []
    try requireIdle(source)
    let options = LaneCreationOptions(request: request, setup: params["setup"]?.boolValue ?? !adopt,
      start: params["start"]?.boolValue ?? true)
    if params["reviewer"]?.boolValue == true {
      // The review launcher already inspected and saved every committed head.
      // Durable integration intake pins those choices; the general lane sheet
      // must not offer to replace them with another branch or revision.
      let repositories = source.definition?.repos.filter {
        (request.repositoryModes[$0.id]?.laneMode ?? $0.laneMode) == .worktree
      } ?? []
      guard !adopt, operationID != nil, !options.start, !repositories.isEmpty,
        Set(request.repositoryRefs.keys) == Set(repositories.map(\.id)),
        request.repositoryRefs.values.allSatisfy({ $0.range(of: "^[0-9a-f]{40,64}$", options: .regularExpression) != nil }) else {
        throw StackControlError.invalid("Reviewer lanes require a durable operation and exact committed heads for every isolated repository")
      }
      return try await createApprovedLane(source, options: options, params: params, actor: actor, reviewed: true)
    }
    if presentSheet {
      guard let present = laneCreationPresenter, let definition = source.definition else {
        throw StackControlError(code: "unsupported_capability", message: "The lane creation sheet is unavailable")
      }
      return try await present(definition, options) { [self] approved in
        approved.progress?(.loadingWorkspace)
        await supervisor.reloadDefinitions()
        guard supervisor.definition(source.id) == definition else {
          throw StackControlError(code: "stale_revision", message: "Workspace settings changed while this sheet was open. Cancel and open New lane again to review the new defaults.")
        }
        try requireIdle(source)
        return try await createApprovedLane(source, options: approved, params: params, actor: actor, reviewed: true)
      }
    }
    return try await createApprovedLane(source, options: options, params: params, actor: actor, reviewed: false)
  }

  private func createApprovedLane(_ source: StackDefinitionFile, options: LaneCreationOptions,
    params: JSONValue, actor: StackActor, reviewed: Bool) async throws -> JSONValue {
    let request = options.request
    let created: StackLaneCoordinator.Creation
    do {
      created = try await lanes.create(stack: source.id, request: request, actor: actor,
        setup: options.setup, progress: options.progress)
    } catch let refusal as StackLaneStore.StartRevisionRefusal {
      throw StackControlError.invalid(refusal.message)
    }
    let file = created.file
    var extra: [String: JSONValue] = [:]
    if reviewed {
      extra["creationReviewed"] = .bool(true)
      if let branch = try? StackLaneStore.record(id: file.id, in: supervisor.lanesDirectory)?.worktrees.first?.branch {
        extra["createdBranch"] = .string(branch)
      }
    }
    if !created.warnings.isEmpty { extra["warnings"] = .array(created.warnings.map(JSONValue.string)) }
    if let setup = created.setup { extra["setup"] = (try? JSONValue(encoding: setup)) ?? .null }
    func respond(_ value: JSONValue) -> JSONValue {
      guard var object = value.objectValue else { return value }
      object.merge(extra) { _, new in new }
      return .object(object)
    }
    if !options.start || !created.setupSucceeded {
      if !created.setupSucceeded {
        extra["note"] = .string("Setup failed, so services were not started. Read the run with workspace_run_logs, fix it, then run_lane_setup or start_services.")
      }
      return respond(.object(["workspace": try JSONValue(encoding: stackSnapshot(supervisor.files.first { $0.id == file.id } ?? file))]))
    }
    let supervisor = supervisor
    options.progress?(.startingServices)
    let timedOut = await settle(file, params: params) { await supervisor.start(stack: file.id, actor: actor) }
    return respond(await actionResult(file, timedOut: timedOut, waited: params["wait"]?.boolValue ?? true))
  }

  private func services(_ params: JSONValue, in file: StackDefinitionFile, key: String = "services") throws -> Set<String>? {
    guard let names = params[key]?.stringsValue ?? params["service"]?.stringsValue, !names.isEmpty else { return nil }
    let known = Set((file.definition?.services.map(\.id) ?? []) + (supervisor.states[file.id]?.services.keys.map { $0 } ?? []))
    let unknown = names.filter { !known.contains($0) }
    guard unknown.isEmpty else {
      throw StackControlError.notFound("Unknown service \(unknown.joined(separator: ", ")) in \(file.name). Services: \(known.sorted().joined(separator: ", "))")
    }
    return Set(names)
  }

  private func requireIdle(_ file: StackDefinitionFile) throws {
    if workspaceRunner.activeRun(file.id) != nil { throw StackControlError(code: "busy", message: "A task or workflow is running. Wait for it or cancel the run first.") }
    if supervisor.isBootstrapping { throw StackControlError(code: "busy", message: "Cinderdeck is still reconnecting to running services. Try again in a moment.") }
    if let operation = supervisor.states[file.id]?.operation {
      throw StackControlError(code: "busy", message: "\(file.name) is busy (\(operation)). Try again when it finishes.")
    }
  }

  private func settle(_ file: StackDefinitionFile, params: JSONValue, body: @escaping () async -> Void) async -> Bool {
    let wait = params["wait"]?.boolValue ?? true
    let timeout = min(max(params["timeout"]?.doubleValue ?? 180, 1), 900)
    let flag = StackCompletionFlag()
    Task { await body(); flag.done = true }
    guard wait else { return false }
    let deadline = Date().addingTimeInterval(timeout)
    while !flag.done, Date() < deadline { try? await Task.sleep(nanoseconds: 200_000_000) }
    return !flag.done
  }

  private func actionResult(_ file: StackDefinitionFile, timedOut: Bool, waited: Bool) async -> JSONValue {
    let refreshed = supervisor.files.first { $0.id == file.id } ?? file
    let snapshot = stackSnapshot(refreshed)
    var object: [String: JSONValue] = ["workspace": (try? JSONValue(encoding: snapshot)) ?? .null]
    object["timedOut"] = .bool(timedOut)
    if !waited { object["note"] = .string("Returned without waiting. Poll workspace_details (CLI: services status) or pass wait=true.") }
    // Crashed services come back with their recent output so agents can react.
    var failures: [String: JSONValue] = [:]
    for service in snapshot.services where service.phase == StackServicePhase.crashed.rawValue || service.phase == StackServicePhase.unhealthy.rawValue {
      let lines = await recentLines(stack: file.id, service: service.name, limit: 30)
      failures[service.name] = .object(["status": .string(service.status), "detail": .string(service.detail ?? ""),
        "lastLines": .array(lines.map { .string($0.text) })])
    }
    if !failures.isEmpty { object["problems"] = .object(failures) }
    return .object(object)
  }

  private func start(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let file = try workspaceFile(params)
    guard file.definition != nil else {
      throw StackControlError(code: "invalid_definition", message: "\(file.name) has errors: " + file.issues.map(\.message).joined(separator: "; "))
    }

    try requireIdle(file)
    let selected = try services(params, in: file)
    let supervisor = supervisor
    let timedOut = await settle(file, params: params) { await supervisor.start(stack: file.id, services: selected, actor: actor) }
    return await actionResult(file, timedOut: timedOut, waited: params["wait"]?.boolValue ?? true)
  }

  private func stop(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let file = try workspaceFile(params)

    let selected = try services(params, in: file)
    let dependents = self.supervisor.dependents(of: file.id, services: selected)
    if !dependents.isEmpty, params["force"]?.boolValue != true {
      let files = self.supervisor.files
      let names = dependents.map { id in files.first { $0.id == id }?.lane?.reference ?? id }
      throw StackControlError(code: "in_use", message: "\(names.joined(separator: ", ")) \(names.count == 1 ? "uses" : "use") these services. Stop \(names.count == 1 ? "it" : "them") first, or pass force=true to stop anyway.")
    }
    let supervisor = supervisor
    let timedOut = await settle(file, params: params) { await supervisor.stop(stack: file.id, services: selected, actor: actor) }
    return await actionResult(file, timedOut: timedOut, waited: params["wait"]?.boolValue ?? true)
  }

  private func restart(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let file = try workspaceFile(params)
    guard file.definition != nil else {
      throw StackControlError(code: "invalid_definition", message: "\(file.name) has errors: " + file.issues.map(\.message).joined(separator: "; "))
    }

    try requireIdle(file)
    let selected = try services(params, in: file)
    guard selected == nil || selected!.count == 1 else { throw StackControlError.invalid("Restart one service at a time, or omit service to restart the workspace") }
    let dependents = params["dependents"]?.boolValue ?? false
    let supervisor = supervisor
    let timedOut = await settle(file, params: params) {
      await supervisor.restart(stack: file.id, service: selected?.first, includeDependents: dependents, actor: actor)
    }
    return await actionResult(file, timedOut: timedOut, waited: params["wait"]?.boolValue ?? true)
  }

  // MARK: Logs

  private func recentLines(stack: String, service: String?, limit: Int, after: Double? = nil) async -> [StackLogLine] {
    let buffered = await supervisor.logLines(stack: stack, service: service, limit: limit, after: after)
    if !buffered.isEmpty { return buffered }
    // An unchanged live buffer must not fall back to rereading its whole log file.
    if after != nil, !(await supervisor.logRevision(stack: stack, service: service)).isEmpty { return [] }
    // Nothing buffered this session: read the files services write to.
    let names = service.map { [$0] } ?? (supervisor.definition(stack)?.services.map(\.id) ?? [])
    let files = names.map { (name: $0, url: supervisor.logURL(stack: stack, service: $0)) }
    return await Task.detached(priority: .utility) {
      var chunks: [[StackLogLine]] = []
      var remaining = limit
      for file in files.reversed() where remaining > 0 {
        let date = (try? file.url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date.distantPast
        if let after, date.timeIntervalSince1970 <= after { continue }
        let lines = Self.tail(file.url, maxLines: remaining).map { StackLogLine(service: file.name, text: $0, timestamp: date) }
        chunks.append(lines)
        remaining -= lines.count
      }
      return chunks.reversed().flatMap { $0 }
    }.value
  }

  nonisolated static func tail(_ url: URL, maxLines: Int, maxBytes: UInt64 = 512 * 1024) -> [String] {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return [] }
    defer { try? handle.close() }
    guard let size = try? handle.seekToEnd() else { return [] }
    let start = size > maxBytes ? size - maxBytes : 0
    try? handle.seek(toOffset: start)
    let data = (try? handle.readToEnd()) ?? Data()
    var lines = String(decoding: data, as: UTF8.self).components(separatedBy: "\n")
    if start > 0, !lines.isEmpty { lines.removeFirst() }
    if lines.last == "" { lines.removeLast() }
    return lines.suffix(maxLines).map { AnsiParser.plainText($0.replacingOccurrences(of: "\r", with: "")) }
  }

  private func logs(_ params: JSONValue) async throws -> JSONValue {
    let file = try workspaceFile(params)
    let service = try services(params, in: file, key: "service")?.first
    let limit = min(max(params["lines"]?.intValue ?? 200, 1), 5000)
    let after = params["after"]?.doubleValue
    var lines = await recentLines(stack: file.id, service: service, limit: params["grep"] == nil ? limit : 5000, after: after)
    if let pattern = params["grep"]?.stringValue, !pattern.isEmpty {
      let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
      lines = lines.filter { line in
        let text = AnsiParser.plainText(line.text)
        if let regex { return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil }
        return text.localizedCaseInsensitiveContains(pattern)
      }
    }
    lines = Array(lines.suffix(limit))
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let names = service.map { [$0] } ?? (stackSnapshot(file).services.map(\.name))
    var files: [String: JSONValue] = [:]
    for name in names { files[name] = .string(supervisor.logURL(stack: file.id, service: name).path) }
    return .object([
      "workspace": .string(file.id),
      "lines": .array(lines.map { .object(["service": .string($0.service), "at": .string(formatter.string(from: $0.timestamp)),
        "text": .string(AnsiParser.plainText($0.text))]) }),
      "cursor": .number(lines.last?.timestamp.timeIntervalSince1970 ?? after ?? Date().timeIntervalSince1970),
      "files": .object(files),
    ])
  }

  // MARK: Ports

  private func managedGroups() -> [Int32: StackPortListener.Managed] {
    var result: [Int32: StackPortListener.Managed] = [:]
    for (stack, state) in supervisor.states {
      let name = supervisor.files.first { $0.id == stack }?.name ?? stack
      for (service, runtime) in state.services { if let process = runtime.process { result[process.pgid] = .init(stack: stack, stackName: name, service: service) } }
    }
    return result
  }

  private func ports(_ params: JSONValue) async throws -> JSONValue {
    var listeners = try await StackProcessInspector.listeners(managed: managedGroups())
    if let port = params["port"]?.intValue { listeners = listeners.filter { $0.port == port } }
    if params["managed"]?.boolValue == true { listeners = listeners.filter { $0.managed != nil } }
    if params["external"]?.boolValue == true { listeners = listeners.filter { $0.managed == nil } }
    return try JSONValue(encoding: listeners)
  }

  private func killPort(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    guard let port = params["port"]?.intValue, let rawPID = params["pid"]?.intValue else {
      throw StackControlError.invalid("Pass port and pid (from ports) so the right process is stopped")
    }
    let pid = Int32(clamping: rawPID)
    let listeners = try await StackProcessInspector.listeners(managed: managedGroups())
    guard let listener = listeners.first(where: { $0.port == port && $0.pid == pid }) else {
      throw StackControlError.notFound("PID \(pid) is not listening on port \(port) anymore")
    }
    if let managed = listener.managed {
      throw StackControlError(code: "managed", message: "Port \(port) belongs to \(managed.stackName)/\(managed.service). Stop it with stop_services (CLI: services stop) instead.")
    }
    let owner = StackPortOwner(pid: pid, name: listener.process, startTime: StackProcessIdentity.startTime(pid: pid))
    try await PortInspector.terminate(StackPortConflict(port: port, owners: [owner]))
    DiagnosticLogger.shared.log(.info, .system, "\(actor.label) stopped \(listener.process) (PID \(pid)) on port \(port)")
    return .object(["stopped": .number(Double(pid)), "port": .number(Double(port)), "process": .string(listener.process)])
  }

  // MARK: Git

  private func repos(_ params: JSONValue, in stack: StackDefinition) throws -> [RepoDefinition] {
    if let id = params["repo"]?.stringValue, !id.isEmpty {
      guard let repo = stack.repo(id) else {
        throw StackControlError.notFound("Unknown repo \(id). Repos: " + stack.repos.map(\.id).joined(separator: ", "))
      }
      return [repo]
    }
    guard !stack.repos.isEmpty else { throw StackControlError.invalid("\(stack.name) has no [repos.*] entries") }
    return stack.repos
  }

  private func branches(_ params: JSONValue) async throws -> JSONValue {
    let file = try workspaceFile(params)
    guard let stack = file.definition else { throw StackControlError(code: "invalid_definition", message: "\(file.name) has errors") }
    var result: [String: JSONValue] = [:]
    for repo in try repos(params, in: stack) {
      let git = supervisor.gitMonitor.git
      let branches = try await git.branches(at: repo.path)
      let current = try? await git.status(at: repo.path)
      let recent: [String] = (try? await git.recentBranches(at: repo.path)) ?? []
      let local: [JSONValue] = branches.filter { !$0.isRemote }.map { .string($0.name) }
      let remote: [JSONValue] = branches.filter(\.isRemote).map { .string($0.displayName) }
      let entry: [String: JSONValue] = [
        "current": .string(current?.branchLabel ?? ""),
        "recent": .array(recent.map(JSONValue.string)),
        "local": .array(local),
        "remote": .array(remote),
      ]
      result[repo.id] = .object(entry)
    }
    return .object(result)
  }

  private func switchBranch(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let file = try workspaceFile(params)
    guard let stack = file.definition else { throw StackControlError(code: "invalid_definition", message: "\(file.name) has errors") }
    guard let target = params["branch"]?.stringValue?.trimmingCharacters(in: .whitespaces), !target.isEmpty else {
      throw StackControlError.invalid("Pass branch")
    }

    try requireIdle(file)
    let strategy: GitDirtyStrategy
    switch params["dirty"]?.stringValue ?? "fail" {
    case "stash": strategy = .stash
    case "carry": strategy = .carry
    case "fail": strategy = .requireClean
    default: throw StackControlError.invalid("dirty must be fail, stash or carry")
    }
    let git = supervisor.gitMonitor.git
    let candidates = try repos(params, in: stack)
    var choices: [String: GitBranch] = [:]
    var skipped: [String] = []
    var transitions: [String] = []
    var dirty: [String] = []
    for repo in candidates {
      let branches = try await git.branches(at: repo.path)
      let match = branches.first { !$0.isRemote && $0.name == target }
        ?? branches.first { $0.isRemote && $0.displayName == target }
        ?? branches.first { $0.isRemote && $0.name == target && $0.displayName.hasPrefix("origin/") }
        ?? branches.first { $0.isRemote && $0.name == target }
      guard let match else { skipped.append(repo.id); continue }
      let status = try await git.status(at: repo.path)
      if let operation = status.operation { throw StackControlError(code: "git_blocked", message: "\(repo.id): \(operation) — resolve it in a terminal first") }
      if status.branchLabel == match.name && !match.isRemote { skipped.append(repo.id + " (already on it)"); continue }
      try await git.requireBranchAvailable(match, at: repo.path)
      if status.isDirty { dirty.append("\(repo.id) (\(status.changedFiles) changed)") }
      choices[repo.id] = match
      transitions.append("\(repo.id): \(status.branchLabel) → \(match.name)")
    }
    guard !choices.isEmpty else {
      throw StackControlError.notFound("No repo needs switching to \(target). Checked: " + candidates.map(\.id).joined(separator: ", ") +
        (skipped.isEmpty ? "" : ". Skipped: " + skipped.joined(separator: ", ")))
    }
    if !dirty.isEmpty && strategy == .requireClean {
      throw StackControlError(code: "dirty", message: "Uncommitted changes in " + dirty.joined(separator: ", ") +
        ". Pass dirty=stash to stash them (never auto-restored) or dirty=carry to let Git carry non-conflicting changes.")
    }
    let ordered = stack.repos.filter { choices[$0.id] != nil }
    try await supervisor.performGitChange(stack: file.id, repos: Set(choices.keys), eventDetail: transitions.joined(separator: ", "), actor: actor) {
      var completed: [String] = []
      for repo in ordered {
        guard let branch = choices[repo.id] else { continue }
        do { try await git.switchBranch(branch, at: repo.path, dirty: strategy); completed.append(repo.id) }
        catch {
          throw StackError.message("\(repo.id): \(error.localizedDescription)" +
            (completed.isEmpty ? "" : ". Already switched: \(completed.joined(separator: ", ")); remaining repos unchanged."))
        }
      }
    }
    for repo in ordered { await supervisor.gitMonitor.refresh(repo.path) }
    let refreshed = supervisor.files.first { $0.id == file.id } ?? file
    return .object([
      "switched": .array(transitions.map(JSONValue.string)),
      "skipped": .array(skipped.map(JSONValue.string)),
      "workspace": (try? JSONValue(encoding: stackSnapshot(refreshed))) ?? .null,
    ])
  }

  private func fetchOrPull(_ params: JSONValue, pull: Bool, actor: StackActor) async throws -> JSONValue {
    let file = try workspaceFile(params)
    guard let stack = file.definition else { throw StackControlError(code: "invalid_definition", message: "\(file.name) has errors") }
    let git = supervisor.gitMonitor.git
    var done: [String] = []
    if pull { try requireIdle(file) }
    for repo in try repos(params, in: stack) {
      if pull {
        try await supervisor.performGitChange(stack: file.id, repos: [repo.id], eventKind: "pulled", eventDetail: repo.id, actor: actor) {
          try await git.pull(at: repo.path)
        }
      } else {
        try await git.fetch(at: repo.path)
      }
      await supervisor.gitMonitor.refresh(repo.path)
      done.append(repo.id)
    }
    let refreshed = supervisor.files.first { $0.id == file.id } ?? file
    return .object([pull ? "pulled" : "fetched": .array(done.map(JSONValue.string)),
      "repos": (try? JSONValue(encoding: stackSnapshot(refreshed).repos)) ?? .null])
  }

  // MARK: Definitions

  private func validate(_ params: JSONValue) throws -> JSONValue {
    let source: String
    let url: URL
    if let text = params["source"]?.stringValue {
      source = text
      url = supervisor.definitionsDirectory.appendingPathComponent((params["id"]?.stringValue ?? "untitled") + ".toml")
    } else if let path = params["path"]?.stringValue {
      url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
      do { source = try String(contentsOf: url, encoding: .utf8) }
      catch { throw StackControlError.notFound("Cannot read \(url.path): \(error.localizedDescription)") }
    } else { throw StackControlError.invalid("Pass path or source") }
    let file = StackDefinitionLoader.load(source, file: url)
    var result: [String: JSONValue] = [
      "valid": .bool(file.definition != nil && !file.issues.contains { $0.severity == .error }),
      "issues": .array(file.issues.map { .string("\($0.severity.rawValue): \($0.message)") }),
    ]
    if let definition = file.definition {
      result["name"] = .string(definition.name)
      result["services"] = .array(definition.services.map { .string($0.id) })
      result["tasks"] = .array(definition.tasks.map { .string($0.id) })
      result["workflows"] = .array(definition.workflows.map { .string($0.id) })
      result["repos"] = .array(definition.repos.map { .string($0.id) })
      result["startOrder"] = .array(((try? definition.dependencyLayers()) ?? []).map { .array($0.map(JSONValue.string)) })
    }
    return .object(result)
  }
}

private final class StackCompletionFlag {
  var done = false
}
