import AVFoundation
import AppKit
import Combine
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Records the screen without the selection toolbar, for agents and one-click
/// repros from Workspaces. The floating controls stay visible (and out of the
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
    var workspaces: Set<String>?
    var maxSeconds: Double = 300
    var systemAudio = false
    var note: String?
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

  var ownsRecording: Bool { activeID != nil }

  // MARK: Start

  func start(_ options: Options, origin: ReproOrigin, actor: StackActor) async throws -> ReproSession {
    guard recorder.state == .idle, !RecordingCoordinator.shared.isActive, activeID == nil else {
      throw StackControlError(code: "busy", message: "Another screen recording is in progress. Stop it first.")
    }
    let target = try await resolveTarget(options)
    let id = UUID()
    let store = repros.store
    do { try store.prepare(id) } catch { throw StackControlError(code: "failed", message: "Could not create the repro folder: \(error.localizedDescription)") }
    let request = ReproRequest(id: id, title: options.title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
      origin: origin, actor: actor, workspaces: options.workspaces, capture: target.description, note: options.note)
    repros.expect(request)
    var fps = UserDefaults.standard.integer(forKey: PreferencesKeys.recordingFPS)
    if fps <= 0 { fps = 30 }
    let quality = VideoQuality(rawValue: UserDefaults.standard.string(forKey: PreferencesKeys.recordingQuality) ?? "high") ?? .high
    do {
      try await recorder.prepareRecording(rect: target.rect, windowTarget: target.window, format: .mp4, quality: quality, fps: fps,
        captureSystemAudio: options.systemAudio, captureMicrophone: false, showCursor: true,
        saveDirectory: store.folder(id), fileName: "recording", excludeOwnApplication: true)
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
    let limit = min(max(options.maxSeconds, 3), Self.maximumSeconds)
    autoStop = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(limit * 1_000_000_000))
      guard !Task.isCancelled, let self, self.activeID == id else { return }
      _ = try? self.repros.addMarker(label: "Time limit reached", detail: "Stopped after \(Int(limit))s", kind: .note, by: "Cinderdeck")
      _ = try? await self.stop()
    }
    ReproControlsPanel.shared.showRecording()
    return session
  }

  /// Records while a task or workflow runs, then stops a moment after it finishes.
  func startRun(_ options: Options, workspace: String, kind: WorkspaceRunKind, definitionID: String, actor: StackActor,
    runner: WorkspaceRunner, origin: ReproOrigin = .agent) async throws -> (ReproSession, WorkspaceRun) {
    var options = options
    options.workspaces = options.workspaces ?? [workspace]
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
    let run: WorkspaceRun
    do { run = try runner.submit(workspace: workspace, kind: kind, definitionID: definitionID, actor: actor) }
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
    let url = await recorder.stopRecording()
    let saved = await repros.waitUntilSaved(id)
    activeID = nil; activeActor = nil; linkedRun = nil
    guard url != nil, let saved else {
      ReproControlsPanel.shared.hide()
      throw StackControlError(code: "recording_failed", message: "The recording produced no video. Check Screen Recording permission for Cinderdeck.")
    }
    ReproControlsPanel.shared.showSaved(saved)
    return saved
  }

  func cancel() async {
    guard activeID != nil else { return }
    autoStop?.cancel(); autoStop = nil
    runWatch = nil
    await recorder.cancelRecording()
    activeID = nil; activeActor = nil; linkedRun = nil
    ReproControlsPanel.shared.hide()
  }

  // MARK: Targets

  private struct Target {
    let rect: CGRect
    let window: WindowCaptureTarget?
    let description: String
  }

  private func resolveTarget(_ options: Options) async throws -> Target {
    if let query = options.window?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
      guard let snapshot = await WindowSelectionQueryService.prepareSnapshot(prefetchedContentTask: nil, excludeOwnApplication: true) else {
        throw StackControlError(code: "recording_failed", message: "Could not list windows. Check Screen Recording permission for Cinderdeck.")
      }
      let candidates = snapshot.orderedCandidates.filter { $0.target.kind == .normal }
      let lower = query.lowercased()
      func owner(_ candidate: WindowSelectionCandidate) -> String { candidate.ownerName.lowercased() }
      func title(_ candidate: WindowSelectionCandidate) -> String { (candidate.target.title ?? "").lowercased() }
      let match = candidates.first { owner($0) == lower } ?? candidates.first { title($0) == lower }
        ?? candidates.first { owner($0).contains(lower) } ?? candidates.first { title($0).contains(lower) }
      guard let match else {
        let names = candidates.map(\.ownerName).reduce(into: [String]()) { if !$1.isEmpty && !$0.contains($1) { $0.append($1) } }
        throw StackControlError.notFound("No visible window matches \"\(query)\". Visible apps: \(names.prefix(15).joined(separator: ", "))")
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

  static func extract(video: URL, at seconds: [Double], maxDimension: Int, into folder: URL) async throws -> [Frame] {
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
    for value in seconds {
      // The very last instant has no frame; step just inside the video.
      let t = min(max(0, value), max(0, (duration.isFinite ? duration : value) - 0.05))
      let (image, _) = try await generator.image(at: CMTime(seconds: t, preferredTimescale: 600))
      let data = NSMutableData()
      guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw StackError.message("Could not encode the frame")
      }
      CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.72] as CFDictionary)
      guard CGImageDestinationFinalize(destination) else { throw StackError.message("Could not encode the frame") }
      let url = folder.appendingPathComponent("frame-\(Int((t * 1000).rounded()))ms.jpg")
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

  /// Writes the bundle, with frames at the first error and each failure when
  /// the video is available. Returns the folder, or the .zip when `zip` is true.
  static func export(_ session: ReproSession, to destination: URL? = nil, zip: Bool = false, includeVideo: Bool = true) async throws -> URL {
    let recorder = ReproRecorder.shared
    let lines = await recorder.lines(for: session.id)
    let store = recorder.store
    if let video = session.videoURL, FileManager.default.fileExists(atPath: video.path) {
      var moments = session.markers.filter(\.isFailure).map(\.t)
      if let first = session.firstErrorLine, let line = lines.first(where: { $0.id == first }) { moments.insert(line.t, at: 0) }
      let unique = moments.reduce(into: [Double]()) { result, t in if !result.contains(where: { abs($0 - t) < 0.5 }) { result.append(t) } }
      if !unique.isEmpty {
        _ = try? await ReproFrames.extract(video: video, at: Array(unique.prefix(8)), maxDimension: 1600, into: store.framesFolder(session.id))
      }
    }
    let parent = destination ?? defaultDestination
    let result = try await Task.detached {
      try ReproBundleExporter.export(session, lines: lines, store: store, to: parent, includeVideo: includeVideo)
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
}
