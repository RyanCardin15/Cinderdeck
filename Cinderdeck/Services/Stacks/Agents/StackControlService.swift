import Combine
import Darwin
import Foundation

/// Serves the Stacks control API to agents and the `cinderdeck` CLI, keeps
/// `state.json` current, and tracks advisory claims.
@MainActor
final class StackControlService: ObservableObject {
  static let shared = StackControlService(supervisor: .shared, runner: .shared)

  @Published private(set) var claims: [String: StackClaim] = [:]
  @Published private(set) var serverError: String?
  @Published private(set) var isServing = false
  let supervisor: StackSupervisor
  private var server: StackControlSocketServer?
  private var subscriptions = Set<AnyCancellable>()
  private var started = false
  private let claimsFile: URL
  private let prViews: PRViewControlService
  let workspaceRunner: WorkspaceRunner

  init(supervisor: StackSupervisor, prViews: PRViewControlService? = nil, runner: WorkspaceRunner? = nil, claimsFile: URL = StackControlPaths.claims) {
    self.supervisor = supervisor
    self.claimsFile = claimsFile
    self.workspaceRunner = runner ?? WorkspaceRunner(supervisor: supervisor, store: .init(directory: supervisor.logDirectory.appendingPathComponent("Runs")))
    self.prViews = prViews ?? PRViewControlService()
  }

  // MARK: Lifecycle

  func start() {
    guard !started else { return }
    started = true
    loadClaims()
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
      DiagnosticLogger.shared.log(.warning, .system, "Stacks control socket unavailable: \(error.localizedDescription)")
    }
    Publishers.Merge4(
      supervisor.$states.map { _ in () },
      supervisor.$files.map { _ in () },
      supervisor.gitMonitor.$statuses.map { _ in () },
      $claims.map { _ in () }
    )
    .debounce(for: .milliseconds(300), scheduler: RunLoop.main)
    .sink { [weak self] _ in self?.writeState() }
    .store(in: &subscriptions)
    Timer.publish(every: 30, on: .main, in: .common).autoconnect()
      .sink { [weak self] _ in self?.pruneClaims() }
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

  // MARK: Claims

  func release(stack id: String) {
    claims[id] = nil
    saveClaims()
  }

  private func pruneClaims() {
    let expired = claims.filter { $0.value.isExpired }.map(\.key)
    guard !expired.isEmpty else { return }
    expired.forEach { claims[$0] = nil }
    saveClaims()
  }

  private func loadClaims() {
    guard let data = try? Data(contentsOf: claimsFile),
      let values = try? StackControlCoding.decoder().decode([StackClaim].self, from: data) else { return }
    claims = Dictionary(values.filter { !$0.isExpired }.map { ($0.stackID, $0) }, uniquingKeysWith: { $1 })
  }

