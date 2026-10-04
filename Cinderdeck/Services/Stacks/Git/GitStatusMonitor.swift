import Combine
import Foundation

@MainActor
final class GitStatusMonitor: ObservableObject {
  @Published private(set) var statuses: [URL: GitRepoStatus] = [:]
  let git: GitService
  // A separate FSEvents stream per checkout also duplicates every ancestor's
  // descriptors. One stream covers all Git roots, including shared worktree roots.
  private var watcher: StackDirectoryWatcher?
  private var watchedDirectories: [URL: [URL]] = [:]
  private var watcherRoots = Set<String>()
  private var configurationTask: Task<Void, Never>?
  private var eventTask: Task<Void, Never>?
  private var eventSequence = 0
  private var pendingEvents = Set<URL>()
  private struct Refresh {
    let id = UUID()
    let task: Task<GitRepoStatus, Error>
  }
  private var refreshing: [URL: Refresh] = [:]
  private var wanted = Set<URL>()
  private var visibleTask: Task<Void, Never>?
  private var visibleSources = Set<String>()
  private var fetchTask: Task<Void, Never>?
  private var generation = 0
  private var autoFetchMinutes = 0
  init(git: GitService = .shared) { self.git = git }
  // stop() owns actor-bound shutdown. Stored values need no executor hop on release.
  nonisolated deinit {}

  func configure(_ repos: [RepoDefinition]) {
    generation += 1
    let version = generation
    wanted = Set(repos.map(\.path))
    for path in statuses.keys where !wanted.contains(path) { statuses[path] = nil }
    for path in watchedDirectories.keys where !wanted.contains(path) { watchedDirectories[path] = nil }
    pendingEvents.formIntersection(wanted)
    configurationTask?.cancel()
    rebuildWatcher()
    let paths = wanted.filter { watchedDirectories[$0] == nil }.sorted { $0.path < $1.path }
    configurationTask = Task { [weak self] in
      guard let self else { return }
      // Bound initial discovery too; configure previously spawned every Git
      // status and directory lookup concurrently when hundreds of lanes loaded.
      await withTaskGroup(of: Void.self) { group in
        var next = 0
        for _ in 0..<min(4, paths.count) {
          let path = paths[next]; next += 1
          group.addTask { await self.discover(path, version: version) }
        }
        while await group.next() != nil, next < paths.count, !Task.isCancelled {
          let path = paths[next]; next += 1
          group.addTask { await self.discover(path, version: version) }
        }
      }
      guard generation == version, !Task.isCancelled else { return }
      rebuildWatcher()
    }
  }

  private func discover(_ path: URL, version: Int) async {
    guard generation == version, wanted.contains(path), !Task.isCancelled else { return }
    await refresh(path)
    guard generation == version, wanted.contains(path), !Task.isCancelled else { return }
    do {
      let directories = try await git.gitDirectories(at: path)
      guard generation == version, wanted.contains(path), !Task.isCancelled else { return }
      watchedDirectories[path] = directories.map { $0.standardizedFileURL.resolvingSymlinksInPath() }
    } catch is CancellationError { return }
    catch { if wanted.contains(path) { statuses[path]?.error = error.localizedDescription } }
  }

  private func rebuildWatcher() {
    let all = Set(watchedDirectories.values.flatMap { $0.map(\.path) })
    var roots: [String] = []
    for path in all.sorted(by: { $0.count < $1.count }) {
      if !roots.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) { roots.append(path) }
    }
    let selected = Set(roots)
    guard selected != watcherRoots else { return }
    watcher?.stop(); watcher = nil; watcherRoots = []
    guard !roots.isEmpty else { return }
    do {
      watcher = try StackDirectoryWatcher(directories: roots.map { URL(fileURLWithPath: $0) }, onPathsChange: { [weak self] changes in
        Task { @MainActor in self?.receiveFilesystemChanges(changes) }
      })
      watcherRoots = selected
    } catch { for path in wanted { statuses[path]?.error = error.localizedDescription } }
  }

  // An empty delivery means the kernel dropped events; all owners must rescan.
  func receiveFilesystemChanges(_ changes: [String]) {
    guard !wanted.isEmpty else { return }
    if changes.isEmpty { pendingEvents.formUnion(wanted) }
    else {
      // FSEvents may deliver /var while discovery resolves it to /private/var.
      // Compare filesystem identities in the same canonical spelling.
      let canonicalChanges = changes.map { URL(fileURLWithPath: $0).standardizedFileURL.resolvingSymlinksInPath().path }
      for (path, directories) in watchedDirectories where wanted.contains(path) {
        if directories.contains(where: { directory in canonicalChanges.contains(where: { change in
          change == directory.path || change.hasPrefix(directory.path + "/") || directory.path.hasPrefix(change + "/")
        }) }) { pendingEvents.insert(path) }
      }
    }
    guard eventTask == nil, !pendingEvents.isEmpty else { return }
    eventSequence += 1
    let sequence = eventSequence
    eventTask = Task { [weak self] in
      guard let self else { return }
      defer { if eventSequence == sequence { eventTask = nil } }
      while !pendingEvents.isEmpty, !Task.isCancelled {
        let paths = Array(pendingEvents.intersection(wanted)); pendingEvents.removeAll()
        await refreshPaths(paths)
      }
    }
  }
  func refresh(_ path: URL) async {
    let read: Refresh
    let owner: Bool
    if let existing = refreshing[path] { read = existing; owner = false }
    else {
      let git = self.git
      read = Refresh(task: Task { try await git.status(at: path) })
      refreshing[path] = read; owner = true
    }
    defer { if owner, refreshing[path]?.id == read.id { refreshing[path] = nil } }
    let status: GitRepoStatus
    do { status = try await read.task.value }
    catch is CancellationError { return }
    catch { status = GitRepoStatus(error: error.localizedDescription) }
    // Publishing an unchanged status redraws every workspace view and rewrites the agent state file.
    if wanted.contains(path), statuses[path] != status { statuses[path] = status }
  }
  /// A few repositories at a time: each refresh spawns Git, and many workspaces
  /// can share one 30-second tick.
  func refreshAll() async {
    await refreshPaths(Array(wanted))
  }
  private func refreshPaths(_ paths: [URL]) async {
    await withTaskGroup(of: Void.self) { group in
      var next = 0
      for _ in 0..<min(4, paths.count) {
        let path = paths[next]; next += 1
        group.addTask { await self.refresh(path) }
      }
      while await group.next() != nil, next < paths.count, !Task.isCancelled {
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
    configurationTask?.cancel(); configurationTask = nil
    refreshing.values.forEach { $0.task.cancel() }; refreshing.removeAll()
    eventSequence += 1; eventTask?.cancel(); eventTask = nil; pendingEvents.removeAll()
    watcher?.stop(); watcher = nil; watcherRoots.removeAll(); watchedDirectories.removeAll(); wanted.removeAll()
  }
}
