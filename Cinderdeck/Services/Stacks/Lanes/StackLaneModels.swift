import Foundation

nonisolated struct StackLaneInfo: Codable, Equatable, Sendable {
  let sourceStackID: String
  let name: String
  let owner: StackActor
  let createdAt: Date
  /// The lane's working folder: its worktrees live below it. Records from before
  /// lanes moved out of the definitions folder use the record folder.
  let directory: URL
  /// Assigned ports. Keys: "<service>", "<service>.<port name>", "task:<task>", "task:<task>.<port name>".
  var ports: [String: Int]
  var slug: String?
  /// Per-lane overrides from `lane create --env`. They win over TOML values.
  var environment: [String: String] = [:]
  /// Start point for branches this lane created.
  var from: String?
  /// Set with `[lanes] hosts = true`: `<slug>.<workspace>.localhost`.
  var host: String?
  /// A lane created before lanes followed their source keeps its saved definition until unpinned.
  var pinned = false
  /// At least one worktree was adopted rather than created, so Cinderdeck never deletes it.
  var adopted = false

  var reference: String { sourceStackID + "/" + name }
  var effectiveSlug: String { slug ?? Self.slug(for: name) }

  static func portVariable(_ service: String) -> String {
    "CINDERDECK_PORT_" + variableName(service)
  }
  static func portVariable(_ service: String, port: String) -> String {
    portVariable(service) + "_" + variableName(port)
  }
  static func urlVariable(_ service: String) -> String { "CINDERDECK_URL_" + variableName(service) }
  static func variableName(_ name: String) -> String {
    name.uppercased().replacingOccurrences(of: "-", with: "_").replacingOccurrences(of: ":", with: "__")
  }

  /// Hostname-safe: lowercase letters, digits and single hyphens, at most 40 characters.
  static func slug(for name: String) -> String {
    let folded = name.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    let trimmed = String(folded.prefix(40)).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return trimmed.isEmpty ? "lane" : trimmed
  }
  static func ident(for slug: String) -> String { slug.replacingOccurrences(of: "-", with: "_") }
  static func hostLabel(_ id: String) -> String {
    let label = id.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
      .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    return label.isEmpty ? "workspace" : String(label.prefix(40))
  }
  static func composeProject(source: String, slug: String) -> String {
    (source.lowercased() + "-" + slug).replacingOccurrences(of: "[^a-z0-9_-]+", with: "-", options: .regularExpression)
  }
}

extension StackLaneInfo {
  nonisolated enum CodingKeys: String, CodingKey {
    case sourceStackID, name, owner, createdAt, directory, ports, slug, environment, from, host, pinned, adopted
  }
  nonisolated init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sourceStackID = try c.decode(String.self, forKey: .sourceStackID)
    name = try c.decode(String.self, forKey: .name)
    owner = try c.decode(StackActor.self, forKey: .owner)
    createdAt = try c.decode(Date.self, forKey: .createdAt)
    directory = try c.decode(URL.self, forKey: .directory)
    ports = try c.decodeIfPresent([String: Int].self, forKey: .ports) ?? [:]
    slug = try c.decodeIfPresent(String.self, forKey: .slug)
    environment = try c.decodeIfPresent([String: String].self, forKey: .environment) ?? [:]
    from = try c.decodeIfPresent(String.self, forKey: .from)
    host = try c.decodeIfPresent(String.self, forKey: .host)
    pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
    adopted = try c.decodeIfPresent(Bool.self, forKey: .adopted) ?? false
  }
}

nonisolated struct StackLaneWorktree: Codable, Equatable, Sendable {
  /// The repository's original checkout, where Git commands for this worktree run.
  let source: URL
  let path: URL
  var branch: String?
  /// Cinderdeck created this worktree and may remove it. Adopted worktrees are never removed.
  var managed = true
  /// The branch tip when the lane started using it; commits after it make "merged" meaningful.
  var baseCommit: String?
}

extension StackLaneWorktree {
  nonisolated enum CodingKeys: String, CodingKey { case source, path, branch, managed, baseCommit }
  nonisolated init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    source = try c.decode(URL.self, forKey: .source)
    path = try c.decode(URL.self, forKey: .path)
    branch = try c.decodeIfPresent(String.self, forKey: .branch)
    managed = try c.decodeIfPresent(Bool.self, forKey: .managed) ?? true
    baseCommit = try c.decodeIfPresent(String.self, forKey: .baseCommit)
  }
}

