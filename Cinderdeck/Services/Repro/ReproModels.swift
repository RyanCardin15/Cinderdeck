import Foundation

// A repro is a screen recording with the workspace output that happened while it
// was captured: service and task logs, lifecycle events, markers, and the Git and
// service state at the start. Every log line carries its position on the video
// timeline so the video, the logs, and agents all share one clock.

nonisolated enum ReproLogLevel: String, Codable, CaseIterable, Comparable, Sendable {
  case debug, info, warning, error

  private var rank: Int {
    switch self { case .debug: return 0; case .info: return 1; case .warning: return 2; case .error: return 3 }
  }
  static func < (lhs: Self, rhs: Self) -> Bool { lhs.rank < rhs.rank }

  // Word-boundary matches keep "terror" or "errorless" identifiers from counting.
  private static let errorPattern = try! NSRegularExpression(
    pattern: #"\b(error|errors|err|fatal|panic|panicked|exception|traceback|uncaught|unhandled|fail|failed|failure|failing|segmentation fault|critical|crit|emerg|alert)\b|✖|✗|❌"#,
    options: [.caseInsensitive])
  /// TypeError, NullPointerException, ECONNREFUSED-style names.
  private static let errorNamePattern = try! NSRegularExpression(
    pattern: #"\b[A-Z][A-Za-z0-9]*(Error|Exception)\b|\bE(CONNREFUSED|CONNRESET|ADDRINUSE|ACCES|NOENT|PIPE|TIMEDOUT)\b"#, options: [])
  private static let benignErrorPattern = try! NSRegularExpression(
    pattern: #"\b(0|no|zero|without) (errors?|failures?|failed|fail)\b|\berrors?: ?0\b|\bfail(ed)?: ?0\b"#,
    options: [.caseInsensitive])
  private static let warningPattern = try! NSRegularExpression(
    pattern: #"\b(warn|warning|warnings|deprecated|deprecation|retrying|timeout|timed out)\b|⚠"#, options: [.caseInsensitive])
  private static let debugPattern = try! NSRegularExpression(
    pattern: #"^\W{0,3}(debug|trace|verbose)\b|\[(debug|trace|verbose)\]|\blevel[=:]"?(debug|trace)\b"#, options: [.caseInsensitive])
  private static let httpPattern = try! NSRegularExpression(
    pattern: #"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b.*?\s([1-5]\d\d)\b"#, options: [])
  /// An access log entry for a successful request: `GET /api/errors 200` or `"GET /x HTTP/1.1" 304`.
  private static let successPattern = try! NSRegularExpression(
    pattern: #"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+"?(/|https?://)\S*(\s+HTTP/[\d.]+"?)?\s+[1-3]\d\d\b"#, options: [])

  /// Heuristic level for one plain-text log line. Explicit level tokens and HTTP
  /// status codes win over incidental words.
  static func classify(_ text: String) -> ReproLogLevel {
    let range = NSRange(text.startIndex..., in: text)
    func matches(_ regex: NSRegularExpression) -> Bool { regex.firstMatch(in: text, range: range) != nil }
    if let match = httpPattern.firstMatch(in: text, range: range), let codeRange = Range(match.range(at: 2), in: text),
      let code = Int(text[codeRange]) {
      if code >= 500 { return .error }
      if code >= 400 { return .warning }
    }
    if matches(debugPattern) { return .debug }
    // In a successful request, words in the path (/api/errors) are not problems;
    // only what follows the status can be.
    var words = text
    if let success = successPattern.firstMatch(in: text, range: range), let end = Range(success.range, in: text)?.upperBound {
      words = String(text[end...])
    }
    let wordsRange = NSRange(words.startIndex..., in: words)
    func found(_ regex: NSRegularExpression) -> Bool { regex.firstMatch(in: words, range: wordsRange) != nil }
    if found(errorNamePattern) || (found(errorPattern) && !found(benignErrorPattern)) { return .error }
    if found(warningPattern) { return .warning }
    return .info
  }
}

nonisolated struct ReproLogLine: Codable, Equatable, Identifiable, Sendable {
  /// Sequence number within the repro.
  var id: Int
  /// Seconds on the video timeline.
  var t: Double
  var at: Date
  /// ReproSource id: "workspace/service" or "run/<run>/<step>".
  var source: String
  var text: String
  var level: ReproLogLevel
  /// Output from just before the video started or while it was paused. Kept for
  /// context and pinned to the nearest visible moment.
  var offscreen: Bool?

  var isOffscreen: Bool { offscreen == true }
  /// Written in the seconds before the video started. Kept as context, but not
  /// counted as an error or warning of the recording.
  var isPreRoll: Bool { isOffscreen && t == 0 }
}

// Clock times are stored as epoch seconds with milliseconds; ISO 8601 dates
// would drop the fraction the log file shows.
extension ReproLogLine {
  nonisolated private enum CodingKeys: String, CodingKey { case id, t, at, source, text, level, offscreen }
  nonisolated init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(Int.self, forKey: .id)
    t = try c.decode(Double.self, forKey: .t)
    at = Date(timeIntervalSince1970: try c.decode(Double.self, forKey: .at))
    source = try c.decode(String.self, forKey: .source)
    text = try c.decode(String.self, forKey: .text)
    level = try c.decode(ReproLogLevel.self, forKey: .level)
    offscreen = try c.decodeIfPresent(Bool.self, forKey: .offscreen)
  }
  nonisolated func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode((t * 1000).rounded() / 1000, forKey: .t)
    try c.encode((at.timeIntervalSince1970 * 1000).rounded() / 1000, forKey: .at)
    try c.encode(source, forKey: .source)
    try c.encode(text, forKey: .text)
    try c.encode(level, forKey: .level)
    try c.encodeIfPresent(offscreen, forKey: .offscreen)
  }
}

nonisolated struct ReproSource: Codable, Equatable, Identifiable, Sendable {
  /// `external` is output an agent added itself, such as a browser console; it belongs to no workspace.
  enum Kind: String, Codable, Sendable { case service, task, external }
  var id: String
  var kind: Kind
  var workspace: String
  var workspaceName: String
  var name: String
  var lineCount = 0
  var errorCount = 0
  var warningCount = 0
}

nonisolated struct ReproMarker: Codable, Equatable, Identifiable, Sendable {
  enum Kind: String, Codable, CaseIterable, Sendable {
    case note, check, step, runStarted, runFinished
    case serviceStarting, serviceReady, serviceUnhealthy, serviceCrashed, serviceStopped
  }
  enum Outcome: String, Codable, Sendable { case pass, fail, info }
  var id = UUID()
  var t: Double
  var at: Date
  var kind: Kind
  var label: String
  var detail: String?
  var outcome: Outcome?
  var source: String?
  var by: String?

  var isFailure: Bool { outcome == .fail }
}

extension ReproMarker {
  nonisolated private enum CodingKeys: String, CodingKey { case id, t, at, kind, label, detail, outcome, source, by }
  nonisolated init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(UUID.self, forKey: .id)
    t = try c.decode(Double.self, forKey: .t)
    at = Date(timeIntervalSince1970: try c.decode(Double.self, forKey: .at))
    kind = try c.decode(Kind.self, forKey: .kind)
    label = try c.decode(String.self, forKey: .label)
    detail = try c.decodeIfPresent(String.self, forKey: .detail)
    outcome = try c.decodeIfPresent(Outcome.self, forKey: .outcome)
    source = try c.decodeIfPresent(String.self, forKey: .source)
    by = try c.decodeIfPresent(String.self, forKey: .by)
  }
  nonisolated func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(t, forKey: .t)
    try c.encode((at.timeIntervalSince1970 * 1000).rounded() / 1000, forKey: .at)
    try c.encode(kind, forKey: .kind)
    try c.encode(label, forKey: .label)
    try c.encodeIfPresent(detail, forKey: .detail)
    try c.encodeIfPresent(outcome, forKey: .outcome)
    try c.encodeIfPresent(source, forKey: .source)
    try c.encodeIfPresent(by, forKey: .by)
  }
}

nonisolated struct ReproRepoState: Codable, Equatable, Sendable {
  var id: String
  var path: String
  var branch: String
  var head: String?
  var upstream: String?
  var ahead = 0
  var behind = 0
  var changedFiles: [String] = []
  /// Relative path of the saved uncommitted diff inside the repro folder.
  var diffFile: String?
  var diffTruncated: Bool?
}

nonisolated struct ReproServiceState: Codable, Equatable, Sendable {
  var name: String
  var status: String
  var command: String
  var port: Int?
  var url: String?
  var pid: Int32?
  var startedBy: String?
}

nonisolated struct ReproWorkspaceContext: Codable, Equatable, Sendable {
  var id: String
  var name: String
  var root: String
  var definitionFingerprint: String
  /// Variable names only. Values are never stored; secrets are listed by variable name.
  var environmentKeys: [String]
  var secretKeys: [String]
  var services: [ReproServiceState]
  var repos: [ReproRepoState]
}

nonisolated struct ReproRunLink: Codable, Equatable, Sendable {
  var id: UUID
  var workspace: String
  var name: String
  var kind: String
  var status: String
  var startedAt: Double
  var finishedAt: Double?
  var failedStep: String?
}

nonisolated enum ReproStatus: String, Codable, Sendable {
  case recording, finalizing, ready, failed, cancelled
  var isActive: Bool { self == .recording || self == .finalizing }
}

/// Which workspaces' output a screen recording captures.
nonisolated enum ReproLogScope: Equatable, Sendable {
  /// Every workspace with a service or run producing output.
  case running
  /// Only these workspace ids.
  case only(Set<String>)
  /// Plain videos: nothing is captured. The default until a workspace is chosen.
  case off

  init(mode: String?, workspaces: [String]?) {
    switch mode {
    case "running": self = .running
    case "selected": self = .only(Set(workspaces ?? []))
    default: self = .off
    }
  }
  var mode: String {
    switch self { case .running: return "running"; case .only: return "selected"; case .off: return "off" }
  }
  var workspaces: [String] { if case .only(let ids) = self { return ids.sorted() }; return [] }

  func includes(_ workspace: String) -> Bool {
    switch self {
    case .running: return true
    case .only(let ids): return ids.contains(workspace)
    case .off: return false
    }
  }
  var isOff: Bool {
    switch self { case .off: return true; case .only(let ids): return ids.isEmpty; case .running: return false }
  }

  /// Selecting a workspace from "all running" narrows to it; toggling the last one off turns logs off.
  func toggling(_ workspace: String) -> ReproLogScope {
    switch self {
    case .running, .off: return .only([workspace])
    case .only(var ids):
      if ids.contains(workspace) { ids.remove(workspace) } else { ids.insert(workspace) }
      return ids.isEmpty ? .off : .only(ids)
    }
  }

  /// "All running workspaces", "Shop and Billing", or "Off".
  func summary(names: [String: String]) -> String {
    switch self {
    case .running: return "All running workspaces"
    case .off: return "Off"
    case .only(let ids):
      let labels = ids.map { names[$0] ?? $0 }.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
      return labels.isEmpty ? "Off" : ReproFormat.list(labels)
    }
  }
}

nonisolated enum ReproOrigin: String, Codable, Sendable {
  /// Any screen recording made while workspace services or runs were active.
  case recording
  /// Started from Workspaces → Recordings.
  case workspace
  /// Started by an agent or the CLI.
  case agent
}

nonisolated struct ReproSession: Codable, Equatable, Identifiable, Sendable {
  var id = UUID()
  var title: String
  var status: ReproStatus = .recording
  var origin: ReproOrigin
  var createdAt = Date()
  var endedAt: Date?
  /// Seconds of video.
  var duration: Double = 0
  var videoPath: String?
  var videoBookmark: Data?
  var capture: String?
  var actor: StackActor
  var workspaces: [ReproWorkspaceContext] = []
  var sources: [ReproSource] = []
  var markers: [ReproMarker] = []
  var runs: [ReproRunLink] = []
  var lineCount = 0
  var errorCount = 0
  var warningCount = 0
  var firstErrorLine: Int?
  var truncated = false
  var detail: String?
  /// How the workspaces were chosen, e.g. "All running workspaces".
  var scope: String?
  /// The log file people see: next to the video when it was saved there.
  var logFile: String?
  /// How wall-clock times map onto the video, kept so lines added after the
  /// recording stopped land on the same timeline.
  var clock: ReproClock?
  /// Lines a service printed faster than they could be read, so they were never captured.
  var droppedLines: Int?
  var videoURL: URL? { videoPath.map { URL(fileURLWithPath: $0) } }
  var workspaceIDs: [String] { workspaces.map(\.id) }

  /// Workspaces with captured state or output, in first-seen order.
  var workspaceNames: [String] {
    (workspaces.map(\.name) + sources.filter { $0.kind != .external }.map(\.workspaceName)).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
  }

  func source(_ id: String) -> ReproSource? { sources.first { $0.id == id } }
  func label(for source: String) -> String { self.source(source)?.name ?? source }
}

// MARK: - Clock

nonisolated struct ReproPause: Codable, Equatable, Sendable {
  var start: Date
  var end: Date?
}

/// Maps wall-clock times to positions on the recorded video. The video starts at
/// its first frame, and paused spans are removed from it.
nonisolated struct ReproClock: Codable, Equatable, Sendable {
  private(set) var origin: Date
  private(set) var hasFirstFrame = false
  private(set) var pauses: [ReproPause] = []
  private(set) var stoppedAt: Date?

  init(start: Date) { origin = start }

  mutating func firstFrame(at date: Date) {
    guard !hasFirstFrame else { return }
    hasFirstFrame = true
    origin = date
  }
  mutating func pause(at date: Date) {
    guard pauses.last.map({ $0.end != nil }) ?? true else { return }
    pauses.append(.init(start: date))
  }
  mutating func resume(at date: Date) {
    guard let last = pauses.indices.last, pauses[last].end == nil else { return }
    pauses[last].end = max(date, pauses[last].start)
  }
  mutating func stop(at date: Date) {
    if stoppedAt == nil { stoppedAt = date }
    resume(at: date)
  }
  var isPaused: Bool { pauses.last.map { $0.end == nil } ?? false }

  /// Position on the video and whether the moment was actually recorded.
  func position(at date: Date) -> (t: Double, visible: Bool) {
    if date < origin { return (0, false) }
    let clamped = stoppedAt.map { min(date, $0) } ?? date
    var paused = 0.0, visible = true
    for pause in pauses where pause.start < clamped {
      let end = min(pause.end ?? clamped, clamped)
      paused += max(0, end.timeIntervalSince(pause.start))
      if pause.end.map({ $0 > clamped }) ?? true { visible = false }
    }
    if let stoppedAt, date > stoppedAt { visible = false }
    return (max(0, clamped.timeIntervalSince(origin) - paused), visible)
  }

  var duration: Double { stoppedAt.map { position(at: $0).t } ?? position(at: Date()).t }

  /// Position for a moment on a finished video of `duration` seconds. Moments after
  /// the last frame are pinned to it and marked as not recorded.
  func position(at date: Date, duration: Double) -> (t: Double, visible: Bool) {
    let position = position(at: date)
    guard position.t > duration else { return position }
    // The clock and the encoded video can disagree by a frame; that is still on screen.
    return (duration, position.visible && position.t - duration < 0.1)
  }
}

// MARK: - Formatting

nonisolated enum ReproFormat {
  /// 75.25 → "01:15.250"; hours are added when needed.
  static func timestamp(_ seconds: Double, precise: Bool = true) -> String {
    let value = max(0, seconds.isFinite ? seconds : 0)
    let totalMillis = Int((value * 1000).rounded())
    let hours = totalMillis / 3_600_000, minutes = (totalMillis / 60_000) % 60
    let secs = (totalMillis / 1000) % 60, millis = totalMillis % 1000
    // Formatted by hand: this runs for every line of large logs, and String(format:) is slow.
    func padded(_ value: Int, _ width: Int) -> String {
      let digits = String(value)
      return digits.count >= width ? digits : String(repeating: "0", count: width - digits.count) + digits
    }
    var text = hours > 0 ? "\(hours):\(padded(minutes, 2)):\(padded(secs, 2))" : "\(padded(minutes, 2)):\(padded(secs, 2))"
    if precise { text += "." + padded(millis, 3) }
    return text
  }

  /// Accepts seconds ("12.5") or clock notation ("1:02.5", "0:01:02").
  static func parseTime(_ text: String) -> Double? {
    let trimmed = text.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: "s", with: "")
    if let value = Double(trimmed), value.isFinite { return max(0, value) }
    let parts = trimmed.split(separator: ":").map(String.init)
    guard (2...3).contains(parts.count) else { return nil }
    var total = 0.0
    for part in parts {
      guard let value = Double(part), value >= 0 else { return nil }
      total = total * 60 + value
    }
    return total
  }

  /// "A", "A and B", "A, B, and C".
  static func list(_ items: [String]) -> String {
    switch items.count {
    case 0: return ""
    case 1: return items[0]
    case 2: return "\(items[0]) and \(items[1])"
    default: return items.dropLast().joined(separator: ", ") + ", and " + items.last!
    }
  }

  static func duration(_ seconds: Double) -> String {
    let value = Int(seconds.rounded())
    if value < 60 { return "\(value)s" }
    if value < 3600 { return "\(value / 60)m \(value % 60)s" }
    return "\(value / 3600)h \((value / 60) % 60)m"
  }
}

