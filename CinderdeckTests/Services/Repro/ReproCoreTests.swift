import XCTest
@testable import Cinderdeck

final class ReproCoreTests: XCTestCase {
  private let agent = StackActor(kind: .agent, name: "Codex", session: "t1")

  private func line(_ id: Int, _ t: Double, _ source: String, _ text: String, offscreen: Bool? = nil) -> ReproLogLine {
    ReproLogLine(id: id, t: t, at: Date(timeIntervalSince1970: 1_000 + t), source: source, text: text,
      level: ReproLogLevel.classify(text), offscreen: offscreen)
  }

  private func session(lines: [ReproLogLine] = [], markers: [ReproMarker] = []) -> ReproSession {
    var session = ReproSession(title: "Checkout fails", origin: .agent, actor: agent)
    session.duration = 30
    session.sources = [
      ReproSource(id: "shop/api", kind: .service, workspace: "shop", workspaceName: "Shop", name: "api"),
      ReproSource(id: "shop/web", kind: .service, workspace: "shop", workspaceName: "Shop", name: "web"),
    ]
    session.markers = markers
    session.lineCount = lines.count
    session.errorCount = lines.filter { $0.level == .error }.count
    session.warningCount = lines.filter { $0.level == .warning }.count
    session.firstErrorLine = lines.first { $0.level == .error }?.id
    return session
  }

  // MARK: Classification

  func testClassifiesErrorsWarningsAndDebug() {
    XCTAssertEqual(ReproLogLevel.classify("TypeError: cannot read properties of undefined"), .error)
    XCTAssertEqual(ReproLogLevel.classify("Unhandled promise rejection"), .error)
    XCTAssertEqual(ReproLogLevel.classify("panic: runtime error: index out of range"), .error)
    XCTAssertEqual(ReproLogLevel.classify("  ✖ 2 problems"), .error)
    XCTAssertEqual(ReproLogLevel.classify("(node:1) DeprecationWarning: Buffer() is deprecated"), .warning)
    XCTAssertEqual(ReproLogLevel.classify("[debug] cache miss for /api/cart"), .debug)
    XCTAssertEqual(ReproLogLevel.classify("Server listening on http://localhost:3000"), .info)
  }

  func testIgnoresZeroErrorSummariesAndSubstrings() {
    XCTAssertEqual(ReproLogLevel.classify("Found 0 errors. Watching for file changes."), .info)
    XCTAssertEqual(ReproLogLevel.classify("Tests: 12 passed, 0 failed"), .info)
    XCTAssertEqual(ReproLogLevel.classify("compiled without errors"), .info)
    XCTAssertEqual(ReproLogLevel.classify("loading terrorbird.png"), .info)
  }

  func testClassifiesHTTPStatus() {
    XCTAssertEqual(ReproLogLevel.classify("POST /api/checkout 500 12ms"), .error)
    XCTAssertEqual(ReproLogLevel.classify("GET /favicon.ico 404 1ms"), .warning)
    XCTAssertEqual(ReproLogLevel.classify("GET /api/cart 200 4ms"), .info)
    XCTAssertTrue(ReproLogLevel.warning < .error && ReproLogLevel.debug < .info)
  }

  // MARK: Clock

  func testClockStartsAtFirstFrameAndRemovesPauses() {
    let start = Date(timeIntervalSince1970: 100)
    var clock = ReproClock(start: start)
    clock.firstFrame(at: start.addingTimeInterval(0.5))
    clock.firstFrame(at: start.addingTimeInterval(9))  // Ignored: only the first frame counts.
    XCTAssertEqual(clock.position(at: start).t, 0)
    XCTAssertFalse(clock.position(at: start).visible)
    XCTAssertEqual(clock.position(at: start.addingTimeInterval(2.5)).t, 2, accuracy: 0.0001)

    clock.pause(at: start.addingTimeInterval(4.5))   // t = 4
    let paused = clock.position(at: start.addingTimeInterval(6))
    XCTAssertEqual(paused.t, 4, accuracy: 0.0001)
    XCTAssertFalse(paused.visible)
    XCTAssertTrue(clock.isPaused)
    clock.resume(at: start.addingTimeInterval(10.5))  // six seconds removed
    let after = clock.position(at: start.addingTimeInterval(12.5))
    XCTAssertEqual(after.t, 6, accuracy: 0.0001)
    XCTAssertTrue(after.visible)

    clock.stop(at: start.addingTimeInterval(15.5))
    XCTAssertEqual(clock.duration, 9, accuracy: 0.0001)
    let late = clock.position(at: start.addingTimeInterval(20))
    XCTAssertEqual(late.t, 9, accuracy: 0.0001)
    XCTAssertFalse(late.visible)
  }

