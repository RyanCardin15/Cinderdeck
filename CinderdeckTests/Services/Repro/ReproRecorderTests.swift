import Combine
import Foundation
import XCTest
@testable import Cinderdeck

/// Drives the capture engine with real service and task processes and a
/// simulated recorder lifecycle, then checks what the saved repro contains.
@MainActor
final class ReproRecorderTests: XCTestCase {
  private struct FixedSecrets: StackSecretsStoring {
    func read(_ name: String) throws -> String { "tok_live_1234567890" }
  }

  private var root: URL!
  private var supervisor: StackSupervisor!
  private var runner: WorkspaceRunner!
  private var recorder: ReproRecorder!
  private var events: PassthroughSubject<RecordingLifecycleEvent, Never>!
  private var store: ReproStore!

  override func setUp() async throws {
    root = try StackTestSupport.temporaryDirectory()
    let defaults = UserDefaults(suiteName: "ReproTests-\(UUID())")!
    defaults.set(root.path, forKey: PreferencesKeys.stacksDirectory)
    defaults.set(false, forKey: PreferencesKeys.stacksNotifyOnCrash)
    let pool = try DatabaseManager.openDatabase(at: root.appendingPathComponent("db")).dbPool
    supervisor = StackSupervisor(store: StackRunStore(pool: pool), defaults: defaults, secrets: FixedSecrets(),
      logRoot: root.appendingPathComponent("services"), environment: { _ in ProcessInfo.processInfo.environment })
    runner = WorkspaceRunner(supervisor: supervisor, store: WorkspaceRunStore(directory: root.appendingPathComponent("runs")),
      secrets: FixedSecrets(), environment: { _ in ProcessInfo.processInfo.environment })
    await runner.recover()
    let control = StackControlService(supervisor: supervisor, runner: runner, claimsFile: root.appendingPathComponent("claims.json"))
    events = PassthroughSubject()
    store = ReproStore(directory: root.appendingPathComponent("repros"))
    recorder = ReproRecorder(supervisor: supervisor, runner: runner, store: store, events: events.eraseToAnyPublisher(),
      defaults: defaults, secrets: FixedSecrets(), snapshot: { control.stackSnapshot($0) }, isTemporary: { _ in false })
    recorder.start()
  }

  override func tearDown() async throws {
    await runner?.cancelAll()
    await supervisor?.stopAll()
    await supervisor?.shutdownMonitoring()
    if let root { try? FileManager.default.removeItem(at: root) }
    recorder = nil; runner = nil; supervisor = nil; events = nil; store = nil; root = nil
  }

  private func load(_ source: String) async throws {
    try ("root = \(WorkspaceDefinitionWriter.quote(root.path))\nshell = \"/bin/sh\"\n" + source)
      .write(to: root.appendingPathComponent("shop.toml"), atomically: true, encoding: .utf8)
    await supervisor.reloadDefinitions()
    XCTAssertNotNil(supervisor.definition("shop"), supervisor.files.flatMap(\.issues).map(\.message).joined(separator: "; "))
  }

  private func until(_ seconds: Double = 10, _ condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(seconds)
    while !condition() && Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
    XCTAssertTrue(condition(), "Timed out")
  }

  private func stopRecording() async throws -> ReproSession? {
    let id = try XCTUnwrap(recorder.activeSessionID)
    // Longer than one poll so the last output is read.
    try await Task.sleep(nanoseconds: 500_000_000)
    events.send(.stopping(Date()))
    let video = root.appendingPathComponent("recording.mov")
    try Data("not a real movie".utf8).write(to: video)
    events.send(.finished(video))
    return await recorder.waitUntilSaved(id)
  }