// MARK: - Queries

nonisolated struct ReproLogQuery: Equatable, Sendable {
  var from: Double?
  var to: Double?
  var sources: Set<String> = []
  var minimumLevel: ReproLogLevel = .debug
  var text: String?
  var includeOffscreen = true
  var limit = 500
  /// When more lines match than `limit`, keep the ones nearest this moment instead of the earliest.
  var anchor: Double?

  /// Lines within `window` seconds either side of `t`.
  static func around(_ t: Double, window: Double = 5) -> ReproLogQuery {
    ReproLogQuery(from: max(0, t - window), to: t + window, anchor: t)
  }

  /// Matches plain text case-insensitively, or as a regex when the text is a valid pattern with regex syntax.
  func filter(_ lines: [ReproLogLine], session: ReproSession? = nil) -> [ReproLogLine] {
    let regex: NSRegularExpression? = text.flatMap { value in
      guard !value.isEmpty, value.rangeOfCharacter(from: CharacterSet(charactersIn: "\\^$.|?*+()[]{}")) != nil else { return nil }
      return try? NSRegularExpression(pattern: value, options: [.caseInsensitive])
    }
    let matched = lines.filter { line in
      if let from, line.t < from { return false }
      if let to, line.t > to { return false }
      if !includeOffscreen && line.isOffscreen { return false }
      if line.level < minimumLevel { return false }
      if !sources.isEmpty {
        let name = session?.source(line.source)?.name
        if !sources.contains(line.source) && !(name.map(sources.contains) ?? false) { return false }
      }
      if let text, !text.isEmpty {
        if let regex { return regex.firstMatch(in: line.text, range: NSRange(line.text.startIndex..., in: line.text)) != nil }
        return line.text.range(of: text, options: [.caseInsensitive, .diacriticInsensitive]) != nil
      }
      return true
    }
    guard limit > 0, matched.count > limit else { return matched }
    // Around a moment, keep the lines nearest it, so the moment itself is never cut off.
    if let anchor {
      let pivot = reproLineIndex(atOrBefore: anchor, in: matched).map { $0 + 1 } ?? 0
      let start = min(max(0, pivot - (limit + 1) / 2), matched.count - limit)
      return Array(matched[start..<(start + limit)])
    }
    // Otherwise keep the earliest lines of a range: they are closest to the cause.
    return Array(matched.prefix(limit))
  }
}