  private func saveClaims() {
    do {
      try FileManager.default.createDirectory(at: claimsFile.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let data = try StackControlCoding.encoder(pretty: true).encode(Array(claims.values).sorted { $0.stackID < $1.stackID })
      try data.write(to: claimsFile, options: .atomic)
    } catch {
      DiagnosticLogger.shared.log(.warning, .system, "Could not save stack claims: \(error.localizedDescription)")
    }
  }

  /// Throws when another agent holds an unexpired claim and `force` is false.
  func checkClaim(_ id: String, actor: StackActor, force: Bool) throws {
    guard let claim = claims[id], !claim.isExpired, claim.holder.key != actor.key, !force else { return }
    let name = supervisor.definition(id)?.name ?? id
    let until = DateFormatter.localizedString(from: claim.expiresAt, dateStyle: .none, timeStyle: .short)
    let note: String = claim.note.map { " (\"" + $0 + "\")" } ?? ""
    throw StackControlError(code: "claimed",
      message: "\(name) is claimed by \(claim.holder.label)\(note) until \(until). Coordinate with that agent or the user, or pass force=true to override.")
  }

  // MARK: Snapshots

  func snapshot(appRunning: Bool = true) -> StacksSnapshot {
    StacksSnapshot(updatedAt: Date(), appRunning: appRunning, appPID: getpid(),
      socket: StackControlPaths.socket.path,
      stacksDirectory: StackDefinitionLoader.directory().path,
      logsDirectory: supervisor.logDirectory.path,
      stacks: supervisor.files.map { stackSnapshot($0) })
  }

  func stackSnapshot(_ file: StackDefinitionFile) -> StackSnapshot {
    let state = supervisor.states[file.id] ?? .init()
    var services = file.definition?.services ?? []
    for runtime in state.services.values {
      if let service = runtime.launchDefinition?.service, !services.contains(where: { $0.id == service.id }) { services.append(service) }
    }
    let repos = file.definition?.repos ?? []
    return StackSnapshot(
      id: file.id, name: file.name, file: file.file.path, state: state.label, operation: state.operation,
      definitionChanged: supervisor.definitionChanged(file.id),
      issues: file.issues.map { "\($0.severity.rawValue): \($0.message)" },
      claim: claims[file.id].flatMap { $0.isExpired ? nil : $0 },
      services: services.map { service in
        let runtime = state.services[service.id] ?? .init()
        let port = service.port ?? { if case .port(let port) = service.readiness { return port }; return nil }()
        let repo = service.repo.flatMap { id in (runtime.launchDefinition?.stack ?? file.definition)?.repo(id) }
        return StackServiceSnapshot(
          name: service.id, phase: runtime.phase.rawValue, status: runtime.phase.label,
          ready: runtime.phase == .ready, pid: runtime.process?.pid, pgid: runtime.process?.pgid,
          port: port, url: port.map { "http://localhost:\($0)" }, startedAt: runtime.startedAt,
          restarts: runtime.restartCount, detail: runtime.detail, owner: runtime.owner,
          repo: service.repo, branch: repo.flatMap { supervisor.gitMonitor.statuses[$0.path]?.branchLabel },
          cwd: service.directory.path, command: service.command, dependsOn: service.dependencies,
          autostart: service.autostart, logFile: supervisor.logURL(stack: file.id, service: service.id).path)
      },
      repos: repos.map { repo in
        let status = supervisor.gitMonitor.statuses[repo.path] ?? GitRepoStatus(branch: "Loading…")
        return StackRepoSnapshot(id: repo.id, path: repo.path.path, branch: status.branchLabel, dirty: status.isDirty,
          changedFiles: status.changedFiles, ahead: status.ahead, behind: status.behind, upstream: status.upstream,
          operation: status.operation, error: status.error)
      }, lane: file.lane)
  }

  private func writeState(appRunning: Bool = true) {
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

  func handle(_ method: String, params: JSONValue, actor: StackActor) async throws -> JSONValue {
    if method.hasPrefix("workspace.") { return try await handleWorkspace(method, params: params, actor: actor) }
    if method.hasPrefix("prs.views.") { return try await prViews.handle(method, params: params) }
    if method.hasPrefix("repro.") { return try await handleRepro(method, params: params, actor: actor) }
    switch method {
    case "ping":
      return try JSONValue(encoding: [
        "ok": "true", "pid": String(getpid()),
        "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
        "socket": StackControlPaths.socket.path, "you": actor.label,
      ])
    case "snapshot", "stacks.list":
      return try JSONValue(encoding: snapshot())
    case "stack.get":
      let file = try stackFile(params)
      return try JSONValue(encoding: stackSnapshot(file))
    case "stack.start": return try await start(params, actor: actor)
    case "stack.stop": return try await stop(params, actor: actor)
    case "stack.restart": return try await restart(params, actor: actor)
    case "lane.list":
      let source = try params["stack"].map { _ in try stackFile(params) }
      let sourceID = source?.lane?.sourceStackID ?? source?.id
      let files = supervisor.files.filter { sourceID == nil || $0.id == sourceID || $0.lane?.sourceStackID == sourceID }
      return try JSONValue(encoding: files.map { stackSnapshot($0) })
    case "lane.create":
      let source = try stackFile(params)
      guard let branch = params["branch"]?.stringValue else { throw StackControlError.invalid("Pass a branch name for the new lane.") }
      try requireIdle(source)
      // Cloning a claimed source does not change it or use its service ports.
      let file = try await supervisor.createLane(stack: source.id, branch: branch, actor: actor)
      _ = try claim(.object(["stack": .string(file.id), "note": .string("Worktree lane " + branch)]), actor: actor)
      if params["start"]?.boolValue == false { return try JSONValue(encoding: ["stack": stackSnapshot(file)]) }
      let supervisor = supervisor
      let timedOut = await settle(file, params: params) { await supervisor.start(stack: file.id, actor: actor) }
      return await actionResult(file, timedOut: timedOut, waited: params["wait"]?.boolValue ?? true)
    case "lane.remove":
      let file = try stackFile(params)
      try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
      try await supervisor.removeLane(file.id, actor: actor)
      release(stack: file.id)
      return .object(["removed": .string(file.id)])
    case "logs": return try await logs(params)
    case "events":
      let file = try stackFile(params)
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
      let file = try stackFile(params)
      for repo in file.definition?.repos ?? [] { await supervisor.gitMonitor.refresh(repo.path) }
      return try JSONValue(encoding: stackSnapshot(file).repos)
    case "git.branches": return try await branches(params)
    case "git.switch": return try await switchBranch(params, actor: actor)
    case "git.fetch", "git.pull": return try await fetchOrPull(params, pull: method == "git.pull", actor: actor)
    case "claim": return try claim(params, actor: actor)
    case "release":
      let file = try stackFile(params)
      if let claim = claims[file.id], !claim.isExpired, claim.holder.key != actor.key, params["force"]?.boolValue != true {
        throw StackControlError(code: "claimed", message: "\(file.name) is claimed by \(claim.holder.label). Pass force=true to release someone else's claim.")
      }
      release(stack: file.id)
      return .object(["released": .string(file.id)])
    case "validate": return try validate(params)
    case "reload":
      await supervisor.reloadDefinitions()
      return try JSONValue(encoding: snapshot())
    case "paths":
      return .object([
        "socket": .string(StackControlPaths.socket.path), "state": .string(StackControlPaths.state.path),
        "stacksDirectory": .string(StackDefinitionLoader.directory().path), "logsDirectory": .string(supervisor.logDirectory.path),
        "template": .string(StackAgentGuide.template),
      ])
    default:
      throw StackControlError(code: "unknown_method", message: "Unknown method \(method)")
    }
  }

  // MARK: Stack actions

  func stackFile(_ params: JSONValue) throws -> StackDefinitionFile {
    guard let query = params["stack"]?.stringValue?.trimmingCharacters(in: .whitespaces), !query.isEmpty else {
      if supervisor.files.count == 1, let only = supervisor.files.first { return only }
      throw StackControlError.invalid("Pass stack (id or name). Stacks: " + supervisor.files.map(\.id).joined(separator: ", "))
    }
    let files = supervisor.files
    if let exact = files.first(where: { $0.id == query }) { return exact }
    if let lane = files.first(where: { $0.lane?.reference == query }) { return lane }
    if let named = files.first(where: { $0.name.caseInsensitiveCompare(query) == .orderedSame || $0.id.caseInsensitiveCompare(query) == .orderedSame }) { return named }
    let prefixed = files.filter { $0.id.lowercased().hasPrefix(query.lowercased()) || $0.name.lowercased().hasPrefix(query.lowercased()) }
    if prefixed.count == 1 { return prefixed[0] }
    throw StackControlError.notFound("No stack matches \"\(query)\". Stacks: " + files.map(\.id).joined(separator: ", "))
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
    var object: [String: JSONValue] = ["stack": (try? JSONValue(encoding: snapshot)) ?? .null]
    object["timedOut"] = .bool(timedOut)
    if !waited { object["note"] = .string("Returned without waiting. Poll stack.get or pass wait=true.") }
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
    let file = try stackFile(params)
    guard file.definition != nil else {
      throw StackControlError(code: "invalid_definition", message: "\(file.name) has errors: " + file.issues.map(\.message).joined(separator: "; "))
    }
    try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
    try requireIdle(file)
    let selected = try services(params, in: file)
    let supervisor = supervisor
    let timedOut = await settle(file, params: params) { await supervisor.start(stack: file.id, services: selected, actor: actor) }
    return await actionResult(file, timedOut: timedOut, waited: params["wait"]?.boolValue ?? true)
  }

  private func stop(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let file = try stackFile(params)
    try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
    let selected = try services(params, in: file)
    let supervisor = supervisor
    let timedOut = await settle(file, params: params) { await supervisor.stop(stack: file.id, services: selected, actor: actor) }
    return await actionResult(file, timedOut: timedOut, waited: params["wait"]?.boolValue ?? true)
  }

  private func restart(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let file = try stackFile(params)
    guard file.definition != nil else {
      throw StackControlError(code: "invalid_definition", message: "\(file.name) has errors: " + file.issues.map(\.message).joined(separator: "; "))
    }
    try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
    try requireIdle(file)
    let selected = try services(params, in: file)
    guard selected == nil || selected!.count == 1 else { throw StackControlError.invalid("Restart one service at a time, or omit service to restart the stack") }
    let dependents = params["dependents"]?.boolValue ?? false
    let supervisor = supervisor
    let timedOut = await settle(file, params: params) {
      await supervisor.restart(stack: file.id, service: selected?.first, includeDependents: dependents, actor: actor)
    }
    return await actionResult(file, timedOut: timedOut, waited: params["wait"]?.boolValue ?? true)
  }

  // MARK: Logs

  private func recentLines(stack: String, service: String?, limit: Int) async -> [StackLogLine] {
    let buffered = await supervisor.logLines(stack: stack, service: service)
    if !buffered.isEmpty { return Array(buffered.suffix(limit)) }
    // Nothing buffered this session: read the files services write to.
    let names = service.map { [$0] } ?? (supervisor.definition(stack)?.services.map(\.id) ?? [])
    var lines: [StackLogLine] = []
    for name in names {
      let url = supervisor.logURL(stack: stack, service: name)
      let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date.distantPast
      lines += Self.tail(url, maxLines: limit).map { StackLogLine(service: name, text: $0, timestamp: date) }
    }
    return Array(lines.suffix(limit))
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
    let file = try stackFile(params)
    let service = try services(params, in: file, key: "service")?.first
    let limit = min(max(params["lines"]?.intValue ?? 200, 1), 5000)
    let after = params["after"]?.doubleValue
    var lines = await recentLines(stack: file.id, service: service, limit: after == nil && params["grep"] == nil ? limit : 5000)
    if let after { lines = lines.filter { $0.timestamp.timeIntervalSince1970 > after } }
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
      "stack": .string(file.id),
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
      throw StackControlError(code: "managed", message: "Port \(port) belongs to \(managed.stackName)/\(managed.service). Use stack.stop instead.")
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
    let file = try stackFile(params)
    guard let stack = file.definition else { throw StackControlError(code: "invalid_definition", message: "\(file.name) has errors") }
    var result: [String: JSONValue] = [:]
    for repo in try repos(params, in: stack) {
      let git = supervisor.gitMonitor.git
      let branches = try await git.branches(at: repo.path)
      let current = try? await git.status(at: repo.path)
      result[repo.id] = .object([
        "current": .string(current?.branchLabel ?? ""),
        "recent": .array(((try? await git.recentBranches(at: repo.path)) ?? []).map(JSONValue.string)),
        "local": .array(branches.filter { !$0.isRemote }.map { .string($0.name) }),
        "remote": .array(branches.filter(\.isRemote).map { .string($0.displayName) }),
      ])
    }
    return .object(result)
  }

  private func switchBranch(_ params: JSONValue, actor: StackActor) async throws -> JSONValue {
    let file = try stackFile(params)
    guard let stack = file.definition else { throw StackControlError(code: "invalid_definition", message: "\(file.name) has errors") }
    guard let target = params["branch"]?.stringValue?.trimmingCharacters(in: .whitespaces), !target.isEmpty else {
      throw StackControlError.invalid("Pass branch")
    }
    try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
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
      "stack": (try? JSONValue(encoding: stackSnapshot(refreshed))) ?? .null,
    ])
  }

