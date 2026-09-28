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
  // A conservative high-water mark also handles wall-clock adjustments. It may
  // outlive an evicted line, but never hides newer output from a follower.
  private var latestTimestamp = -Double.infinity
  /// Total lines ever appended; unlike `version`, clear() does not move it.
  private var appended = 0
  /// `appended` at the last clear(), so followers can tell cleared lines from evicted ones.
  private var clearedAt = 0
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
    latestTimestamp = max(latestTimestamp, date.timeIntervalSince1970)
  }
  /// Evicts once per batch; trimming per line would shift the whole ring for every line.
  private func trim() {
    if lines.count > capacity { lines.removeFirst(lines.count - capacity) }
  }
  func snapshot(limit: Int? = nil, after: Double? = nil) -> [StackLogLine] {
    // Polling agents usually have nothing new to read. Test before copying.
    if let after, latestTimestamp <= after { return [] }
    let selected = after.map { after in lines.filter { $0.timestamp.timeIntervalSince1970 > after } } ?? lines
    return limit.map { Array(selected.suffix(max(0, $0))) } ?? selected
  }
  func revision() -> Int { version }
  /// Lines appended after `position`, a value this method returned earlier (0 at first).
  /// Followers use it to copy only new output instead of the whole ring. `dropped` counts
  /// lines appended since `position` that the ring evicted before this call.
  func lines(after position: Int) -> (lines: [StackLogLine], next: Int, dropped: Int) {
    let fresh = min(lines.count, max(0, appended - position))
    let dropped = position > 0 && clearedAt <= position ? max(0, appended - position - fresh) : 0
    return (fresh == 0 ? [] : Array(lines.suffix(fresh)), appended, dropped)
  }
  func clear() { lines.removeAll(); partial.removeAll(); version += 1; clearedAt = appended; latestTimestamp = -Double.infinity }
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
  /// A heap makes a full merge O(N log K). A tail request walks backwards and
  /// stops at `limit`, instead of merging N lines to throw almost all of them away.
  /// Ties keep the earlier buffer first, including when reading backwards.
  static func merged(_ buffers: [[StackLogLine]], limit: Int? = nil) -> [StackLogLine] {
    let buffers = buffers.filter { !$0.isEmpty }
    let count = min(max(0, limit ?? Int.max), buffers.reduce(0) { $0 + $1.count })
    guard count > 0 else { return [] }
    if buffers.count == 1 { return count == buffers[0].count ? buffers[0] : Array(buffers[0].suffix(count)) }
    let backwards = limit != nil
    struct Cursor { let buffer: Int; var line: Int }
    var heap: [Cursor] = []
    func precedes(_ lhs: Cursor, _ rhs: Cursor) -> Bool {
      let a = buffers[lhs.buffer][lhs.line].timestamp
      let b = buffers[rhs.buffer][rhs.line].timestamp
      if a == b { return backwards ? lhs.buffer > rhs.buffer : lhs.buffer < rhs.buffer }
      return backwards ? a > b : a < b
    }
    for index in buffers.indices {
      heap.append(Cursor(buffer: index, line: backwards ? buffers[index].count - 1 : 0))
      var child = heap.count - 1
      while child > 0 {
        let parent = (child - 1) / 2
        guard precedes(heap[child], heap[parent]) else { break }
        heap.swapAt(child, parent); child = parent
      }
    }
    var result: [StackLogLine] = []
    result.reserveCapacity(count)
    while !heap.isEmpty, result.count < count {
      let next = heap[0]
      result.append(buffers[next.buffer][next.line])
      let line = next.line + (backwards ? -1 : 1)
      if buffers[next.buffer].indices.contains(line) { heap[0] = Cursor(buffer: next.buffer, line: line) }
      else {
        let last = heap.removeLast()
        if heap.isEmpty { break }
        heap[0] = last
      }
      var parent = 0
      while parent * 2 + 1 < heap.count {
        var child = parent * 2 + 1
        if child + 1 < heap.count, precedes(heap[child + 1], heap[child]) { child += 1 }
        guard precedes(heap[child], heap[parent]) else { break }
        heap.swapAt(parent, child); parent = child
      }
    }
    return backwards ? result.reversed() : result
  }
}
