import Foundation

/// A directed graph of managed processes. Dependency traversal never walks back
/// through a shared service into a sibling lane that happens to use it too.
struct WorkspaceLaneGraph {
  enum ID: Hashable {
    case lane(String), service(String, String), run(UUID), step(UUID)
  }
  struct Node: Identifiable {
    let id: ID
    let workspaceID: String
    var title: String
    var subtitle: String
    var status: String
    var detail: String
    var phase: StackServicePhase?
    var runStatus: WorkspaceRunStatus?
    var serviceID: String?
    var runID: UUID?
    var isLane = false
    var runtimeActive = false
    var process: StackProcessIdentity?
    var command: String?
    var directory: String?
    var endpoint: URL?
    var owner: String?
    var warning: String?
    var isSharedResource = false
    var isActive: Bool { runtimeActive || phase?.isActive == true || runStatus?.isActive == true }
    /// Queued work belongs in the live map, but must not look as if it is executing.
    var hasLiveActivity: Bool { runtimeActive || process != nil || runStatus == .running || runStatus == .cancelling }
    var needsAttention: Bool {
      warning != nil || phase == .crashed || phase == .unhealthy || runStatus == .failed
        || status == "Needs attention" || status == "Unavailable"
    }
    var kind: String {
      switch id { case .lane: return "Checkout"; case .service: return "Service"; case .run: return "Run"; case .step: return "Step" }
    }
  }
  struct Edge: Hashable, Identifiable {
    enum Kind: String { case contains, depends = "uses", sequence = "then" }
    let from: ID
    let to: ID
    let kind: Kind
    var id: Self { self }
  }
  var nodes: [Node] = []
  var edges: [Edge] = []

