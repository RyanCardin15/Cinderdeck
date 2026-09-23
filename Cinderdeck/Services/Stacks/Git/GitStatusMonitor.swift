import Combine
import Foundation

@MainActor
final class GitStatusMonitor: ObservableObject {
  @Published private(set) var statuses: [URL: GitRepoStatus] = [:]
  let git: GitService
  private var watchers: [URL: StackFileWatcher] = [:]
  private var refreshing = Set<URL>()
  private var wanted = Set<URL>()
  private var visibleTask: Task<Void, Never>?
  private var visibleSources = Set<String>()
  private var fetchTask: Task<Void, Never>?
  private var generation = 0
  private var autoFetchMinutes = 0
  init(git: GitService = .shared) { self.git = git }

  func configure(_ repos: [RepoDefinition]) {
    wanted = Set(repos.map(\.path))
    for path in watchers.keys where !wanted.contains(path) { watchers.removeValue(forKey: path)?.stop(); statuses[path] = nil }
    for path in wanted {
      Task { [weak self] in
        guard let self else { return }
        await refresh(path)
        guard watchers[path] == nil, wanted.contains(path), let directories = try? await git.gitDirectories(at: path) else { return }
        watchers[path] = StackFileWatcher(delay: 0.6, paths: {
          var urls = directories + [path.appendingPathComponent(".git")]
          for directory in directories {
            urls += ["HEAD", "index", "packed-refs", "refs", "logs", "logs/HEAD"].map { directory.appendingPathComponent($0) }
            for folder in ["refs", "logs/refs"] {
              if let enumerator = FileManager.default.enumerator(at: directory.appendingPathComponent(folder), includingPropertiesForKeys: nil) {
                urls += enumerator.compactMap { $0 as? URL }
              }
            }
          }
          return urls
        }, onChange: { [weak self] in Task { @MainActor in await self?.refresh(path) } })
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
