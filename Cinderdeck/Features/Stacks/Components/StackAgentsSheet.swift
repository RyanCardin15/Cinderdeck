import AppKit
import SwiftUI

/// Connects coding agents (Cursor, Codex, Claude Code, VS Code Copilot, any shell) to stacks and PR views,
/// and installs the agent skills that ship with Cinderdeck.
struct StackAgentsSheet: View {
  @Environment(\.dismiss) private var dismiss
  @ObservedObject private var control = StackControlService.shared
  @State private var cliInstalled = StackCLI.isInstalled
  @State private var results: [String: StackAgentSetup.Result] = [:]
  @State private var writeInstructions = true
  @State private var copied = false
  @State private var error: String?
  @State private var skills = StackAgentSkills.skills()
  @State private var skillStates: [String: [StackAgentSkills.State]] = [:]
  @State private var skillNotes: [String: String] = [:]

  private var command: String { StackCLI.preferredCommandPath() }

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack(alignment: .top, spacing: 12) {
        ZStack {
          RoundedRectangle(cornerRadius: 11, style: .continuous).fill(StackPalette.agent.opacity(0.15)).frame(width: 40, height: 40)
          Image(systemName: "sparkles").font(.system(size: 18, weight: .semibold)).foregroundColor(StackPalette.agent)
        }
        VStack(alignment: .leading, spacing: 3) {
          Text("Agent access").font(.title2.weight(.semibold))
          Text("Let Cursor, Codex, Claude Code, VS Code Copilot, or any shell run services, tasks, workflows, and screen-recorded repros, and configure Pull Request tabs. Saved views update in the PR window immediately; services started by agents are labeled with their name.")
            .font(.callout).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
        }
      }

      ScrollView { sections }.frame(maxHeight: 560)

