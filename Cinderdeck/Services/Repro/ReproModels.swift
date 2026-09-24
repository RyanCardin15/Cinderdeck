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
    pattern: #"\b(error|errors|err|fatal|panic|panicked|exception|traceback|uncaught|unhandled|failed|failure|failing|segmentation fault|critical|crit|emerg|alert)\b|✖|✗|❌"#,
    options: [.caseInsensitive])
  /// TypeError, NullPointerException, ECONNREFUSED-style names.
  private static let errorNamePattern = try! NSRegularExpression(
    pattern: #"\b[A-Z][A-Za-z0-9]*(Error|Exception)\b|\bE(CONNREFUSED|CONNRESET|ADDRINUSE|ACCES|NOENT|PIPE|TIMEDOUT)\b"#, options: [])
  private static let benignErrorPattern = try! NSRegularExpression(
    pattern: #"\b(0|no|zero|without) (errors?|failures?|failed)\b|\berrors?: ?0\b|\bfailed: ?0\b|\b0 failed\b"#,
    options: [.caseInsensitive])
  private static let warningPattern = try! NSRegularExpression(
    pattern: #"\b(warn|warning|warnings|deprecated|deprecation|retrying|timeout|timed out)\b|⚠"#, options: [.caseInsensitive])
  private static let debugPattern = try! NSRegularExpression(
    pattern: #"^\W{0,3}(debug|trace|verbose)\b|\[(debug|trace|verbose)\]|\blevel[=:]"?(debug|trace)\b"#, options: [.caseInsensitive])
  private static let httpPattern = try! NSRegularExpression(
    pattern: #"\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b.*?\s([1-5]\d\d)\b"#, options: [])

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
    if matches(errorNamePattern) || (matches(errorPattern) && !matches(benignErrorPattern)) { return .error }
    if matches(warningPattern) { return .warning }
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
}

nonisolated struct ReproSource: Codable, Equatable, Identifiable, Sendable {
  enum Kind: String, Codable, Sendable { case service, task }
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

nonisolated enum ReproOrigin: String, Codable, Sendable {
  /// Any screen recording made while workspace services or runs were active.
  case recording
  /// Started from Workspaces → Repros.
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
  var videoURL: URL? { videoPath.map { URL(fileURLWithPath: $0) } }
  var workspaceIDs: [String] { workspaces.map(\.id) }

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
nonisolated struct ReproClock: Equatable, Sendable {
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
}

// MARK: - Formatting

nonisolated enum ReproFormat {
  /// 75.25 → "01:15.250"; hours are added when needed.
  static func timestamp(_ seconds: Double, precise: Bool = true) -> String {
    let value = max(0, seconds.isFinite ? seconds : 0)
    let totalMillis = Int((value * 1000).rounded())
    let hours = totalMillis / 3_600_000, minutes = (totalMillis / 60_000) % 60
    let secs = (totalMillis / 1000) % 60, millis = totalMillis % 1000
    let base = hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, secs) : String(format: "%02d:%02d", minutes, secs)
    return precise ? base + String(format: ".%03d", millis) : base
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

  /// Lines within `window` seconds either side of `t`.
  static func around(_ t: Double, window: Double = 5) -> ReproLogQuery {
    ReproLogQuery(from: max(0, t - window), to: t + window)
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
    // Keep the earliest lines of a range: they are closest to the cause.
    return limit > 0 && matched.count > limit ? Array(matched.prefix(limit)) : matched
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
    /// Errors or warnings appeared, but nothing crashed or failed.
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

  init(session: ReproSession, lines: [ReproLogLine]) {
    let errorLines = lines.filter { $0.level == .error }
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
      let key = line.text.replacingOccurrences(of: #"\d+"#, with: "#", options: .regularExpression).prefix(160)
      guard seen.insert(String(key)).inserted else { continue }
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
  static func markdown(_ session: ReproSession, lines: [ReproLogLine], videoFile: String? = nil) -> String {
    let summary = ReproSummary(session: session, lines: lines)
    let date = ISO8601DateFormatter().string(from: session.createdAt)
    var out = "# \(session.title)\n\n"
    out += "**\(summary.verdict.rawValue.capitalized):** \(summary.headline)\n\n"
    out += "- Recorded: \(date) by \(session.actor.label)\n"
    out += "- Duration: \(ReproFormat.duration(session.duration)) · \(session.lineCount) log lines from \(session.sources.count) source\(session.sources.count == 1 ? "" : "s")\n"
    if let capture = session.capture { out += "- Captured: \(capture)\n" }
    if let videoFile { out += "- Video: `\(videoFile)` (log timestamps are positions in this video)\n" }
    if session.truncated { out += "- Note: output exceeded the capture limit; later lines were counted but not stored.\n" }
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
        out += "| \(source.workspaceName) / \(source.name) | \(source.lineCount) | \(source.errorCount) | \(source.warningCount) |\n"
      }
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
