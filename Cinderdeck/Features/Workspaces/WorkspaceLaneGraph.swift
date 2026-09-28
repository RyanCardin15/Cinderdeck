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
    var isActive: Bool { phase?.isActive == true || runStatus?.isActive == true }
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
      add(.init(id: id, workspaceID: workspace, title: name, subtitle: [owner, endpoint].compactMap { $0 }.joined(separator: "\n"),
        status: configured == nil ? "Unavailable" : runtime.phase.label,
        detail: [process, endpoint, ports.isEmpty ? nil : ports, configured?.command,
          configured?.directory.path, runtime.owner.map { "Started by \($0.label)" }, runtime.bindWarning, runtime.detail]
          .compactMap { $0 }.joined(separator: "\n"), phase: runtime.phase, serviceID: name))
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
      add(.init(id: .lane(file.id), workspaceID: file.id,
        title: file.lane?.name ?? (file.id == workspaceID ? "Original checkout" : file.name),
        subtitle: branches,
        status: file.definition == nil ? "Needs attention" : activeRuns.first.map { "\($0.kind.rawValue.capitalized) \($0.status.rawValue)" } ?? state.label,
        detail: [file.name, branches, file.lane?.owner.label, file.definition?.root.path,
          file.issues.isEmpty ? nil : file.issues.map(\.message).joined(separator: "\n")].compactMap { $0 }.joined(separator: "\n"),
        runStatus: activeRuns.first?.status, isLane: true))
      let services = Set(file.definition?.services.map(\.id) ?? []).union(state.services.keys)
      for name in services.sorted() { connect(.lane(file.id), service(file.id, name), .contains) }
      // Include links even when only a task or a URL template uses the service.
      for link in file.definition?.links ?? [] {
        connect(.lane(file.id), service(link.stack, link.service), .depends)
      }
      for run in activeRuns {
        let runID = ID.run(run.id)
        add(.init(id: runID, workspaceID: file.id, title: run.name, subtitle: "\(run.kind.rawValue.capitalized) · \(file.lane?.name ?? file.name)",
          status: run.status.label, detail: "Started by \(run.actor.label)\n\(run.detail ?? "")", runStatus: run.status, runID: run.id))
        connect(.lane(file.id), runID, .contains)
        var previous = runID
        for step in run.steps {
          let stepID = ID.step(step.id)
          add(.init(id: stepID, workspaceID: file.id, title: step.title, subtitle: step.reference,
            status: step.status.label,
            detail: [step.process.map { "PID \($0.pid) · Process group \($0.pgid)" }, step.command, step.directory, step.detail]
              .compactMap { $0 }.joined(separator: "\n"), runStatus: step.status, runID: run.id))
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
