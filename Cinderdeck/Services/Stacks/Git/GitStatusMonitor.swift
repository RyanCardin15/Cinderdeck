import Combine
import Foundation

@MainActor
final class GitStatusMonitor: ObservableObject {
  @Published private(set) var statuses: [URL: GitRepoStatus] = [:]
  let git: GitService
  private var watchers: [URL: StackDirectoryWatcher] = [:]
  private var refreshing = Set<URL>()
  private var wanted = Set<URL>()
  private var visibleTask: Task<Void, Never>?
  private var visibleSources = Set<String>()
  private var fetchTask: Task<Void, Never>?
  private var generation = 0
  private var autoFetchMinutes = 0
  init(git: GitService = .shared) { self.git = git }

  func configure(_ repos: [RepoDefinition]) {
    generation += 1
    let version = generation
    wanted = Set(repos.map(\.path))
    for path in watchers.keys where !wanted.contains(path) { watchers.removeValue(forKey: path)?.stop(); statuses[path] = nil }
    for path in wanted {
      Task { [weak self] in
        guard let self else { return }
        await refresh(path)
        guard generation == version, watchers[path] == nil, wanted.contains(path),
          let directories = try? await git.gitDirectories(at: path) else { return }
        // Recheck after suspension: a removed repo or stopped monitor must not
        // acquire a watcher, and concurrent configure calls must not replace one.
        guard generation == version, watchers[path] == nil, wanted.contains(path) else { return }
        do {
          watchers[path] = try StackDirectoryWatcher(directories: directories) { [weak self] in
            Task { @MainActor in
              guard let self, self.wanted.contains(path) else { return }
              await self.refresh(path)
            }
          }
        } catch { statuses[path]?.error = error.localizedDescription }
      }
    }
  }
  func refresh(_ path: URL) async {
    guard !refreshing.contains(path) else { return }
    refreshing.insert(path)
    defer { refreshing.remove(path) }
    let status: GitRepoStatus
    do { status = try await git.status(at: path) }
    catch { status = GitRepoStatus(error: error.localizedDescription) }
    // Publishing an unchanged status redraws every workspace view and rewrites the agent state file.
    if statuses[path] != status { statuses[path] = status }
  }
  /// A few repositories at a time: each refresh spawns Git, and many workspaces
  /// can share one 30-second tick.
  func refreshAll() async {
    let paths = Array(wanted)
    await withTaskGroup(of: Void.self) { group in
      var next = 0
      for _ in 0..<min(4, paths.count) {
        let path = paths[next]; next += 1
        group.addTask { await self.refresh(path) }
      }
      while await group.next() != nil, next < paths.count {
        let path = paths[next]; next += 1
        group.addTask { await self.refresh(path) }
      }
    }
  }
  func setVisible(_ visible: Bool, source: String = "history") {
    if visible { visibleSources.insert(source) } else { visibleSources.remove(source) }
    guard !visibleSources.isEmpty else { visibleTask?.cancel(); visibleTask = nil; return }
    guard visibleTask == nil else { return }
    visibleTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refreshAll()
        try? await Task.sleep(nanoseconds: 30_000_000_000)
      }
    }
  }
  func setAutoFetch(minutes: Int) {
    guard autoFetchMinutes != minutes else { return }
    autoFetchMinutes = minutes
    fetchTask?.cancel(); fetchTask = nil
    guard minutes > 0 else { return }
    fetchTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: UInt64(min(minutes, 10080)) * 60_000_000_000)
        guard !Task.isCancelled, let self else { return }
        for path in wanted {
          do { try await git.fetch(at: path); await refresh(path) }
          catch { statuses[path]?.error = error.localizedDescription }
        }
      }
    }
  }
  func stop() {
    generation += 1
    visibleTask?.cancel(); fetchTask?.cancel()
    visibleTask = nil; fetchTask = nil; visibleSources.removeAll()
    watchers.values.forEach { $0.stop() }; watchers.removeAll(); wanted.removeAll()
  }
}