  init(workspaceID: String, files: [StackDefinitionFile], navigation: WorkspaceNavigation,
       states: [String: StackRuntimeState], statuses: [URL: GitRepoStatus], runs: [WorkspaceRun]) {
    let contexts = files.filter { $0.id == workspaceID } + navigation.lanes(for: workspaceID)
    let byID = Dictionary(files.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    var seen = Set<ID>()
    func add(_ node: Node) { if seen.insert(node.id).inserted { nodes.append(node) } }
    func connect(_ from: ID, _ to: ID, _ kind: Edge.Kind) {
      let edge = Edge(from: from, to: to, kind: kind)
      if !edges.contains(edge) { edges.append(edge) }
    }
    func target(_ name: String, definition: StackDefinition?, workspace: String) -> (String, String) {
      if let link = definition?.link(name) { return (link.stack, link.service) }
      return (workspace, name)
    }
    func service(_ workspace: String, _ name: String) -> ID {
      let id = ID.service(workspace, name)
      guard !seen.contains(id) else { return id }
      let runtime = states[workspace]?.services[name] ?? .init()
      // A running process may still use its previous definition after a file edit.
      let definition = runtime.launchDefinition?.stack ?? byID[workspace]?.definition
      let configured = runtime.launchDefinition?.service ?? definition?.service(name)
      let ports = configured?.allPorts.sorted { $0.key < $1.key }.map {
        "\($0.key.isEmpty ? "Port" : $0.key): \($0.value)"
      }.joined(separator: " · ") ?? ""
      let endpoint = configured?.port.map { "\(definition?.host ?? "localhost"):\($0)" }
      let owner = byID[workspace]?.lane?.name ?? byID[workspace]?.name ?? workspace
      let process = runtime.process.map { "PID \($0.pid) · Process group \($0.pgid)" }
      // Typed locals keep these literals from dominating the module's type-check time.
      let subtitle: [String?] = [owner, endpoint]
      let detail: [String?] = [process, endpoint, ports.isEmpty ? nil : ports, configured?.command,
        configured?.directory.path, runtime.owner.map { "Started by \($0.label)" }, runtime.bindWarning, runtime.detail]
      let failed: Bool = runtime.phase == .crashed || runtime.phase == .unhealthy
      let warning: String? = runtime.bindWarning ?? (failed ? runtime.detail : nil)
      add(.init(id: id, workspaceID: workspace, title: name, subtitle: subtitle.compactMap { $0 }.joined(separator: "\n"),
        status: configured == nil ? "Unavailable" : runtime.phase.label,
        detail: detail.compactMap { $0 }.joined(separator: "\n"), phase: runtime.phase, serviceID: name,
        process: runtime.process, command: configured?.command, directory: configured?.directory.path,
        endpoint: endpoint.flatMap { URL(string: "http://" + $0) }, owner: runtime.owner?.label,
        warning: warning, isSharedResource: configured?.laneMode == .shared))
      for dependency in configured?.dependencies ?? [] {
        let (stack, serviceName) = target(dependency, definition: definition, workspace: workspace)
        connect(id, service(stack, serviceName), .depends)
      }
      return id
    }
    for file in contexts {
      let state = states[file.id] ?? .init()
      let branches = Self.branchSummary(file, statuses: statuses)
      let activeRuns = runs.filter { $0.workspaceID == file.id && $0.status.isActive }
      let title: String = file.lane?.name ?? (file.id == workspaceID ? "Original checkout" : file.name)
      let runLabel: String? = activeRuns.first.map { "\($0.kind.rawValue.capitalized) \($0.status.rawValue)" }
      let status: String = file.definition == nil ? "Needs attention" : runLabel ?? state.label
      let issues: String? = file.issues.isEmpty ? nil : file.issues.map(\.message).joined(separator: "\n")
      let detail: [String?] = [file.name, branches, file.lane?.owner.label, file.definition?.root.path, issues]
      add(.init(id: .lane(file.id), workspaceID: file.id, title: title, subtitle: branches, status: status,
        detail: detail.compactMap { $0 }.joined(separator: "\n"),
        runStatus: activeRuns.first?.status, isLane: true, runtimeActive: state.isActive,
        directory: file.definition?.root.path, owner: file.lane?.owner.label, warning: issues))
      let services = Set(file.definition?.services.map(\.id) ?? []).union(state.services.keys)
      for name in services.sorted() { connect(.lane(file.id), service(file.id, name), .contains) }
      // Include links even when only a task or a URL template uses the service.
      for link in file.definition?.links ?? [] {
        connect(.lane(file.id), service(link.stack, link.service), .depends)
      }
      for run in activeRuns {
        let runID = ID.run(run.id)
        add(.init(id: runID, workspaceID: file.id, title: run.name, subtitle: "\(run.kind.rawValue.capitalized) · \(file.lane?.name ?? file.name)",
          status: run.status.label, detail: "Started by \(run.actor.label)\n\(run.detail ?? "")", runStatus: run.status, runID: run.id, owner: run.actor.label))
        connect(.lane(file.id), runID, .contains)
        var previous = runID
        for step in run.steps {
          let stepID = ID.step(step.id)
          let stepDetail: [String?] = [
            step.process.map { "PID \($0.pid) · Process group \($0.pgid)" }, step.command, step.directory, step.detail,
          ]
          add(.init(id: stepID, workspaceID: file.id, title: step.title, subtitle: step.reference,
            status: step.status.label,
            detail: stepDetail.compactMap { $0 }.joined(separator: "\n"), runStatus: step.status, runID: run.id, process: step.process,
            command: step.command, directory: step.directory, owner: run.actor.label,
            warning: step.status == .failed ? step.detail : nil))
          connect(previous, stepID, previous == runID ? .contains : .sequence)
          previous = stepID
          let parts = step.reference.split(separator: ":", maxSplits: 1).map(String.init)
          if parts.count == 2 {
            let dependencies = parts[0] == "task" ? file.definition?.task(parts[1])?.requiresServices ?? [] : [parts[1]]
            for dependency in dependencies {
              let (stack, name) = target(dependency, definition: file.definition, workspace: file.id)
              connect(stepID, service(stack, name), .depends)
            }
          }
        }
      }
    }
    // A shared process has one identity even when several checkouts use it.
    let owners = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0.workspaceID) })
    let linked = Set(edges.filter { $0.kind == .depends && owners[$0.from] != owners[$0.to] }.map(\.to))
    for index in nodes.indices where linked.contains(nodes[index].id) { nodes[index].isSharedResource = true }
  }

  /// Suppress redundant checkout-to-service lines already represented by a
  /// local service dependency chain. The inspector retains every direct link.
  var diagramEdges: [Edge] {
    let byID = Dictionary(uniqueKeysWithValues: nodes.map { ($0.id, $0) })
    let reachable = Dictionary(uniqueKeysWithValues: nodes.filter { $0.serviceID != nil }.map { ($0.id, connected(to: $0.id)) })
    return edges.filter { edge in
      guard byID[edge.from]?.isLane == true, byID[edge.to]?.serviceID != nil else { return true }
      return !edges.contains { other in
        other.from == edge.from && other.to != edge.to && byID[other.to]?.serviceID != nil
          && byID[other.to]?.workspaceID == byID[edge.from]?.workspaceID
          && reachable[other.to]?.contains(edge.to) == true && reachable[edge.to]?.contains(other.to) != true
      }
    }
  }

  var processCount: Int { Set(nodes.compactMap { $0.process?.pid }).count }
  var sharedServices: [Node] {
    let checkouts = Set(nodes.filter(\.isLane).map(\.workspaceID))
    return nodes.filter { $0.serviceID != nil && ($0.isSharedResource || !checkouts.contains($0.workspaceID)) }
  }

  enum Trace: String, CaseIterable { case dependencies = "Uses", consumers = "Used by" }

  func traced(from selection: ID, direction: Trace) -> Set<ID> {
    if direction == .dependencies { return connected(to: selection) }
    var visited: Set<ID> = [selection]
    var pending = [selection]
    while let id = pending.popLast() {
      for edge in edges where edge.to == id {
        if visited.insert(edge.from).inserted { pending.append(edge.from) }
      }
    }
    return visited
  }

  func focused(on selection: ID?, direction: Trace = .dependencies) -> WorkspaceLaneGraph {
    guard let selection, nodes.contains(where: { $0.id == selection }) else { return self }
    let included = traced(from: selection, direction: direction)
    var result = self
    result.nodes = nodes.filter { included.contains($0.id) }
    result.edges = edges.filter { included.contains($0.from) && included.contains($0.to) }
    return result
  }

  func matches(_ query: String) -> [Node] {
    let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else { return [] }
    return nodes.filter { [$0.title, $0.subtitle, $0.command ?? "", $0.process.map { String($0.pid) } ?? ""]
      .contains { $0.localizedCaseInsensitiveContains(query) } }
  }

  func connected(to selection: ID) -> Set<ID> {
    var visited: Set<ID> = [selection]
    var pending = [selection]
    while let id = pending.popLast() {
      for edge in edges where edge.from == id {
        if visited.insert(edge.to).inserted { pending.append(edge.to) }
      }
    }
    // Selecting a process also identifies its owning lane, without lighting up siblings.
    if let node = nodes.first(where: { $0.id == selection }), !node.isLane,
       nodes.contains(where: { $0.id == .lane(node.workspaceID) }) {
      visited.insert(.lane(node.workspaceID))
    }
    return visited
  }

  static func branchSummary(_ file: StackDefinitionFile, statuses: [URL: GitRepoStatus]) -> String {
    let repos = file.definition?.repos ?? []
    if !repos.isEmpty {
      return repos.map { repo in
        let status = statuses[repo.path]
        let saved = file.laneWorktrees.first { $0.path.standardizedFileURL == repo.path.standardizedFileURL }?.branch
        let branch = status.map { $0.error == nil ? $0.branchLabel : "Branch unavailable" }
          ?? saved.map { "\($0) (last known)" } ?? "Loading branch…"
        return "\(repo.id): \(branch)"
      }.joined(separator: "\n")
    }
    if !file.laneWorktrees.isEmpty {
      return file.laneWorktrees.map { "\($0.path.lastPathComponent): \($0.branch ?? "Detached") (last known)" }.joined(separator: "\n")
    }
    return file.definition == nil ? "Branch unavailable" : "No Git repositories"
  }
}