  func testStopWhilePausedClosesPause() {
    let start = Date(timeIntervalSince1970: 0)
    var clock = ReproClock(start: start)
    clock.pause(at: start.addingTimeInterval(3))
    clock.stop(at: start.addingTimeInterval(8))
    XCTAssertFalse(clock.isPaused)
    XCTAssertEqual(clock.duration, 3, accuracy: 0.0001)
  }

  // MARK: Formatting and queries

  func testTimestampsRoundTrip() {
    XCTAssertEqual(ReproFormat.timestamp(75.25), "01:15.250")
    XCTAssertEqual(ReproFormat.timestamp(3725, precise: false), "1:02:05")
    XCTAssertEqual(ReproFormat.parseTime("1:15.25"), 75.25)
    XCTAssertEqual(ReproFormat.parseTime("12.5s"), 12.5)
    XCTAssertEqual(ReproFormat.parseTime("0:01:02"), 62)
    XCTAssertNil(ReproFormat.parseTime("soon"))
    XCTAssertEqual(ReproFormat.duration(125), "2m 5s")
  }

  func testQueryFiltersByTimeSourceLevelAndText() {
    let lines = [
      line(1, 1, "shop/api", "listening on 4000"),
      line(2, 4, "shop/web", "GET /cart 200"),
      line(3, 5, "shop/api", "Error: payment declined"),
      line(4, 5.5, "shop/api", "retrying payment"),
      line(5, 12, "shop/web", "Unhandled error in checkout"),
    ]
    let session = session(lines: lines)
    XCTAssertEqual(ReproLogQuery.around(5, window: 1).filter(lines).map(\.id), [2, 3, 4])
    XCTAssertEqual(ReproLogQuery(minimumLevel: .warning).filter(lines).map(\.id), [3, 4, 5])
    XCTAssertEqual(ReproLogQuery(sources: ["api"]).filter(lines, session: session).map(\.id), [1, 3, 4])
    XCTAssertEqual(ReproLogQuery(text: "PAYMENT").filter(lines).map(\.id), [3, 4])
    XCTAssertEqual(ReproLogQuery(text: "^(GET|POST) ").filter(lines).map(\.id), [2])
    XCTAssertEqual(ReproLogQuery(limit: 2).filter(lines).map(\.id), [1, 2])
    XCTAssertEqual(reproLineIndex(atOrBefore: 5.2, in: lines), 2)
    XCTAssertNil(reproLineIndex(atOrBefore: 0.5, in: lines))
  }

  func testQueryCanExcludeOffscreenLines() {
    let lines = [line(1, 0, "shop/api", "before recording", offscreen: true), line(2, 1, "shop/api", "visible")]
    XCTAssertEqual(ReproLogQuery(includeOffscreen: false).filter(lines).map(\.id), [2])
  }

  // MARK: Summary and report

  func testSummaryVerdicts() {
    let clean = session(lines: [line(1, 1, "shop/api", "ok")])
    XCTAssertEqual(ReproSummary(session: clean, lines: [line(1, 1, "shop/api", "ok")]).verdict, .clean)

    let noisyLines = [line(1, 2, "shop/api", "Error: timeout 1"), line(2, 3, "shop/api", "Error: timeout 2"), line(3, 4, "shop/web", "TypeError: x")]
    let noisy = ReproSummary(session: session(lines: noisyLines), lines: noisyLines)
    XCTAssertEqual(noisy.verdict, .errors)
    XCTAssertEqual(noisy.firstError?.time, "00:02.000")
    XCTAssertEqual(noisy.topErrors.count, 2, "Messages that differ only in numbers are grouped")

    let crash = ReproMarker(t: 6, at: Date(), kind: .serviceCrashed, label: "api crashed", outcome: .fail)
    let check = ReproMarker(t: 7, at: Date(), kind: .check, label: "Cart shows total", outcome: .fail)
    let failed = ReproSummary(session: session(markers: [crash, check]), lines: [])
    XCTAssertEqual(failed.verdict, .failed)
    XCTAssertEqual(failed.checksFailed, 1)
    XCTAssertTrue(failed.headline.contains("1 crash"))
  }

