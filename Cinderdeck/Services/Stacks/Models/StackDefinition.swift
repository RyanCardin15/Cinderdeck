import CryptoKit
import Foundation

typealias StackID = String

/// How a repository takes part in a worktree lane.
nonisolated enum StackRepoLaneMode: String, Codable, Sendable, CaseIterable {
  /// Each lane gets its own Git worktree on the lane's branch.
  case worktree
  /// Lanes use the original checkout. Its services default to `shared`.
  case shared
}

/// How a service takes part in a worktree lane.
nonisolated enum StackServiceLaneMode: String, Codable, Sendable, CaseIterable {
  /// The lane runs its own copy on its own ports.
  case isolate
  /// The lane uses the original checkout's instance; starting the lane starts it there.
  case shared
  /// The service does not exist in lanes.
  case off
}

nonisolated struct RepoDefinition: Codable, Equatable, Identifiable, Sendable {
  let id: String
  let path: URL
  var laneMode: StackRepoLaneMode = .worktree
}

nonisolated enum StackReadiness: Codable, Equatable, Sendable {
  case alive
  case port(Int)
  case http(URL)
  case log(String)
}

nonisolated struct ServiceDefinition: Codable, Equatable, Identifiable, Sendable {
  let id: String
  var command: String
  var repo: String?
  var directory: URL
  var dependencies: [String] = []
  var port: Int?
  var readiness: StackReadiness = .alive
  var readyTimeout: TimeInterval = 90
  var environment: [String: String] = [:]
  var restartOnFailure = true
  var stopSignal: Int32 = SIGTERM
  var stopTimeout: TimeInterval = 10
  var autostart = true
  /// Extra named ports, e.g. `ports.hmr = 24678`. `port` stays the primary port.
  var ports: [String: Int] = [:]
  /// nil uses the default: isolate, or shared when the folder is outside the lane's worktrees.
  var laneMode: StackServiceLaneMode?
  /// Values as written in the TOML, kept when they contain `{{…}}` templates.
  var raw: StackRawValues?

  /// Primary port plus named ports, keyed "" for the primary port.
  var allPorts: [String: Int] {
    var result = ports
    if let port { result[""] = port }
    return result
  }
}

/// Template text as written in the definition. Concrete fields hold the value
/// rendered for the workspace or lane the definition belongs to.
nonisolated struct StackRawValues: Codable, Equatable, Sendable {
  var command: String?
  var environment: [String: String] = [:]
  var readyHTTP: String?
  /// `ready.port = "hmr"` names one of the service's ports.
  var readyPort: String?
  var isEmpty: Bool { command == nil && environment.isEmpty && readyHTTP == nil && readyPort == nil }
}

/// A service a workspace uses but does not run: the original checkout's instance of a
/// `shared` service in a lane (id "db"), or another workspace's service (id "backend:api").
nonisolated struct StackServiceLink: Codable, Equatable, Identifiable, Sendable {
  let id: String
  var stack: String
  var service: String
  var port: Int?
  var ports: [String: Int] = [:]
  var host = "localhost"
  var shared: Bool
  var isExternal: Bool { id.contains(":") }
}

/// The `[lanes]` table: how lanes of this workspace are prepared and cleaned up.
nonisolated struct StackLaneSettings: Codable, Equatable, Sendable {
  var directory: String?
  var from: String?
  var copy: [String] = []
  var link: [String] = []
  var setup: String?
  var teardown: String?
  var hosts = false
  var environment: [String: String] = [:]
  var rawEnvironment: [String: String] = [:]
}

nonisolated struct StackDefinition: Codable, Equatable, Identifiable, Sendable {
  let id: StackID
  var name: String
  let file: URL
  var root: URL
  var shell: String
  var restartOnBranchChange = true
  var environment: [String: String] = [:]
  var secrets: [String: String] = [:]
  var repos: [RepoDefinition] = []
  var services: [ServiceDefinition] = []
  var tasks: [WorkspaceTaskDefinition] = []
  var workflows: [WorkspaceWorkflowDefinition] = []
  var lane: StackLaneInfo?
  var links: [StackServiceLink] = []
  var laneSettings: StackLaneSettings?
  /// Templated `[env]` values as written.
  var rawEnvironment: [String: String] = [:]

  /// Hostname services of this workspace are reached at.
  var host: String { lane?.host ?? "localhost" }
  /// The workspace a lane was created from, or this workspace.
  var sourceID: String { lane?.sourceStackID ?? id }
  func link(_ id: String) -> StackServiceLink? { links.first { $0.id == id } }

  var fingerprint: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    return SHA256.hash(data: (try? encoder.encode(self)) ?? Data()).map { String(format: "%02x", $0) }.joined()
  }

  func service(_ id: String) -> ServiceDefinition? { services.first { $0.id == id } }
  func repo(_ id: String) -> RepoDefinition? { repos.first { $0.id == id } }

  /// Deterministic Kahn layers. Disabled services remain in the graph for manual starts.
  func dependencyLayers() throws -> [[String]] {
    // Links (shared and other-workspace services) are started separately, not ordered here.
    let local = Set(services.map(\.id))
    var remaining = Dictionary(uniqueKeysWithValues: services.map { ($0.id, Set($0.dependencies).intersection(local)) })
    var layers: [[String]] = []
    while !remaining.isEmpty {
      let ready = remaining.filter { $0.value.isEmpty }.keys.sorted()
      guard !ready.isEmpty else { throw StackError.message("Dependency cycle: \(remaining.keys.sorted().joined(separator: ", "))") }
      layers.append(ready)
      for id in ready { remaining.removeValue(forKey: id) }
      for id in remaining.keys { remaining[id]?.subtract(ready) }
    }
    return layers
  }

  func affectedServices(repos ids: Set<String>) -> Set<String> {
    Set(services.filter { $0.repo.map(ids.contains) ?? false }.map(\.id))
  }

  func includingDependents(of ids: Set<String>) -> Set<String> {
    var result = ids
    while true {
      let next = result.union(services.filter { !result.isDisjoint(with: $0.dependencies) }.map(\.id))
      if next == result { return result }
      result = next
    }
  }
}

