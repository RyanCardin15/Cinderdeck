import Combine
import Foundation
import SwiftUI
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
    // Most tests exercise capture; toolbar recordings default to plain videos.
    recorder.setScope(.running)
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
    let quiet = try XCTUnwrap(unselected, "Keep the explicit choice even if the definition is unavailable")
    XCTAssertEqual(quiet.workspaceIDs, ["billing"])
    XCTAssertTrue(quiet.sources.isEmpty, "Output from unselected workspaces is not captured")

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

  /// The toolbar popover's ticks, with three workspaces printing: only the ticked ones
  /// reach the recording, including ones that start after it began, and nothing from the
  /// others shows in its sources, workspaces, log file, or the Recordings lists.
  func testSeveralSelectedWorkspacesCaptureOnlyThemselves() async throws {
    for name in ["alpha", "beta", "gamma"] {
      try ("root = \(WorkspaceDefinitionWriter.quote(root.path))\nshell = \"/bin/sh\"\n"
        + "[services.talk]\ncmd = \"while true; do echo \(name)-service; sleep 0.05; done\"\n"
        + "[tasks.check]\ncmd = \"echo \(name)-task\"\n")
        .write(to: root.appendingPathComponent("\(name).toml"), atomically: true, encoding: .utf8)
    }
    await supervisor.reloadDefinitions()
    for name in ["alpha", "beta"] {
      await supervisor.start(stack: name, services: ["talk"])
      try await until { self.supervisor.runtime(name, "talk").phase == .ready }
    }

    // Ticks in the popover: alpha, beta, gamma, then beta off again.
    var scope = ReproLogScope.off
    for id in ["alpha", "beta", "gamma", "beta"] { scope = scope.toggling(id) }
    XCTAssertEqual(scope, .only(["alpha", "gamma"]))
    recorder.setScope(scope)
    XCTAssertEqual(ToolbarWorkspacePicker.title(scope: recorder.scope, choices: WorkspaceLogChoice.all(supervisor: supervisor, runner: runner)), "2 workspaces")

    events.send(.started(Date()))
    events.send(.firstFrame(Date()))
    let id = try XCTUnwrap(recorder.activeSessionID)
    // A selected workspace that starts while recording, and an unselected task run.
    await supervisor.start(stack: "gamma", services: ["talk"])
    let run = try runner.submit(workspace: "beta", kind: .task, definitionID: "check", actor: .user)
    try await until { self.runner.run(run.id)?.status.isActive == false }
    try await until { (self.recorder.live?.sources ?? 0) >= 2 }
    let stopped = try await stopRecording()
    let saved = try XCTUnwrap(stopped)

    XCTAssertEqual(saved.id, id)
    XCTAssertEqual(Set(saved.sources.map(\.workspace)), ["alpha", "gamma"], saved.sources.map(\.id).joined(separator: ", "))
    XCTAssertFalse(saved.workspaceIDs.contains("beta"), "beta is not listed as captured: \(saved.workspaceIDs)")
    XCTAssertTrue(saved.runs.isEmpty, "beta's task run is not linked")
    let lines = await recorder.lines(for: id)
    let log = ReproReport.logFile(saved, lines: lines, videoName: nil)
    XCTAssertTrue(log.contains("alpha-service") && log.contains("gamma-service"), log)
    XCTAssertFalse(log.contains("beta-"), "beta output leaked into the log")
    // What Workspaces → Recordings and `repro list <workspace>` match on.
    func listed(under workspace: String) -> Bool { saved.workspaceIDs.contains(workspace) || saved.sources.contains { $0.workspace == workspace } }
    XCTAssertTrue(listed(under: "alpha") && listed(under: "gamma"))
    XCTAssertFalse(listed(under: "beta"))
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

  func testSelectedQuietWorkspacesStayInLibraryAndExcludeOtherOutput() async throws {
    try await load("[tasks.noop]\ncmd = \"true\"\n")
    for id in ["billing", "other"] {
      let source = "root = \(WorkspaceDefinitionWriter.quote(root.path))\nshell = \"/bin/sh\"\n[services.api]\ncmd = \"while true; do echo tick; sleep 0.1; done\"\n"
      try source.write(to: root.appendingPathComponent("\(id).toml"), atomically: true, encoding: .utf8)
    }
    await supervisor.reloadDefinitions()
    await supervisor.start(stack: "other", services: ["api"])
    try await until { self.supervisor.runtime("other", "api").phase == .ready }

    for ids: Set<String> in [["shop"], ["shop", "billing"]] {
      recorder.setScope(.only(ids))
      events.send(.started(Date()))
      // Changing the next recording's choice cannot discard this one at stop.
      recorder.setScope(.off)
      let stopped = try await stopRecording()
      let saved = try XCTUnwrap(stopped, "Explicit workspace choices must survive even without output")
      XCTAssertEqual(saved.status, .ready)
      XCTAssertEqual(Set(saved.workspaceIDs), ids)
      XCTAssertEqual(Set(saved.workspaces.map(\.id)), ids)
      XCTAssertTrue(saved.sources.isEmpty, "The unselected running workspace must not leak into the recording")
      XCTAssertEqual(saved.lineCount, 0)
      XCTAssertTrue(saved.runs.isEmpty)
      XCTAssertTrue(FileManager.default.fileExists(atPath: try XCTUnwrap(saved.videoPath)))
      XCTAssertTrue(FileManager.default.fileExists(atPath: store.logURL(saved.id).path))
      XCTAssertNotNil(recorder.sessions.first { $0.id == saved.id })
      let reloaded = try XCTUnwrap(store.loadSessions().first { $0.id == saved.id })
      XCTAssertEqual(reloaded.workspaceIDs, saved.workspaceIDs, "Workspace membership must survive reloading the library")
      XCTAssertEqual(reloaded.videoPath, saved.videoPath)
      XCTAssertEqual(reloaded.status, .ready)
    }
  }

  func testAllRunningKeepsAQuietActiveWorkspace() async throws {
    try await load("[services.api]\ncmd = \"sleep 30\"\n")
    await supervisor.start(stack: "shop", services: ["api"])
    try await until { self.supervisor.runtime("shop", "api").phase == .ready }
    events.send(.started(Date()))
    let stopped = try await stopRecording()
    let saved = try XCTUnwrap(stopped)
    XCTAssertEqual(saved.workspaceIDs, ["shop"])
    XCTAssertEqual(saved.lineCount, 0)
    XCTAssertEqual(saved.status, .ready)
  }

  func testInterruptedSelectionSurvivesBeforeContextIsCaptured() async throws {
    var chosen = ReproSession(title: "Selected workspace", origin: .recording, actor: .user)
    chosen.selectedWorkspaceIDs = ["shop", "billing"]
    try store.save(chosen)
    let automatic = ReproSession(title: "No workspace", origin: .recording, actor: .user)
    try store.save(automatic)
    let recovered = ReproRecorder(supervisor: supervisor, runner: runner, store: store,
      events: Empty<RecordingLifecycleEvent, Never>().eraseToAnyPublisher(),
      defaults: UserDefaults(suiteName: "ReproRecovery-\(UUID())")!, secrets: FixedSecrets())
    recovered.start()

    XCTAssertEqual(recovered.sessions.map(\.id), [chosen.id])
    XCTAssertEqual(recovered.sessions.first?.status, .failed)
    XCTAssertEqual(recovered.sessions.first?.workspaceIDs, ["shop", "billing"])
    XCTAssertNotNil(store.loadSession(chosen.id))
    XCTAssertNil(store.loadSession(automatic.id))
  }

  func testRecordingFilterAndDropdownShareScopeWithoutLosingMultipleChoices() async throws {
    try await load("[tasks.noop]\ncmd = \"true\"\n")
    let file = try XCTUnwrap(supervisor.files.first { $0.id == "shop" })
    let view = WorkspaceReprosView(file: file, recorder: recorder, controller: .shared, runner: runner)

    recorder.setScope(.only(["shop", "billing"]))
    XCTAssertFalse(view.workspaceFilter.wrappedValue)
    XCTAssertEqual(recorder.scope, .only(["shop", "billing"]), "Opening the library must preserve toolbar choices")
    XCTAssertEqual(view.recordingScope, .only(["shop", "billing"]))

    view.workspaceFilter.wrappedValue = true
    XCTAssertEqual(recorder.scope, .running, "All workspaces updates the shared dropdown setting")
    XCTAssertEqual(view.recordingScope, .running, "The record action must follow the same choice")
    XCTAssertTrue(view.workspaceFilter.wrappedValue)
    view.workspaceFilter.wrappedValue = false
    XCTAssertEqual(recorder.scope, .only(["shop"]), "With Shop narrows the dropdown to Shop")

    recorder.setScope(.running)
    XCTAssertTrue(view.workspaceFilter.wrappedValue, "Changing the dropdown updates the filter too")
    recorder.setScope(.off)
    XCTAssertFalse(view.workspaceFilter.wrappedValue)
    XCTAssertEqual(view.recordingScope, .only(["shop"]), "Record with Logs explicitly enables this workspace")
  }

  func testSelectedQuietWorkspaceWithoutVideoKeepsFailureAndCancelDiscards() async throws {
    try await load("[tasks.noop]\ncmd = \"true\"\n")
    recorder.setScope(.only(["shop"]))
    events.send(.started(Date()))
    let stopped = try await stopImmediately(video: false)
    let saved = try XCTUnwrap(stopped)
    XCTAssertEqual(saved.status, .failed)
    XCTAssertEqual(saved.workspaceIDs, ["shop"])
    XCTAssertTrue(saved.detail?.contains("no video") == true)

    events.send(.started(Date()))
    let id = try XCTUnwrap(recorder.activeSessionID)
    events.send(.cancelled)
    let cancelled = await recorder.waitUntilSaved(id)
    XCTAssertNil(cancelled)
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.folder(id).path))
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

  func testLogsOffCapturesNoWorkspaceOutputButKeepsAgentLines() async throws {
    try await load("[services.api]\ncmd = \"while true; do echo tick; sleep 0.1; done\"\n")
    await supervisor.start(stack: "shop", services: ["api"])
    try await until { self.supervisor.runtime("shop", "api").phase == .ready }

    let request = ReproRequest(title: "Plain", origin: .agent, actor: StackActor(kind: .agent, name: "Codex"), workspaces: [])
    recorder.expect(request)
    events.send(.started(Date()))
    XCTAssertEqual(recorder.activeSessionID, request.id)
    let added = try recorder.appendExternal([
      .init(text: "[browser:log] cart loaded"),
      .init(text: "Uncaught TypeError: price is undefined"),
      .init(text: "GET /api/cart 404", level: .warning),
      .init(text: "   "),
    ], source: "browser")
    XCTAssertEqual(added, 3, "Blank lines are skipped")
    let stopped = try await stopRecording()
    let saved = try XCTUnwrap(stopped)
    XCTAssertEqual(saved.sources.map(\.id), ["external/browser"], "No workspace output when logs are off")
    XCTAssertEqual(saved.sources.first?.kind, .external)
    XCTAssertTrue(saved.workspaceNames.isEmpty)
    XCTAssertEqual(saved.scope, "workspace logs off")
    XCTAssertEqual(saved.errorCount, 1)
    XCTAssertEqual(saved.warningCount, 1)

    let lines = await recorder.lines(for: saved.id)
    let log = ReproReport.logFile(saved, lines: lines, videoName: "recording.mov")
    XCTAssertTrue(log.contains("Captured:   No workspace output (workspace logs off)"), log)
    XCTAssertTrue(log.contains("browser  ERROR  Uncaught TypeError: price is undefined"), log)
    XCTAssertFalse(log.contains("tick"))
    XCTAssertThrowsError(try recorder.appendExternal([.init(text: "late")], source: "browser"), "Only while recording")
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

  // MARK: Agent speed

  private func agentRequest(_ title: String = "Agent check") -> ReproRequest {
    ReproRequest(title: title, origin: .agent, actor: StackActor(kind: .agent, name: "Codex"))
  }

  /// Stops the way an agent does: right after the output it cares about, with no pause.
  private func stopImmediately(video: Bool = true) async throws -> ReproSession? {
    let id = try XCTUnwrap(recorder.activeSessionID)
    events.send(.stopping(Date()))
    guard video else {
      events.send(.noVideo)
      return await recorder.waitUntilSaved(id)
    }
    let url = root.appendingPathComponent("recording.mov")
    try Data("not a real movie".utf8).write(to: url)
    events.send(.finished(url))
    return await recorder.waitUntilSaved(id)
  }

  func testStopRightAfterOutputKeepsTheLastLines() async throws {
    let trigger = root.appendingPathComponent("go")
    try await load("""
    [services.api]
    cmd = "echo listening; while [ ! -f '\(trigger.path)' ]; do sleep 0.01; done; echo 'Error: payment declined'; sleep 30"
    ready.log = "listening"
    """)
    await supervisor.start(stack: "shop", services: ["api"])
    try await until { self.supervisor.runtime("shop", "api").phase == .ready }
    recorder.expect(agentRequest())
    let start = Date()
    events.send(.started(start))
    events.send(.firstFrame(start))
    try await Task.sleep(nanoseconds: 300_000_000)
    // The agent triggers the failure and stops as soon as it has happened.
    FileManager.default.createFile(atPath: trigger.path, contents: nil)
    try await Task.sleep(nanoseconds: 40_000_000)
    let stopped = try await stopImmediately()
    let saved = try XCTUnwrap(stopped)
    let lines = store.loadLines(saved.id)
    let error = try XCTUnwrap(lines.first { $0.text == "Error: payment declined" }, "The last output before stop is kept: \(lines.map(\.text))")
    XCTAssertEqual(saved.errorCount, 1)
    XCTAssertLessThanOrEqual(error.t, saved.duration + 0.001, "Pinned inside the video")
    XCTAssertEqual(ReproSummary(session: saved, lines: lines).verdict, .errors)
  }

  func testLinesAndMarksSentWhileStoppingAreKept() async throws {
    recorder.expect(agentRequest())
    let start = Date()
    events.send(.started(start))
    events.send(.firstFrame(start))
    let id = try XCTUnwrap(recorder.activeSessionID)
    try await Task.sleep(nanoseconds: 200_000_000)
    // Agents send tool calls in parallel: these arrive after stop began.
    events.send(.stopping(Date()))
    XCTAssertNoThrow(try recorder.appendExternal([.init(text: "Uncaught TypeError: price is undefined")], source: "browser"))
    XCTAssertNoThrow(try recorder.addMarker(label: "Pay succeeds", outcome: .fail, kind: .check, by: "Codex"))
    let url = root.appendingPathComponent("recording.mov")
    try Data("not a real movie".utf8).write(to: url)
    events.send(.finished(url))
    // …and while it is being saved.
    XCTAssertNoThrow(try recorder.addMarker(label: "Receipt shown", outcome: .fail, kind: .check, by: "Codex"))
    let result = await recorder.waitUntilSaved(id)
    let saved = try XCTUnwrap(result)
    let lines = store.loadLines(saved.id)
    XCTAssertTrue(lines.contains { $0.text.contains("price is undefined") }, "\(lines)")
    XCTAssertEqual(Set(saved.markers.map(\.label)), ["Pay succeeds", "Receipt shown"])
    XCTAssertEqual(ReproSummary(session: saved, lines: lines).verdict, .failed)
    let log = try String(contentsOf: store.logURL(saved.id), encoding: .utf8)
    XCTAssertTrue(log.contains("price is undefined") && log.contains("Receipt shown"), log)
  }

  func testLinesAndMarksAfterTheStopAmendTheSavedRepro() async throws {
    do {
      _ = try await recorder.append([.init(text: "nothing to add to")], source: "browser")
      XCTFail("Nothing is recording or just stopped")
    } catch {}
    recorder.expect(agentRequest())
    let start = Date().addingTimeInterval(-3)
    events.send(.started(start))
    events.send(.firstFrame(start))
    try recorder.appendExternal([.init(text: "cart loaded")], source: "browser")
    events.send(.stopping(start.addingTimeInterval(2)))
    let url = root.appendingPathComponent("recording.mov")
    try Data("not a real movie".utf8).write(to: url)
    let id = try XCTUnwrap(recorder.activeSessionID)
    events.send(.finished(url))
    _ = await recorder.waitUntilSaved(id)

    // The console was read after the stop: one line with its real time, one without.
    let added = try await recorder.append([
      .init(text: "Uncaught TypeError: price is undefined", at: start.addingTimeInterval(1)),
      .init(text: "[browser:log] unload"),
    ], source: "browser")
    XCTAssertEqual(added.repro, id)
    XCTAssertTrue(added.late)
    XCTAssertEqual(added.count, 2)
    let marked = try await recorder.mark(label: "Receipt shown", outcome: .fail, kind: .check, by: "Codex")
    XCTAssertTrue(marked.late)
    XCTAssertEqual(marked.marker.t, 2, accuracy: 0.01, "Pinned to the end of the video")

    let saved = try XCTUnwrap(recorder.sessions.first { $0.id == id })
    XCTAssertEqual(saved.lineCount, 3)
    XCTAssertEqual(saved.errorCount, 1)
    let lines = store.loadLines(id)
    let error = try XCTUnwrap(lines.first { $0.text.contains("price is undefined") })
    XCTAssertEqual(error.t, 1, accuracy: 0.01, "Placed by its clock time")
    XCTAssertNil(error.offscreen)
    XCTAssertEqual(saved.firstErrorLine, error.id)
    let unload = try XCTUnwrap(lines.first { $0.text.contains("unload") })
    XCTAssertEqual(unload.t, 2, accuracy: 0.01)
    XCTAssertEqual(unload.offscreen, true, "Reported after the video ended")
    XCTAssertEqual(Set(lines.map(\.id)).count, 3, "Ids stay unique")
    XCTAssertEqual(ReproSummary(session: saved, lines: lines).verdict, .failed)
    let log = try String(contentsOf: store.logURL(id), encoding: .utf8)
    XCTAssertTrue(log.contains("[00:01.000") && log.contains("ERROR  Uncaught TypeError: price is undefined"), log)
    XCTAssertTrue(log.contains("Receipt shown  [FAIL]"), log)
    let reloaded = await recorder.lines(for: id)
    XCTAssertEqual(reloaded.count, 3, "The line cache sees the amendment")

    // An explicit id reaches any saved repro.
    let explicit = try await recorder.append([.init(text: "follow-up")], source: "agent", to: String(id.uuidString.prefix(8)))
    XCTAssertEqual(explicit.repro, id)
  }

  func testCaptureThatStopsOnItsOwnIsMarked() async throws {
    recorder.expect(agentRequest())
    let start = Date().addingTimeInterval(-2)
    events.send(.started(start))
    events.send(.firstFrame(start))
    // The recorded browser window was closed before the recording stopped.
    events.send(.interrupted(start.addingTimeInterval(0.2), "The window was closed"))
    let stopped = try await stopImmediately()
    let saved = try XCTUnwrap(stopped)
    let marker = try XCTUnwrap(saved.markers.first { $0.label == "Screen capture stopped" })
    XCTAssertEqual(marker.detail, "The window was closed. The video holds its last frame until the recording stops.")
    XCTAssertEqual(marker.t, 0.2, accuracy: 0.01)
    XCTAssertEqual(ReproSummary(session: saved, lines: []).verdict, .clean, "Information, not a failure")
  }

  func testStopWithoutVideoKeepsTheLog() async throws {
    try await load("[tasks.noop]\ncmd = \"true\"\n")
    recorder.expect(agentRequest())
    events.send(.started(Date()))
    try recorder.appendExternal([.init(text: "Error: window was closed")], source: "agent")
    let stopped = try await stopImmediately(video: false)
    let saved = try XCTUnwrap(stopped, "The log is kept when there is no video")
    XCTAssertEqual(saved.status, .failed)
    XCTAssertNil(saved.videoPath)
    XCTAssertTrue(saved.detail?.contains("no video") == true)
    XCTAssertEqual(store.loadLines(saved.id).count, 1)
    let log = try String(contentsOf: store.logURL(saved.id), encoding: .utf8)
    XCTAssertTrue(log.contains("Video:      (not saved)") && log.contains("Note:       The recording produced no video"), log)

    // A toolbar recording with nothing captured is still just discarded.
    events.send(.started(Date()))
    let quiet = try XCTUnwrap(recorder.activeSessionID)
    let discarded = try await stopImmediately(video: false)
    XCTAssertNil(discarded)
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.folder(quiet).path))
  }

  func testTimelineIsPlacedFromTheFirstFrameAndTheVideoLength() async throws {
    recorder.expect(agentRequest())
    let start = Date().addingTimeInterval(-10)
    events.send(.started(start))
    // Output and a mark arrive before the first frame does.
    try recorder.appendExternal([.init(text: "Error: before the video", at: start.addingTimeInterval(0.3))], source: "app")
    try recorder.addMarker(label: "Open cart", at: start.addingTimeInterval(1))
    events.send(.firstFrame(start.addingTimeInterval(0.5)))
    try recorder.appendExternal([.init(text: "TypeError: in the video", at: start.addingTimeInterval(1.9))], source: "app")
    let stopped = try await stopRecordingAt(start.addingTimeInterval(2))
    let saved = try XCTUnwrap(stopped)
    XCTAssertEqual(saved.duration, 1.5, accuracy: 0.01)
    let lines = store.loadLines(saved.id)
    let early = try XCTUnwrap(lines.first { $0.text.contains("before the video") })
    XCTAssertEqual(early.t, 0)
    XCTAssertEqual(early.offscreen, true)
    let late = try XCTUnwrap(lines.first { $0.text.contains("in the video") })
    XCTAssertEqual(late.t, 1.4, accuracy: 0.01)
    XCTAssertEqual(saved.markers.first?.t ?? -1, 0.5, accuracy: 0.01)
    XCTAssertEqual(saved.errorCount, 1, "Output from before the video is context, not an error of the recording")
    XCTAssertEqual(saved.firstErrorLine, late.id)
    XCTAssertEqual(saved.clock?.origin, start.addingTimeInterval(0.5))
  }

  private func stopRecordingAt(_ date: Date) async throws -> ReproSession? {
    let id = try XCTUnwrap(recorder.activeSessionID)
    events.send(.stopping(date))
    let url = root.appendingPathComponent("recording.mov")
    try Data("not a real movie".utf8).write(to: url)
    events.send(.finished(url))
    return await recorder.waitUntilSaved(id)
  }

  func testVideoSavedWhileItsReproSavesKeepsItsLog() async throws {
    try await load("[services.api]\ncmd = \"while true; do echo tick; sleep 0.05; done\"\n")
    await supervisor.start(stack: "shop", services: ["api"])
    try await until { self.supervisor.runtime("shop", "api").phase == .ready }
    events.send(.started(Date()))
    let id = try XCTUnwrap(recorder.activeSessionID)
    try await Task.sleep(nanoseconds: 400_000_000)
    events.send(.stopping(Date()))
    let temporary = root.appendingPathComponent("temp.mov"), saved = root.appendingPathComponent("Saved.mov")
    try Data("not a real movie".utf8).write(to: temporary)
    events.send(.finished(temporary))
    // Quick Access saves the video before the repro has finished saving.
    try FileManager.default.moveItem(at: temporary, to: saved)
    NotificationCenter.default.post(name: .captureSavedFromTemp, object: nil, userInfo: ["from": temporary, "to": saved])
    _ = await recorder.waitUntilSaved(id)
    try await until { self.recorder.sessions.first?.logFile == self.root.appendingPathComponent("Saved.log").path }
    XCTAssertEqual(recorder.sessions.first?.videoPath, saved.path)
    XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("Saved.log").path))
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

  func testToolbarRecordingsDefaultToNoWorkspace() async throws {
    try await load("[services.api]\ncmd = \"while true; do echo tick; sleep 0.1; done\"\n")
    await supervisor.start(stack: "shop", services: ["api"])
    try await until { self.supervisor.runtime("shop", "api").phase == .ready }

    let defaults = UserDefaults(suiteName: "ReproTests-default-\(UUID())")!
    let subject = PassthroughSubject<RecordingLifecycleEvent, Never>()
    let fresh = ReproRecorder(supervisor: supervisor, runner: runner, store: store, events: subject.eraseToAnyPublisher(),
      defaults: defaults, secrets: FixedSecrets(), snapshot: { _ in fatalError("Not used when no workspace is chosen") })
    XCTAssertEqual(fresh.scope, .off, "No workspace is chosen until someone picks one")
    subject.send(.started(Date()))
    XCTAssertNil(fresh.activeSessionID, "A running workspace is not captured unless it was chosen")
  }
}
