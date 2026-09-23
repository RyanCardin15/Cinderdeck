import Foundation

/// Session-only results. The owner resets this store whenever the account or host changes.
@MainActor
final class PRSearchCache {
  struct Entry {
    var page: PullRequestSearchPage
    var updated: Date
  }
  private struct Pending {
    var id: UUID
    var task: Task<Entry, Error>
  }
  private var entries: [String: Entry] = [:]
  private var pending: [String: Pending] = [:]
  private var activeLoads = 0
  private let lifetime: TimeInterval
  private let now: () -> Date
  init(lifetime: TimeInterval = 60, now: @escaping () -> Date = Date.init) {
    self.lifetime = lifetime
    self.now = now
  }
  func entry(for query: String) -> Entry? { entries[query] }
  func isFresh(_ entry: Entry) -> Bool { now().timeIntervalSince(entry.updated) < lifetime }

  func load(_ query: String, service: GitHubPRServing, force: Bool = false) async throws -> Entry {
    if !force, let entry = entries[query], isFresh(entry) { return entry }
    // A tab selected while being prefetched joins the same request.
    if let request = pending[query] { return try await request.task.value }
    let id = UUID()
    let task = Task {
      let page = try await self.page(query, after: nil, service: service)
      try Task.checkCancellation()
      return Entry(page: page, updated: now())
    }
    pending[query] = Pending(id: id, task: task)
    defer { if pending[query]?.id == id { pending[query] = nil } }
    let entry = try await task.value
    guard pending[query]?.id == id else { throw CancellationError() }
    store(entry, for: query)
    return entry
  }
  func page(_ query: String, after: String?, service: GitHubPRServing) async throws -> PullRequestSearchPage {
    while activeLoads >= 3 { try await Task.sleep(nanoseconds: 25_000_000) }
    try Task.checkCancellation()
    activeLoads += 1
    defer { activeLoads -= 1 }
    return try await service.search(query, after: after)
  }
  func store(_ entry: Entry, for query: String) {
    entries[query] = entry
    // Bound memory, including pages appended by Load more.
    if entries.count > 16, let oldest = entries.filter({ $0.key != query }).min(by: { $0.value.updated < $1.value.updated })?.key {
      entries[oldest] = nil
    }
  }
  func retainRequests(for queries: Set<String>) {
    for key in Array(pending.keys) where !queries.contains(key) {
      pending.removeValue(forKey: key)?.task.cancel()
    }
  }
  func reset() {
    retainRequests(for: [])
    entries.removeAll()
  }
}