  func testCapturesServiceAndTaskOutputWithMarkersAndRedaction() async throws {
    try await load("""
    [secrets]
    TOKEN = "shop-token"
    [services.api]
    cmd = "echo \\"auth $TOKEN\\"; echo listening; while true; do echo tick; sleep 0.2; done"
    ready.log = "listening"
    [tasks.check]
    cmd = "echo 'running checks'; echo 'TypeError: total is undefined'; exit 3"
    requires_services = ["api"]
    [workflows.verify]
    name = "Verify"
    steps = ["start:api", "task:check"]
    """)
    let start = Date()
    events.send(.started(start))
    events.send(.firstFrame(start.addingTimeInterval(0.1)))
    XCTAssertNotNil(recorder.live)

    let run = try runner.submit(workspace: "shop", kind: .workflow, definitionID: "verify")
    try await until { self.runner.run(run.id)?.status.isActive == false }
    try recorder.addMarker(label: "Total shows $42", outcome: .fail, kind: .check, by: "Test Agent")

    let stopped = try await stopRecording()
    let saved = try XCTUnwrap(stopped)
    XCTAssertEqual(saved.status, .ready)
    XCTAssertNil(recorder.live)
    let lines = store.loadLines(saved.id)

    XCTAssertTrue(saved.sources.contains { $0.id == "shop/api" && $0.kind == .service })
    XCTAssertTrue(saved.sources.contains { $0.kind == .task && $0.name == "check" })
    XCTAssertTrue(lines.contains { $0.text == "tick" && $0.source == "shop/api" })
    let failure = try XCTUnwrap(lines.first { $0.text.contains("TypeError") })
    XCTAssertEqual(failure.level, .error)
    XCTAssertEqual(saved.firstErrorLine, failure.id)
    XCTAssertGreaterThan(failure.t, 0)
    XCTAssertTrue(lines.contains { $0.text == "auth [secret TOKEN]" }, "Secret values are redacted")
    XCTAssertFalse(lines.contains { $0.text.contains("tok_live_1234567890") })
    XCTAssertEqual(lines.map(\.t), lines.map(\.t).sorted())

    let kinds = Set(saved.markers.map(\.kind))
    XCTAssertTrue(kinds.isSuperset(of: [.runStarted, .serviceStarting, .serviceReady, .step, .runFinished, .check]), "\(kinds)")
    XCTAssertTrue(saved.markers.contains { $0.kind == .step && $0.outcome == .fail && $0.detail?.contains("exit 3") == true })
    XCTAssertEqual(saved.runs.first?.status, "failed")
    XCTAssertEqual(saved.runs.first?.failedStep, "check")
    XCTAssertEqual(saved.markers.map(\.t), saved.markers.map(\.t).sorted())

    let context = try XCTUnwrap(saved.workspaces.first)
    XCTAssertEqual(context.id, "shop")
    XCTAssertEqual(context.secretKeys, ["TOKEN"])

    let summary = ReproSummary(session: saved, lines: lines)
    XCTAssertEqual(summary.verdict, .failed)
    XCTAssertEqual(summary.checksFailed, 1)
    XCTAssertEqual(recorder.sessions.first?.id, saved.id)
    XCTAssertEqual(recorder.session(forVideo: root.appendingPathComponent("recording.mov"))?.id, saved.id)
    XCTAssertEqual(try recorder.resolve(String(saved.id.uuidString.prefix(8))).id, saved.id)

    // The readable log sits next to the video, with a library copy.
    XCTAssertEqual(saved.logFile, root.appendingPathComponent("recording.log").path)
    let log = try String(contentsOf: root.appendingPathComponent("recording.log"), encoding: .utf8)
    XCTAssertTrue(log.contains("Video:      recording.mov"))
    XCTAssertTrue(log.contains("ERROR  TypeError: total is undefined"))
    XCTAssertTrue(log.contains("auth [secret TOKEN]"))
    XCTAssertTrue(log.contains("▶ api ready"))
    XCTAssertTrue(FileManager.default.fileExists(atPath: store.logURL(saved.id).path))
  }

  func testSelectedWorkspacesLimitCaptureAndOffRecordsPlainVideo() async throws {
    try await load("[services.api]\ncmd = \"while true; do echo tick; sleep 0.1; done\"\n")
    await supervisor.start(stack: "shop", services: ["api"])
    try await until { self.supervisor.runtime("shop", "api").phase == .ready }

    recorder.setScope(.only(["billing"]))
    events.send(.started(Date()))
    let unselected = try await stopRecording()
    XCTAssertNil(unselected, "Output from unselected workspaces is not captured")

    recorder.setScope(.only(["shop"]))
    events.send(.started(Date()))
    let stopped = try await stopRecording()
    let saved = try XCTUnwrap(stopped)
    XCTAssertEqual(saved.sources.map(\.id), ["shop/api"])
    XCTAssertEqual(saved.scope, "chosen in the recording toolbar")

    recorder.setScope(.off)
    events.send(.started(Date()))
    XCTAssertNil(recorder.activeSessionID, "Logs off means a plain video")
    recorder.setScope(.running)
  }

