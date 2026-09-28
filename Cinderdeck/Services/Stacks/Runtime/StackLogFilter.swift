import Foundation

/// Stable line IDs let live searches evaluate only new output. Retain matches
/// only for the current buffer, so long-running consoles cannot grow the cache.
nonisolated struct StackLogFilter {
  private var query = ""
  private var matches: [UUID: Bool] = [:]

  mutating func filter(_ lines: [StackLogLine], query: String) -> [StackLogLine] {
    guard !query.isEmpty else { self.query = ""; matches.removeAll(); return lines }
    if self.query != query { matches.removeAll(); self.query = query }
    var retained: [UUID: Bool] = [:]
    retained.reserveCapacity(lines.count)
    let result = lines.filter { line in
      let match = matches[line.id] ?? AnsiParser.plainText(line.text).localizedCaseInsensitiveContains(query)
      retained[line.id] = match
      return match
    }
    matches = retained
    return result
  }
}