nonisolated struct StackDefinitionIssue: Identifiable, Equatable, Sendable {
  enum Severity: String, Sendable { case warning, error }
  let severity: Severity
  let message: String
  var id: String { severity.rawValue + message }
}

nonisolated struct StackDefinitionFile: Identifiable, Equatable, Sendable {
  let id: StackID
  let file: URL
  var definition: StackDefinition?
  var issues: [StackDefinitionIssue] = []
  var savedLane: StackLaneInfo?
  var laneSetup: StackLaneSetupState?
  var laneWorktrees: [StackLaneWorktree] = []
  /// Services added to the source after the lane was created, waiting for ports.
  var pendingLanePorts: [String] = []
  var lane: StackLaneInfo? { definition?.lane ?? savedLane }
  var name: String { definition?.name ?? savedLane?.reference ?? file.deletingPathExtension().lastPathComponent }
}

nonisolated enum StackError: LocalizedError {
  case message(String)
  var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

nonisolated struct StackLaunchDefinition: Codable, Equatable, Sendable {
  let stack: StackDefinition
  let service: ServiceDefinition

  /// Variables Cinderdeck adds for the environment contract, in the base checkout and in lanes.
  static let managedPrefixes = ["CINDERDECK_", "SNAPZY_"]

  func environment(shell: [String: String], secrets: [String: String]) -> [String: String] {
    var result = shell.merging(stack.environment) { _, value in value }
      .merging(service.environment) { _, value in value }
    if let lane = stack.lane { result.merge(lane.environment) { _, value in value } }
    result.merge(secrets) { _, value in value }
    result["FORCE_COLOR"] = "1"
    result["CLICOLOR_FORCE"] = "1"
    result["PYTHONUNBUFFERED"] = "1"
    result["DOTNET_SYSTEM_CONSOLE_ALLOW_ANSI_COLOR_REDIRECTION"] = "1"
    if result["DOTNET_WATCH_RESTART_ON_RUDE_EDIT"] == nil { result["DOTNET_WATCH_RESTART_ON_RUDE_EDIT"] = "1" }
    result.merge(contract()) { _, value in value }
    result["CINDERDECK_SERVICE"] = service.id
    if let lane = stack.lane {
      // Assigned ports must win over shell, TOML and secrets, including a stale PORT.
      if let port = service.port { result["PORT"] = String(port) }
      if result["COMPOSE_PROJECT_NAME"] == nil { result["COMPOSE_PROJECT_NAME"] = StackLaneInfo.composeProject(source: lane.sourceStackID, slug: lane.effectiveSlug) }
    } else if let port = service.port,
      stack.environment["PORT"] == nil, service.environment["PORT"] == nil, secrets["PORT"] == nil {
      // In the original checkout an explicit env.PORT keeps working as before.
      result["PORT"] = String(port)
    }
    // Compatibility for existing project scripts.
    result["SNAPZY_STACK"] = stack.id
    result["SNAPZY_SERVICE"] = service.id
    return result
  }

  /// Workspace-level variables: identity, lane, and every service's ports and URLs.
  func contract() -> [String: String] {
    var result: [String: String] = [:]
    result["CINDERDECK_STACK"] = stack.id
    result["CINDERDECK_WORKSPACE"] = stack.id
    result["CINDERDECK_SOURCE_STACK"] = stack.sourceID
    result["CINDERDECK_HOST"] = stack.host
    func add(_ name: String, ports: [String: Int], host: String) {
      for (portName, port) in ports {
        let variable = portName.isEmpty ? StackLaneInfo.portVariable(name) : StackLaneInfo.portVariable(name, port: portName)
        result[variable] = String(port)
        if portName.isEmpty { result[StackLaneInfo.urlVariable(name)] = "http://\(host):\(port)" }
      }
    }
    for service in stack.services { add(service.id, ports: service.allPorts, host: stack.host) }
    for link in stack.links where !link.isExternal {
      var ports = link.ports
      if let port = link.port { ports[""] = port }
      add(link.id, ports: ports, host: link.host)
    }
    if let lane = stack.lane {
      result["CINDERDECK_LANE"] = lane.name
      result["CINDERDECK_LANE_SLUG"] = lane.effectiveSlug
      result["CINDERDECK_LANE_DIR"] = lane.directory.path
    }
    return result
  }
}

// Old saved service launches predate tasks and workflows. Keep them reconnectable.
extension StackDefinition {
  nonisolated enum CodingKeys: String, CodingKey {
    case id, name, file, root, shell, restartOnBranchChange, environment, secrets, repos, services, tasks, workflows, lane
    case links, laneSettings, rawEnvironment
  }
  nonisolated init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    file = try c.decode(URL.self, forKey: .file)
    root = try c.decode(URL.self, forKey: .root)
    shell = try c.decode(String.self, forKey: .shell)
    restartOnBranchChange = try c.decode(Bool.self, forKey: .restartOnBranchChange)
    environment = try c.decode([String: String].self, forKey: .environment)
    secrets = try c.decode([String: String].self, forKey: .secrets)
    repos = try c.decode([RepoDefinition].self, forKey: .repos)
    services = try c.decode([ServiceDefinition].self, forKey: .services)
    tasks = try c.decodeIfPresent([WorkspaceTaskDefinition].self, forKey: .tasks) ?? []
    workflows = try c.decodeIfPresent([WorkspaceWorkflowDefinition].self, forKey: .workflows) ?? []
    lane = try c.decodeIfPresent(StackLaneInfo.self, forKey: .lane)
    links = try c.decodeIfPresent([StackServiceLink].self, forKey: .links) ?? []
    laneSettings = try c.decodeIfPresent(StackLaneSettings.self, forKey: .laneSettings)
    rawEnvironment = try c.decodeIfPresent([String: String].self, forKey: .rawEnvironment) ?? [:]
  }
}

