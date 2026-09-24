import AVFoundation
import Combine
import Foundation

/// What the next screen recording should capture. Agents and the Workspaces
/// window set this before starting a recording; ordinary recordings use defaults.
struct ReproRequest: Sendable {
  var id = UUID()
  var title: String?
  var origin: ReproOrigin
  var actor: StackActor
  /// Only these workspaces. nil follows every workspace with output.
  var workspaces: Set<String>?
  var capture: String?
  var note: String?
  var requestedAt = Date()
}

/// Follows service and task output while the screen is recorded and turns it
/// into a repro: every line placed on the video timeline, plus lifecycle and
/// workflow markers and the Git and service state when recording started.
@MainActor
final class ReproRecorder: ObservableObject {
  static let shared = ReproRecorder(supervisor: .shared, runner: .shared, store: .shared,
    events: ScreenRecordingManager.shared.lifecycle.eraseToAnyPublisher())

  /// Progress of the repro being recorded, for the controls and Workspaces.
  struct Live: Equatable {
    var id: UUID
    var title: String
    var origin: ReproOrigin
    var actor: String
    var startedAt: Date
    var lines = 0
    var errors = 0
    var warnings = 0
    var sources = 0
    var markers = 0
    var lastError: String?
    var isPaused = false
    var isFinalizing = false
  }

  /// Output beyond this is counted but not stored.
  static let lineLimit = 250_000
  /// Output from just before recording is kept as context.
  static let preRoll: TimeInterval = 3

  @Published private(set) var live: Live?
  @Published private(set) var sessions: [ReproSession] = []
  @Published private(set) var lastError: String?

  let supervisor: StackSupervisor
  let runner: WorkspaceRunner
  let store: ReproStore
  private let defaults: UserDefaults
  private let secrets: any StackSecretsStoring
  private var subscriptions = Set<AnyCancellable>()
  private var started = false

  // Current recording
  private var session: ReproSession?
  private var request: ReproRequest?
  private var clock: ReproClock?
  private var writer: ReproLineWriter?
  private var redactor = ReproRedactor(secrets: [:])
  private var nextLineID = 1
  private var pending: [ReproLogLine] = []
  private var cursors: [ObjectIdentifier: Cursor] = [:]
  private var retired: [(source: ReproSource, buffer: LogBuffer)] = []
  private var phases: [String: StackServicePhase] = [:]
  private var runSteps: [UUID: [UUID: WorkspaceRunStatus]] = [:]
  private var runStatus: [UUID: WorkspaceRunStatus] = [:]
  private var capturedWorkspaces = Set<String>()
  private var contextTasks: [Task<Void, Never>] = []
  private var pollTask: Task<Void, Never>?
  private var stopRequested = false
  private var lastSave = Date.distantPast
  private var lastFirstFrame: Date?
  private var waiters: [UUID: [CheckedContinuation<ReproSession?, Never>]] = [:]
  private var lineCache: [UUID: [ReproLogLine]] = [:]
  private var lineCacheOrder: [UUID] = []

  private struct Cursor {
    let buffer: LogBuffer
    var revision: Int
    var lastID: UUID?
  }

  init(supervisor: StackSupervisor, runner: WorkspaceRunner, store: ReproStore,
    events: AnyPublisher<RecordingLifecycleEvent, Never>, defaults: UserDefaults = .standard,
    secrets: any StackSecretsStoring = StackSecretsStore()) {
    self.supervisor = supervisor; self.runner = runner; self.store = store
    self.defaults = defaults; self.secrets = secrets
    events.sink { [weak self] event in self?.handle(event) }.store(in: &subscriptions)
  }

