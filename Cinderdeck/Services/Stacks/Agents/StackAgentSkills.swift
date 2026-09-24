import CryptoKit
import Foundation

/// Installs the agent skills that ship with Cinderdeck (`skills/` in the repository, bundled as
/// `AgentSkills`) into the folders coding agents load skills from. Every bundled skill is
/// included, so a new skill needs no code here.
nonisolated enum StackAgentSkills {
  struct Agent: Identifiable, Sendable {
    let id: String
    let name: String
    /// Where Add installs, relative to the home folder.
    let folder: String
    /// Every folder the agent loads skills from. A copy in any of them is enough.
    let reads: [String]
  }

  /// Folders from each agent's documentation. Cursor and VS Code Copilot also read the
  /// Claude Code and Codex folders, so an existing copy there is refreshed instead of duplicated.
  static let agents: [Agent] = [
    Agent(id: "claude", name: "Claude Code", folder: ".claude/skills", reads: [".claude/skills"]),
    Agent(id: "codex", name: "Codex", folder: ".agents/skills", reads: [".agents/skills"]),
    Agent(id: "cursor", name: "Cursor", folder: ".cursor/skills", reads: [".cursor/skills", ".agents/skills", ".claude/skills", ".codex/skills"]),
    Agent(id: "copilot", name: "VS Code Copilot", folder: ".copilot/skills", reads: [".copilot/skills", ".claude/skills", ".agents/skills"]),
  ]

  static func agent(_ id: String) -> Agent? { agents.first { $0.id == id } }

  struct Skill: Identifiable, Sendable {
    var id: String { name }
    let name: String
    let summary: String
    let folder: URL
    let fingerprint: String
  }

  enum State: Equatable, Sendable {
    case missing
    case current(URL)
    case outdated(URL)
    /// A folder Cinderdeck did not write, such as a link to a clone. Never replaced.
    case userManaged(URL)
  }

  /// Written into each installed skill, so updates only touch copies Cinderdeck made.
  static let markerName = ".cinderdeck-skill"

  // MARK: Bundled skills

  static func bundledFolder(_ bundle: Bundle = .main) -> URL? {
    guard let url = bundle.resourceURL?.appendingPathComponent("AgentSkills", isDirectory: true),
      FileManager.default.fileExists(atPath: url.path) else { return nil }
    return url
  }

  static func skills(in folder: URL? = bundledFolder()) -> [Skill] {
    guard let folder, let entries = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return [] }
    return entries.compactMap { entry -> Skill? in
      let file = entry.appendingPathComponent("SKILL.md")
      guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
      let meta = frontmatter(text)
      return Skill(name: meta["name"] ?? entry.lastPathComponent, summary: firstSentence(meta["description"] ?? ""),
        folder: entry, fingerprint: fingerprint(entry))
    }.sorted { $0.name < $1.name }
  }

  static func frontmatter(_ text: String) -> [String: String] {
    let lines = text.components(separatedBy: .newlines)
    guard lines.first?.trimmingCharacters(in: .whitespaces) == "---" else { return [:] }
    var values: [String: String] = [:]
    for line in lines.dropFirst() {
      if line.trimmingCharacters(in: .whitespaces) == "---" { break }
      guard let colon = line.firstIndex(of: ":") else { continue }
      let key = line[..<colon].trimmingCharacters(in: .whitespaces)
      var value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      if value.count >= 2, value.first == "\"", value.last == "\"" { value = String(value.dropFirst().dropLast()) }
      values[key] = value
    }
    return values
  }

  private static func firstSentence(_ text: String) -> String {
    guard let end = text.range(of: ". ") else { return text }
    return String(text[..<end.lowerBound]) + "."
  }

  /// A hash of every file in the skill, so a changed skill shows as an update.
  static func fingerprint(_ folder: URL) -> String {
    var hasher = SHA256()
    let files = (FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey])?.allObjects as? [URL] ?? [])
      .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true && $0.lastPathComponent != markerName }
      .map { (path: String($0.standardizedFileURL.path.dropFirst(folder.standardizedFileURL.path.count)), url: $0) }
      .sorted { $0.path < $1.path }
    for file in files {
      hasher.update(data: Data(file.path.utf8))
      hasher.update(data: (try? Data(contentsOf: file.url)) ?? Data())
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  // MARK: State

  static func state(of skill: Skill, for agent: Agent, home: URL = StackAgentSetup.home("")) -> State {
    var managed: [State] = []
    var mine: URL?
    for folder in agent.reads {
      let url = home.appendingPathComponent(folder).appendingPathComponent(skill.name)
      guard FileManager.default.fileExists(atPath: url.appendingPathComponent("SKILL.md").path) else { continue }
      if let installed = installedFingerprint(url) {
        managed.append(installed == skill.fingerprint ? .current(url) : .outdated(url))
      } else if mine == nil {
        mine = url
      }
    }
    if let outdated = managed.first(where: { if case .outdated = $0 { return true }; return false }) { return outdated }
    if let current = managed.first { return current }
    if let mine { return .userManaged(mine) }
    return .missing
  }

  private static func installedFingerprint(_ url: URL) -> String? {
    guard !isSymbolicLink(url), let data = try? Data(contentsOf: url.appendingPathComponent(markerName)),
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return object["fingerprint"] as? String
  }

  private static func isSymbolicLink(_ url: URL) -> Bool {
    (try? url.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true
  }

  // MARK: Install

  /// Installs or updates every skill for one agent. Copies Cinderdeck made are refreshed where
  /// they are; skills the person manages themselves are left alone.
  static func install(_ skills: [Skill], for agent: Agent, home: URL = StackAgentSetup.home("")) throws -> [String] {
    guard !skills.isEmpty else { throw StackError.message("No skills are bundled with this build of Cinderdeck") }
    var notes: [String] = []
    for skill in skills {
      var targets: [URL] = []
      var mine: URL?
      for folder in agent.reads {
        let url = home.appendingPathComponent(folder).appendingPathComponent(skill.name)
        guard FileManager.default.fileExists(atPath: url.appendingPathComponent("SKILL.md").path) else { continue }
        if installedFingerprint(url) != nil { targets.append(url) } else if mine == nil { mine = url }
      }
      if targets.isEmpty, let mine {
        notes.append("\(skill.name): kept yours at \(mine.path)")
        continue
      }
      if targets.isEmpty { targets = [home.appendingPathComponent(agent.folder).appendingPathComponent(skill.name)] }
      for target in targets {
        try copy(skill, to: target)
        notes.append("\(skill.name) → \(target.deletingLastPathComponent().path.replacingOccurrences(of: home.path, with: "~"))")
      }
    }
    return notes
  }

  private static func copy(_ skill: Skill, to target: URL) throws {
    let manager = FileManager.default
    let parent = target.deletingLastPathComponent()
    try manager.createDirectory(at: parent, withIntermediateDirectories: true)
    let staging = parent.appendingPathComponent(".\(skill.name).cinderdeck-\(UUID().uuidString.prefix(8))")
    try manager.copyItem(at: skill.folder, to: staging)
    let marker: [String: Any] = ["skill": skill.name, "fingerprint": skill.fingerprint, "installedBy": "Cinderdeck",
      "note": "Installed by Cinderdeck → Agent access. Cinderdeck updates this copy; remove this file to keep your own edits."]
    try JSONSerialization.data(withJSONObject: marker, options: [.prettyPrinted, .sortedKeys])
      .write(to: staging.appendingPathComponent(markerName), options: .atomic)
    if manager.fileExists(atPath: target.path) {
      _ = try manager.replaceItemAt(target, withItemAt: staging)
    } else {
      try manager.moveItem(at: staging, to: target)
    }
  }

  // MARK: CLI

  /// `cinderdeck skills [list] [--json]` and `cinderdeck skills install [--claude] [--codex] [--cursor] [--copilot] [--all]`.
  static func run(_ arguments: [String]) -> Int32 {
    let command = arguments.first(where: { !$0.hasPrefix("-") }) ?? "list"
    let flags = Set(arguments.filter { $0.hasPrefix("--") }.map { String($0.dropFirst(2)) })
    let skills = skills()
    switch command {
    case "list", "status":
      if flags.contains("json") {
        let value = JSONValue.array(skills.map { skill in
          .object(["name": .string(skill.name), "summary": .string(skill.summary),
            "agents": .object(Dictionary(uniqueKeysWithValues: agents.map { ($0.id, .string(describe(state(of: skill, for: $0)))) }))])
        })
        print(value.prettyString())
        return 0
      }
      if skills.isEmpty { print("No skills are bundled with this build of Cinderdeck."); return 0 }
      for skill in skills {
        print(StackCLI.paint(skill.name, .bold) + "  " + skill.summary)
        for agent in agents { print("  \(agent.name): \(describe(state(of: skill, for: agent)))") }
      }
      print(StackCLI.paint("Install: cinderdeck skills install --all  (or --claude, --codex, --cursor, --copilot)", .dim))
      return 0
    case "install", "add", "update":
      var chosen = agents.filter { flags.contains($0.id) || (flags.contains("vscode") && $0.id == "copilot") }
      if chosen.isEmpty || flags.contains("all") { chosen = agents }
      var failed = false
      for agent in chosen {
        do {
          for note in try install(skills, for: agent) { print(StackCLI.paint("✓ ", .green) + "\(agent.name): \(note)") }
        } catch {
          failed = true
          FileHandle.standardError.write(Data((StackCLI.paint("error: ", .red) + "\(agent.name): \(error.localizedDescription)\n").utf8))
        }
      }
      return failed ? 1 : 0
    case "path", "where":
      print(bundledFolder()?.path ?? "No skills are bundled with this build")
      return 0
    default:
      print("""
      cinderdeck skills — agent skills that ship with Cinderdeck

        list [--json]                  Bundled skills and where each agent has them
        install [--claude] [--codex]   Install or update skills (default: every agent)
                [--cursor] [--copilot]
        path                           Folder the bundled skills are read from
      """)
      return command == "help" ? 0 : 1
    }
  }

  static func describe(_ state: State) -> String {
    let home = StackAgentSetup.home("").path
    func short(_ url: URL) -> String { url.deletingLastPathComponent().path.replacingOccurrences(of: home, with: "~") }
    switch state {
    case .missing: return "not installed"
    case .current(let url): return "installed in \(short(url))"
    case .outdated(let url): return "update available in \(short(url))"
    case .userManaged(let url): return "yours in \(short(url))"
    }
  }
}