// Fields added after launches were first saved decode with their defaults.
extension RepoDefinition {
  nonisolated enum CodingKeys: String, CodingKey { case id, path, laneMode }
  nonisolated init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    path = try c.decode(URL.self, forKey: .path)
    laneMode = try c.decodeIfPresent(StackRepoLaneMode.self, forKey: .laneMode) ?? .worktree
  }
}

extension ServiceDefinition {
  nonisolated enum CodingKeys: String, CodingKey {
    case id, command, repo, directory, dependencies, port, readiness, readyTimeout, environment, restartOnFailure
    case stopSignal, stopTimeout, autostart, ports, laneMode, raw
  }
  nonisolated init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    command = try c.decode(String.self, forKey: .command)
    repo = try c.decodeIfPresent(String.self, forKey: .repo)
    directory = try c.decode(URL.self, forKey: .directory)
    dependencies = try c.decodeIfPresent([String].self, forKey: .dependencies) ?? []
    port = try c.decodeIfPresent(Int.self, forKey: .port)
    readiness = try c.decodeIfPresent(StackReadiness.self, forKey: .readiness) ?? .alive
    readyTimeout = try c.decodeIfPresent(TimeInterval.self, forKey: .readyTimeout) ?? 90
    environment = try c.decodeIfPresent([String: String].self, forKey: .environment) ?? [:]
    restartOnFailure = try c.decodeIfPresent(Bool.self, forKey: .restartOnFailure) ?? true
    stopSignal = try c.decodeIfPresent(Int32.self, forKey: .stopSignal) ?? SIGTERM
    stopTimeout = try c.decodeIfPresent(TimeInterval.self, forKey: .stopTimeout) ?? 10
    autostart = try c.decodeIfPresent(Bool.self, forKey: .autostart) ?? true
    ports = try c.decodeIfPresent([String: Int].self, forKey: .ports) ?? [:]
    laneMode = try c.decodeIfPresent(StackServiceLaneMode.self, forKey: .laneMode)
    raw = try c.decodeIfPresent(StackRawValues.self, forKey: .raw)
  }
}

extension StackLaneSettings {
  nonisolated enum CodingKeys: String, CodingKey { case directory, from, copy, link, setup, teardown, hosts, environment, rawEnvironment }
  nonisolated init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    directory = try c.decodeIfPresent(String.self, forKey: .directory)
    from = try c.decodeIfPresent(String.self, forKey: .from)
    copy = try c.decodeIfPresent([String].self, forKey: .copy) ?? []
    link = try c.decodeIfPresent([String].self, forKey: .link) ?? []
    setup = try c.decodeIfPresent(String.self, forKey: .setup)
    teardown = try c.decodeIfPresent(String.self, forKey: .teardown)
    hosts = try c.decodeIfPresent(Bool.self, forKey: .hosts) ?? false
    environment = try c.decodeIfPresent([String: String].self, forKey: .environment) ?? [:]
    rawEnvironment = try c.decodeIfPresent([String: String].self, forKey: .rawEnvironment) ?? [:]
  }
}