  /// Loads the library and marks repros interrupted by a quit or crash.
  func start() {
    guard !started else { return }
    started = true
    var loaded = store.loadSessions()
    for index in loaded.indices where loaded[index].status.isActive {
      loaded[index].status = .failed
      loaded[index].detail = "Cinderdeck closed while this was recording. Captured output was kept."
      try? store.save(loaded[index])
    }
    sessions = loaded
    supervisor.logBufferRetiring = { [weak self] stack, service, buffer in
      guard let self, self.session != nil, self.inScope(stack) else { return }
      self.retired.append((self.serviceSource(stack, service), buffer))
    }
    runner.stepOutputFinishing = { [weak self] runID, stepID, buffer in
      guard let self, self.session != nil, let run = self.runner.run(runID), self.inScope(run.workspaceID),
        let step = run.steps.first(where: { $0.id == stepID }) else { return }
      self.retired.append((self.taskSource(run, step), buffer))
    }
    supervisor.$states.sink { [weak self] states in self?.observe(states) }.store(in: &subscriptions)
    runner.$runs.sink { [weak self] runs in self?.observe(runs) }.store(in: &subscriptions)
  }

  var isCapturing: Bool { session != nil }
  var activeSessionID: UUID? { session?.id }
  var isEnabled: Bool { defaults.object(forKey: PreferencesKeys.reproCaptureLogs) as? Bool ?? true }

  /// The next recording that starts within a minute becomes this repro.
  func expect(_ request: ReproRequest) { self.request = request }
  func clearExpectation(_ id: UUID) { if request?.id == id { request = nil } }

  // MARK: Recording lifecycle

  private func handle(_ event: RecordingLifecycleEvent) {
    switch event {
    case .started(let date): begin(at: date)
    case .firstFrame(let date):
      lastFirstFrame = date
      clock?.firstFrame(at: date)
    case .paused(let date):
      clock?.pause(at: date); live?.isPaused = true
    case .resumed(let date):
      clock?.resume(at: date); live?.isPaused = false
    case .stopping(let date):
      guard session != nil else { return }
      stopRequested = true
      clock?.stop(at: date)
      live?.isFinalizing = true
    case .finished(let url):
      guard session != nil else { return }
      Task { await finalize(video: url) }
    case .cancelled:
      // Either the recording was deleted, or stopping produced no video.
      guard session != nil else { return }
      Task { await discard() }
    }
  }