  func testMarkdownReportIncludesTimelineErrorsAndContext() {
    let lines = [line(1, 1, "shop/api", "listening"), line(2, 3, "shop/api", "Error: payment | declined")]
    var repro = session(lines: lines, markers: [ReproMarker(t: 2, at: Date(), kind: .note, label: "Clicked Pay")])
    repro.workspaces = [ReproWorkspaceContext(id: "shop", name: "Shop", root: "/src/shop", definitionFingerprint: "abc",
      environmentKeys: ["NODE_ENV"], secretKeys: ["STRIPE_KEY"],
      services: [ReproServiceState(name: "api", status: "Ready", command: "npm run dev", port: 4000)],
      repos: [ReproRepoState(id: "app", path: "/src/shop", branch: "main", head: "0123456789abcdef", changedFiles: ["src/pay.ts"], diffFile: "git/app.diff")])]
    let markdown = ReproReport.markdown(repro, lines: lines, videoFile: "recording.mov")
    XCTAssertTrue(markdown.contains("# Checkout fails"))
    XCTAssertTrue(markdown.contains("| 00:02.000 | Clicked Pay |"))
    XCTAssertTrue(markdown.contains("`00:03.000` **api**"))
    XCTAssertTrue(markdown.contains("Output around the first error"))
    XCTAssertTrue(markdown.contains("`main` @ `0123456789ab`"))
    XCTAssertTrue(markdown.contains("NODE_ENV"))
    XCTAssertFalse(markdown.contains("STRIPE_KEY="))

    let timeline = ReproReport.timeline(repro, lines: lines)
    XCTAssertEqual(timeline.split(separator: "\n").map(String.init),
      ["[00:01.000] api | listening", "[00:02.000] ▶ Clicked Pay", "[00:03.000] api | Error: payment | declined"])
  }

  // MARK: Log file

  func testLogFileStampsVideoAndClockTimeAndExplainsItself() {
    let base = Date(timeIntervalSince1970: 1_790_000_000.25)
    var lines = [
      line(1, 0, "shop/api", "listening on 4000", offscreen: true),
      line(2, 1.5, "shop/web", "GET /cart 200"),
      line(3, 3.125, "shop/api", "Error: payment declined"),
    ]
    for index in lines.indices { lines[index].at = base.addingTimeInterval(lines[index].t) }
    var repro = session(lines: lines, markers: [
      ReproMarker(t: 3.125, at: base.addingTimeInterval(3.125), kind: .check, label: "Pay succeeds", detail: "spinner", outcome: .fail, by: "Codex"),
    ])
    repro.scope = "all running workspaces"
    repro.sources[0].lineCount = 2
    repro.sources[0].errorCount = 1
    repro.workspaces = [ReproWorkspaceContext(id: "billing", name: "Billing", root: "/b", definitionFingerprint: "", environmentKeys: [],
      secretKeys: [], services: [], repos: [])]
    let text = ReproReport.logFile(repro, lines: lines, videoName: "Recording.mov", timeZone: TimeZone(identifier: "UTC")!)
    let rows = text.components(separatedBy: "\n")
    XCTAssertTrue(text.hasPrefix("Cinderdeck workspace log"))
    XCTAssertTrue(rows.contains("Video:      Recording.mov"))
    XCTAssertTrue(rows.contains { $0.hasPrefix("Captured:   Billing and Shop (all running workspaces)") }, text)
    XCTAssertTrue(rows.contains { $0.hasPrefix("  Billing") && $0.contains("printed nothing") })
    XCTAssertTrue(rows.contains { $0.hasPrefix("  api") && $0.contains("2 lines, 1 error") })
    XCTAssertTrue(rows.contains("[00:00.000  14:13:20.250] ~ api  listening on 4000"), text)
    XCTAssertTrue(rows.contains("[00:01.500  14:13:21.750]   web  GET /cart 200"), text)
    let check = rows.firstIndex { $0.contains("▶ Pay succeeds — spinner  [FAIL]  (Codex)") }
    let error = rows.firstIndex { $0.hasSuffix("api  ERROR  Error: payment declined") }
    XCTAssertNotNil(check); XCTAssertNotNil(error)
    XCTAssertLessThan(check ?? 0, error ?? 0, "Events come before output at the same moment")
  }

  func testLogFileQualifiesSourcesWhenWorkspacesMix() {
    var repro = session()
    repro.sources.append(ReproSource(id: "billing/api", kind: .service, workspace: "billing", workspaceName: "Billing", name: "api"))
    XCTAssertEqual(ReproReport.sourceLabels(repro)["shop/api"], "shop/api")
    XCTAssertEqual(ReproReport.sourceLabels(repro)["billing/api"], "billing/api")
    XCTAssertEqual(ReproReport.sourceLabels(session())["shop/api"], "api")
    XCTAssertTrue(ReproReport.logFile(ReproSession(title: "x", origin: .recording, actor: .user), lines: [], videoName: nil).contains("(nothing was captured)"))
  }

