import Foundation

/// MCP, skills and Claude Code mod setup for the main window's Settings → Integrations → MCP & skills.
/// The renderer only names an agent and an action; paths, files and commands stay native.
nonisolated struct IntegrationAgentAccessStatus: Codable, Sendable {
  struct CLI: Codable, Sendable { let installed: Bool; let path: String }
  struct Install: Codable, Sendable {
    /// missing, partial, outdated, current or yours (a copy the person manages)
    let state: String
    let detail: String
  }
  struct Client: Codable, Sendable {
    let id: String
    let name: String
    let mcpConfigured: Bool
    let mcpLocation: String
    let skills: Install
  }
  struct Skill: Codable, Sendable { let name: String; let summary: String }

  let cli: CLI
  let clients: [Client]
  let skills: [Skill]
  /// Absent when this build ships no Claude Code mod.
  let claudeMod: Install?
}

nonisolated struct IntegrationAgentAccessResult: Codable, Sendable {
  let ok: Bool
  let detail: String
  let status: IntegrationAgentAccessStatus
}

nonisolated enum IntegrationAgentAccess {
  static let clients: [(id: String, name: String, location: String)] = [
    ("claude", "Claude Code", "claude mcp add --scope user"),
    ("codex", "Codex", "~/.codex/config.toml"),
    ("cursor", "Cursor", "~/.cursor/mcp.json"),
    ("copilot", "VS Code Copilot", "Code/User/mcp.json"),
  ]
  static let actions: Set<String> = ["cli", "mcp", "skills", "mod"]

  static func summarize(_ states: [StackAgentSkills.State], folder: String) -> IntegrationAgentAccessStatus.Install {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    func short(_ url: URL) -> String { url.deletingLastPathComponent().path.replacingOccurrences(of: home, with: "~") }
    let outdated = states.filter { if case .outdated = $0 { return true }; return false }.count
    let missing = states.filter { $0 == .missing }.count
    if states.isEmpty { return .init(state: "missing", detail: "Nothing bundled") }
    if outdated > 0 { return .init(state: "outdated", detail: "\(outdated) of \(states.count) can be updated") }
    if missing == states.count { return .init(state: "missing", detail: "Installs to ~/\(folder)") }
    if missing > 0 { return .init(state: "partial", detail: "\(states.count - missing) of \(states.count) installed") }
    let located = states.compactMap { state -> URL? in
      switch state { case .current(let url), .userManaged(let url): return url; default: return nil }
    }
    let yours = states.allSatisfy { if case .userManaged = $0 { return true }; return false }
    let location = located.first.map(short) ?? "~/\(folder)"
    return .init(state: yours ? "yours" : "current", detail: yours ? "Your copy in \(location)" : "Up to date in \(location)")
  }

  static func status() -> IntegrationAgentAccessStatus {
    let skills = StackAgentSkills.skills()
    let clients = clients.map { client -> IntegrationAgentAccessStatus.Client in
      let agent = StackAgentSkills.agent(client.id)
      let states = agent.map { agent in skills.map { StackAgentSkills.state(of: $0, for: agent) } } ?? []
      return .init(id: client.id, name: client.name, mcpConfigured: StackAgentSetup.isConfigured(client.id),
        mcpLocation: client.location, skills: summarize(states, folder: agent?.folder ?? ""))
    }
    let mod = StackClaudeMod.state().map { summarize([$0], folder: StackClaudeMod.agent.folder) }
    return .init(cli: .init(installed: StackCLI.isInstalled, path: StackCLI.installedLink.path), clients: clients,
      skills: skills.map { .init(name: $0.name, summary: $0.summary) }, claudeMod: mod)
  }

  /// One setup step. Every MCP step installs the CLI first, since the MCP entry runs it.
  static func apply(action: String, agent: String?, instructions: Bool) -> (ok: Bool, detail: String) {
    do {
      switch action {
      case "cli":
        return (true, "Installed at \(try StackCLI.install().path)")
      case "mcp":
        guard let agent, clients.contains(where: { $0.id == agent }) else { return (false, "Choose an agent") }
        if !StackCLI.isInstalled { _ = try StackCLI.install() }
        let results = StackAgentSetup.apply(targets: [agent], command: StackCLI.preferredCommandPath(), instructions: instructions)
        let failure = results.first { !$0.ok }
        return (failure == nil, (failure ?? results.first)?.detail ?? "Nothing to do")
      case "skills":
        guard let agent, let target = StackAgentSkills.agent(agent) else { return (false, "Choose an agent") }
        let notes = try StackAgentSkills.install(StackAgentSkills.skills(), for: target)
        return (true, notes.contains { $0.contains("kept yours") } ? notes.joined(separator: " · ") : "Skills installed")
      case "mod":
        if !StackCLI.isInstalled { _ = try StackCLI.install() }
        return (true, try StackClaudeMod.install())
      default:
        return (false, "Unsupported action")
      }
    } catch {
      return (false, error.localizedDescription)
    }
  }
}

extension StackControlService {
  func handleIntegrationAgents(_ method: String, params: JSONValue) async throws -> JSONValue {
    let allowed: Set<String>
    switch method {
    case "integration.agents.status": allowed = ["installationID"]
    case "integration.agents.apply": allowed = ["installationID", "action", "agent", "instructions"]
    default: throw StackControlError(code: "unknown_method", message: "Unsupported agent access method")
    }
    guard let object = params.objectValue, Set(object.keys).isSubset(of: allowed),
      let installationID = params["installationID"]?.stringValue else {
      throw StackControlError.invalid("Pass the selected installation and a known agent access argument")
    }
    guard installationID == (try integrationStore()).installationID else {
      throw StackControlError(code: "installation_changed", message: "Reconnect the selected installation")
    }
    if method == "integration.agents.status" {
      return try JSONValue(encoding: await Task.detached { IntegrationAgentAccess.status() }.value)
    }
    guard let action = params["action"]?.stringValue, IntegrationAgentAccess.actions.contains(action) else {
      throw StackControlError.invalid("Unsupported agent access action")
    }
    let agent = params["agent"]?.stringValue
    guard agent.map({ value in IntegrationAgentAccess.clients.contains { $0.id == value } }) ?? true else {
      throw StackControlError.invalid("Unknown agent")
    }
    let instructions = params["instructions"]?.boolValue ?? false
    // Registering with Claude Code runs its CLI; keep that off the main actor.
    let result = await Task.detached { () -> IntegrationAgentAccessResult in
      let outcome = IntegrationAgentAccess.apply(action: action, agent: agent, instructions: instructions)
      return IntegrationAgentAccessResult(ok: outcome.ok, detail: outcome.detail, status: IntegrationAgentAccess.status())
    }.value
    return try JSONValue(encoding: result)
  }
}