/// Index of the last line at or before `t`. Lines are ordered by `t`.
nonisolated func reproLineIndex(atOrBefore t: Double, in lines: [ReproLogLine]) -> Int? {
  var low = 0, high = lines.count - 1, result: Int?
  while low <= high {
    let mid = (low + high) / 2
    if lines[mid].t <= t { result = mid; low = mid + 1 } else { high = mid - 1 }
  }
  return result
}

// MARK: - Summary

nonisolated struct ReproSummary: Codable, Equatable, Sendable {
  enum Verdict: String, Codable, Sendable {
    /// No error output, crashes, failed checks, or failed runs.
    case clean
    /// Error lines appeared, but nothing crashed or failed.
    case errors
    /// A service crashed, a check or run failed.
    case failed
  }
  struct Highlight: Codable, Equatable, Sendable {
    var t: Double
    var time: String
    var source: String
    var text: String
  }
  var verdict: Verdict
  var headline: String
  var duration: Double
  var lines: Int
  var errors: Int
  var warnings: Int
  var checksPassed: Int
  var checksFailed: Int
  var crashes: [String]
  var failedRuns: [String]
  var firstError: Highlight?
  var topErrors: [Highlight]

  /// Verdict and headline come from the session's counts and markers; `lines`
  /// only adds the first and distinct errors, so pass [] when those are not shown.
  init(session: ReproSession, lines: [ReproLogLine]) {
    let errorLines = lines.filter { $0.level == .error && !$0.isPreRoll }
    let checks = session.markers.filter { $0.kind == .check }
    checksPassed = checks.filter { $0.outcome == .pass }.count
    checksFailed = checks.filter { $0.outcome == .fail }.count
    crashes = session.markers.filter { $0.kind == .serviceCrashed }.map { "\($0.label) at \(ReproFormat.timestamp($0.t, precise: false))" }
    failedRuns = session.runs.filter { $0.status == "failed" }.map { run in run.failedStep.map { "\(run.name): \($0)" } ?? run.name }
    duration = session.duration
    self.lines = session.lineCount
    errors = session.errorCount
    warnings = session.warningCount
    func highlight(_ line: ReproLogLine) -> Highlight {
      Highlight(t: line.t, time: ReproFormat.timestamp(line.t), source: session.label(for: line.source), text: String(line.text.prefix(400)))
    }
    firstError = errorLines.first.map(highlight)
    // Distinct messages, so one error repeated in a loop does not hide the others.
    var seen = Set<String>(), top: [Highlight] = []
    for line in errorLines {
      guard seen.insert(Self.errorKey(line.text)).inserted else { continue }
      top.append(highlight(line))
      if top.count == 8 { break }
    }
    topErrors = top
    if !crashes.isEmpty || checksFailed > 0 || !failedRuns.isEmpty { verdict = .failed }
    else if errors > 0 { verdict = .errors }
    else { verdict = .clean }
    var parts: [String] = []
    if !crashes.isEmpty { parts.append("\(crashes.count) crash\(crashes.count == 1 ? "" : "es")") }
    if !failedRuns.isEmpty { parts.append("\(failedRuns.count) failed run\(failedRuns.count == 1 ? "" : "s")") }
    if checksFailed > 0 { parts.append("\(checksFailed) failed check\(checksFailed == 1 ? "" : "s")") }
    if errors > 0 { parts.append("\(errors) error line\(errors == 1 ? "" : "s")") }
    if warnings > 0 { parts.append("\(warnings) warning\(warnings == 1 ? "" : "s")") }
    if checksPassed > 0 && checksFailed == 0 { parts.append("\(checksPassed) check\(checksPassed == 1 ? "" : "s") passed") }
    headline = parts.isEmpty ? "No errors in \(session.lineCount) log lines" : parts.joined(separator: " · ")
  }

  /// The first 160 bytes of a message with each run of digits collapsed to "#",
  /// so "timeout after 30ms (attempt 2)" and "(attempt 3)" group together.
  static func errorKey(_ text: String) -> String {
    var bytes: [UInt8] = []
    bytes.reserveCapacity(160)
    var inDigits = false
    for byte in text.utf8 {
      let isDigit = byte >= 0x30 && byte <= 0x39
      if isDigit && inDigits { continue }
      inDigits = isDigit
      bytes.append(isDigit ? 0x23 : byte)
      if bytes.count == 160 { break }
    }
    return String(decoding: bytes, as: UTF8.self)
  }
}