  private func begin(at date: Date) {
    let expected = request.flatMap { date.timeIntervalSince($0.requestedAt) < 60 ? $0 : nil }
    request = nil
    guard session == nil, expected != nil || isEnabled else { return }
    let incoming = expected ?? ReproRequest(origin: .recording, actor: .user)
    var clock = ReproClock(start: date)
    if let lastFirstFrame, abs(lastFirstFrame.timeIntervalSince(date)) < 10 { clock.firstFrame(at: lastFirstFrame) }
    var session = ReproSession(id: incoming.id, title: incoming.title ?? "", origin: incoming.origin, createdAt: date, actor: incoming.actor)
    session.capture = incoming.capture
    do {
      try store.prepare(session.id)
      try store.save(session)
      writer = try ReproLineWriter(url: store.linesURL(session.id))
    } catch {
      lastError = "Could not start repro capture: \(error.localizedDescription)"
      return
    }
    self.session = session
    self.clock = clock
    expectedRequest = incoming
    stopRequested = false
    nextLineID = 1; pending = []; retired = []; cursors = [:]; capturedWorkspaces = []; contextTasks = []
    live = Live(id: session.id, title: displayTitle(session), origin: session.origin, actor: session.actor.label, startedAt: date)

    // Only state changes during the recording become markers.
    phases = [:]
    for (stack, state) in supervisor.states { for (service, runtime) in state.services { phases["\(stack)/\(service)"] = runtime.phase } }
    runSteps = [:]; runStatus = [:]
    for run in runner.runs where run.status.isActive && inScope(run.workspaceID) { track(run, at: date, alreadyRunning: true) }

    var secretValues: [String: String] = [:]
    for file in supervisor.files {
      guard let definition = file.definition, inScope(file.id), supervisor.states[file.id]?.isActive == true
        || runner.activeRun(file.id) != nil || incoming.workspaces != nil else { continue }
      captureContext(file.id)
      for (variable, name) in definition.secrets { if let value = try? secrets.read(name) { secretValues[variable] = value } }
    }
    redactor = ReproRedactor(secrets: secretValues)
    if let note = incoming.note, !note.isEmpty { _ = try? addMarker(label: note, kind: .note, by: incoming.actor.label) }

    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.poll()
        try? await Task.sleep(nanoseconds: 200_000_000)
      }
    }
  }
  private var expectedRequest: ReproRequest?

  private func inScope(_ workspace: String) -> Bool {
    guard let scope = expectedRequest?.workspaces else { return true }
    return scope.contains(workspace)
  }

  // MARK: Following output

  private func serviceSource(_ stack: String, _ service: String) -> ReproSource {
    ReproSource(id: "\(stack)/\(service)", kind: .service, workspace: stack,
      workspaceName: supervisor.definition(stack)?.name ?? stack, name: service)
  }
  private func taskSource(_ run: WorkspaceRun, _ step: WorkspaceRunStep) -> ReproSource {
    ReproSource(id: "run/\(run.id.uuidString)/\(step.id.uuidString)", kind: .task, workspace: run.workspaceID,
      workspaceName: run.workspaceName, name: step.title)
  }

  private var isPolling = false
  private func poll() async {
    guard session != nil, !isPolling else { return }
    isPolling = true
    defer { isPolling = false }
    for entry in supervisor.logBuffers() where inScope(entry.stack) {
      await drain(entry.buffer, source: serviceSource(entry.stack, entry.service))
    }
    for entry in runner.liveStepBuffers() where inScope(entry.run.workspaceID) {
      await drain(entry.buffer, source: taskSource(entry.run, entry.step))
    }
    while !retired.isEmpty {
      let entry = retired.removeFirst()
      await drain(entry.buffer, source: entry.source)
      cursors[ObjectIdentifier(entry.buffer)] = nil
    }
    flush()
  }

  private func drain(_ buffer: LogBuffer, source: ReproSource) async {
    guard let clock, let start = session?.createdAt else { return }
    let key = ObjectIdentifier(buffer)
    let revision = await buffer.revision()
    if let cursor = cursors[key], cursor.revision == revision { return }
    let lines = await buffer.snapshot()
    let cutoff = start.addingTimeInterval(-Self.preRoll)
    var fresh: [StackLogLine] = []
    for line in lines.reversed() {
      if let last = cursors[key]?.lastID, line.id == last { break }
      if line.timestamp < cutoff { break }
      fresh.append(line)
    }
    cursors[key] = Cursor(buffer: buffer, revision: revision, lastID: lines.last?.id)
    guard session != nil, !fresh.isEmpty else { return }
    for line in fresh.reversed() {
      if let stoppedAt = clock.stoppedAt, line.timestamp > stoppedAt { continue }
      ingest(line, source: source, clock: clock)
    }
  }

  private func ingest(_ line: StackLogLine, source: ReproSource, clock: ReproClock) {
    guard var session else { return }
    let text = redactor.redact(AnsiParser.plainText(line.text))
    let position = clock.position(at: line.timestamp)
    let level = ReproLogLevel.classify(text)
    let beforeVideo = line.timestamp < clock.origin
    if !session.sources.contains(where: { $0.id == source.id }) {
      session.sources.append(source)
      if !capturedWorkspaces.contains(source.workspace) { captureContext(source.workspace) }
    }
    let index = session.sources.firstIndex { $0.id == source.id }!
    session.sources[index].lineCount += 1
    session.lineCount += 1
    // Pre-roll output is context; it does not count against the recording.
    if !beforeVideo {
      if level == .error { session.sources[index].errorCount += 1; session.errorCount += 1 }
      if level == .warning { session.sources[index].warningCount += 1; session.warningCount += 1 }
    }
    if session.lineCount > Self.lineLimit {
      session.truncated = true
    } else {
      let entry = ReproLogLine(id: nextLineID, t: position.t, at: line.timestamp, source: source.id, text: text, level: level,
        offscreen: position.visible ? nil : true)
      nextLineID += 1
      pending.append(entry)
      if level == .error && !beforeVideo {
        if session.firstErrorLine == nil { session.firstErrorLine = entry.id }
        live?.lastError = String(text.prefix(160))
      }
    }
    self.session = session
  }

  private func flush() {
    guard let session else { return }
    if !pending.isEmpty {
      do { try writer?.append(pending) } catch { lastError = "Could not save repro output: \(error.localizedDescription)" }
      pending.removeAll(keepingCapacity: true)
    }
    live?.lines = session.lineCount
    live?.errors = session.errorCount
    live?.warnings = session.warningCount
    live?.sources = session.sources.count
    live?.markers = session.markers.count
    if Date().timeIntervalSince(lastSave) > 5 { save() }
  }

  private func save() {
    guard let session else { return }
    lastSave = Date()
    do { try store.save(session) } catch { lastError = "Could not save repro: \(error.localizedDescription)" }
  }

  // MARK: Markers

  var now: Double { clock?.position(at: Date()).t ?? 0 }

  @discardableResult
  func addMarker(label: String, detail: String? = nil, outcome: ReproMarker.Outcome? = nil, kind: ReproMarker.Kind = .note,
    source: String? = nil, by: String? = nil, at date: Date = Date()) throws -> ReproMarker {
    guard session != nil, let clock else { throw StackError.message("No repro is recording") }
    let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { throw StackError.message("A marker needs a label") }
    let marker = ReproMarker(t: clock.position(at: date).t, at: date, kind: kind, label: String(trimmed.prefix(200)),
      detail: detail.map { redactor.redact(String($0.prefix(2000))) }, outcome: outcome, source: source, by: by)
    session?.markers.append(marker)
    live?.markers = session?.markers.count ?? 0
    save()
    return marker
  }

  private func observe(_ states: [StackID: StackRuntimeState]) {
    guard session != nil, !stopRequested else { return }
    for (stack, state) in states where inScope(stack) {
      for (service, runtime) in state.services {
        let key = "\(stack)/\(service)"
        let previous = phases[key]
        phases[key] = runtime.phase
        guard let previous, previous != runtime.phase else { continue }
        let by = runtime.owner?.label
        switch runtime.phase {
        case .starting where !previous.isActive || previous == .waiting:
          _ = try? addMarker(label: "\(service) starting", detail: runtime.detail, kind: .serviceStarting, source: key, by: by)
        case .ready:
          _ = try? addMarker(label: "\(service) ready", kind: .serviceReady, source: key, by: by)
        case .unhealthy:
          _ = try? addMarker(label: "\(service) readiness failing", detail: runtime.detail, outcome: .fail, kind: .serviceUnhealthy, source: key)
        case .crashed:
          _ = try? addMarker(label: "\(service) crashed", detail: runtime.detail, outcome: .fail, kind: .serviceCrashed, source: key)
        case .stopped where previous.isActive:
          _ = try? addMarker(label: "\(service) stopped", kind: .serviceStopped, source: key)
        default: break
        }
      }
    }
  }

  private func observe(_ runs: [WorkspaceRun]) {
    guard session != nil, !stopRequested else { return }
    for run in runs where inScope(run.workspaceID) && (run.status.isActive || runStatus[run.id]?.isActive == true) {
      track(run, at: Date(), alreadyRunning: false)
    }
  }

  private func track(_ run: WorkspaceRun, at date: Date, alreadyRunning: Bool) {
    guard session != nil else { return }
    let t = clock?.position(at: date).t ?? 0
    if runStatus[run.id] == nil {
      runStatus[run.id] = run.status
      runSteps[run.id] = Dictionary(uniqueKeysWithValues: run.steps.map { ($0.id, alreadyRunning ? $0.status : .queued) })
      session?.runs.append(ReproRunLink(id: run.id, workspace: run.workspaceID, name: run.name, kind: run.kind.rawValue,
        status: run.status.rawValue, startedAt: alreadyRunning ? 0 : t))
      if !capturedWorkspaces.contains(run.workspaceID) { captureContext(run.workspaceID) }
      let verb = alreadyRunning ? "already running" : "started"
      _ = try? addMarker(label: "\(run.name) \(verb)", detail: "\(run.kind.rawValue.capitalized) by \(run.actor.label)", kind: .runStarted,
        by: run.actor.label, at: alreadyRunning ? date : run.createdAt)
    }
    for (index, step) in run.steps.enumerated() {
      let previous = runSteps[run.id]?[step.id] ?? .queued
      guard previous != step.status else { continue }
      runSteps[run.id]?[step.id] = step.status
      let number = run.steps.count > 1 ? "\(index + 1). " : ""
      switch step.status {
      case .running:
        _ = try? addMarker(label: "\(number)\(step.title)", detail: step.command, kind: .step, source: "run/\(run.id.uuidString)/\(step.id.uuidString)",
          at: step.startedAt ?? date)
      case .succeeded, .failed, .cancelled, .interrupted:
        let seconds = step.startedAt.flatMap { start in step.finishedAt.map { String(format: "%.1fs", $0.timeIntervalSince(start)) } }
        let exit = step.exitCode.map { "exit \($0)" }
        let detail = [step.detail, exit, seconds].compactMap { $0 }.joined(separator: " · ")
        _ = try? addMarker(label: "\(number)\(step.title) \(step.status.label.lowercased())", detail: detail.isEmpty ? nil : detail,
          outcome: step.status == .succeeded ? .pass : .fail, kind: .step,
          source: "run/\(run.id.uuidString)/\(step.id.uuidString)", at: step.finishedAt ?? date)
      default: break
      }
    }
    if runStatus[run.id] != run.status {
      runStatus[run.id] = run.status
      if let index = session?.runs.firstIndex(where: { $0.id == run.id }) {
        session?.runs[index].status = run.status.rawValue
        if !run.status.isActive {
          session?.runs[index].finishedAt = clock?.position(at: run.finishedAt ?? date).t
          session?.runs[index].failedStep = run.steps.first { $0.status == .failed }?.title
          _ = try? addMarker(label: "\(run.name) \(run.status.label.lowercased())", detail: run.detail,
            outcome: run.status == .succeeded ? .pass : (run.status == .skipped ? .info : .fail), kind: .runFinished,
            by: run.actor.label, at: run.finishedAt ?? date)
        }
      }
    }
  }

  // MARK: Workspace state

  private func captureContext(_ workspace: String) {
    guard let session, let file = supervisor.files.first(where: { $0.id == workspace }), let definition = file.definition else { return }
    capturedWorkspaces.insert(workspace)
    let snapshot = StackControlService.shared.stackSnapshot(file)
    let services = snapshot.services.map { service in
      ReproServiceState(name: service.name, status: service.status, command: service.command, port: service.port, url: service.url,
        pid: service.pid, startedBy: service.owner?.label)
    }
    var keys = Set(definition.environment.keys)
    for service in definition.services { keys.formUnion(service.environment.keys) }
    let environmentKeys = keys.sorted()
    let heads = Dictionary(uniqueKeysWithValues: definition.repos.map { ($0.id, supervisor.gitMonitor.statuses[$0.path]) })
    let store = store, id = session.id
    let repos = definition.repos
    let task = Task { [weak self] in
      var states: [ReproRepoState] = []
      for repo in repos {
        let status = heads[repo.id] ?? nil
        var state = ReproRepoState(id: repo.id, path: repo.path.path, branch: status?.branchLabel ?? "unknown",
          head: status.flatMap { $0.oid.isEmpty ? nil : $0.oid }, upstream: status?.upstream, ahead: status?.ahead ?? 0, behind: status?.behind ?? 0)
        let git = await Self.gitDetails(repo: repo, workspace: workspace, store: store, id: id)
        if state.head == nil { state.head = git.head }
        state.changedFiles = git.changed
        state.diffFile = git.diffFile
        state.diffTruncated = git.truncated ? true : nil
        states.append(state)
      }
      let context = ReproWorkspaceContext(id: workspace, name: file.name, root: definition.root.path,
        definitionFingerprint: definition.fingerprint, environmentKeys: environmentKeys,
        secretKeys: definition.secrets.keys.sorted(), services: services, repos: states)
      guard let self, self.session?.id == id else { return }
      self.session?.workspaces.removeAll { $0.id == workspace }
      self.session?.workspaces.append(context)
      self.save()
    }
    contextTasks.append(task)
  }

  /// HEAD, changed paths, and the uncommitted diff (capped at 2 MB).
  private nonisolated static func gitDetails(repo: RepoDefinition, workspace: String, store: ReproStore, id: UUID) async
    -> (head: String?, changed: [String], diffFile: String?, truncated: Bool) {
    guard FileManager.default.fileExists(atPath: repo.path.appendingPathComponent(".git").path) else { return (nil, [], nil, false) }
    var environment = (try? await ShellEnvironmentResolver.shared.resolve()) ?? ProcessInfo.processInfo.environment
    environment["GIT_TERMINAL_PROMPT"] = "0"; environment["GIT_OPTIONAL_LOCKS"] = "0"; environment["LC_ALL"] = "C"
    func git(_ arguments: [String]) async -> String? {
      guard let result = try? await StackCommandRunner.run("/usr/bin/git", ["-c", "color.ui=false"] + arguments,
        directory: repo.path, environment: environment, timeout: 20), result.status == 0 else { return nil }
      return result.text
    }
    let head = await git(["rev-parse", "HEAD"])?.trimmingCharacters(in: .whitespacesAndNewlines)
    let changed = (await git(["status", "--porcelain=v1", "--untracked-files=normal"]) ?? "")
      .split(separator: "\n").map { String($0.dropFirst(3)) }.filter { !$0.isEmpty }
    guard !changed.isEmpty, var diff = await git(["diff", "HEAD", "--no-ext-diff", "--no-color"]), !diff.isEmpty else {
      return (head, Array(changed.prefix(500)), nil, false)
    }
    let limit = 2 * 1024 * 1024
    let truncated = diff.utf8.count > limit
    if truncated { diff = String(decoding: Data(diff.utf8.prefix(limit)), as: UTF8.self) + "\n[diff truncated at 2 MB]\n" }
    let folder = store.gitFolder(id)
    let name = ReproReport.slug(repo.id == workspace ? repo.id : "\(workspace)-\(repo.id)", fallback: "repo") + ".diff"
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      try diff.write(to: folder.appendingPathComponent(name), atomically: true, encoding: .utf8)
      return (head, Array(changed.prefix(500)), "git/\(name)", truncated)
    } catch { return (head, Array(changed.prefix(500)), nil, false) }
  }

  // MARK: Finishing

  private func settleCapture() async {
    pollTask?.cancel()
    await pollTask?.value
    pollTask = nil
    // Catch output written just before the stop, including relaunches.
    await poll()
    for task in contextTasks { await task.value }
    contextTasks = []
    writer?.close()
    writer = nil
  }

  private func finalize(video url: URL) async {
    guard session != nil else { return }
    live?.isFinalizing = true
    await settleCapture()
    guard var session else { return }
    let keepEmpty = session.origin != .recording
    session.duration = clock?.duration ?? 0
    if let seconds = try? await AVURLAsset(url: url).load(.duration).seconds, seconds.isFinite, seconds > 0 { session.duration = seconds }
    session.endedAt = clock?.stoppedAt ?? Date()
    session.videoPath = url.path
    session.videoBookmark = try? url.bookmarkData()
    session.markers.sort { $0.t == $1.t ? $0.at < $1.at : $0.t < $1.t }
    // Markers placed after the last frame still belong to the recording.
    for index in session.markers.indices where session.markers[index].t > session.duration { session.markers[index].t = session.duration }
    if session.title.isEmpty { session.title = displayTitle(session) }
    session.status = .ready
    reset()
    guard keepEmpty || session.lineCount > 0 || !session.runs.isEmpty else {
      try? store.delete(session.id)
      resume(session.id, with: nil)
      return
    }
    do { try store.save(session) } catch { lastError = "Could not save repro: \(error.localizedDescription)" }
    sessions.removeAll { $0.id == session.id }
    sessions.insert(session, at: 0)
    resume(session.id, with: session)
  }

  private func discard() async {
    await settleCapture()
    guard let id = session?.id else { return }
    reset()
    try? store.delete(id)
    resume(id, with: nil)
  }

  private func reset() {
    session = nil; clock = nil; live = nil; expectedRequest = nil
    cursors = [:]; retired = []; pending = []; phases = [:]; runSteps = [:]; runStatus = [:]
    stopRequested = false; lastFirstFrame = nil
    redactor = ReproRedactor(secrets: [:])
  }

  private func resume(_ id: UUID, with session: ReproSession?) {
    for waiter in waiters.removeValue(forKey: id) ?? [] { waiter.resume(returning: session) }
  }

  /// Waits for a stopped repro to be saved. Returns nil if it was discarded.
  func waitUntilSaved(_ id: UUID) async -> ReproSession? {
    if session?.id != id { return sessions.first { $0.id == id } }
    return await withCheckedContinuation { continuation in waiters[id, default: []].append(continuation) }
  }

  private func displayTitle(_ session: ReproSession) -> String {
    if !session.title.isEmpty { return session.title }
    let names = session.sources.map(\.workspaceName).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
    let formatter = DateFormatter()
    formatter.dateStyle = .medium; formatter.timeStyle = .short
    let date = formatter.string(from: session.createdAt)
    return names.isEmpty ? "Repro · \(date)" : "\(names.joined(separator: ", ")) · \(date)"
  }

  // MARK: Library

  /// The in-progress repro while recording, otherwise the saved one.
  func current(_ id: UUID) -> ReproSession? { session?.id == id ? session : sessions.first { $0.id == id } }

  /// Finds a repro by id, unique id prefix, "latest", or "active".
  func resolve(_ query: String?) throws -> ReproSession {
    let value = (query ?? "latest").trimmingCharacters(in: .whitespaces).lowercased()
    if value == "active" || value == "current" {
      guard let session else { throw StackControlError.notFound("No repro is recording") }
      return session
    }
    if value == "latest" || value == "last" || value.isEmpty {
      guard let latest = session ?? sessions.first else { throw StackControlError.notFound("No repros yet. Start one with start_repro_recording.") }
      return latest
    }
    let all = (session.map { [$0] } ?? []) + sessions
    if let exact = all.first(where: { $0.id.uuidString.lowercased() == value }) { return exact }
    let matches = all.filter { $0.id.uuidString.lowercased().hasPrefix(value) || $0.title.lowercased() == value }
    if matches.count == 1 { return matches[0] }
    throw StackControlError.notFound(matches.isEmpty ? "No repro matches \"\(query ?? "")\"" : "\"\(query ?? "")\" matches several repros; use more of the id")
  }

  /// A repro whose video is at `url`, following renames and moves.
  func session(forVideo url: URL) -> ReproSession? {
    let path = url.standardizedFileURL.resolvingSymlinksInPath().path
    if let match = sessions.first(where: { $0.videoPath.map { URL(fileURLWithPath: $0).standardizedFileURL.resolvingSymlinksInPath().path } == path }) {
      return match
    }
    for index in sessions.indices {
      guard let bookmark = sessions[index].videoBookmark, let current = sessions[index].videoPath,
        !FileManager.default.fileExists(atPath: current) else { continue }
      var stale = false
      guard let resolved = try? URL(resolvingBookmarkData: bookmark, bookmarkDataIsStale: &stale),
        resolved.standardizedFileURL.resolvingSymlinksInPath().path == path else { continue }
      sessions[index].videoPath = resolved.path
      if stale { sessions[index].videoBookmark = try? resolved.bookmarkData() }
      try? store.save(sessions[index])
      return sessions[index]
    }
    return nil
  }

  func lines(for id: UUID) async -> [ReproLogLine] {
    if session?.id == id {
      flush()
      let store = store
      return await Task.detached { store.loadLines(id) }.value
    }
    if let cached = lineCache[id] { return cached }
    let store = store
    let lines = await Task.detached { store.loadLines(id) }.value
    lineCache[id] = lines
    lineCacheOrder.removeAll { $0 == id }
    lineCacheOrder.append(id)
    while lineCacheOrder.count > 4 { lineCache[lineCacheOrder.removeFirst()] = nil }
    return lines
  }

  func rename(_ id: UUID, to title: String) {
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, let index = sessions.firstIndex(where: { $0.id == id }) else { return }
    sessions[index].title = String(trimmed.prefix(120))
    try? store.save(sessions[index])
  }

  func delete(_ id: UUID) throws {
    guard session?.id != id else { throw StackError.message("Stop the recording before deleting this repro") }
    try store.delete(id)
    sessions.removeAll { $0.id == id }
    lineCache[id] = nil
  }
}
