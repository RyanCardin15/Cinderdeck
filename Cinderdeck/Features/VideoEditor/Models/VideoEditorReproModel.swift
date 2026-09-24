import Combine
import Foundation

/// One row in the editor's repro panel: a log line or a marker, in video order.
struct VideoEditorReproEntry: Identifiable, Equatable {
  enum Content: Equatable {
    case line(ReproLogLine)
    case marker(ReproMarker)
  }
  let id: String
  let t: Double
  let content: Content
}

/// Output and markers of the repro recorded with the open video. Kept apart from
/// VideoEditorState so filtering and playback updates only redraw the panel.
@MainActor
final class VideoEditorReproModel: ObservableObject {
  enum LevelFilter: String, CaseIterable, Identifiable {
    case all = "All", warnings = "Warnings", errors = "Errors"
    var id: String { rawValue }
    var minimum: ReproLogLevel { self == .all ? .debug : self == .warnings ? .warning : .error }
  }

  @Published private(set) var session: ReproSession?
  @Published private(set) var lines: [ReproLogLine] = []
  @Published private(set) var entries: [VideoEditorReproEntry] = []
  @Published var level = LevelFilter.all { didSet { rebuild() } }
  @Published var hiddenSources = Set<String>() { didSet { rebuild() } }
  @Published var search = "" { didSet { scheduleRebuild() } }
  @Published var showMarkers = true { didSet { rebuild() } }
  @Published var follow = true
  @Published private(set) var isExporting = false
  @Published var message: String?

  private var pendingSeek: Double?
  private var searchTask: Task<Void, Never>?

  /// Opening a repro at a moment (from Workspaces or an agent) seeks once it loads.
  private static var pendingSeeks: [String: Double] = [:]
  static func requestSeek(_ t: Double, video: URL) { pendingSeeks[key(video)] = t }
  private static func key(_ url: URL) -> String { url.standardizedFileURL.resolvingSymlinksInPath().path }

  func load(for urls: [URL]) async -> Bool {
    let recorder = ReproRecorder.shared
    guard let session = urls.lazy.compactMap({ recorder.session(forVideo: $0) }).first else { return false }
    self.session = session
    lines = await recorder.lines(for: session.id)
    for url in urls { if let t = Self.pendingSeeks.removeValue(forKey: Self.key(url)) { pendingSeek = t } }
    rebuild()
    return true
  }

  func takePendingSeek() -> Double? {
    defer { pendingSeek = nil }
    return pendingSeek
  }

  private func scheduleRebuild() {
    searchTask?.cancel()
    searchTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 150_000_000)
      guard !Task.isCancelled else { return }
      self?.rebuild()
    }
  }

  private func rebuild() {
    guard let session else { entries = []; return }
    let visibleSources = Set(session.sources.map(\.id)).subtracting(hiddenSources)
    var query = ReproLogQuery(minimumLevel: level.minimum, limit: 0)
    query.text = search.trimmingCharacters(in: .whitespaces)
    let matched = query.filter(lines).filter { visibleSources.contains($0.source) || session.source($0.source) == nil }
    var result = matched.map { VideoEditorReproEntry(id: "l\($0.id)", t: $0.t, content: .line($0)) }
    if showMarkers && query.text?.isEmpty != false {
      let markers = session.markers.filter { level == .all || $0.isFailure }
      result += markers.map { VideoEditorReproEntry(id: "m\($0.id.uuidString)", t: $0.t, content: .marker($0)) }
      // Markers sort before lines at the same instant: the step explains the output.
      result.sort { $0.t == $1.t ? ($0.id.hasPrefix("m") && !$1.id.hasPrefix("m")) : $0.t < $1.t }
    }
    entries = result
  }

  /// Index of the last entry at or before `t`.
  func entryIndex(at t: Double) -> Int? {
    var low = 0, high = entries.count - 1, result: Int?
    while low <= high {
      let mid = (low + high) / 2
      if entries[mid].t <= t + 0.0005 { result = mid; low = mid + 1 } else { high = mid - 1 }
    }
    return result
  }

  var errorTimes: [Double] { lines.filter { $0.level == .error && !$0.isOffscreen }.map(\.t) }
  var warningTimes: [Double] { lines.filter { $0.level == .warning && !$0.isOffscreen }.map(\.t) }

  /// Next or previous error relative to the playhead, wrapping around.
  func error(after t: Double, forward: Bool) -> Double? {
    let times = errorTimes
    guard !times.isEmpty else { return nil }
    if forward { return times.first { $0 > t + 0.05 } ?? times.first }
    return times.last { $0 < t - 0.05 } ?? times.last
  }

  func sourceName(_ id: String) -> String { session?.label(for: id) ?? id }

  /// A consistent hue per source, stable across launches.
  func sourceHue(_ id: String) -> Double {
    guard let index = session?.sources.firstIndex(where: { $0.id == id }) else { return 0.6 }
    let palette: [Double] = [0.58, 0.36, 0.08, 0.78, 0.48, 0.92, 0.16, 0.68]
    return palette[index % palette.count]
  }

  // MARK: Actions

  func export(to folder: URL) async -> URL? {
    guard let session, !isExporting else { return nil }
    isExporting = true
    defer { isExporting = false }
    do { return try await ReproExport.export(session, to: folder) }
    catch { message = error.localizedDescription; return nil }
  }

  /// Markdown for bug reports or to paste into an agent, with the id for MCP tools.
  func agentBrief() -> String {
    guard let session else { return "" }
    return ReproReport.markdown(session, lines: lines, videoFile: session.videoPath)
      + "\n---\nCinderdeck repro id: `\(session.id.uuidString)`. Agents can inspect it with the Cinderdeck MCP tools "
      + "`repro_summary`, `repro_logs`, and `repro_frame` (or `cinderdeck repro show \(session.id.uuidString.prefix(8))`).\n"
  }
}
