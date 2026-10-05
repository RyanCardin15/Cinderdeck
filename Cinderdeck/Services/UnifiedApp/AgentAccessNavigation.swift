import Foundation

/// MCP, skills and the Claude Code mod are set up in the main window: Settings → Integrations →
/// MCP & skills. Native entry points route there; the sheet remains for builds without the shell.
@MainActor
enum AgentAccessNavigation {
  static let section = "agent-access"

  static func open(orPresent fallback: () -> Void) {
    if !AgentShellController.shared.show(section: section) { fallback() }
  }
}
