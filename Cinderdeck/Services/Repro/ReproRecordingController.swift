import AVFoundation
import AppKit
import Combine
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Records a screen or Chromium page without the selection toolbar, for agents
/// and one-click repros from Workspaces. The floating controls stay visible (and out of the
/// video) so the person at the Mac always sees that recording is on and can stop it.
@MainActor
final class ReproRecordingController: ObservableObject {
  static let shared = ReproRecordingController()

  struct Options: Sendable {
    var title: String?
    /// "main", or a 1-based display number.
    var display: String?
    /// Application name or window title to record instead of a display.
    var window: String?
    /// Exact window to record, from `repro.windows`. Takes precedence over `window`.
    var windowID: CGWindowID?
    var workspaces: Set<String>?
    var maxSeconds: Double = 300
    var systemAudio = false
    var note: String?
    var browser: BrowserReproOptions?
    var buildProof: WorkspaceBuildCaptureProof?
  }

  static let maximumSeconds: Double = 3600

  @Published private(set) var activeID: UUID?
  @Published private(set) var activeActor: StackActor?
  @Published private(set) var linkedRun: UUID?

  private let recorder = ScreenRecordingManager.shared
  private let repros = ReproRecorder.shared
  private var autoStop: Task<Void, Never>?
  private var runWatch: AnyCancellable?
  private var stopping = false
  private var starting = false
  private var browser: BrowserReproCapture?
  @Published private(set) var browserInfo: BrowserReproCapture.Info?

  var ownsRecording: Bool { activeID != nil }
  var isBusy: Bool { starting || ownsRecording }
  var isPaused: Bool { repros.live?.isPaused ?? recorder.isPaused }

  // MARK: Start

  func start(_ options: Options, origin: ReproOrigin, actor: StackActor) async throws -> ReproSession {
    guard recorder.state == .idle, !RecordingCoordinator.shared.isActive, !isBusy else {
      throw StackControlError(code: "busy", message: "Another recording is in progress. Stop it first.")
    }
    starting = true
    defer { starting = false }
    if let browserOptions = options.browser { return try await startBrowser(options, browserOptions: browserOptions, origin: origin, actor: actor) }
    let target = try await resolveTarget(options)
    // A toolbar recording that just stopped may still be saving its log; this one would get no log.
    if let previous = repros.stoppingSessionID { _ = await repros.waitUntilSaved(previous) }
    let id = UUID()
    let store = repros.store
    do { try store.prepare(id) } catch { throw StackControlError(code: "failed", message: "Could not create the repro folder: \(error.localizedDescription)") }
    let request = ReproRequest(id: id, title: options.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
      origin: origin, actor: actor, workspaces: options.workspaces, capture: target.description, note: options.note, buildProof: options.buildProof)
    repros.expect(request)
    var fps = UserDefaults.standard.integer(forKey: PreferencesKeys.recordingFPS)
    if fps <= 0 { fps = 30 }
    let quality = VideoQuality(rawValue: UserDefaults.standard.string(forKey: PreferencesKeys.recordingQuality) ?? "high") ?? .high
    do {
      try await recorder.prepareRecording(rect: target.rect, windowTarget: target.window, format: .mp4, quality: quality, fps: fps,
        captureSystemAudio: options.systemAudio, captureMicrophone: false, showCursor: true,
        saveDirectory: store.folder(id), fileName: "recording", excludeOwnApplication: true,
        followsWindowTarget: target.window != nil, includesWindowTargetApplication: target.window != nil)
      try await recorder.startRecording()
    } catch {
      repros.clearExpectation(id)
      if recorder.state != .idle { await recorder.cancelRecording() }
      try? store.delete(id)
      throw StackControlError(code: "recording_failed", message: Self.explain(error))
    }
    guard let session = repros.current(id) else {
      await recorder.cancelRecording()
      try? store.delete(id)
      throw StackControlError(code: "failed", message: repros.lastError ?? "Repro capture could not start")
    }
    activeID = id
    activeActor = actor
    scheduleStop(id: id, maxSeconds: options.maxSeconds)
    ReproControlsPanel.shared.showRecording()
    return session
  }