/// A file Cinderdeck copied or linked into a lane. Unchanged copies are removed without asking.
nonisolated struct StackLaneCopiedFile: Codable, Equatable, Sendable {
  let path: URL
  /// SHA-256 of a copied file; nil for directories and links.
  var hash: String?
  var link = false
}

nonisolated struct StackLaneSetupState: Codable, Equatable, Sendable {
  enum Status: String, Codable, Sendable { case pending, running, succeeded, failed, skipped }
  var status: Status
  var reference: String
  var runID: UUID?
  var detail: String?
  var updatedAt = Date()
}

/// `lane.json`. Version 2 stores an overlay on the source definition; version 1
/// stored a full definition snapshot, which now loads as a pinned lane.
nonisolated struct StackLaneRecord: Codable, Sendable {
  var id: String
  var info: StackLaneInfo
  var worktrees: [StackLaneWorktree]
  var ready: Bool?
  var setup: StackLaneSetupState?
  /// The saved definition of a pinned lane.
  var definition: StackDefinition?
  var copied: [StackLaneCopiedFile] = []
  var version = 2

  init(id: String, info: StackLaneInfo, worktrees: [StackLaneWorktree], ready: Bool? = nil) {
    self.id = id; self.info = info; self.worktrees = worktrees; self.ready = ready
  }

  enum CodingKeys: String, CodingKey { case id, info, worktrees, ready, setup, definition, copied, version }
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    worktrees = try c.decode([StackLaneWorktree].self, forKey: .worktrees)
    ready = try c.decodeIfPresent(Bool.self, forKey: .ready)
    setup = try c.decodeIfPresent(StackLaneSetupState.self, forKey: .setup)
    definition = try c.decodeIfPresent(StackDefinition.self, forKey: .definition)
    copied = try c.decodeIfPresent([StackLaneCopiedFile].self, forKey: .copied) ?? []
    version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
    if let info = try c.decodeIfPresent(StackLaneInfo.self, forKey: .info) {
      self.info = info
      id = try c.decode(String.self, forKey: .id)
    } else {
      guard let definition, var info = definition.lane else {
        throw StackError.message("Lane record has neither lane details nor a saved definition")
      }
      info.pinned = true
      self.info = info
      id = definition.id
    }
  }
}

/// What to create: a branch, where to start it, and per-lane choices.
nonisolated struct StackLaneRequest: Sendable {
  var branch: String
  var from: String?
  var environment: [String: String] = [:]
  var copy: [String] = []
  /// Adopt an existing worktree instead of creating one for its repository.
  var adoptPath: URL?
  init(branch: String, from: String? = nil, environment: [String: String] = [:], copy: [String] = [], adoptPath: URL? = nil) {
    self.branch = branch; self.from = from; self.environment = environment; self.copy = copy; self.adoptPath = adoptPath
  }
}

nonisolated struct StackLaneRemovalOptions: Sendable {
  /// Delete ignored files such as node_modules, build output and .env copies.
  var discardIgnored = false
  /// Keep every worktree on disk and only forget the lane (`lane release`).
  var keepWorktrees = false
  var deleteLogs = false
  var forceTeardown = false
  init(discardIgnored: Bool = false, keepWorktrees: Bool = false, deleteLogs: Bool = false, forceTeardown: Bool = false) {
    self.discardIgnored = discardIgnored; self.keepWorktrees = keepWorktrees; self.deleteLogs = deleteLogs; self.forceTeardown = forceTeardown
  }
}

nonisolated struct StackLaneIgnoredEntry: Codable, Equatable, Sendable {
  let path: String
  let bytes: Int64?
  var note: String?
}

/// What removal found and did.
nonisolated struct StackLaneRemovalReport: Codable, Sendable {
  var ignored: [StackLaneIgnoredEntry] = []
  var removedWorktrees: [String] = []
  var keptWorktrees: [String] = []
  /// Branch → commits that are on no remote. Branches are kept, so this is informational.
  var unpushed: [String: Int] = [:]
  var ignoredBytes: Int64 { ignored.compactMap(\.bytes).reduce(0, +) }
}

nonisolated struct StackLaneGitState: Codable, Equatable, Sendable {
  var merged = false
  var upstreamGone = false
  var unpushed = 0
  var branches: [String] = []
}