// MARK: - Reports

nonisolated enum ReproReport {
  static func logLine(_ line: ReproLogLine, session: ReproSession, sourceWidth: Int = 0) -> String {
    var name = session.label(for: line.source)
    if sourceWidth > name.count { name += String(repeating: " ", count: sourceWidth - name.count) }
    return "[\(ReproFormat.timestamp(line.t))] \(name) | \(line.text)"
  }

  static func timeline(_ session: ReproSession, lines: [ReproLogLine]) -> String {
    let width = min(24, session.sources.map { $0.name.count }.max() ?? 0)
    var events: [(Double, Int, String)] = lines.map { ($0.t, $0.id * 2 + 1, logLine($0, session: session, sourceWidth: width)) }
    for (index, marker) in session.markers.enumerated() {
      let outcome = marker.outcome.map { " [\($0.rawValue.uppercased())]" } ?? ""
      events.append((marker.t, -1_000_000 + index, "[\(ReproFormat.timestamp(marker.t))] ▶ \(marker.label)\(outcome)" + (marker.detail.map { " — " + $0 } ?? "")))
    }
    return events.sorted { $0.0 == $1.0 ? $0.1 < $1.1 : $0.0 < $1.0 }.map(\.2).joined(separator: "\n") + "\n"
  }

  /// A self-contained Markdown summary for bug reports and agent prompts.
  static func markdown(_ session: ReproSession, lines: [ReproLogLine], videoFile: String? = nil, logFile: String? = nil) -> String {
    let summary = ReproSummary(session: session, lines: lines)
    let date = ISO8601DateFormatter().string(from: session.createdAt)
    var out = "# \(session.title)\n\n"
    out += "**\(summary.verdict.rawValue.capitalized):** \(summary.headline)\n\n"
    out += "- Recorded: \(date) by \(session.actor.label)\n"
    out += "- Duration: \(ReproFormat.duration(session.duration)) · \(session.lineCount) log lines from \(session.sources.count) source\(session.sources.count == 1 ? "" : "s")\n"
    if let capture = session.capture { out += "- Captured: \(capture)\n" }
    if let videoFile { out += "- Video: `\(videoFile)`\n" }
    if let logFile { out += "- Log file: `\(logFile)` (every line is stamped with its position in the video)\n" }
    if session.truncated { out += "- Note: output exceeded the capture limit; later lines were counted but not stored.\n" }
    if let dropped = session.droppedLines, dropped > 0 { out += "- Note: \(dropped) line\(dropped == 1 ? "" : "s") printed faster than Cinderdeck could read were not captured.\n" }
    if let detail = session.detail { out += "- Note: \(detail)\n" }
    if !session.markers.isEmpty {
      out += "\n## Timeline\n\n| Time | Event | Result |\n| --- | --- | --- |\n"
      for marker in session.markers.sorted(by: { $0.t < $1.t }) {
        let label = (marker.label + (marker.detail.map { " — " + $0 } ?? "")).replacingOccurrences(of: "|", with: "\\|")
        out += "| \(ReproFormat.timestamp(marker.t)) | \(label) | \(marker.outcome?.rawValue ?? "") |\n"
      }
    }
    if !summary.topErrors.isEmpty {
      out += "\n## Errors\n\n"
      for error in summary.topErrors {
        out += "- `\(error.time)` **\(error.source)**: \(error.text.replacingOccurrences(of: "`", with: "'"))\n"
      }
      if let first = session.firstErrorLine, let line = lines.first(where: { $0.id == first }) {
        let context = lines.filter { $0.t >= line.t - 5 && $0.t <= line.t + 2 }.suffix(40)
        out += "\n### Output around the first error\n\n```\n" + context.map { logLine($0, session: session) }.joined(separator: "\n") + "\n```\n"
      }
    }
    if !session.runs.isEmpty {
      out += "\n## Runs\n\n"
      for run in session.runs {
        out += "- \(run.name) (\(run.kind)): **\(run.status)**" + (run.failedStep.map { " at \($0)" } ?? "") + " · started \(ReproFormat.timestamp(run.startedAt))\n"
      }
    }
    for workspace in session.workspaces {
      out += "\n## Workspace: \(workspace.name)\n\n"
      if workspace.services.isEmpty && workspace.repos.isEmpty { out += "No services or repositories were recorded for this workspace.\n" }
      if !workspace.services.isEmpty {
        out += "| Service | Status at start | Command |\n| --- | --- | --- |\n"
        for service in workspace.services {
          out += "| \(service.name)\(service.port.map { " :\($0)" } ?? "") | \(service.status) | `\(service.command.replacingOccurrences(of: "|", with: "\\|"))` |\n"
        }
      }
      for repo in workspace.repos {
        out += "\n- **\(repo.id)** `\(repo.branch)` @ `\(repo.head.map { String($0.prefix(12)) } ?? "unknown")`"
        if repo.ahead > 0 || repo.behind > 0 { out += " (↑\(repo.ahead) ↓\(repo.behind))" }
        if !repo.changedFiles.isEmpty {
          out += " with \(repo.changedFiles.count) uncommitted change\(repo.changedFiles.count == 1 ? "" : "s")"
          if let diff = repo.diffFile { out += " (`\(diff)`)" }
          out += ": " + repo.changedFiles.prefix(12).map { "`\($0)`" }.joined(separator: ", ")
          if repo.changedFiles.count > 12 { out += ", …" }
        }
        out += "\n"
      }
      if !workspace.environmentKeys.isEmpty {
        out += "\nEnvironment variables set by the workspace (values omitted): " + workspace.environmentKeys.joined(separator: ", ") + "\n"
      }
    }
    if !session.sources.isEmpty {
      out += "\n## Sources\n\n| Source | Lines | Errors | Warnings |\n| --- | --- | --- | --- |\n"
      for source in session.sources {
        let name = source.kind == .external ? source.name : "\(source.workspaceName) / \(source.name)"
        out += "| \(name) | \(source.lineCount) | \(source.errorCount) | \(source.warningCount) |\n"
      }
    }
    return out
  }

  /// "api" when one workspace was captured; "shop/api" when several are mixed.
  static func sourceLabels(_ session: ReproSession) -> [String: String] {
    let multiple = Set(session.sources.filter { $0.kind != .external }.map(\.workspace)).count > 1
    return Dictionary(uniqueKeysWithValues: session.sources.map {
      ($0.id, multiple && $0.kind != .external ? "\($0.workspace)/\($0.name)" : $0.name)
    })
  }

  /// The plain-text log saved with a recording: every captured line and event in
  /// video order, each stamped with its video position and clock time.
  static func logFile(_ session: ReproSession, lines: [ReproLogLine], videoName: String?, timeZone: TimeZone = .current) -> String {
    let posix = Locale(identifier: "en_US_POSIX")
    let clock = DateFormatter()
    clock.locale = posix; clock.timeZone = timeZone; clock.dateFormat = "HH:mm:ss.SSS"
    let day = DateFormatter()
    day.locale = posix; day.timeZone = timeZone; day.dateFormat = "yyyy-MM-dd HH:mm:ss zzz"
    let summary = ReproSummary(session: session, lines: lines)
    let labels = sourceLabels(session)
    let width = min(24, labels.values.map(\.count).max() ?? 0)
    func pad(_ text: String, _ count: Int) -> String { text.count >= count ? text : text + String(repeating: " ", count: count - text.count) }
    func stamp(_ t: Double, _ date: Date) -> String { "[\(ReproFormat.timestamp(t))  \(clock.string(from: date))]" }

    var out = "Cinderdeck workspace log\n========================\n"
    out += "Video:      \(videoName ?? "(not saved)")\n"
    out += "Recorded:   \(day.string(from: session.createdAt)) · \(ReproFormat.duration(session.duration))\n"
    let names = session.workspaceNames
    let captured = names.isEmpty ? "No workspace output" : ReproFormat.list(names)
    out += "Captured:   \(captured)" + (session.scope.map { " (\($0))" } ?? "") + "\n"
    out += "Result:     \(summary.verdict.rawValue.capitalized) — \(summary.headline)\n"
    if session.truncated {
      out += "Note:       Only the first \(lines.count) lines were saved; \(max(0, session.lineCount - lines.count)) later lines were counted but not saved.\n"
    }
    if let dropped = session.droppedLines, dropped > 0 {
      out += "Note:       \(dropped) line\(dropped == 1 ? " was" : "s were") printed faster than Cinderdeck could read \(dropped == 1 ? "it" : "them") and \(dropped == 1 ? "is" : "are") missing.\n"
    }
    if let detail = session.detail { out += "Note:       \(detail)\n" }

    out += "\nSources\n"
    let sourceWidth = max(width, 12)
    for source in session.sources {
      var row = "  " + pad(labels[source.id] ?? source.name, sourceWidth) + "  " + "\(source.lineCount) line\(source.lineCount == 1 ? "" : "s")"
      if source.errorCount > 0 { row += ", \(source.errorCount) error\(source.errorCount == 1 ? "" : "s")" }
      if source.warningCount > 0 { row += ", \(source.warningCount) warning\(source.warningCount == 1 ? "" : "s")" }
      out += row + "\n"
    }
    for workspace in session.workspaces where !session.sources.contains(where: { $0.workspace == workspace.id }) {
      out += "  " + pad(workspace.name, sourceWidth) + "  running, but printed nothing during the recording\n"
    }
    if session.sources.isEmpty && session.workspaces.isEmpty { out += "  (none)\n" }

    let zone = timeZone.abbreviation(for: session.createdAt) ?? timeZone.identifier
    out += """

    How to read this file
      [video time  clock time]  source  message
      Video time 00:00.000 is the first frame of the video. Seek the video there to see that moment.
      Clock times are local (\(zone)).
      ERROR and WARN mark lines that look like errors or warnings.
      ▶ marks events: services starting, becoming ready, or crashing, workflow steps, and marks you added.
      ~ marks output written just before recording started, while it was paused, or reported after
        it stopped. It is pinned to the nearest recorded moment.

    """
    out += String(repeating: "-", count: 78) + "\n"

    // Events sort before output at the same instant: the step explains the output.
    var rows: [(t: Double, order: Int, text: String)] = []
    for (index, marker) in session.markers.enumerated() {
      var text = "\(stamp(marker.t, marker.at)) ▶ \(marker.label)"
      if let detail = marker.detail, !detail.isEmpty { text += " — " + detail.replacingOccurrences(of: "\n", with: " ") }
      if let outcome = marker.outcome, outcome != .info { text += "  [\(outcome.rawValue.uppercased())]" }
      if let by = marker.by, marker.kind == .note || marker.kind == .check { text += "  (\(by))" }
      rows.append((marker.t, index - 1_000_000, text))
    }
    for line in lines {
      let level = line.level == .error ? "ERROR  " : line.level == .warning ? "WARN   " : ""
      let text = "\(stamp(line.t, line.at)) \(line.isOffscreen ? "~" : " ") \(pad(labels[line.source] ?? line.source, width))  \(level)\(line.text)"
      rows.append((line.t, line.id, text))
    }
    rows.sort { $0.t == $1.t ? $0.order < $1.order : $0.t < $1.t }
    out += rows.map(\.text).joined(separator: "\n")
    if rows.isEmpty { out += "(nothing was captured)" }
    return out + "\n"
  }

  /// One source's lines, stamped like the log file, for the export bundle's `logs/` folder.
  static func sourceLog(_ session: ReproSession, lines: [ReproLogLine], source id: String, timeZone: TimeZone = .current) -> String {
    let clock = DateFormatter()
    clock.locale = Locale(identifier: "en_US_POSIX"); clock.timeZone = timeZone; clock.dateFormat = "HH:mm:ss.SSS"
    let mine = lines.filter { $0.source == id }
    var out = "\(sourceLabels(session)[id] ?? session.label(for: id)) · \(mine.count) line\(mine.count == 1 ? "" : "s") · \(session.title)\n"
    out += "[video time  clock time]  message\n"
    for line in mine {
      let level = line.level == .error ? "ERROR  " : line.level == .warning ? "WARN   " : ""
      out += "[\(ReproFormat.timestamp(line.t))  \(clock.string(from: line.at))] \(line.isOffscreen ? "~" : " ") \(level)\(line.text)\n"
    }
    return out
  }

  /// A filesystem-safe name fragment.
  static func slug(_ text: String, fallback: String = "repro") -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
    let pieces = text.lowercased().unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
    let collapsed = String(pieces).split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
    return collapsed.isEmpty ? fallback : String(collapsed.prefix(60))
  }
}

// MARK: - Redaction

/// Replaces Keychain secret values that appear in output with their names.
nonisolated struct ReproRedactor: Sendable {
  private let secrets: [(value: String, name: String)]
  init(secrets: [String: String]) {
    // Very short values would produce false matches in ordinary text.
    self.secrets = secrets.filter { $0.value.count >= 6 }.map { (value: $0.value, name: $0.key) }.sorted { $0.value.count > $1.value.count }
  }
  var isEmpty: Bool { secrets.isEmpty }
  func redact(_ text: String) -> String {
    var result = text
    for secret in secrets where result.contains(secret.value) {
      result = result.replacingOccurrences(of: secret.value, with: "[secret \(secret.name)]")
    }
    return result
  }
}