  private func scheduleStop(id: UUID, maxSeconds: Double) {
    let limit = min(max(maxSeconds, 3), Self.maximumSeconds)
    autoStop = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000))
      guard !Task.isCancelled, let self, self.activeID == id else { return }
      _ = try? self.repros.addMarker(label: "Time limit reached", detail: "Stopped after \(Int(limit))s", kind: .note, by: "Cinderdeck")
      _ = try? await self.stop()
    }
  }

  private func startBrowser(_ options: Options, browserOptions: BrowserReproOptions, origin: ReproOrigin, actor: StackActor) async throws -> ReproSession {
    if let previous = repros.stoppingSessionID { _ = await repros.waitUntilSaved(previous) }
    let id = UUID()
    try repros.store.prepare(id)
    let capture = BrowserReproCapture(options: browserOptions,
      videoURL: repros.store.folder(id).appendingPathComponent("recording.mp4"),
      onLog: { [weak self] logs in
        await self?.receiveBrowserLogs(logs, id: id)
      }, onDisconnect: { [weak self] reason in
        await self?.browserDisconnected(reason, id: id)
      })
    let info: BrowserReproCapture.Info
    do { info = try await capture.prepare() }
    catch { await capture.cancel(); try? repros.store.delete(id); throw error }
    browser = capture; browserInfo = info
    activeID = id; activeActor = actor
    let request = ReproRequest(id: id, title: options.title, origin: origin, actor: actor,
      workspaces: options.workspaces, capture: "Browser: \(info.url)", note: options.note)
    repros.beginBrowser(request, at: Date())
    do {
      guard repros.current(id) != nil else { throw StackControlError(code: "recording_failed", message: repros.lastError ?? "Could not start the browser log") }
      scheduleStop(id: id, maxSeconds: options.maxSeconds)
      let firstFrame = try await capture.start()
      repros.browserEvent(.firstFrame(firstFrame), id: id)
      ReproControlsPanel.shared.showRecording()
      if let url = browserOptions.url { try await capture.navigate(url) }
      guard activeID == id, let session = repros.current(id) else { throw StackControlError(code: "browser_disconnected", message: "The browser closed while recording started") }
      return session
    } catch {
      if activeID == id, repros.activeSessionID == id {
        repros.captureFailed(error.localizedDescription)
        _ = try? await stop()
      }
      else {
        // A user may stop/cancel while the first frame or navigation is starting.
        // Preserve a saved repro, and clean up only this browser instance.
        await capture.cancel()
        if activeID == id { browser = nil; browserInfo = nil; activeID = nil; activeActor = nil }
        if repros.current(id) == nil { try? repros.store.delete(id) }
      }
      throw StackControlError(code: "browser_failed", message: "\(error.localizedDescription). Repro: \(id.uuidString)")
    }
  }

  private func receiveBrowserLogs(_ logs: [BrowserReproCapture.Log], id: UUID) {
    guard repros.activeSessionID == id else { return }
    for source in ["browser", "network"] {
      let entries = logs.filter { $0.source == source }.map { ReproRecorder.ExternalLine(text: $0.text, at: $0.at, level: $0.level) }
      for offset in stride(from: 0, to: entries.count, by: ReproRecorder.externalBatchLimit) {
        _ = try? repros.appendExternal(Array(entries[offset..<min(offset + ReproRecorder.externalBatchLimit, entries.count)]), source: source)
      }
    }
  }

  private func browserDisconnected(_ reason: String, id: UUID) {
    guard activeID == id, !stopping else { return }
    repros.captureFailed(reason)
    // Do not await stop in the CDP reader: stop needs that reader to finish commands.
    Task { [weak self] in
      guard let self, self.activeID == id else { return }
      _ = try? await self.stop()
    }
  }

  func togglePause() async {
    guard !stopping else { return }
    if let browser, let id = activeID {
      let date = Date(), paused = !isPaused
      await browser.setPaused(paused, at: date)
      repros.browserEvent(paused ? .paused(date) : .resumed(date), id: id)
    } else { recorder.togglePause() }
  }

  /// Agents can use these small controls, or drive the returned CDP endpoint with their own tools.
  func browserAction(url: String?, expression: String?, screenshot: Bool) async throws -> JSONValue {
    guard let browser, let id = activeID, !stopping else { throw StackControlError.notFound("No browser repro is recording. Start with headless or cdp.") }
    guard url == nil || expression == nil else { throw StackControlError.invalid("Pass url or expression, not both") }
    do {
      var result: [String: JSONValue] = ["repro": .string(id.uuidString)]
      if let url {
        _ = try repros.addMarker(label: "Navigate to \(BrowserReproOptions.logURL(url))", kind: .note, by: activeActor?.label)
        try await browser.navigate(url)
      } else if let expression {
        _ = try repros.addMarker(label: "Browser action", kind: .note, by: activeActor?.label)
        result["result"] = try await browser.evaluate(expression)
      } else {
        result["page"] = try await browser.evaluate("""
          ({url: location.href, title: document.title, ready: document.readyState,
            text: (document.body?.innerText || '').slice(0, 16000),
            controls: [...document.querySelectorAll('a,button,input,select,textarea,[role="button"]')].slice(0, 100)
              .map(e => ({tag: e.tagName.toLowerCase(), id: e.id, name: e.getAttribute('name'),
                text: (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '').slice(0, 160)}))})
          """)
      }
      if screenshot {
        let data = try await browser.screenshot()
        let path = repros.store.framesFolder(id).appendingPathComponent("browser-live.jpg")
        try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try data.write(to: path, options: .atomic)
        let source = CGImageSourceCreateWithData(data as CFData, nil)
        let properties = source.flatMap { CGImageSourceCopyPropertiesAtIndex($0, 0, nil) as? [CFString: Any] }
        result["frames"] = .array([.object(["imageBase64": .string(data.base64EncodedString()), "mimeType": .string("image/jpeg"),
          "path": .string(path.path), "t": .number(repros.now), "time": .string(ReproFormat.timestamp(repros.now)),
          "width": .number(Double(properties?[kCGImagePropertyPixelWidth] as? Int ?? 0)),
          "height": .number(Double(properties?[kCGImagePropertyPixelHeight] as? Int ?? 0))])])
      }
      return .object(result)
    } catch {
      if activeID == id {
        _ = try? repros.addMarker(label: "Browser action failed", detail: error.localizedDescription,
          outcome: .fail, kind: .check, by: activeActor?.label)
      }
      throw error
    }
  }

  /// Records while a task or workflow runs, then stops a moment after it finishes.
  func startRun(_ options: Options, workspace: String, kind: WorkspaceRunKind, definitionID: String, actor: StackActor,
    runner: WorkspaceRunner, origin: ReproOrigin = .agent) async throws -> (ReproSession, WorkspaceRun) {
    var options = options
    // The run's own workspace is always captured, alongside any others asked for.
    options.workspaces = (options.workspaces ?? []).union([workspace])
    if options.title == nil {
      let definition = runner.supervisor.definition(workspace)
      let name = kind == .task ? definition?.task(definitionID)?.name : definition?.workflow(definitionID)?.name
      options.title = "\(name ?? definitionID) · \(definition?.name ?? workspace)"
    }
    options.maxSeconds = max(options.maxSeconds, 60)
    let session = try await start(options, origin: origin, actor: actor)
    // Let the first frames land so the run's first output is visible in the video.
    try? await Task.sleep(nanoseconds: 700_000_000)
    await runner.recover()
    guard activeID == session.id, !stopping else {
      throw StackControlError(code: "recording_stopped", message: "The recording stopped before the task could start. The task was not launched.")
    }
    let run: WorkspaceRun
    var environment: [String: String] = [:]
    if let browserInfo {
      environment = ["CINDERDECK_BROWSER_ENDPOINT": browserInfo.endpoint.absoluteString,
        "CINDERDECK_BROWSER_PAGE_ID": browserInfo.pageID, "CINDERDECK_REPRO": session.id.uuidString]
    }
    do { run = try runner.submit(workspace: workspace, kind: kind, definitionID: definitionID, actor: actor, environment: environment) }
    catch {
      await cancel()
      throw StackControlError(code: "run_failed", message: error.localizedDescription)
    }
    linkedRun = run.id
    runWatch = runner.$runs.sink { [weak self] runs in
      guard let self, let current = runs.first(where: { $0.id == run.id }), !current.status.isActive else { return }
      self.runWatch = nil
      Task { @MainActor [weak self] in
        // Keep the result on screen briefly before stopping.
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard let self, self.activeID == session.id else { return }
        _ = try? await self.stop()
      }
    }
    return (session, run)
  }

  // MARK: Stop

  @discardableResult
  func stop() async throws -> ReproSession {
    guard let id = activeID else { throw StackControlError.notFound("No repro is recording") }
    guard !stopping else {
      if let saved = await repros.waitUntilSaved(id) { return saved }
      throw StackControlError.notFound("The repro is already stopping")
    }
    stopping = true
    defer { stopping = false }
    autoStop?.cancel(); autoStop = nil
    runWatch = nil
    ReproControlsPanel.shared.showFinalizing()
    if let browser {
      let date = Date()
      repros.browserEvent(.stopping(date), id: id)
      do { repros.browserEvent(.finished(try await browser.stop(at: date)), id: id) }
      catch {
        repros.captureFailed(error.localizedDescription)
        repros.browserEvent(.noVideo, id: id)
      }
    } else { _ = await recorder.stopRecording() }
    // Saved even without a video: the log is kept, and its detail says what happened.
    let saved = await repros.waitUntilSaved(id)
    activeID = nil; activeActor = nil; linkedRun = nil; browser = nil; browserInfo = nil
    guard let saved else {
      ReproControlsPanel.shared.hide()
      throw StackControlError(code: "recording_failed", message: "The recording produced no video. Check Screen Recording permission for Cinderdeck.")
    }
    ReproControlsPanel.shared.showSaved(saved)
    return saved
  }

  func cancel() async {
    guard let id = activeID, !stopping else { return }
    stopping = true
    defer { stopping = false }
    autoStop?.cancel(); autoStop = nil
    runWatch = nil
    if let browser {
      await browser.cancel()
      repros.browserEvent(.cancelled, id: id)
      _ = await repros.waitUntilSaved(id)
    } else { await recorder.cancelRecording() }
    activeID = nil; activeActor = nil; linkedRun = nil; browser = nil; browserInfo = nil
    ReproControlsPanel.shared.hide()
  }

  // MARK: Targets

  private struct Target {
    let rect: CGRect
    let window: WindowCaptureTarget?
    let description: String
  }

  /// Windows that can be recorded, frontmost first.
  func windows() async throws -> [WindowSelectionCandidate] {
    guard let snapshot = await WindowSelectionQueryService.prepareSnapshot(prefetchedContentTask: nil, excludeOwnApplication: true) else {
      throw StackControlError(code: "recording_failed", message: "Could not list windows. Check Screen Recording permission for Cinderdeck.")
    }
    return snapshot.orderedCandidates.filter { $0.target.kind == .normal }
  }

  private func resolveTarget(_ options: Options) async throws -> Target {
    if let windowID = options.windowID {
      guard let match = try await windows().first(where: { $0.target.windowID == windowID }) else {
        throw StackControlError.notFound("Window \(windowID) is not visible. Run `cinderdeck repro windows` (MCP list_repro_windows) for current ids; ids change when a window is closed and reopened.")
      }
      let title = match.target.title.map { " — \($0)" } ?? ""
      return Target(rect: match.target.frame, window: match.target, description: "Window: \(match.ownerName)\(title)")
    }
    if let query = options.window?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
      let candidates = try await windows()
      let lower = query.lowercased()
      func owner(_ candidate: WindowSelectionCandidate) -> String { candidate.ownerName.lowercased() }
      func title(_ candidate: WindowSelectionCandidate) -> String { (candidate.target.title ?? "").lowercased() }
      let match = candidates.first { owner($0) == lower } ?? candidates.first { title($0) == lower }
        ?? candidates.first { owner($0).contains(lower) } ?? candidates.first { title($0).contains(lower) }
      guard let match else {
        let names = candidates.map(\.ownerName).reduce(into: [String]()) { if !$1.isEmpty && !$0.contains($1) { $0.append($1) } }
        throw StackControlError.notFound("No visible window matches \"\(query)\". Visible apps: \(names.prefix(15).joined(separator: ", ")). Run `cinderdeck repro windows` to see titles and ids.")
      }
      let title = match.target.title.map { " — \($0)" } ?? ""
      return Target(rect: match.target.frame, window: match.target, description: "Window: \(match.ownerName)\(title)")
    }
    let screens = NSScreen.screens
    guard !screens.isEmpty else { throw StackControlError(code: "recording_failed", message: "No display is available") }
    var screen = NSScreen.main ?? screens[0]
    var number = (screens.firstIndex(of: screen) ?? 0) + 1
    if let value = options.display?.trimmingCharacters(in: .whitespaces).lowercased(), !value.isEmpty, value != "main" {
      guard let index = Int(value), (1...screens.count).contains(index) else {
        throw StackControlError.invalid("display must be \"main\" or 1–\(screens.count)")
      }
      screen = screens[index - 1]; number = index
    }
    let scale = screen.backingScaleFactor
    let size = "\(Int(screen.frame.width * scale))×\(Int(screen.frame.height * scale))"
    return Target(rect: screen.frame, window: nil, description: screens.count > 1 ? "Display \(number) (\(size))" : "Screen (\(size))")
  }

  private static func explain(_ error: Error) -> String {
    if let error = error as? RecordingError, case .permissionDenied = error {
      return "Cinderdeck needs Screen Recording permission. Grant it in System Settings → Privacy & Security → Screen & System Audio Recording, then try again."
    }
    return error.localizedDescription
  }
}

private extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - Frames

/// Still frames from a repro video, for agents to look at and for exports.
nonisolated enum ReproFrames {
  struct Frame: Sendable {
    let url: URL
    let data: Data
    let t: Double
    let width: Int
    let height: Int
  }

  /// Frames at `seconds`, saved as JPEGs in `folder`. `names` (without extension) replaces
  /// the default `frame-<ms>ms` file names, one per moment.
  static func extract(video: URL, at seconds: [Double], maxDimension: Int, into folder: URL, names: [String]? = nil) async throws -> [Frame] {
    let asset = AVURLAsset(url: video)
    let duration = try await asset.load(.duration).seconds
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: maxDimension, height: maxDimension)
    let tolerance = CMTime(seconds: 0.05, preferredTimescale: 600)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var frames: [Frame] = []
    for (index, value) in seconds.enumerated() {
      // The very last instant has no frame; step just inside the video.
      let t = min(max(0, value), max(0, (duration.isFinite ? duration : value) - 0.05))
      let (image, _) = try await generator.image(at: CMTime(seconds: t, preferredTimescale: 600))
      let data = NSMutableData()
      guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw StackError.message("Could not encode the frame")
      }
      CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
      guard CGImageDestinationFinalize(destination) else { throw StackError.message("Could not encode the frame") }
      let name = names.flatMap { index < $0.count ? $0[index] : nil } ?? "frame-\(Int((t * 1000).rounded()))ms"
      let url = folder.appendingPathComponent(name + ".jpg")
      try (data as Data).write(to: url, options: .atomic)
      frames.append(Frame(url: url, data: data as Data, t: t, width: image.width, height: image.height))
    }
    return frames
  }
}