  func testLinesAndMarkersKeepMillisecondClockTimes() throws {
    let date = Date(timeIntervalSince1970: 1_790_000_000.123)
    let entry = ReproLogLine(id: 1, t: 1.23456, at: date, source: "shop/api", text: "x", level: .info)
    let decoded = try StackControlCoding.decoder().decode(ReproLogLine.self, from: StackControlCoding.encoder().encode(entry))
    XCTAssertEqual(decoded.at.timeIntervalSince1970, 1_790_000_000.123, accuracy: 0.0005)
    XCTAssertEqual(decoded.t, 1.235, accuracy: 0.0001)
    let marker = ReproMarker(t: 2, at: date, kind: .note, label: "Mark")
    let restored = try StackControlCoding.decoder().decode(ReproMarker.self, from: StackControlCoding.encoder().encode(marker))
    XCTAssertEqual(restored.at.timeIntervalSince1970, 1_790_000_000.123, accuracy: 0.0005)
    XCTAssertEqual(restored.id, marker.id)
  }

  func testScopeChoices() {
    XCTAssertEqual(ReproLogScope(mode: nil, workspaces: nil), .running)
    XCTAssertEqual(ReproLogScope(mode: "off", workspaces: ["shop"]), .off)
    let selected = ReproLogScope(mode: "selected", workspaces: ["shop", "billing"])
    XCTAssertTrue(selected.includes("shop"))
    XCTAssertFalse(selected.includes("docs"))
    XCTAssertEqual(selected.mode, "selected")
    XCTAssertEqual(selected.workspaces, ["billing", "shop"])
    XCTAssertEqual(ReproLogScope.running.toggling("shop"), .only(["shop"]))
    XCTAssertEqual(ReproLogScope.only(["shop"]).toggling("shop"), .off)
    XCTAssertEqual(ReproLogScope.only(["shop"]).toggling("billing"), .only(["shop", "billing"]))
    XCTAssertTrue(ReproLogScope.only([]).isOff)
    XCTAssertFalse(ReproLogScope.off.includes("shop"))
    XCTAssertEqual(selected.summary(names: ["shop": "Shop", "billing": "Billing"]), "Billing and Shop")
    XCTAssertEqual(ReproFormat.list(["A", "B", "C"]), "A, B, and C")
  }

  func testRedactorReplacesSecretValues() {
    let redactor = ReproRedactor(secrets: ["STRIPE_KEY": "sk_test_12345", "PIN": "42"])
    XCTAssertEqual(redactor.redact("auth sk_test_12345 ok 42"), "auth [secret STRIPE_KEY] ok 42")
    XCTAssertEqual(ReproReport.slug("Checkout: fails on Safari!"), "checkout-fails-on-safari")
  }

  // MARK: Storage and export

  func testStoreRoundTripsAndToleratesPartialRows() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("repro-tests-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ReproStore(directory: root)
    let lines = [line(1, 2, "shop/api", "second"), line(2, 1, "shop/api", "first")]
    var repro = session(lines: lines)
    try store.save(repro)
    let writer = try ReproLineWriter(url: store.linesURL(repro.id))
    try writer.append(lines)
    writer.close()
    let handle = try FileHandle(forWritingTo: store.linesURL(repro.id))
    _ = try handle.seekToEnd()
    try handle.write(contentsOf: Data("{\"id\":3,\"t\":".utf8))
    try handle.close()

    XCTAssertEqual(store.loadLines(repro.id).map(\.text), ["first", "second"])
    repro.status = .ready
    try store.save(repro)
    XCTAssertEqual(store.loadSessions().first?.status, .ready)
    XCTAssertEqual(store.loadSession(repro.id)?.title, "Checkout fails")

    try FileManager.default.createDirectory(at: store.gitFolder(repro.id), withIntermediateDirectories: true)
    try "diff --git a/x b/x".write(to: store.gitFolder(repro.id).appendingPathComponent("app.diff"), atomically: true, encoding: .utf8)
    let exported = try ReproBundleExporter.export(repro, lines: store.loadLines(repro.id), store: store, to: root.appendingPathComponent("out"))
    let files = try FileManager.default.subpathsOfDirectory(atPath: exported.folder.path).sorted()
    XCTAssertEqual(files, ["README.md", "git", "git/app.diff", "logs", "logs/api.log", "logs/web.log", "recording.log", "repro.json", "summary.json"])
    let second = try ReproBundleExporter.export(repro, lines: [], store: store, to: root.appendingPathComponent("out"))
    XCTAssertNotEqual(second.folder, exported.folder)

    try store.delete(repro.id)
    XCTAssertTrue(store.loadSessions().isEmpty)
  }
}
