import Foundation

/// Repros live in one private folder each:
///
///     Repros/<id>/session.json    metadata, markers, sources, workspace state
///     Repros/<id>/lines.jsonl     one log line per row, appended while recording
///     Repros/<id>/git/<repo>.diff uncommitted changes when the recording started
///     Repros/<id>/recording.log   the readable log file (also saved next to the video)
///     Repros/<id>/frames/         frames extracted for agents and exports
///     Repros/<id>/recording.mov   agent and workspace recordings (user recordings stay where they were saved)
nonisolated struct ReproStore: Sendable {
  let directory: URL

  static var defaultDirectory: URL { StackControlPaths.directory.appendingPathComponent("Repros", isDirectory: true) }
  static let shared = ReproStore(directory: defaultDirectory)

  func folder(_ id: UUID) -> URL { directory.appendingPathComponent(id.uuidString, isDirectory: true) }
  func sessionURL(_ id: UUID) -> URL { folder(id).appendingPathComponent("session.json") }
  func linesURL(_ id: UUID) -> URL { folder(id).appendingPathComponent("lines.jsonl") }
  /// The library copy of the readable log file. Always present for saved repros with output.
  func logURL(_ id: UUID) -> URL { folder(id).appendingPathComponent("recording.log") }
  func framesFolder(_ id: UUID) -> URL { folder(id).appendingPathComponent("frames", isDirectory: true) }
  func gitFolder(_ id: UUID) -> URL { folder(id).appendingPathComponent("git", isDirectory: true) }

  func prepare(_ id: UUID) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try FileManager.default.createDirectory(at: folder(id), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }

  func save(_ session: ReproSession) throws {
    try prepare(session.id)
    let url = sessionURL(session.id)
    try StackControlCoding.encoder(pretty: true).encode(session).write(to: url, options: .atomic)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }

  /// Newest first. Unreadable folders are skipped rather than failing the library.
  func loadSessions() -> [ReproSession] {
    guard let folders = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return [] }
    let decoder = StackControlCoding.decoder()
    return folders.compactMap { folder in
      guard UUID(uuidString: folder.lastPathComponent) != nil,
        let data = try? Data(contentsOf: folder.appendingPathComponent("session.json")) else { return nil }
      return try? decoder.decode(ReproSession.self, from: data)
    }.sorted { $0.createdAt > $1.createdAt }
  }

  func loadSession(_ id: UUID) -> ReproSession? {
    guard let data = try? Data(contentsOf: sessionURL(id)) else { return nil }
    return try? StackControlCoding.decoder().decode(ReproSession.self, from: data)
  }

  /// Tolerates a partially written last row after a crash.
  func loadLines(_ id: UUID) -> [ReproLogLine] {
    guard let data = try? Data(contentsOf: linesURL(id)) else { return [] }
    let decoder = StackControlCoding.decoder()
    var lines: [ReproLogLine] = []
    for row in data.split(separator: 10, omittingEmptySubsequences: true) {
      if let line = try? decoder.decode(ReproLogLine.self, from: Data(row)) { lines.append(line) }
    }
    // Sources are polled independently; order the file by the video timeline.
    return lines.sorted { $0.t == $1.t ? $0.id < $1.id : $0.t < $1.t }
  }

  /// Whether any output was written for this repro.
  func hasLines(_ id: UUID) -> Bool {
    ((try? FileManager.default.attributesOfItem(atPath: linesURL(id).path)[.size] as? Int) ?? 0) > 0
  }

  func delete(_ id: UUID) throws {
    let url = folder(id)
    if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
  }

  /// Total bytes used by one repro folder.
  func size(_ id: UUID) -> Int64 {
    guard let enumerator = FileManager.default.enumerator(at: folder(id), includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
    var total: Int64 = 0
    for case let url as URL in enumerator { total += Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    return total
  }
}

/// Appends captured lines to `lines.jsonl` so a crash never loses what was recorded.
nonisolated final class ReproLineWriter: @unchecked Sendable {
  private let handle: FileHandle
  private let encoder = StackControlCoding.encoder()
  private let lock = NSLock()
  private let queue = DispatchQueue(label: "Cinderdeck.ReproLineWriter", qos: .utility)
  private var failure: Error?

  init(url: URL) throws {
    if !FileManager.default.fileExists(atPath: url.path) {
      guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
        throw StackError.message("Could not create \(url.lastPathComponent)")
      }
    }
    handle = try FileHandle(forWritingTo: url)
    _ = try handle.seekToEnd()
  }

  func append(_ lines: [ReproLogLine]) throws {
    guard !lines.isEmpty else { return }
    var data = Data()
    for line in lines {
      data.append(try encoder.encode(line))
      data.append(10)
    }
    lock.lock(); defer { lock.unlock() }
    try handle.write(contentsOf: data)
  }

  /// Encodes and writes on the writer's queue, keeping busy output off the main thread.
  /// A failure is kept for `takeFailure()`.
  func enqueue(_ lines: [ReproLogLine]) {
    guard !lines.isEmpty else { return }
    queue.async { [self] in
      do { try append(lines) } catch { lock.withLock { if failure == nil { failure = error } } }
    }
  }

  func waitForPendingWrites() { queue.sync {} }

  func takeFailure() -> Error? {
    lock.withLock {
      defer { failure = nil }
      return failure
    }
  }

  func close() {
    waitForPendingWrites()
    lock.lock(); defer { lock.unlock() }
    try? handle.synchronize()
    try? handle.close()
  }
}

