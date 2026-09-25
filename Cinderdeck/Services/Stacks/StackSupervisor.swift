import Combine
import Foundation

@MainActor
final class StackSupervisor: ObservableObject {
  static let shared = StackSupervisor(store: (try? DatabaseManager.shared().dbPool).map { StackRunStore(pool: $0) })
  @Published private(set) var files: [StackDefinitionFile] = []
  @Published private(set) var states: [StackID: StackRuntimeState] = [:]
  @Published private(set) var errorMessage: String?
  @Published private(set) var isBootstrapping = false
  let gitMonitor: GitStatusMonitor
  private let store: StackRunStore?
  private let defaults: UserDefaults
  private let secrets: any StackSecretsStoring
  private let makeProcess: @Sendable () -> any ProcessLaunching
  private let environment: @Sendable (String) async throws -> [String: String]
  private let inspectPort: @Sendable (Int) async throws -> StackPortConflict?
  private let probe: @Sendable (StackReadiness, Date, LogBuffer?) async -> Bool
  private let loadFiles: @Sendable (URL) async throws -> [StackDefinitionFile]
  private let logRoot: URL
  private var watcher: StackDefinitionWatcher?
  private var watchedDirectory: URL?
  private var bootstrapped = false
  private var epochs: [String: Int] = [:]
  private var processes: [String: any ProcessLaunching] = [:]
  private var logs: [String: LogBuffer] = [:]
  private var launchTasks: [String: Task<Void, Never>] = [:]
  private var readinessTasks: [String: Task<Void, Never>] = [:]
  private var exitTasks: [String: Task<Void, Never>] = [:]
  private var restartTasks: [String: Task<Void, Never>] = [:]
  private var restartPolicies: [String: StackRestartPolicy] = [:]
  private var stopping = Set<String>()
  private var subscriptions = Set<AnyCancellable>()
  private var reloadGeneration = 0
  private var reloadTask: Task<Void, Never>?
  var activeWorkspaceRun: ((String) -> Bool)?
  /// Called before a service's log buffer is replaced by a relaunch, so a repro
  /// capture can read the final lines of the previous process.
  var logBufferRetiring: ((_ stack: String, _ service: String, _ buffer: LogBuffer) -> Void)?
  /// Lane creation and removal queue here instead of failing while another runs.
  private let laneLock = StackAsyncLock()
  private var removingLanes = Set<String>()
  @Published private(set) var laneGitStates: [String: StackLaneGitState] = [:]

  init(store: StackRunStore?, defaults: UserDefaults = .standard, secrets: any StackSecretsStoring = StackSecretsStore(),
    git: GitService = .shared, logRoot: URL? = nil,
    makeProcess: @escaping @Sendable () -> any ProcessLaunching = { ServiceProcess() },
    environment: @escaping @Sendable (String) async throws -> [String: String] = { try await ShellEnvironmentResolver.shared.resolve(shell: $0) },
    inspectPort: @escaping @Sendable (Int) async throws -> StackPortConflict? = { try await PortInspector.conflict(on: $0) },
    probe: @escaping @Sendable (StackReadiness, Date, LogBuffer?) async -> Bool = { await ReadinessProbe.check($0, startedAt: $1, log: $2) },
    loadFiles: @escaping @Sendable (URL) async throws -> [StackDefinitionFile] = { directory in
      try await Task.detached { try StackWorkspaceResolver.load(directory) }.value
    }
  ) {
    self.store = store; self.defaults = defaults; self.secrets = secrets
    self.makeProcess = makeProcess; self.environment = environment; self.inspectPort = inspectPort; self.probe = probe
    self.loadFiles = loadFiles
    self.gitMonitor = GitStatusMonitor(git: git)
    #if DEBUG
    self.logRoot = logRoot ?? StackPreviewHarness.root?.appendingPathComponent("Logs") ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Cinderdeck/Stacks")
    #else
    self.logRoot = logRoot ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Cinderdeck/Stacks")
    #endif
  }

  var runningCount: Int { states.values.filter(\.isActive).count }
  var hasRunningServices: Bool { states.values.contains(where: \.isActive) || !restartTasks.isEmpty || !launchTasks.isEmpty }
  func definition(_ id: String) -> StackDefinition? { files.first { $0.id == id }?.definition }
  func runtime(_ id: String, _ service: String) -> StackServiceRuntime { states[id]?.services[service] ?? .init() }
  func definitionChanged(_ id: String) -> Bool {
    states[id]?.services.values.contains { $0.launchDefinition.map { $0.stack != definition(id) } ?? false } ?? false
  }
  private func key(_ id: String, _ service: String) -> String { "\(id)/\(service)" }
  var logDirectory: URL { logRoot }
  func logURL(stack id: String, service: String) -> URL {
    logRoot.appendingPathComponent(id).appendingPathComponent(service + ".log")
  }
  private func change(_ id: String, _ service: String, _ body: (inout StackServiceRuntime) -> Void) {
    var state = states[id] ?? .init()
    var runtime = state.services[service] ?? .init()
    body(&runtime); state.services[service] = runtime; states[id] = state
  }

