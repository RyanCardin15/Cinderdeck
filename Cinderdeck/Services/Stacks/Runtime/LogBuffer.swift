import Foundation

nonisolated struct StackLogLine: Identifiable, Equatable, Sendable {
  let id: UUID
  let service: String
  let timestamp: Date
  let text: String
  init(service: String, text: String, timestamp: Date = Date()) {
    id = UUID(); self.service = service; self.text = text; self.timestamp = timestamp
  }
}

nonisolated struct LogBufferRevision: Equatable, Sendable {
  let buffer: ObjectIdentifier
  let revision: Int
}

actor LogBuffer {
  static let capacity = 5_000
  static let maximumFileBytes: UInt64 = 50 * 1024 * 1024
  private let service: String
  private let capacity: Int
  private var lines: [StackLogLine] = []
  private var partial = Data()
  private var handle: FileHandle?
  private var source: DispatchSourceFileSystemObject?
  private var offset: UInt64 = 0
  private var scheduledRead: Task<Void, Never>?
  private var version = 0
  /// Total lines ever appended; unlike `version`, clear() does not move it.
  private var appended = 0
  private var truncatedPartial = false
  private let readinessPattern: String?
  private let readinessRegex: NSRegularExpression?
  private var reachedReadiness = false

  init(service: String, capacity: Int = LogBuffer.capacity, readinessPattern: String? = nil) {
    self.service = service; self.capacity = max(1, capacity)
    self.readinessPattern = readinessPattern
    readinessRegex = readinessPattern.flatMap { try? NSRegularExpression(pattern: $0) }
  }

  func follow(_ url: URL, fromEnd: Bool) throws {
    close()
    let fd = open(url.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
    guard fd >= 0 else { throw StackError.message("Cannot read log for \(service)") }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    offset = fromEnd ? (try handle.seekToEnd()) : 0
    try handle.seek(toOffset: offset)
    self.handle = handle
    let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: [.write, .extend, .delete, .rename], queue: .global(qos: .utility))
    source.setEventHandler { [weak self] in Task { await self?.scheduleRead() } }
    // Cancellation is asynchronous. Keep the descriptor alive until Dispatch
    // has unregistered it so a concurrent command cannot reuse it prematurely.
    source.setCancelHandler { try? handle.close() }
    self.source = source
    source.resume()
    readAvailable()
  }

  private func scheduleRead() {
    guard scheduledRead == nil else { return }
    scheduledRead = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 100_000_000)
      guard !Task.isCancelled else { return }
      await self?.flush()
    }
  }
  private func flush() { scheduledRead = nil; readAvailable() }

  func readAvailable() {
    guard let handle else { return }
    do {
      var info = stat()
      guard fstat(handle.fileDescriptor, &info) == 0 else { return }
      let size = UInt64(max(0, info.st_size))
      if size > Self.maximumFileBytes {
        try handle.truncate(atOffset: 0)
        offset = 0; partial.removeAll()
        append("[Log file rotated at 50 MB]")
      } else if size < offset { offset = 0; partial.removeAll() }
      try handle.seek(toOffset: offset)
      // Bound each read so noisy writers yield to other work. Vnode events alone
      // needn't fire again if the writer stopped after a large burst.
      let data = try handle.read(upToCount: 256 * 1024) ?? Data()
      offset += UInt64(data.count)
      consume(data)
      if data.count == 256 * 1024 { scheduleRead() }
    } catch { append("[Log read failed: \(error.localizedDescription)]") }
  }

  func consume(_ data: Data) {
    partial.append(data)
    // Walk the chunk once and drop consumed bytes at the end. Removing each line
    // from the front of `partial` is quadratic for a burst of short lines.
    var start = partial.startIndex
    let date = Date()
    while let end = partial[start...].firstIndex(of: 10) {
      let line = partial[start..<end]
      var text = String(decoding: line, as: UTF8.self)
      if line.contains(13) { text = text.replacingOccurrences(of: "\r", with: "") }
      appendLine(text + (truncatedPartial ? " [long line truncated]" : ""), at: date)
      start = partial.index(after: end)
      truncatedPartial = false
    }
    if start != partial.startIndex { partial = Data(partial[start...]) }
    trim()
    if partial.count > 64 * 1024 {
      partial = Data(partial.suffix(64 * 1024))
      truncatedPartial = true
    }
    checkReadiness(String(decoding: partial, as: UTF8.self))
  }

  func append(_ text: String, at date: Date = Date()) {
    appendLine(text, at: date)
    trim()
  }
  private func appendLine(_ text: String, at date: Date) {
    checkReadiness(text)
    lines.append(.init(service: service, text: text.utf8.count > 64 * 1024 ? String(text.prefix(64 * 1024)) : text, timestamp: date))
    appended += 1
    version += 1
  }
  /// Evicts once per batch; trimming per line would shift the whole ring for every line.
  private func trim() {
    if lines.count > capacity { lines.removeFirst(lines.count - capacity) }
  }
  func snapshot() -> [StackLogLine] { lines }
  func revision() -> Int { version }
  /// Lines appended after `position`, a value this method returned earlier (0 at first).
  /// Followers use it to copy only new output instead of the whole ring.
  func lines(after position: Int) -> (lines: [StackLogLine], next: Int) {
    let fresh = min(lines.count, max(0, appended - position))
    return (fresh == 0 ? [] : Array(lines.suffix(fresh)), appended)
  }
  func clear() { lines.removeAll(); partial.removeAll(); version += 1 }
  func matches(_ pattern: String) -> Bool {
    if pattern == readinessPattern { return reachedReadiness }
    guard let regex = try? NSRegularExpression(pattern: pattern) else { return false }
    return (lines.map(\.text) + [String(decoding: partial, as: UTF8.self)]).contains {
      let text = AnsiParser.plainText($0)
      return regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
  }
  private func checkReadiness(_ value: String) {
    guard !reachedReadiness, let readinessRegex else { return }
    let text = AnsiParser.plainText(value)
    reachedReadiness = readinessRegex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
  }
  func finish() {
    if let handle {
      let size = (try? handle.seekToEnd()) ?? offset
      while offset < size { let previous = offset; readAvailable(); if offset <= previous { break } }
    }
    if !partial.isEmpty { append(String(decoding: partial, as: UTF8.self)); partial.removeAll() }
  }
  func close() {
    scheduledRead?.cancel(); scheduledRead = nil
    source?.cancel(); source = nil
    handle = nil
  }
  deinit { scheduledRead?.cancel(); source?.cancel() }
  /// Each buffer is already in arrival order, so a k-way merge replaces a full sort.
  /// Ties keep the earlier buffer first.
  static func merged(_ buffers: [[StackLogLine]]) -> [StackLogLine] {
    let buffers = buffers.filter { !$0.isEmpty }
    if buffers.count <= 1 { return buffers.first ?? [] }
    var result: [StackLogLine] = []
    result.reserveCapacity(buffers.reduce(0) { $0 + $1.count })
    var heads = [Int](repeating: 0, count: buffers.count)
    while true {
      var next: Int?
      for index in buffers.indices where heads[index] < buffers[index].count {
        if let current = next, buffers[current][heads[current]].timestamp <= buffers[index][heads[index]].timestamp { continue }
        next = index
      }
      guard let next else { return result }
      result.append(buffers[next][heads[next]])
      heads[next] += 1
    }
  }
}