/// Writes a shareable folder: video, Markdown summary, merged timeline, per-source
/// logs, markers, and the uncommitted diffs captured when recording began.
nonisolated enum ReproBundleExporter {
  struct Result: Sendable {
    let folder: URL
    let readme: URL
    let video: URL?
  }

  static func folderName(for session: ReproSession) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd-HHmmss"
    return "\(ReproReport.slug(session.title))-\(formatter.string(from: session.createdAt))"
  }

  static func export(_ session: ReproSession, lines: [ReproLogLine], store: ReproStore, to parent: URL,
    includeVideo: Bool = true) throws -> Result {
    let manager = FileManager.default
    try manager.createDirectory(at: parent, withIntermediateDirectories: true)
    var folder = parent.appendingPathComponent(folderName(for: session), isDirectory: true)
    var suffix = 2
    while manager.fileExists(atPath: folder.path) {
      folder = parent.appendingPathComponent("\(folderName(for: session))-\(suffix)", isDirectory: true); suffix += 1
    }
    try manager.createDirectory(at: folder, withIntermediateDirectories: true)

    var videoName: String?
    var videoURL: URL?
    if includeVideo, let source = session.videoURL, manager.fileExists(atPath: source.path) {
      let ext = source.pathExtension.isEmpty ? "mov" : source.pathExtension
      let destination = folder.appendingPathComponent("recording.\(ext)")
      try manager.copyItem(at: source, to: destination)
      videoName = destination.lastPathComponent
      videoURL = destination
    }

    let readme = folder.appendingPathComponent("README.md")
    try ReproReport.markdown(session, lines: lines, videoFile: videoName, logFile: "recording.log").write(to: readme, atomically: true, encoding: .utf8)
    try ReproReport.logFile(session, lines: lines, videoName: videoName ?? session.videoURL?.lastPathComponent)
      .write(to: folder.appendingPathComponent("recording.log"), atomically: true, encoding: .utf8)

    let logs = folder.appendingPathComponent("logs", isDirectory: true)
    try manager.createDirectory(at: logs, withIntermediateDirectories: true)
    var usedNames = Set<String>()
    for source in session.sources {
      var name = ReproReport.slug(session.workspaces.count > 1 ? "\(source.workspace)-\(source.name)" : source.name, fallback: "output")
      while !usedNames.insert(name).inserted { name += "-2" }
      let text = lines.filter { $0.source == source.id }.map { ReproReport.logLine($0, session: session) }.joined(separator: "\n")
      try (text + "\n").write(to: logs.appendingPathComponent(name + ".log"), atomically: true, encoding: .utf8)
    }

    let encoder = StackControlCoding.encoder(pretty: true)
    var manifest = session
    manifest.videoBookmark = nil
    manifest.videoPath = videoName
    try encoder.encode(manifest).write(to: folder.appendingPathComponent("repro.json"))
    try encoder.encode(ReproSummary(session: session, lines: lines)).write(to: folder.appendingPathComponent("summary.json"))

    for (name, subfolder) in [("git", store.gitFolder(session.id)), ("frames", store.framesFolder(session.id))] {
      if manager.fileExists(atPath: subfolder.path), let items = try? manager.contentsOfDirectory(atPath: subfolder.path), !items.isEmpty {
        try manager.copyItem(at: subfolder, to: folder.appendingPathComponent(name, isDirectory: true))
      }
    }
    return Result(folder: folder, readme: readme, video: videoURL)
  }
}
