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
    do { statuses[path] = try await git.status(at: path) }
    catch { statuses[path] = GitRepoStatus(error: error.localizedDescription) }
  }
  func refreshAll() async {
    await withTaskGroup(of: Void.self) { group in
      for path in wanted { group.addTask { await self.refresh(path) } }
    }
  }
  func setVisible(_ visible: Bool) {
    visibleTask?.cancel(); visibleTask = nil
    guard visible else { return }
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
    watchers.values.forEach { $0.stop() }; watchers.removeAll(); wanted.removeAll()
  }
}