  func testRecordingWithoutWorkspaceOutputIsDiscarded() async throws {
    try await load("[tasks.noop]\ncmd = \"true\"\n")
    events.send(.started(Date()))
    let id = try XCTUnwrap(recorder.activeSessionID)
    let saved = try await stopRecording()
    XCTAssertNil(saved)
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.folder(id).path))
    XCTAssertTrue(recorder.sessions.isEmpty)
  }

  func testExplicitRequestIsKeptEvenWhenQuietAndCancelDiscards() async throws {
    try await load("[tasks.noop]\ncmd = \"true\"\n")
    let actor = StackActor(kind: .agent, name: "Codex")
    let request = ReproRequest(title: "Quiet check", origin: .agent, actor: actor, note: "Opening the app")
    recorder.expect(request)
    events.send(.started(Date()))
    XCTAssertEqual(recorder.activeSessionID, request.id)
    let stopped = try await stopRecording()
    let saved = try XCTUnwrap(stopped)
    XCTAssertEqual(saved.title, "Quiet check")
    XCTAssertEqual(saved.markers.first?.label, "Opening the app")
    XCTAssertEqual(saved.actor.name, "Codex")

    events.send(.started(Date()))
    let cancelled = try XCTUnwrap(recorder.activeSessionID)
    events.send(.cancelled)
    try await until { self.recorder.activeSessionID == nil }
    try await until { !FileManager.default.fileExists(atPath: self.store.folder(cancelled).path) }
  }

  func testStoppedReproIsNeverMissingWhileItSaves() async throws {
    try await load("[services.api]\ncmd = \"while true; do echo tick; sleep 0.05; done\"\n")
    await supervisor.start(stack: "shop", services: ["api"])
    try await until { self.supervisor.runtime("shop", "api").phase == .ready }
    events.send(.started(Date()))
    let id = try XCTUnwrap(recorder.activeSessionID)
    try await Task.sleep(nanoseconds: 500_000_000)
    events.send(.stopping(Date()))
    let video = root.appendingPathComponent("recording.mov")
    try Data("not a real movie".utf8).write(to: video)
    events.send(.finished(video))
    // Agents waiting on a repro must not see a gap between recording and the library.
    let deadline = Date().addingTimeInterval(10)
    while !recorder.sessions.contains(where: { $0.id == id }) && Date() < deadline {
      XCTAssertTrue(recorder.isRecordingOrSaving(id), "Neither recording nor saved")
      XCTAssertEqual(try? recorder.resolve("latest").id, id, "latest finds the repro while it saves")
      try await Task.sleep(nanoseconds: 1_000_000)
    }
    XCTAssertFalse(recorder.isRecordingOrSaving(id))
    let saved = await recorder.waitUntilSaved(id)
    XCTAssertEqual(saved?.id, id)
  }

  func testPeopleWithoutWorkspacesGetPlainVideos() async throws {
    XCTAssertTrue(supervisor.files.isEmpty)
    events.send(.started(Date()))
    XCTAssertNil(recorder.activeSessionID, "No capture runs behind ordinary recordings without workspaces")
    XCTAssertNil(recorder.live, "The recording bar shows no logs indicator")
    events.send(.cancelled)

    let request = ReproRequest(title: "Agent check", origin: .agent, actor: StackActor(kind: .agent, name: "Codex"))
    recorder.expect(request)
    events.send(.started(Date()))
    XCTAssertEqual(recorder.activeSessionID, request.id, "Explicit requests still record")
    let stopped = try await stopRecording()
    XCTAssertEqual(stopped?.title, "Agent check")
  }

  func testDisabledPreferenceSkipsOrdinaryRecordings() async throws {
    let defaults = UserDefaults(suiteName: "ReproTests-off-\(UUID())")!
    defaults.set("off", forKey: PreferencesKeys.reproLogScope)
    let subject = PassthroughSubject<RecordingLifecycleEvent, Never>()
    let quiet = ReproRecorder(supervisor: supervisor, runner: runner, store: store, events: subject.eraseToAnyPublisher(),
      defaults: defaults, secrets: FixedSecrets(), snapshot: { _ in fatalError("Not used when capture is off") })
    subject.send(.started(Date()))
    XCTAssertNil(quiet.activeSessionID)
  }
}
