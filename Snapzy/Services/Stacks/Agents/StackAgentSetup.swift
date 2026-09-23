import Foundation

/// Registers the Snapzy MCP server with coding agents and, optionally, adds
/// the Stacks instructions to their global instruction files.
nonisolated enum StackAgentSetup {
  struct Result: Sendable { let target: String; let detail: String; let ok: Bool }

  static func run(_ options: StackCLI.Options) throws {
    var targets = Set(["cursor", "codex", "claude"].filter { options.has($0) })
    if targets.isEmpty || options.has("all") { targets = ["cursor", "codex", "claude"] }
    let command = StackCLI.preferredCommandPath()
    if options.has("print") {
      print(snippets(command: command))
      return
    }
    for result in apply(targets: targets, command: command, instructions: options.has("instructions")) {
      print(StackCLI.paint(result.ok ? "✓ " : "• ", result.ok ? .green : .yellow) + result.target + ": " + result.detail)
    }
    if !options.has("instructions") {
      print(StackCLI.paint("Tip: add --instructions to also write usage notes into ~/.codex/AGENTS.md and ~/.claude/CLAUDE.md.", .dim))
    }
  }

  static func apply(targets: Set<String>, command: String, instructions: Bool) -> [Result] {
    var results: [Result] = []
    if targets.contains("cursor") { results.append(capture("Cursor") { try cursor(command: command) }) }
    if targets.contains("codex") {
      results.append(capture("Codex") { try codex(command: command) })
      if instructions { results.append(capture("Codex instructions") { try writeInstructions(to: home(".codex/AGENTS.md"), command: command) }) }
    }
    if targets.contains("claude") {
      results.append(capture("Claude Code") { try claude(command: command) })
      if instructions { results.append(capture("Claude Code instructions") { try writeInstructions(to: home(".claude/CLAUDE.md"), command: command) }) }
    }
    return results
  }

  private static func capture(_ target: String, _ body: () throws -> String) -> Result {
    do { return Result(target: target, detail: try body(), ok: true) }
    catch { return Result(target: target, detail: error.localizedDescription, ok: false) }
  }

  static func home(_ path: String) -> URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(path) }

  private static func backup(_ url: URL) {
    let copy = url.appendingPathExtension("snapzy-backup")
    try? FileManager.default.removeItem(at: copy)
    try? FileManager.default.copyItem(at: url, to: copy)
  }

  /// ~/.cursor/mcp.json → mcpServers.snapzy
  static func cursor(command: String) throws -> String {
    let url = home(".cursor/mcp.json")
    var root: [String: Any] = [:]
    if let data = try? Data(contentsOf: url), !data.isEmpty {
      guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw StackError.message("\(url.path) is not a JSON object; add the server manually (see --print)")
      }
      root = object
      backup(url)
    }
    var servers = root["mcpServers"] as? [String: Any] ?? [:]
    servers["snapzy"] = ["command": command, "args": ["mcp"]]
    root["mcpServers"] = servers
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    try data.write(to: url, options: .atomic)
    return "added to \(url.path) (restart Cursor or toggle the server in Settings → MCP)"
  }

  /// ~/.codex/config.toml → [mcp_servers.snapzy]
  static func codex(command: String) throws -> String {
    let url = home(".codex/config.toml")
    var text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    if !text.isEmpty { backup(url) }
    text = removingTOMLTable("mcp_servers.snapzy", from: text)
    let block = """
    [mcp_servers.snapzy]
    command = "\(escape(command))"
    args = ["mcp"]
    startup_timeout_sec = 30
    tool_timeout_sec = 900
    """
    if !text.isEmpty && !text.hasSuffix("\n") { text += "\n" }
    text += (text.isEmpty ? "" : "\n") + block + "\n"
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try text.write(to: url, atomically: true, encoding: .utf8)
    return "added [mcp_servers.snapzy] to \(url.path)"
  }

  /// Uses the `claude` CLI when it is installed; otherwise prints the command.
  static func claude(command: String) throws -> String {
    let add = ["mcp", "add", "--scope", "user", "snapzy", "--", command, "mcp"]
    let manual = "claude " + add.map { $0.contains(" ") ? "\"\($0)\"" : $0 }.joined(separator: " ")
    let candidates = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", home(".local/bin/claude").path, home(".claude/local/claude").path]
    guard let executable = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
      return "claude CLI not found. Run: \(manual)"
    }
    let remove = Process()
    remove.executableURL = URL(fileURLWithPath: executable)
    remove.arguments = ["mcp", "remove", "--scope", "user", "snapzy"]
    remove.standardOutput = FileHandle.nullDevice; remove.standardError = FileHandle.nullDevice
    try? remove.run(); remove.waitUntilExit()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = add
    process.standardOutput = FileHandle.nullDevice
    let errors = Pipe()
    process.standardError = errors
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
      let message = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      throw StackError.message("claude mcp add failed: \(message.trimmingCharacters(in: .whitespacesAndNewlines)). Run: \(manual)")
    }
    return "registered with `claude mcp add --scope user`"
  }

  static let beginMarker = "<!-- snapzy-stacks:begin -->"
  static let endMarker = "<!-- snapzy-stacks:end -->"

  static func writeInstructions(to url: URL, command: String) throws -> String {
    var text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    if !text.isEmpty { backup(url) }
    let block = beginMarker + "\n" + StackAgentGuide.instructions(command: command) + "\n" + endMarker
    if let start = text.range(of: beginMarker), let end = text.range(of: endMarker, range: start.upperBound..<text.endIndex) {
      text.replaceSubrange(start.lowerBound..<end.upperBound, with: block)
    } else {
      if !text.isEmpty && !text.hasSuffix("\n\n") { text += text.hasSuffix("\n") ? "\n" : "\n\n" }
      text += block + "\n"
    }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try text.write(to: url, atomically: true, encoding: .utf8)
    return "updated \(url.path)"
  }

  static func removingTOMLTable(_ name: String, from text: String) -> String {
    var output: [Substring] = []
    var skipping = false
    for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("[") {
        let header = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "[] "))
        skipping = header == name || header.hasPrefix(name + ".")
      }
      if !skipping { output.append(line) }
    }
    while output.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { output.removeLast() }
    return output.joined(separator: "\n")
  }

  private static func escape(_ value: String) -> String {
    value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
  }

  static func snippets(command: String) -> String {
    """
    Cursor (~/.cursor/mcp.json or .cursor/mcp.json in a project):
      { "mcpServers": { "snapzy": { "command": "\(command)", "args": ["mcp"] } } }

    Codex (~/.codex/config.toml):
      [mcp_servers.snapzy]
      command = "\(escape(command))"
      args = ["mcp"]
      tool_timeout_sec = 900

    Claude Code:
      claude mcp add --scope user snapzy -- "\(command)" mcp

    Any agent with a shell:
      \(command) stacks agent-help
    """
  }
}