      if let error { Text(error).font(.caption).foregroundColor(.red) }
      HStack {
        Button {
          NSPasteboard.general.clearContents()
          NSPasteboard.general.setString(StackAgentGuide.instructions(command: command), forType: .string)
          copied = true
        } label: { Label(copied ? "Copied" : "Copy agent instructions", systemImage: copied ? "checkmark" : "doc.on.doc") }
          .buttonStyle(StackPillButtonStyle(compact: true))
          .help("Paste into a project's AGENTS.md, CLAUDE.md or Cursor rules")
        Spacer()
        Button("Done") { dismiss() }.keyboardShortcut(.defaultAction).buttonStyle(StackPillButtonStyle(kind: .primary(.accentColor)))
      }
    }
    .padding(22)
    .frame(width: 640)
    .onAppear(perform: refreshSkills)
  }

  private var sections: some View {
    VStack(alignment: .leading, spacing: 16) {
      section("Control socket") {
        HStack(spacing: 8) {
          Circle().fill(control.isServing ? StackPalette.color(phase: .ready) : StackPalette.color(phase: .crashed)).frame(width: 8, height: 8)
          Text(control.isServing ? "Listening" : (control.serverError ?? "Not running")).font(.system(size: 12, weight: .medium))
          Spacer()
          Text(StackControlPaths.socket.path).font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary).textSelection(.enabled).lineLimit(1).truncationMode(.head)
        }
        Text("Live stack state for agents that just read files: \(StackControlPaths.state.path)")
          .font(.system(size: 10.5)).foregroundColor(.secondary).textSelection(.enabled)
      }

      section("Command-line tool") {
        HStack(spacing: 8) {
          Image(systemName: cliInstalled ? "checkmark.circle.fill" : "terminal").foregroundColor(cliInstalled ? StackPalette.color(phase: .ready) : .secondary)
          Text(cliInstalled ? "cinderdeck is installed at \(StackCLI.installedLink.path)" : "Install `cinderdeck` in ~/.local/bin").font(.system(size: 12, weight: .medium))
          Spacer()
          Button(cliInstalled ? "Reinstall" : "Install") {
            do { try StackCLI.install(); cliInstalled = StackCLI.isInstalled; error = nil }
            catch { self.error = error.localizedDescription }
          }.buttonStyle(StackPillButtonStyle(compact: true))
        }
        Text("Try: cinderdeck prs views list · cinderdeck prs --help · cinderdeck stacks status")
          .font(.system(size: 10.5, design: .monospaced)).foregroundColor(.secondary).textSelection(.enabled)
      }

      section("MCP server") {
        ForEach([("cursor", "Cursor", "~/.cursor/mcp.json"), ("codex", "Codex", "~/.codex/config.toml"), ("claude", "Claude Code", "claude mcp add --scope user"),
          ("copilot", "VS Code Copilot", "Code/User/mcp.json")], id: \.0) { item in
          HStack(spacing: 8) {
            Text(item.1).font(.system(size: 12, weight: .semibold)).frame(width: 110, alignment: .leading)
            if let result = results[item.0] {
              Image(systemName: result.ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundColor(result.ok ? StackPalette.color(phase: .ready) : .orange)
              Text(result.detail).font(.system(size: 10.5)).foregroundColor(.secondary).lineLimit(2).textSelection(.enabled)
            } else {
              Text(item.2).font(.system(size: 10.5, design: .monospaced)).foregroundColor(.secondary)
            }
            Spacer()
            Button("Add") { add(item.0) }.buttonStyle(StackPillButtonStyle(compact: true))
          }
        }
        Toggle("Also add usage notes to ~/.codex/AGENTS.md and ~/.claude/CLAUDE.md", isOn: $writeInstructions)
          .font(.system(size: 11)).toggleStyle(.checkbox)
      }

      section("Agent skills") {
        if skills.isEmpty {
          Text("This build of Cinderdeck has no bundled skills.").font(.system(size: 11)).foregroundColor(.secondary)
        } else {
          ForEach(skills) { skill in
            VStack(alignment: .leading, spacing: 1) {
              Text(skill.name).font(.system(size: 11.5, weight: .semibold, design: .monospaced))
              Text(skill.summary).font(.system(size: 10.5)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }
          }
          Divider()
          ForEach(StackAgentSkills.agents) { agent in
            HStack(spacing: 8) {
              Text(agent.name).font(.system(size: 12, weight: .semibold)).frame(width: 110, alignment: .leading)
              let status = skillStatus(agent)
              Image(systemName: status.icon).foregroundColor(status.color)
              Text(skillNotes[agent.id] ?? status.text).font(.system(size: 10.5)).foregroundColor(.secondary).lineLimit(2).textSelection(.enabled)
              Spacer()
              Button(status.action) { installSkills(agent) }
                .buttonStyle(StackPillButtonStyle(compact: true))
                .disabled(status.action == "Added")
                .help("Copies the skills to ~/\(agent.folder). Copies Cinderdeck made are updated in place; skills you manage yourself are never replaced.")
            }
          }
          Text("Skills teach agents to record sessions with their actions and logs, and to review recordings. New skills in Cinderdeck updates appear here.")
            .font(.system(size: 10.5)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
        }
      }

      if !control.claims.isEmpty {
        section("Active claims") {
          ForEach(control.claims.values.sorted { $0.stackID < $1.stackID }, id: \.stackID) { claim in
            HStack(spacing: 8) {
              StackClaimChip(claim: claim)
              Text(claim.stackID).font(.system(size: 11, weight: .medium))
              Spacer()
              Text("until " + DateFormatter.localizedString(from: claim.expiresAt, dateStyle: .none, timeStyle: .short))
                .font(.system(size: 10.5)).foregroundColor(.secondary)
              Button("Release") { control.release(stack: claim.stackID) }.buttonStyle(StackPillButtonStyle(compact: true))
            }
          }
        }
      }

    }
  }

  private struct SkillStatus {
    let text: String
    let icon: String
    let color: Color
    let action: String
  }

  private func skillStatus(_ agent: StackAgentSkills.Agent) -> SkillStatus {
    let states = skillStates[agent.id] ?? []
    let missing = states.filter { $0 == .missing }.count
    let outdated = states.filter { if case .outdated = $0 { return true }; return false }.count
    let total = states.count
    if outdated > 0 {
      return SkillStatus(text: "\(outdated) of \(total) can be updated", icon: "arrow.triangle.2.circlepath.circle.fill", color: .orange, action: "Update")
    }
    if missing == total {
      return SkillStatus(text: "~/\(agent.folder)", icon: "square.dashed", color: .secondary, action: "Add")
    }
    if missing > 0 {
      return SkillStatus(text: "\(total - missing) of \(total) installed", icon: "plus.circle", color: .orange, action: "Add")
    }
    let yours = states.filter { if case .userManaged = $0 { return true }; return false }.count
    let location = states.compactMap { state -> URL? in
      switch state {
      case .current(let url), .userManaged(let url): return url.deletingLastPathComponent()
      default: return nil
      }
    }.first.map { $0.path.replacingOccurrences(of: FileManager.default.homeDirectoryForCurrentUser.path, with: "~") } ?? ""
    let detail = yours == total ? "Yours, in \(location)" : "Up to date in \(location)"
    return SkillStatus(text: detail, icon: "checkmark.circle.fill", color: StackPalette.color(phase: .ready), action: "Added")
  }

  private func refreshSkills() {
    skills = StackAgentSkills.skills()
    skillStates = Dictionary(uniqueKeysWithValues: StackAgentSkills.agents.map { agent in
      (agent.id, skills.map { StackAgentSkills.state(of: $0, for: agent) })
    })
  }

  private func installSkills(_ agent: StackAgentSkills.Agent) {
    do {
      let notes = try StackAgentSkills.install(skills, for: agent)
      skillNotes[agent.id] = nil
      if notes.contains(where: { $0.contains("kept yours") }) { skillNotes[agent.id] = notes.joined(separator: " · ") }
      error = nil
    } catch {
      self.error = "\(agent.name) skills: \(error.localizedDescription)"
    }
    refreshSkills()
  }

  private func add(_ target: String) {
    if !cliInstalled, (try? StackCLI.install()) != nil { cliInstalled = StackCLI.isInstalled }
    let results = StackAgentSetup.apply(targets: [target], command: StackCLI.preferredCommandPath(), instructions: writeInstructions)
    for result in results where !result.target.hasSuffix("instructions") { self.results[target] = result }
    if let failure = results.first(where: { !$0.ok && $0.target.hasSuffix("instructions") }) { error = failure.detail }
  }

  private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(title.uppercased()).font(.system(size: 10, weight: .bold)).foregroundColor(.secondary).tracking(0.5)
      VStack(alignment: .leading, spacing: 8) { content() }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .stackSurface(cornerRadius: 12)
    }
  }
}
