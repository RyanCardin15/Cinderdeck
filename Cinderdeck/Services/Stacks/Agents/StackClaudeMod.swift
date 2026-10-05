import Foundation

/// The Claude Code mod that ships with Cinderdeck (`mods/claude-code/cinderdeck`, bundled as
/// `ClaudeCodeMod`): a status line, a `/cinderdeck` pane with service controls, crash toasts and
/// `/cinderdeck logs <service>`. Claude Code loads a plugin folder in `~/.claude/skills` on its own,
/// so installing is a copy, updated in place like the bundled skills.
nonisolated enum StackClaudeMod {
  static let name = "cinderdeck"
  static let agent = StackAgentSkills.Agent(id: "claude", name: "Claude Code", folder: ".claude/skills", reads: [".claude/skills"])

  static func bundled(_ bundle: Bundle = StackCLI.appBundle) -> StackAgentSkills.Skill? {
    guard let folder = bundle.resourceURL?.appendingPathComponent("ClaudeCodeMod/\(name)", isDirectory: true),
      FileManager.default.fileExists(atPath: folder.appendingPathComponent(".claude-plugin/plugin.json").path) else { return nil }
    return StackAgentSkills.Skill(name: name, summary: "Cinderdeck status, service controls and logs inside Claude Code.",
      folder: folder, fingerprint: StackAgentSkills.fingerprint(folder), entry: ".claude-plugin/plugin.json")
  }

  static func state(home: URL = StackAgentSetup.home("")) -> StackAgentSkills.State? {
    bundled().map { StackAgentSkills.state(of: $0, for: agent, home: home) }
  }

  /// Installs or updates the mod. A `cinderdeck` folder the person manages themselves is kept.
  static func install(home: URL = StackAgentSetup.home("")) throws -> String {
    guard let mod = bundled() else { throw StackError.message("This build of Cinderdeck has no Claude Code mod") }
    let notes = try StackAgentSkills.install([mod], for: agent, home: home)
    return (notes.first ?? "installed") + " (loads in new Claude Code sessions; type /cinderdeck)"
  }
}

extension StackAgentSetup {
  /// Whether the Cinderdeck MCP server is already registered for an agent, read from its config file.
  static func isConfigured(_ target: String, home: URL = StackAgentSetup.home(""),
    support: URL = StackAgentSetup.home("Library/Application Support")) -> Bool {
    func json(_ url: URL) -> [String: Any]? {
      guard let data = try? Data(contentsOf: url) else { return nil }
      return (try? JSONSerialization.jsonObject(with: data, options: [.json5Allowed])) as? [String: Any]
    }
    switch target {
    case "cursor":
      return (json(home.appendingPathComponent(".cursor/mcp.json"))?["mcpServers"] as? [String: Any])?["cinderdeck"] != nil
    case "codex":
      let text = (try? String(contentsOf: home.appendingPathComponent(".codex/config.toml"), encoding: .utf8)) ?? ""
      return text.split(separator: "\n").contains { $0.trimmingCharacters(in: .whitespaces) == "[mcp_servers.cinderdeck]" }
    case "claude":
      return (json(home.appendingPathComponent(".claude.json"))?["mcpServers"] as? [String: Any])?["cinderdeck"] != nil
    case "copilot":
      return ["Code", "Code - Insiders"].contains { folder in
        (json(support.appendingPathComponent(folder).appendingPathComponent("User/mcp.json"))?["servers"] as? [String: Any])?["cinderdeck"] != nil
      }
    default:
      return false
    }
  }
}