// MARK: - Export

@MainActor
enum ReproExport {
  static var defaultDestination: URL {
    (FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
      ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads"))
      .appendingPathComponent("Cinderdeck Repros", isDirectory: true)
  }

  /// Writes the bundle, with frames at the first error, each failure, and the end when
  /// the video is available. Returns the folder, or the .zip when `zip` is true.
  static func export(_ session: ReproSession, to destination: URL? = nil, zip: Bool = false, includeVideo: Bool = true) async throws -> URL {
    let recorder = ReproRecorder.shared
    let lines = await recorder.lines(for: session.id)
    let store = recorder.store
    let staging = FileManager.default.temporaryDirectory.appendingPathComponent("cinderdeck-export-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: staging) }
    var frames: [ReproBundleExporter.FrameFile] = []
    if let video = session.videoURL, FileManager.default.fileExists(atPath: video.path) {
      let moments = ReproBundleExporter.frameMoments(session, lines: lines)
      let names = moments.enumerated().map { index, moment in
        String(format: "%02d-", index + 1) + ReproReport.slug(moment.label, fallback: "frame") + "-" + ReproFormat.timestamp(moment.t).replacingOccurrences(of: ":", with: "m") + "s"
      }
      if let extracted = try? await ReproFrames.extract(video: video, at: moments.map(\.t), maxDimension: 1600, into: staging, names: names) {
        frames = Swift.zip(extracted, moments).map { ReproBundleExporter.FrameFile(url: $0.url, t: $0.t, label: $1.label) }
      }
    }
    let parent = destination ?? defaultDestination
    let result = try await Task.detached {
      try ReproBundleExporter.export(session, lines: lines, store: store, to: parent, includeVideo: includeVideo, frames: frames)
    }.value
    guard zip else { return result.folder }
    let archive = result.folder.appendingPathExtension("zip")
    let status = try await Task.detached { () -> Int32 in
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
      process.arguments = ["-c", "-k", "--sequesterRsrc", "--keepParent", result.folder.path, archive.path]
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus
    }.value
    guard status == 0 else { throw StackError.message("Could not create the zip archive (ditto exited with \(status))") }
    try? FileManager.default.removeItem(at: result.folder)
    return archive
  }

  /// What to hand an agent: the README first, then the stamped log, frames, and diffs.
  /// The video is not copied; it is handed over from where it was saved.
  struct Handoff: Equatable {
    let folder: URL
    let files: [URL]
    let video: URL?
    /// The video first, then everything else.
    var allFiles: [URL] { (video.map { [$0] } ?? []) + files }
  }

  /// A video-less bundle kept in the repro's own folder, rebuilt when the recording
  /// changes, so dragging it to an agent never waits on frame extraction.
  static func handoff(_ session: ReproSession) async throws -> Handoff {
    let manager = FileManager.default
    let root = ReproRecorder.shared.store.folder(session.id).appendingPathComponent("handoff", isDirectory: true)
    let stamp = root.appendingPathComponent(".stamp")
    let key = [session.status.rawValue, session.title, "\(session.lineCount)", "\(session.markers.count)", "\(session.duration)", session.videoPath ?? ""]
      .joined(separator: "|")
    if (try? String(contentsOf: stamp, encoding: .utf8)) == key,
      let folder = try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil, options: .skipsHiddenFiles).first(where: \.hasDirectoryPath) {
      return handoffFiles(in: folder, session: session)
    }
    try? manager.removeItem(at: root)
    let folder = try await export(session, to: root, includeVideo: false)
    let readme = folder.appendingPathComponent("README.md")
    if let handle = try? FileHandle(forWritingTo: readme) {
      handle.seekToEndOfFile()
      handle.write(Data("\n---\nCinderdeck repro id: `\(session.id.uuidString)`. With the Cinderdeck MCP server, `repro_frame` pulls a still at any time and `repro_logs` reads lines around it.\n".utf8))
      try? handle.close()
    }
    try key.write(to: stamp, atomically: true, encoding: .utf8)
    return handoffFiles(in: folder, session: session)
  }

  private static func handoffFiles(in folder: URL, session: ReproSession) -> Handoff {
    let manager = FileManager.default
    func sorted(_ name: String) -> [URL] {
      ((try? manager.contentsOfDirectory(at: folder.appendingPathComponent(name, isDirectory: true), includingPropertiesForKeys: nil, options: .skipsHiddenFiles)) ?? [])
        .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }
    let files = [folder.appendingPathComponent("README.md"), folder.appendingPathComponent("recording.log")]
      .filter { manager.fileExists(atPath: $0.path) } + sorted("frames") + sorted("git")
    let video = session.videoURL.flatMap { manager.fileExists(atPath: $0.path) ? $0 : nil }
    return Handoff(folder: folder, files: files, video: video)
  }
}
