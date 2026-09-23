import Foundation

actor GitService {
  static let shared = GitService()
  private var repositories: [URL: GitRepositoryCommands] = [:]
  private func repository(_ path: URL) -> GitRepositoryCommands {
    let key = path.standardizedFileURL.resolvingSymlinksInPath()
    if let worker = repositories[key] { return worker }
    let worker = GitRepositoryCommands(path: key)
    repositories[key] = worker
    return worker
  }
  func status(at path: URL) async throws -> GitRepoStatus { try await repository(path).status() }
  func branches(at path: URL) async throws -> [GitBranch] { try await repository(path).branches() }
  func recentBranches(at path: URL) async throws -> [String] { try await repository(path).recent() }
  func gitDirectories(at path: URL) async throws -> [URL] { try await repository(path).directories() }
  func fetch(at path: URL) async throws { try await repository(path).fetch() }
  func pull(at path: URL) async throws { try await repository(path).pull() }
  func switchBranch(_ branch: GitBranch, at path: URL, dirty: GitDirtyStrategy) async throws {
    try await repository(path).switchBranch(branch, dirty: dirty)
  }
  func stashes(at path: URL) async throws -> [GitStash] { try await repository(path).stashes() }
  func applyStash(_ stash: GitStash, at path: URL, drop: Bool) async throws {
    try await repository(path).applyStash(stash, drop: drop)
  }
}

/// Actors are reentrant at await. This explicit queue serializes whole Git
/// transactions, including status/stash/checkout, not just individual spawns.
private actor GitRepositoryCommands {
  let path: URL
  private var busy = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  init(path: URL) { self.path = path }
  private func acquire() async {
    if !busy { busy = true; return }
    await withCheckedContinuation { waiters.append($0) }
  }
  private func release() {
    if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
  }
  private func command(_ args: [String]) async throws -> String {
    var env = try await ShellEnvironmentResolver.shared.resolve()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "Never"
    env["GIT_OPTIONAL_LOCKS"] = "0"
    env["LC_ALL"] = "C"
    for attempt in 0...1 {
      let result = try await StackCommandRunner.run("/usr/bin/git", ["-c", "color.ui=false"] + args,
        directory: path, environment: env, timeout: 60)
      if result.status == 0 { return result.text }
      if attempt == 0, result.errorText.contains("index.lock") {
        try await Task.sleep(nanoseconds: 500_000_000); continue
      }
      let message = result.errorText.isEmpty ? result.text : result.errorText
      throw StackError.message(String(message.prefix(4000)))
    }
    throw StackError.message("Git command failed")
  }
  private func readDirectories() async throws -> [URL] {
    try await command(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
      .split(separator: "\n").map { StackDefinitionLoader.resolve(String($0), relativeTo: path) }
  }
  private func readStatus() async throws -> GitRepoStatus {
    let output = try await command(["status", "--porcelain=v2", "--branch", "-z"])
    let directories = try await readDirectories()
    var operation: String?
    for directory in directories {
      for (file, label) in [("MERGE_HEAD", "Merge in progress"), ("rebase-merge", "Rebase in progress"),
        ("rebase-apply", "Rebase in progress"), ("CHERRY_PICK_HEAD", "Cherry-pick in progress"), ("REVERT_HEAD", "Revert in progress")] {
        if FileManager.default.fileExists(atPath: directory.appendingPathComponent(file).path) { operation = label }
      }
    }
    return GitStatusParser.parse(output, operation: operation)
  }
  func status() async throws -> GitRepoStatus {
    await acquire(); defer { release() }
    return try await readStatus()
  }
  func directories() async throws -> [URL] {
    await acquire(); defer { release() }
    return try await readDirectories()
  }
  func branches() async throws -> [GitBranch] {
    await acquire(); defer { release() }
    let output = try await command(["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(upstream:short)%00%(subject)", "refs/heads", "refs/remotes"])
    return output.split(separator: "\n").compactMap { line in
      let fields = line.components(separatedBy: "\0")
      guard fields.count >= 3 else { return nil }
      let ref = fields[0]
      let remote = ref.hasPrefix("refs/remotes/")
      guard !remote || !ref.hasSuffix("/HEAD") else { return nil }
      let short = String(ref.dropFirst(remote ? "refs/remotes/".count : "refs/heads/".count))
      let name = remote ? short.split(separator: "/", maxSplits: 1).dropFirst().joined(separator: "/") : short
      return GitBranch(name: name, reference: ref, isRemote: remote, upstream: fields[1].isEmpty ? nil : fields[1], subject: fields[2])
    }
  }
  func recent() async throws -> [String] {
    await acquire(); defer { release() }
    return GitStatusParser.recentBranches(try await command(["reflog", "-n", "200", "--format=%gs"]))
  }
  func fetch() async throws {
    await acquire(); defer { release() }
    _ = try await command(["fetch", "--prune", "--quiet"])
  }
  func pull() async throws {
    await acquire(); defer { release() }
    let status = try await readStatus()
    if let operation = status.operation { throw StackError.message(operation + " — resolve in a terminal") }
    do { _ = try await command(["pull", "--ff-only"]) }
    catch {
      if error.localizedDescription.contains("fast-forward") || error.localizedDescription.contains("diverg") {
        throw StackError.message("Diverged — resolve in a terminal")
      }
      throw error
    }
  }
  func switchBranch(_ branch: GitBranch, dirty: GitDirtyStrategy) async throws {
    await acquire(); defer { release() }
    guard !branch.name.hasPrefix("-"), !branch.name.contains("\0") else { throw StackError.message("Invalid branch name") }
    _ = try await command(["check-ref-format", "--branch", branch.name])
    let status = try await readStatus()
    if let operation = status.operation { throw StackError.message(operation + " — resolve in a terminal") }
    if status.isDirty {
      switch dirty {
      case .requireClean: throw StackError.message("Working tree changed. Review the changes before switching.")
      case .stash: _ = try await command(["stash", "push", "-u", "-m", "cinderdeck: before \(branch.name)"])
      case .carry: break
      }
    }
    if branch.isRemote {
      guard branch.reference.hasPrefix("refs/remotes/") else { throw StackError.message("Invalid remote branch") }
      _ = try await command(["switch", "--track", "--", String(branch.reference.dropFirst("refs/remotes/".count))])
    } else { _ = try await command(["switch", "--", branch.name]) }
  }
  private func readStashes() async throws -> [GitStash] {
    try await command(["stash", "list", "--format=%gd%x00%H%x00%gs"]).split(separator: "\n").compactMap { line in
      let fields = line.components(separatedBy: "\0")
      guard fields.count >= 3, (fields[2].contains(": cinderdeck: before ") || fields[2].contains(": snapzy: before ")) else { return nil }
      return GitStash(reference: fields[0], oid: fields[1], message: fields[2])
    }
  }
  func stashes() async throws -> [GitStash] {
    await acquire(); defer { release() }
    return try await readStashes()
  }
  func applyStash(_ stash: GitStash, drop: Bool) async throws {
    await acquire(); defer { release() }
    guard let current = try await readStashes().first(where: { $0.oid == stash.oid }) else {
      throw StackError.message("This stash no longer exists. Refresh and try again.")
    }
    _ = try await command(["stash", drop ? "drop" : "pop", "--", current.reference])
  }
}