  func bootstrap() async {
    guard !bootstrapped else { return }
    bootstrapped = true; isBootstrapping = true
    defer { isBootstrapping = false }
    await reloadDefinitions()
    do {
      for record in try await store?.records() ?? [] {
        guard record.identity.matchesLiveProcess else {
          try await store?.delete(stack: record.stackID, service: record.serviceName); continue
        }
        do {
        let launch = record.definition
        let process = makeProcess()
        try await process.reattach(record.identity)
        let id = record.stackID, service = record.serviceName, k = key(id, service)
        processes[k] = process
        let buffer = LogBuffer(service: service)
        do { try await buffer.follow(URL(fileURLWithPath: record.logPath), fromEnd: true) }
        catch { errorMessage = error.localizedDescription }
        logs[k] = buffer
        change(id, service) {
          $0.phase = launch == nil ? .unhealthy : .ready
          $0.process = record.identity; $0.startedAt = record.startedAt; $0.launchDefinition = launch
          $0.owner = record.owner
          if launch == nil { $0.detail = "Saved launch settings are damaged. Stop is available; restart uses the current definition." }
        }
        if !files.contains(where: { $0.id == id }) {
          files.append(.init(id: id, file: launch?.stack.file ?? StackDefinitionLoader.directory(defaults: defaults).appendingPathComponent(id + ".toml"), issues: [.init(severity: .warning,
            message: "Definition file was removed. Stop is still available for the running services.")]))
        }
        observeExit(id, service, process: process, identity: record.identity)
        if let launch { observeReadiness(id, service, launch: launch, identity: record.identity, started: record.startedAt, reattached: true) }
        } catch { errorMessage = "Could not reconnect to \(record.stackID)/\(record.serviceName): \(error.localizedDescription)" }
      }
    } catch { errorMessage = "Could not restore stack runs: \(error.localizedDescription)" }
    NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification).debounce(for: .milliseconds(250), scheduler: RunLoop.main)
      .sink { [weak self] _ in
        guard let self else { return }
        if StackDefinitionLoader.directory(defaults: defaults) != watchedDirectory { Task { await self.reloadDefinitions() } }
        gitMonitor.setAutoFetch(minutes: defaults.integer(forKey: PreferencesKeys.stacksAutoFetchMinutes))
      }.store(in: &subscriptions)
    Timer.publish(every: 3600, on: .main, in: .common).autoconnect().sink { [weak self] _ in
      Task { await self?.sweepEvents() }
    }.store(in: &subscriptions)
    await sweepEvents()
  }

  func reloadDefinitions() async {
    reloadGeneration += 1
    // Every caller waits for the latest requested snapshot. A watcher must not
    // make createLane return before its saved definition has been published.
    if let reloadTask { await reloadTask.value; return }
    let task = Task {
      defer { reloadTask = nil }
      while !Task.isCancelled {
        let generation = reloadGeneration
        await loadDefinitions(generation: generation)
        if generation == reloadGeneration { break }
      }
    }
    reloadTask = task
    await task.value
  }

  private func loadDefinitions(generation: Int) async {
    let directory = StackDefinitionLoader.directory(defaults: defaults)
    do {
      let loaded = try await loadFiles(directory)
      guard generation == reloadGeneration, !Task.isCancelled else { return }
      var updated = loaded
      for file in files where !loaded.contains(where: { $0.id == file.id }) && states[file.id]?.isActive == true {
        updated.append(.init(id: file.id, file: file.file, issues: [.init(severity: .warning,
          message: "Definition file was removed. Stop the running services before removing this stack.")]))
      }
      files = updated
      assignPendingLanePorts()
      for file in files {
        if states[file.id] == nil { states[file.id] = .init() }
        for service in file.definition?.services ?? [] where states[file.id]?.services[service.id] == nil {
          change(file.id, service.id) { $0 = .init() }
        }
      }
      errorMessage = nil
      if watchedDirectory != directory {
        watcher?.stop(); watchedDirectory = directory
        watcher = StackDefinitionWatcher(directory: directory) { [weak self] in Task { @MainActor in await self?.reloadDefinitions() } }
      }
      gitMonitor.configure(files.compactMap(\.definition).flatMap(\.repos))
      gitMonitor.setAutoFetch(minutes: defaults.integer(forKey: PreferencesKeys.stacksAutoFetchMinutes))
    } catch {
      if generation == reloadGeneration, !Task.isCancelled { errorMessage = "Cannot load stacks: \(error.localizedDescription)" }
    }
  }

  /// `actor` records who asked for the start. nil keeps the current owner
  /// (used for dependency wake-ups and automatic restarts).
  func start(stack id: String, services: Set<String>? = nil, actor: StackActor? = nil) async {
    guard !isBootstrapping, !removingLanes.contains(id), states[id]?.operation == nil, let definition = definition(id) else { return }
    states[id, default: .init()].operation = "Starting"
    states[id]?.error = nil
    let epoch = epochs[id, default: 0]
    defer {
      if epochs[id, default: 0] == epoch { states[id]?.operation = nil; wakeWaiting(id) }
    }
    let selected = services ?? Set(definition.services.filter(\.autostart).map(\.id))
    for service in selected { restartPolicies[key(id, service)] = nil }
    // Shared and other-workspace services start where they live, before dependents here wait on them.
    var linked: [String: Set<String>] = [:]
    for link in definition.serviceDependencies(selected).compactMap(definition.link) { linked[link.stack, default: []].insert(link.service) }
    for (stack, names) in linked.sorted(by: { $0.key < $1.key }) where stack != id {
      await start(stack: stack, services: names, actor: actor)
    }
    if let actor {
      for service in selected where definition.service(service) != nil && runtime(id, service).process == nil {
        change(id, service) { $0.owner = actor }
      }
    }
    await startServices(id, selected: selected, epoch: epoch)
  }

  private func startServices(_ id: String, selected: Set<String>, epoch: Int) async {
    guard let definition = definition(id) else { return }
    var pending = selected.filter { definition.service($0) != nil && !runtime(id, $0).phase.isActive && runtime(id, $0).process == nil }
    for service in pending { change(id, service) { $0.phase = .waiting; $0.detail = "Waiting for dependencies"; $0.conflict = nil } }
    while !pending.isEmpty, epochs[id, default: 0] == epoch, !Task.isCancelled {
      var progressed = false
      for service in pending.sorted() {
        guard runtime(id, service).phase == .waiting else { pending.remove(service); continue }
        guard let spec = definition.service(service) else { pending.remove(service); continue }
        if let failed = spec.dependencies.first(where: { dependencyRuntime(id, $0).phase == .crashed }) {
          change(id, service) { $0.phase = .crashed; $0.detail = "Dependency \(failed) failed to start" }
          pending.remove(service); progressed = true; continue
        }
        if spec.dependencies.allSatisfy({ dependencyRuntime(id, $0).phase.permitsDependents }) {
          pending.remove(service); progressed = true
          change(id, service) { $0.phase = .starting; $0.detail = nil }
          let launch = StackLaunchDefinition(stack: definition, service: spec)
          let k = key(id, service)
          launchTasks[k] = Task { [weak self] in
            guard let self else { return }
            await self.launch(launch, epoch: epoch)
          }
        }
      }
      // A disabled/stopped dependency remains explicitly Waiting; manual Start of
      // that dependency calls wakeWaiting after readiness, without blocking the UI.
      let inflight = states[id]?.services.values.contains { $0.phase == .starting } ?? false
      if !progressed && !inflight { break }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    while selected.contains(where: { runtime(id, $0).phase == .starting }), epochs[id, default: 0] == epoch, !Task.isCancelled {
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
  }

  private func launch(_ launch: StackLaunchDefinition, epoch: Int) async {
    let id = launch.stack.id, service = launch.service.id, k = key(id, service)
    defer { launchTasks[k] = nil }
    func current() -> Bool { epochs[id, default: 0] == epoch && !Task.isCancelled && !stopping.contains(k) }
    do {
      let shellEnvironment = try await environment(launch.stack.shell)
      guard current() else { return }
      var values: [String: String] = [:]
      for (variable, name) in launch.stack.secrets { values[variable] = try secrets.read(name) }
      if let port = launch.service.port, let conflict = try await inspectPort(port) {
        guard current() else { return }
        change(id, service) { $0.phase = .crashed; $0.conflict = conflict; $0.detail = conflict.description }
        return
      }
      guard current() else { return }
      let process = makeProcess()
      let url = logRoot.appendingPathComponent(id).appendingPathComponent(service + ".log")
      let identity = try await process.launch(launch, environment: launch.environment(shell: shellEnvironment, secrets: values), logURL: url)
      if !current() { try await process.stop(signal: launch.service.stopSignal, timeout: launch.service.stopTimeout); return }
      let started = Date()
      do {
        guard let store else { throw StackError.message("Run database is unavailable; service was stopped") }
        try await store.save(StackRunRecord(definition: launch, process: identity, logURL: url, startedAt: started,
          owner: runtime(id, service).owner))
      } catch { try? await process.stop(signal: SIGTERM, timeout: 1); throw error }
      processes[k] = process
      let pattern: String? = if case .log(let pattern) = launch.service.readiness { pattern } else { nil }
      let buffer = LogBuffer(service: service, readinessPattern: pattern)
      do { try await buffer.follow(url, fromEnd: false) }
      catch {
        try? await process.stop(signal: SIGTERM, timeout: 1)
        processes[k] = nil
        try? await store?.delete(stack: id, service: service)
        throw error
      }
      if let previous = logs[k] { logBufferRetiring?(id, service, previous) }
      await logs[k]?.close(); logs[k] = buffer
      change(id, service) { $0.process = identity; $0.startedAt = started; $0.launchDefinition = launch; $0.conflict = nil; $0.bindWarning = nil }
      if !current() { return } // Stop is waiting on this launch and will own cleanup.
      await event(id, service, "started", actor: runtime(id, service).owner)
      observeExit(id, service, process: process, identity: identity)
      observeReadiness(id, service, launch: launch, identity: identity, started: started)
    } catch {
      if current() { change(id, service) { $0.phase = .crashed; $0.detail = error.localizedDescription } }
    }
  }

  private func observeReadiness(_ id: String, _ service: String, launch: StackLaunchDefinition,
    identity: StackProcessIdentity, started: Date, reattached: Bool = false) {
    let k = key(id, service)
    readinessTasks[k]?.cancel()
    readinessTasks[k] = Task { [weak self] in
      guard let self else { return }
      let deadline = (reattached ? Date() : started).addingTimeInterval(launch.service.readyTimeout)
      var reachedReadiness = reattached
      while !Task.isCancelled, runtime(id, service).process == identity, !stopping.contains(k) {
        let ready = reachedReadiness && { if case .log = launch.service.readiness { return true }; return false }()
          ? true : await probe(launch.service.readiness, started, logs[k])
        guard !Task.isCancelled, runtime(id, service).process == identity else { return }
        if ready {
          if runtime(id, service).phase != .ready {
            change(id, service) { $0.phase = .ready; $0.detail = nil }
            await event(id, service, "ready")
            wakeWaiting(id)
            wakeLinked(id, service)
            verifyBinding(id, service, launch: launch, identity: identity)
          }
          reachedReadiness = true
        } else if Date() >= deadline || reachedReadiness {
          if runtime(id, service).phase != .unhealthy {
            change(id, service) { $0.phase = .unhealthy; $0.detail = "Readiness check is failing; dependents may start" }
            wakeWaiting(id)
            wakeLinked(id, service)
            verifyBinding(id, service, launch: launch, identity: identity)
          }
        }
        // Probe quickly while starting. Afterwards this is a health check for the
        // life of the service; at 2 Hz per service, many running workspaces add up.
        try? await Task.sleep(nanoseconds: reachedReadiness ? 2_000_000_000 : 500_000_000)
      }
    }
  }

  private func wakeWaiting(_ id: String) {
    guard states[id]?.operation == nil else { return }
    let waiting = Set(states[id]?.services.filter {
      $0.value.phase == .waiting && definition(id)?.service($0.key)?.dependencies.allSatisfy {
        dependencyRuntime(id, $0).phase.permitsDependents
      } == true
    }.keys.map { $0 } ?? [])
    guard !waiting.isEmpty else { return }
    // Requeue without treating Waiting as an already-running process.
    for service in waiting { change(id, service) { $0.phase = .stopped } }
    Task { await start(stack: id, services: waiting) }
  }

  private func observeExit(_ id: String, _ service: String, process: any ProcessLaunching, identity: StackProcessIdentity) {
    let k = key(id, service)
    exitTasks[k] = Task { [weak self] in
      let result = await process.waitForExit()
      guard !Task.isCancelled else { return }
      await self?.exited(id, service, identity: identity, result: result)
    }
  }

  private func exited(_ id: String, _ service: String, identity: StackProcessIdentity, result: StackProcessExit) async {
    let k = key(id, service)
    guard !stopping.contains(k), runtime(id, service).process == identity else { return }
    readinessTasks.removeValue(forKey: k)?.cancel()
    let old = runtime(id, service)
    let failed = result.failed || old.phase == .starting
    do { try await processes[k]?.stop(signal: SIGTERM, timeout: 1) }
    catch { change(id, service) { $0.phase = .crashed; $0.detail = error.localizedDescription }; return }
    processes[k] = nil
    do { try await store?.delete(stack: id, service: service) } catch { errorMessage = error.localizedDescription }
    change(id, service) {
      $0.phase = failed ? .crashed : .stopped; $0.process = nil; $0.startedAt = nil
      if failed { $0.lastCrashedAt = Date() } else { $0.owner = nil }
      $0.detail = failed ? result.code.map { "Exited with status \($0)" } ?? "Reattached process exited (status unavailable)" : nil
      $0.launchDefinition = nil
    }
    await logs[k]?.readAvailable()
    await event(id, service, failed ? "crashed" : "stopped", detail: result.code.map(String.init))
    guard failed else { return }
    if old.launchDefinition?.service.restartOnFailure == true, let delay = restartPolicies[k, default: .init()].delay() {
      let epoch = epochs[id, default: 0]
      change(id, service) { $0.phase = .starting; $0.detail = "Restarting in \(Int(delay))s"; $0.restartCount += 1 }
      restartTasks[k] = Task { [weak self] in
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        guard let self, !Task.isCancelled, epochs[id, default: 0] == epoch,
          let stack = definition(id), let service = stack.service(service) else { return }
        defer { restartTasks[k] = nil }
        await launch(.init(stack: stack, service: service), epoch: epoch)
      }
    } else {
      if defaults.object(forKey: PreferencesKeys.stacksNotifyOnCrash) as? Bool ?? true {
        let lastLines = await logs[k]?.snapshot().suffix(5).map(\.text).joined(separator: "\n") ?? ""
        _ = await SystemNotificationService.shared.post(title: "\(definition(id)?.name ?? id): \(service) crashed",
          body: String(lastLines.prefix(600)), stackRestart: (id, service))
      }
    }
  }

  func stop(stack id: String, services: Set<String>? = nil, actor: StackActor? = nil) async {
    if states[id]?.operation == "Stopping" { return }
    // Cancelling one service must not invalidate sibling launches. The stopping
    // set protects it while startServices drops that service from its pending set.
    let ownsOperation = services == nil || states[id]?.operation == nil
    if services == nil { epochs[id, default: 0] += 1 }
    if ownsOperation { states[id, default: .init()].operation = "Stopping" }
    defer { if ownsOperation { states[id]?.operation = nil } }
    let selected = services ?? Set(states[id]?.services.keys.map { $0 } ?? [])
    await stopServices(id, selected: selected, actor: actor)
  }

  private func stopServices(_ id: String, selected: Set<String>, actor: StackActor? = nil) async {
    let activeDefinition = states[id]?.services.values.compactMap(\.launchDefinition).first?.stack ?? definition(id)
    let order = ((try? activeDefinition?.dependencyLayers()) ?? []).flatMap { $0 }.reversed()
    let ordered = Array(order).filter(selected.contains) + selected.subtracting(order).sorted()
    for service in ordered { stopping.insert(key(id, service)); change(id, service) { $0.phase = .stopping } }
    for service in ordered {
      let k = key(id, service)
      let retry = restartTasks.removeValue(forKey: k)
      retry?.cancel()
      await retry?.value
      launchTasks[k]?.cancel()
      await launchTasks[k]?.value
      readinessTasks.removeValue(forKey: k)?.cancel()
      exitTasks.removeValue(forKey: k)?.cancel()
      let spec = runtime(id, service).launchDefinition?.service ?? definition(id)?.service(service)
      do {
        try await processes[k]?.stop(signal: spec?.stopSignal ?? SIGTERM, timeout: spec?.stopTimeout ?? 10)
        processes[k] = nil
        try await store?.delete(stack: id, service: service)
        await logs[k]?.readAvailable()
        let wasRunning = runtime(id, service).process != nil || runtime(id, service).startedAt != nil
        change(id, service) { $0.phase = .stopped; $0.process = nil; $0.startedAt = nil; $0.launchDefinition = nil; $0.detail = nil; $0.owner = nil; $0.bindWarning = nil }
        if let port = spec?.port, let conflict = try await inspectPort(port) {
          change(id, service) { $0.conflict = conflict; $0.detail = "Still listening after stop. " + conflict.description }
        }
        if wasRunning || actor != nil { await event(id, service, "stopped", actor: actor) }
      } catch { change(id, service) { $0.phase = .crashed; $0.detail = error.localizedDescription }; states[id]?.error = error.localizedDescription }
      stopping.remove(k)
    }
  }

  func restart(stack id: String, service: String? = nil, includeDependents: Bool = false, actor: StackActor? = nil) async {
    guard !removingLanes.contains(id), states[id]?.operation == nil else { return }
    let selected = service.map { includeDependents ? definition(id)?.includingDependents(of: [$0]) ?? [$0] : [$0] }
    // Keep the original owner unless someone else asked for the restart.
    let owners = Dictionary(uniqueKeysWithValues: (states[id]?.services ?? [:]).compactMap { name, runtime in runtime.owner.map { (name, $0) } })
    await stop(stack: id, services: selected, actor: actor)
    guard !(selected ?? Set(states[id]?.services.keys.map { $0 } ?? [])).contains(where: { runtime(id, $0).process != nil }) else { return }
    await reloadDefinitions()
    if actor == nil { for (name, owner) in owners { change(id, name) { $0.owner = owner } } }
    await start(stack: id, services: selected, actor: actor)
  }

  func stopAll() async {
    for id in states.keys.sorted() { await stop(stack: id) }
  }

  // MARK: Worktree lanes

  var definitionsDirectory: URL { StackDefinitionLoader.directory(defaults: defaults) }
  /// Lane records: `<definitions>/.lanes/<id>/lane.json`.
  var lanesDirectory: URL { StackLaneStore.directory(for: definitionsDirectory) }
  /// Default folder for lane worktrees; `[lanes] dir` overrides it per workspace.
  var worktreeRoot: URL {
    if let path = defaults.string(forKey: PreferencesKeys.stacksLanesDirectory), !path.isEmpty {
      return URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true).standardizedFileURL
    }
    #if DEBUG
    if let root = StackPreviewHarness.root { return root.appendingPathComponent("lanes", isDirectory: true) }
    #endif
    return StackLaneStore.defaultWorktreeRoot
  }
  func isRemovingLane(_ id: String) -> Bool { removingLanes.contains(id) }
  var isLaneOperationRunning: Bool { laneLock.isLocked }

  /// The runtime a dependency refers to: a local service, or the linked service in its own workspace.
  func dependencyRuntime(_ id: String, _ name: String) -> StackServiceRuntime {
    if let link = definition(id)?.link(name) { return runtime(link.stack, link.service) }
    return runtime(id, name)
  }

  /// Workspaces (lanes, or others that depend on it) with running services that use `service` of `id`.
  func dependents(of id: String, services names: Set<String>? = nil) -> [String] {
    files.compactMap { file -> String? in
      guard file.id != id, let definition = file.definition, states[file.id]?.isActive == true else { return nil }
      let uses = definition.links.contains { $0.stack == id && (names?.contains($0.service) ?? true) }
      return uses ? file.id : nil
    }.sorted()
  }

  /// Everything a new lane must not take: configured ports, other lanes, and live launches.
  private func occupiedPorts() -> Set<Int> {
    let definitions = files.compactMap(\.definition) + states.values.flatMap { $0.services.values.compactMap { $0.launchDefinition?.stack } }
    var ports = Set<Int>()
    for definition in definitions {
      for service in definition.services {
        ports.formUnion(service.allPorts.values)
        if case .port(let port) = service.readiness { ports.insert(port) }
        if case .http(let url) = service.readiness, let port = url.port { ports.insert(port) }
      }
      for task in definition.tasks { ports.formUnion(task.allPorts.values) }
    }
    // Include interrupted lanes, whose worktrees may not currently be loadable.
    for record in (try? StackLaneStore.records(in: lanesDirectory)) ?? [] { ports.formUnion(record.info.ports.values) }
    return ports
  }

  /// Services added to a source after its lanes were created get ports on the next load.
  private func assignPendingLanePorts() {
    guard !laneLock.isLocked else { return }
    var changed = false
    for index in files.indices where !files[index].pendingLanePorts.isEmpty && !removingLanes.contains(files[index].id) {
      let file = files[index]
      do {
        let used = occupiedPorts()
        try StackLaneStore.update(id: file.id, in: lanesDirectory) { record in
          record.info.ports = try StackLaneStore.extend(record.info.ports, adding: file.pendingLanePorts, excluding: used)
        }
        changed = true
      } catch {
        files[index].issues.append(.init(severity: .error, message: "Could not assign ports to new services: \(error.localizedDescription)"))
      }
    }
    if changed { reloadGeneration += 1 }
  }

  struct LaneCreation {
    let file: StackDefinitionFile
    let warnings: [String]
  }

  /// Definition and lane metadata changes must not race worktree creation/removal.
  func withDefinitionLock<T>(workspace id: String, _ body: () throws -> T) async throws -> T {
    await laneLock.acquire()
    let affected: [String]
    let result: T
    do {
      affected = [id] + (try StackLaneStore.records(in: lanesDirectory)).filter { $0.info.sourceStackID == id }.map(\.id)
      result = try body()
    } catch { laneLock.release(); throw error }
    // Don't let a service or run start from the old in-memory definition while the file reloads.
    for id in affected { states[id, default: .init()].operation = "Updating definition" }
    laneLock.release()
    defer { for id in affected { states[id]?.operation = nil } }
    await reloadDefinitions()
    return result
  }

  func createLane(stack id: String, branch: String, actor: StackActor) async throws -> StackDefinitionFile {
    try await createLane(stack: id, request: .init(branch: branch), actor: actor).file
  }

  func createLane(stack id: String, request: StackLaneRequest, actor: StackActor) async throws -> LaneCreation {
    guard !isBootstrapping else { throw StackError.message("Cinderdeck is still reconnecting to running services. Try again in a moment.") }
    await laneLock.acquire()
    let creation: StackLaneStore.Creation
    do {
      guard states[id]?.operation == nil, let source = definition(id) else { throw StackError.message("This stack needs a valid definition and must finish its current operation") }
      creation = try await StackLaneStore.create(source: source, request: request, owner: actor,
        directory: lanesDirectory, worktreeRoot: worktreeRoot, occupiedPorts: occupiedPorts())
    } catch {
      laneLock.release()
      await reloadDefinitions()
      throw error
    }
    laneLock.release()
    await reloadDefinitions()
    guard let file = files.first(where: { $0.id == creation.record.id }), file.definition != nil else {
      let issues = files.first { $0.id == creation.record.id }?.issues.map(\.message).joined(separator: "; ") ?? ""
      throw StackError.message("Lane was saved but could not be loaded. \(issues)")
    }
    await event(file.id, nil, request.adoptPath == nil ? "laneCreated" : "laneAdopted", detail: file.lane?.name, actor: actor)
    return LaneCreation(file: file, warnings: creation.warnings)
  }

  /// Registers an existing worktree (for example one an agent created) as a lane. Cinderdeck never deletes it.
  func adoptLane(stack id: String, path: URL, name: String?, actor: StackActor) async throws -> LaneCreation {
    try await createLane(stack: id, request: .init(branch: name ?? "", adoptPath: path), actor: actor)
  }

  func removeLane(_ id: String, actor: StackActor) async throws {
    _ = try await removeLane(id, actor: actor, options: .init())
  }

  @discardableResult
  func removeLane(_ id: String, actor: StackActor, options: StackLaneRemovalOptions) async throws -> StackLaneRemovalReport {
    guard !isBootstrapping else { throw StackError.message("Cinderdeck is still reconnecting to running services. Try again in a moment.") }
    guard activeWorkspaceRun?(id) != true else { throw StackError.message("Wait for this lane's task or workflow to finish, or cancel its run before removing it.") }
    guard let record = try StackLaneStore.record(id: id, in: lanesDirectory) else {
      throw StackError.message("Select a worktree lane. The original checkout cannot be removed.")
    }
    guard states[id]?.operation == nil, !removingLanes.contains(id) else { throw StackError.message("Wait for this lane to finish its current operation.") }
    removingLanes.insert(id)
    defer { removingLanes.remove(id) }
    // Refuse before stopping anything when removal would lose work.
    _ = try await StackLaneStore.check(record, others: try StackLaneStore.records(in: lanesDirectory), options: options)
    await stop(stack: id, actor: actor)
    guard states[id]?.isActive != true else { throw StackError.message("Could not stop all lane services. Worktrees were kept.") }
    await laneLock.acquire()
    let report: StackLaneRemovalReport
    do {
      // Re-read under the lock: another workspace's lane may now share a worktree.
      report = try await StackLaneStore.remove(record, in: lanesDirectory, others: try StackLaneStore.records(in: lanesDirectory), options: options)
    } catch {
      laneLock.release()
      await reloadDefinitions()
      throw error
    }
    laneLock.release()
    await event(id, nil, options.keepWorktrees ? "laneReleased" : "laneRemoved", detail: record.info.name, actor: actor)
    for service in states[id]?.services.keys.map({ $0 }) ?? [] {
      let k = key(id, service)
      if let buffer = logs.removeValue(forKey: k) {
        logBufferRetiring?(id, service, buffer)
        await buffer.close()
      }
      launchTasks.removeValue(forKey: k)?.cancel()
      restartPolicies[k] = nil
    }
    if options.deleteLogs { try? FileManager.default.removeItem(at: logRoot.appendingPathComponent(id, isDirectory: true)) }
    states[id] = nil
    laneGitStates[id] = nil
    await reloadDefinitions()
    return report
  }

  /// Converts a lane saved before lanes followed their source into one that does.
  func unpinLane(_ id: String, actor: StackActor) async throws {
    guard let record = try StackLaneStore.record(id: id, in: lanesDirectory), record.info.pinned else {
      throw StackError.message("This lane already follows its source workspace.")
    }
    await laneLock.acquire()
    do {
      try StackLaneStore.update(id: id, in: lanesDirectory) { record in
        record.info.pinned = false
        record.definition = nil
        record.version = 2
      }
    } catch { laneLock.release(); throw error }
    laneLock.release()
    await event(id, nil, "laneUnpinned", detail: record.info.name, actor: actor)
    await reloadDefinitions()
  }

  /// Records a lane's setup progress durably and shows it immediately.
  func setLaneSetup(_ id: String, _ state: StackLaneSetupState?) {
    _ = try? StackLaneStore.update(id: id, in: lanesDirectory) { $0.setup = state }
    if let index = files.firstIndex(where: { $0.id == id }) { files[index].laneSetup = state }
  }

  /// Merged, upstream-deleted and unpushed state for every lane (or `ids`).
  func refreshLaneGitStates(_ ids: [String]? = nil) async {
    let records = ((try? StackLaneStore.records(in: lanesDirectory)) ?? []).filter { ids?.contains($0.id) ?? true }
    for record in records { laneGitStates[record.id] = await StackLaneStore.gitState(record) }
  }

  private func wakeLinked(_ stack: String, _ service: String) {
    for file in files where file.id != stack {
      if file.definition?.links.contains(where: { $0.stack == stack && $0.service == service }) == true { wakeWaiting(file.id) }
    }
  }

  /// A service that ignores its assigned port still binds something; say which.
  private func verifyBinding(_ id: String, _ service: String, launch: StackLaunchDefinition, identity: StackProcessIdentity) {
    let expected = Set(launch.service.allPorts.values)
    guard !expected.isEmpty else { return }
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: 1_500_000_000)
      let listening = await PortInspector.listeningPorts(processGroup: identity.pgid)
      guard let self, runtime(id, service).process == identity else { return }
      var warning: String?
      if !listening.isEmpty, listening.isDisjoint(with: expected) {
        let found = listening.sorted().map(String.init).joined(separator: ", ")
        let assigned = expected.sorted().map(String.init).joined(separator: ", ")
        warning = launch.stack.lane == nil
          ? "\(service) is listening on \(found), not its configured port \(assigned). Update port in the definition."
          : "\(service) is listening on \(found), not its assigned \(assigned). Its command ignores $PORT; use $PORT or {{port.\(service)}}."
      }
      if runtime(id, service).bindWarning != warning { change(id, service) { $0.bindWarning = warning } }
    }
  }

  /// Settle pending launches before quitting so every surviving child has a
  /// durable run record. Already running services keep their process groups.
  func prepareToLeaveRunning() async {
    for id in states.keys { epochs[id, default: 0] += 1 }
    let pending = Array(restartTasks.values) + Array(launchTasks.values)
    pending.forEach { $0.cancel() }
    for task in pending { await task.value }
    restartTasks.removeAll(); launchTasks.removeAll()
    for id in states.keys {
      states[id]?.operation = nil
      for (service, runtime) in states[id]?.services ?? [:] where runtime.process == nil && runtime.phase.isActive {
        change(id, service) { $0.phase = .stopped; $0.detail = nil }
      }
    }
    await shutdownMonitoring()
  }

  func performGitChange(stack id: String, repos: Set<String>, eventKind: String = "branchSwitched",
    eventDetail: String? = nil, actor: StackActor? = nil, action: () async throws -> Void) async throws {
    guard let stack = definition(id) else { throw StackError.message("This stack needs a valid definition") }
    let paths = Set(stack.repos.filter { repos.contains($0.id) }.map { $0.path.resolvingSymlinksInPath().standardizedFileURL.path })
    // A folder may be shared by several stacks, even under different repo names.
    var affected: [String: Set<String>] = [id: []]
    for file in files {
      if let definition = file.definition {
        let matching = Set(definition.repos.filter { paths.contains($0.path.resolvingSymlinksInPath().standardizedFileURL.path) }.map(\.id))
        if !matching.isEmpty { affected[file.id, default: []].formUnion(definition.affectedServices(repos: matching)) }
      }
      for (name, runtime) in states[file.id]?.services ?? [:] {
        if let launch = runtime.launchDefinition, let repoID = launch.service.repo, let repo = launch.stack.repo(repoID),
          paths.contains(repo.path.resolvingSymlinksInPath().standardizedFileURL.path) {
          affected[file.id, default: []].insert(name)
        }
      }
    }
    if affected.keys.contains(where: { activeWorkspaceRun?($0) == true }) {
      throw StackError.message("A task or workflow is using this repository. Finish or cancel that run before changing branches or pulling.")
    }
    var restart: [String: Set<String>] = [:]
    for (stackID, services) in affected {
      guard !removingLanes.contains(stackID), states[stackID]?.operation == nil,
        !services.contains(where: { [.starting, .stopping, .waiting].contains(runtime(stackID, $0).phase) }) else {
        throw StackError.message("Wait for services using this repo to finish starting or stopping")
      }
      let running = services.filter { runtime(stackID, $0).process != nil }
      guard running.isEmpty || definition(stackID) != nil else {
        throw StackError.message("Restore the definition for \(stackID) or stop its services before changing this repo")
      }
      restart[stackID] = definition(stackID)?.restartOnBranchChange == false ? [] : running
    }
    let operationEpochs = Dictionary(uniqueKeysWithValues: affected.keys.map { ($0, epochs[$0, default: 0]) })
    for stackID in affected.keys { states[stackID, default: .init()].operation = "Updating repos" }
    defer { for stackID in affected.keys { states[stackID]?.operation = nil; wakeWaiting(stackID) } }
    var failure: Error?
    // Services restarted around a checkout keep whoever started them.
    var owners: [String: [String: StackActor]] = [:]
    for (stackID, services) in restart {
      for service in services { if let owner = runtime(stackID, service).owner { owners[stackID, default: [:]][service] = owner } }
    }
    for stackID in restart.keys.sorted() { await stopServices(stackID, selected: restart[stackID] ?? []) }
    if restart.contains(where: { stackID, services in services.contains { runtime(stackID, $0).process != nil } }) {
      failure = StackError.message("Could not stop all affected services; repo was not changed")
    } else {
      do {
        try await action()
        for stackID in affected.keys { await event(stackID, nil, eventKind, detail: eventDetail, actor: actor) }
      } catch {
        failure = error
        await event(id, nil, "repoChangeFailed", detail: error.localizedDescription)
      }
    }
    for (stackID, epoch) in operationEpochs where epochs[stackID, default: 0] == epoch {
      let stopped = (restart[stackID] ?? []).filter { runtime(stackID, $0).process == nil }
      for service in stopped { if let owner = owners[stackID]?[service] { change(stackID, service) { $0.owner = owner } } }
      await startServices(stackID, selected: stopped, epoch: epoch)
    }
    if let failure { throw failure }
  }

  func killPortOwner(stack id: String, service: String, startAfter: Bool) async throws {
    guard let conflict = runtime(id, service).conflict else { return }
    try await PortInspector.terminate(conflict)
    change(id, service) { $0.conflict = nil; $0.detail = nil; if $0.process == nil { $0.phase = .stopped } }
    if startAfter { await start(stack: id, services: [service]) }
  }

  func dismissPortConflict(stack id: String, service: String) {
    change(id, service) { $0.conflict = nil; $0.detail = nil; if $0.process == nil { $0.phase = .stopped } }
  }

  /// Identifies the buffers behind `logLines` and how far each has changed, so
  /// pollers can skip copying and merging output that has not moved.
  func logRevision(stack id: String, service: String? = nil) async -> [LogBufferRevision] {
    var result: [LogBufferRevision] = []
    for name in states[id]?.services.keys.sorted() ?? [] where service == nil || service == name {
      if let buffer = logs[key(id, name)] { result.append(.init(buffer: ObjectIdentifier(buffer), revision: await buffer.revision())) }
    }
    return result
  }
  func logLines(stack id: String, service: String? = nil) async -> [StackLogLine] {
    var buffers: [[StackLogLine]] = []
    for name in states[id]?.services.keys.sorted() ?? [] where service == nil || service == name {
      if let buffer = logs[key(id, name)] { buffers.append(await buffer.snapshot()) }
    }
    return LogBuffer.merged(buffers)
  }
  /// Every service buffer that has output this session, for live followers.
  func logBuffers() -> [(stack: String, service: String, buffer: LogBuffer)] {
    logs.compactMap { key, buffer in
      let parts = key.split(separator: "/", maxSplits: 1).map(String.init)
      return parts.count == 2 ? (parts[0], parts[1], buffer) : nil
    }
  }
  func clearLogs(stack id: String, service: String?) async {
    for name in states[id]?.services.keys.sorted() ?? [] where service == nil || service == name { await logs[key(id, name)]?.clear() }
  }
  func events(stack id: String, limit: Int = 40) async -> [StackEventRecord] { (try? await store?.events(stack: id, limit: limit)) ?? [] }
  func recordEvent(stack id: String, service: String?, kind: String, detail: String? = nil, actor: StackActor? = nil) async {
    await event(id, service, kind, detail: detail, actor: actor)
  }
  private func event(_ id: String, _ service: String?, _ kind: String, detail: String? = nil, actor: StackActor? = nil) async {
    do { try await store?.event(.init(stackID: id, serviceName: service, kind: kind, detail: detail, actor: actor.map(\.label))) }
    catch { errorMessage = "Could not save stack activity: \(error.localizedDescription)" }
  }
  private func sweepEvents() async {
    do { try await store?.pruneEvents() } catch { errorMessage = error.localizedDescription }
    await sweepLaneLogs()
  }

  /// Logs of removed lanes are kept for a while for inspection, then deleted.
  func sweepLaneLogs(olderThan age: TimeInterval = 14 * 86400) async {
    let live = Set(files.map(\.id)).union(states.keys)
    let root = logRoot
    await Task.detached(priority: .utility) {
      let keys: [URLResourceKey] = [.contentModificationDateKey]
      let cutoff = Date().addingTimeInterval(-age)
      for folder in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: keys)) ?? []
      where folder.lastPathComponent.contains("--lane-") && !live.contains(folder.lastPathComponent) {
        let entries = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
        let newest = (entries + [folder]).compactMap { try? $0.resourceValues(forKeys: Set(keys)).contentModificationDate }.max() ?? .distantFuture
        if newest < cutoff { try? FileManager.default.removeItem(at: folder) }
      }
    }.value
  }

  /// Releases observers without signaling services. Used when leaving them running.
  func shutdownMonitoring() async {
    reloadTask?.cancel()
    await reloadTask?.value
    watcher?.stop(); watcher = nil; watchedDirectory = nil
    subscriptions.removeAll(); gitMonitor.stop()
    readinessTasks.values.forEach { $0.cancel() }; readinessTasks.removeAll()
    restartTasks.values.forEach { $0.cancel() }; restartTasks.removeAll()
    exitTasks.values.forEach { $0.cancel() }; exitTasks.removeAll()
    for buffer in logs.values { await buffer.close() }
  }
}

/// A first-in, first-out lock for async work on the main actor.
@MainActor
final class StackAsyncLock {
  private var locked = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  var isLocked: Bool { locked }
  func acquire() async {
    guard locked else { locked = true; return }
    await withCheckedContinuation { waiters.append($0) }
  }
  func release() {
    if waiters.isEmpty { locked = false } else { waiters.removeFirst().resume() }
  }
}