  private func fetchOrPull(_ params: JSONValue, pull: Bool, actor: StackActor) async throws -> JSONValue {
    let file = try stackFile(params)
    guard let stack = file.definition else { throw StackControlError(code: "invalid_definition", message: "\(file.name) has errors") }
    let git = supervisor.gitMonitor.git
    var done: [String] = []
    if pull { try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true); try requireIdle(file) }
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

  // MARK: Claims and definitions

  private func claim(_ params: JSONValue, actor: StackActor) throws -> JSONValue {
    let file = try stackFile(params)
    try checkClaim(file.id, actor: actor, force: params["force"]?.boolValue == true)
    let minutes = min(max(params["ttlMinutes"]?.doubleValue ?? params["ttl"]?.doubleValue ?? 30, 1), 480)
    let existing = claims[file.id].flatMap { $0.holder.key == actor.key && !$0.isExpired ? $0 : nil }
    let claim = StackClaim(stackID: file.id, holder: actor, note: params["note"]?.stringValue.map { String($0.prefix(140)) } ?? existing?.note,
      since: existing?.since ?? Date(), expiresAt: Date().addingTimeInterval(minutes * 60))
    claims[file.id] = claim
    saveClaims()
    return try JSONValue(encoding: claim)
  }

  private func validate(_ params: JSONValue) throws -> JSONValue {
    let source: String
    let url: URL
    if let text = params["source"]?.stringValue {
      source = text
      url = StackDefinitionLoader.directory().appendingPathComponent((params["id"]?.stringValue ?? "untitled") + ".toml")
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
      result["repos"] = .array(definition.repos.map { .string($0.id) })
      result["startOrder"] = .array(((try? definition.dependencyLayers()) ?? []).map { .array($0.map(JSONValue.string)) })
    }
    return .object(result)
  }
}

private final class StackCompletionFlag {
  var done = false
}
