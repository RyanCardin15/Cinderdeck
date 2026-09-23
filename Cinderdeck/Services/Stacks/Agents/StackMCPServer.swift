import Darwin
import Foundation

/// `cinderdeck mcp` — a Model Context Protocol server over stdio that forwards
/// tool calls to the running Cinderdeck app. The client's name (from
/// `initialize`) becomes the actor shown on services it starts.
nonisolated enum StackMCPServer {
  private struct Tool {
    let name: String
    let description: String
    let properties: [String: JSONValue]
    let required: [String]
    let readOnly: Bool
  }

  private static func property(_ type: String, _ description: String, items: String? = nil, values: [String]? = nil) -> JSONValue {
    var object: [String: JSONValue] = ["type": .string(type), "description": .string(description)]
    if let items { object["items"] = .object(["type": .string(items)]) }
    if let values { object["enum"] = .array(values.map { JSONValue.string($0) }) }
    return .object(object)
  }

  private static let stack = property("string", "Stack id or name (see list_stacks)")
  private static let force = property("boolean", "Override another agent's claim. Only with the user's approval.")

  private static let tools: [Tool] = [
    Tool(name: "list_stacks", description: "List every stack with service status, ports, URLs, PIDs, who started each service, Git branches and claims.",
      properties: [:], required: [], readOnly: true),
    Tool(name: "stack_status", description: "Full detail for one stack: services (phase, pid, port, url, owner, log file, command, cwd), repos and claim.",
      properties: ["stack": stack], required: ["stack"], readOnly: true),
    Tool(name: "start_stack", description: "Start a stack (or some services) in dependency order. Waits until services are ready and returns crash output for anything that failed.",
      properties: ["stack": stack, "services": property("array", "Only these services (and nothing else)", items: "string"),
        "wait": property("boolean", "Wait for readiness (default true)"), "timeout": property("number", "Seconds to wait (default 180)"), "force": force],
      required: ["stack"], readOnly: false),
    Tool(name: "stop_stack", description: "Stop a stack or specific services (reverse dependency order, whole process groups).",
      properties: ["stack": stack, "services": property("array", "Only these services", items: "string"), "force": force],
      required: ["stack"], readOnly: false),
    Tool(name: "restart_stack", description: "Restart a whole stack, or one service. Waits for readiness and reports failures.",
      properties: ["stack": stack, "service": property("string", "Restart just this service"),
        "dependents": property("boolean", "Also restart services that depend on it"), "timeout": property("number", "Seconds to wait (default 180)"), "force": force],
      required: ["stack"], readOnly: false),
    Tool(name: "read_logs", description: "Read recent service output (ANSI stripped). Use `after` with the returned cursor to read only new lines.",
      properties: ["stack": stack, "service": property("string", "One service; omit for all, interleaved"),
        "lines": property("number", "Maximum lines (default 200)"), "grep": property("string", "Case-insensitive regex filter"),
        "after": property("number", "Cursor from a previous read_logs call")],
      required: ["stack"], readOnly: true),
    Tool(name: "list_ports", description: "Every listening TCP port with its process, working directory, terminal (tty) and the app it was started from (Cursor, Terminal, Codex…), or the Cinderdeck stack/service that owns it.",
      properties: ["port": property("number", "Only this port"), "external_only": property("boolean", "Hide ports owned by Cinderdeck services")],
      required: [], readOnly: true),
    Tool(name: "stop_port_process", description: "Stop a stray non-Cinderdeck process listening on a port (e.g. a dev server left in another terminal). Requires the pid from list_ports. Ask the user first if you did not start it.",
      properties: ["port": property("number", "Port"), "pid": property("number", "Process ID from list_ports")],
      required: ["port", "pid"], readOnly: false),
    Tool(name: "git_status", description: "Current branch, dirty files and ahead/behind for each repo in a stack.",
      properties: ["stack": stack], required: ["stack"], readOnly: true),
    Tool(name: "list_branches", description: "Recent, local and remote branches for a stack's repos.",
      properties: ["stack": stack, "repo": property("string", "One repo id")], required: ["stack"], readOnly: true),
    Tool(name: "switch_branch", description: "Check out a branch in one repo or every repo of a stack that has it. Stops affected running services first and restarts them after.",
      properties: ["stack": stack, "branch": property("string", "Branch name, or origin/name for a remote branch"),
        "repo": property("string", "Only this repo; omit for all repos that have the branch"),
        "dirty": property("string", "What to do with uncommitted changes (default fail)", values: ["fail", "stash", "carry"]), "force": force],
      required: ["stack", "branch"], readOnly: false),
    Tool(name: "pull_repos", description: "Fast-forward pull a stack's repos (or one repo), restarting affected services. Use fetch=true to only fetch.",
      properties: ["stack": stack, "repo": property("string", "One repo id"), "fetch": property("boolean", "Fetch only; do not pull"), "force": force],
      required: ["stack"], readOnly: false),
    Tool(name: "claim_stack", description: "Take an advisory claim on a stack while you depend on it (tests, debugging). Other agents must ask before changing it. Calling again renews it.",
      properties: ["stack": stack, "note": property("string", "What you are doing, shown to the user"), "ttl_minutes": property("number", "Default 30, max 480"), "force": force],
      required: ["stack"], readOnly: false),
    Tool(name: "release_stack", description: "Release your claim on a stack.",
      properties: ["stack": stack, "force": force], required: ["stack"], readOnly: false),
    Tool(name: "recent_activity", description: "Recent starts, crashes, stops and branch switches for a stack, with who caused them.",
      properties: ["stack": stack, "limit": property("number", "Default 40")], required: ["stack"], readOnly: true),
    Tool(name: "stacks_guide", description: "Where stack TOML files, logs and live state live, plus a definition template. Use before creating or editing a stack.",
      properties: [:], required: [], readOnly: true),
    Tool(name: "validate_stack", description: "Validate a stack definition (file path or TOML source) and show its start order. Call reload_stacks after saving a file.",
      properties: ["path": property("string", "Path to a .toml file"), "source": property("string", "TOML text")], required: [], readOnly: true),
    Tool(name: "reload_stacks", description: "Reload stack definitions from disk.", properties: [:], required: [], readOnly: false),
  ]

  // MARK: Loop

  static func run() -> Int32 {
    signal(SIGPIPE, SIG_IGN)
    var client = StackControlClientInfo(name: nil, session: (ProcessInfo.processInfo.environment["CINDERDECK_AGENT_SESSION"] ?? ProcessInfo.processInfo.environment["SNAPZY_AGENT_SESSION"]),
      cwd: FileManager.default.currentDirectoryPath)
    if let name = (ProcessInfo.processInfo.environment["CINDERDECK_AGENT"] ?? ProcessInfo.processInfo.environment["SNAPZY_AGENT"]) { client.name = name }
    var connection: StackControlConnection?
    while let line = readLine(strippingNewline: true) {
      guard !line.trimmingCharacters(in: .whitespaces).isEmpty,
        let message = try? StackControlCoding.decoder().decode(JSONValue.self, from: Data(line.utf8)) else {
        send(["jsonrpc": .string("2.0"), "id": .null, "error": .object(["code": .number(-32700), "message": .string("Parse error")])])
        continue
      }
      guard let id = message["id"], id != .null else { continue } // notification
      let method = message["method"]?.stringValue ?? ""
      let params = message["params"] ?? .object([:])
      var response: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": id]
      switch method {
      case "initialize":
        if client.name == nil, let name = params["clientInfo"]?["name"]?.stringValue { client.name = displayName(name) }
        connection?.client = client
        response["result"] = .object([
          "protocolVersion": .string(params["protocolVersion"]?.stringValue ?? "2025-06-18"),
          "capabilities": .object(["tools": .object(["listChanged": .bool(false)])]),
          "serverInfo": .object(["name": .string("cinderdeck-stacks"), "title": .string("Cinderdeck Stacks"), "version": .string(version)]),
          "instructions": .string(StackAgentGuide.mcpInstructions),
        ])
      case "ping":
        response["result"] = .object([:])
      case "tools/list":
        response["result"] = .object(["tools": .array(tools.map(describe))])
      case "tools/call":
        let name = params["name"]?.stringValue ?? ""
        let arguments = params["arguments"]?.objectValue ?? [:]
        response["result"] = call(name, arguments, client: client, connection: &connection)
      case "resources/list": response["result"] = .object(["resources": .array([])])
      case "resources/templates/list": response["result"] = .object(["resourceTemplates": .array([])])
      case "prompts/list": response["result"] = .object(["prompts": .array([])])
      default:
        response["error"] = .object(["code": .number(-32601), "message": .string("Method not found: \(method)")])
      }
      send(response)
    }
    return 0
  }

  private static var version: String {
    Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
  }

  /// Friendly names for common MCP client identifiers.
  static func displayName(_ client: String) -> String {
    let lower = client.lowercased()
    if lower.contains("cursor") { return "Cursor" }
    if lower.contains("codex") { return "Codex" }
    if lower.contains("claude") { return "Claude Code" }
    if lower.contains("windsurf") { return "Windsurf" }
    if lower.contains("zed") { return "Zed" }
    if lower.contains("copilot") || lower.contains("vscode") || lower == "visual studio code" { return "VS Code" }
    return String(client.prefix(40))
  }

  private static func send(_ object: [String: JSONValue]) {
    guard var data = try? StackControlCoding.encoder().encode(JSONValue.object(object)) else { return }
    data.append(10)
    FileHandle.standardOutput.write(data)
  }

  private static func describe(_ tool: Tool) -> JSONValue {
    var schema: [String: JSONValue] = ["type": .string("object"), "properties": .object(tool.properties)]
    if !tool.required.isEmpty { schema["required"] = .array(tool.required.map { JSONValue.string($0) }) }
    return .object([
      "name": .string(tool.name), "description": .string(tool.description), "inputSchema": .object(schema),
      "annotations": .object(["readOnlyHint": .bool(tool.readOnly), "destructiveHint": .bool(!tool.readOnly && tool.name != "claim_stack"),
        "openWorldHint": .bool(false)]),
    ])
  }

  // MARK: Tool calls

  private static func call(_ name: String, _ arguments: [String: JSONValue], client: StackControlClientInfo,
    connection: inout StackControlConnection?) -> JSONValue {
    do {
      let (method, params, timeout) = try request(for: name, arguments)
      let result: JSONValue
      if method == "local.guide" {
        result = .object(["paths": pathsValue(), "template": .string(StackAgentGuide.template),
          "rules": .string("Services must run in the foreground. Use double-quoted strings, [services.<id>] tables and dotted keys (ready.port). No inline tables or arrays of tables.")])
      } else {
        if connection == nil { connection = try StackCLI.connect(client) }
        do { result = try connection!.call(method, params, timeout: timeout) }
        catch let error as StackControlError { throw error }
        catch {
          // Transport failure: the app may have restarted. Reconnect once.
          connection = try StackCLI.connect(client)
          result = try connection!.call(method, params, timeout: timeout)
        }
      }
      return .object(["content": .array([.object(["type": .string("text"), "text": .string(render(name, result))])]), "isError": .bool(false)])
    } catch let error as StackControlError {
      return errorResult("\(error.message) [\(error.code)]")
    } catch {
      return errorResult(error.localizedDescription)
    }
  }

  private static func errorResult(_ message: String) -> JSONValue {
    .object(["content": .array([.object(["type": .string("text"), "text": .string(message)])]), "isError": .bool(true)])
  }

  private static func pathsValue() -> JSONValue {
    .object([
      "stacksDirectory": .string(StackDefinitionLoader.directory().path), "state": .string(StackControlPaths.state.path),
      "logs": .string(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Cinderdeck/Stacks").path),
      "cli": .string(StackCLI.preferredCommandPath()),
    ])
  }

  private static func request(for tool: String, _ arguments: [String: JSONValue]) throws -> (String, [String: JSONValue], TimeInterval) {
    var params = arguments
    let wait = min(max(arguments["timeout"]?.doubleValue ?? 180, 1), 900)
    switch tool {
    case "list_stacks": return ("snapshot", [:], 30)
    case "stack_status": return ("stack.get", params, 30)
    case "start_stack": return ("stack.start", params, wait + 30)
    case "stop_stack": return ("stack.stop", params, 120)
    case "restart_stack": return ("stack.restart", params, wait + 60)
    case "read_logs": return ("logs", params, 30)
    case "list_ports":
      if arguments["external_only"]?.boolValue == true { params["external"] = .bool(true) }
      return ("ports", params, 30)
    case "stop_port_process": return ("port.kill", params, 30)
    case "git_status": return ("git.status", params, 90)
    case "list_branches": return ("git.branches", params, 90)
    case "switch_branch": return ("git.switch", params, 300)
    case "pull_repos": return (arguments["fetch"]?.boolValue == true ? "git.fetch" : "git.pull", params, 300)
    case "claim_stack":
      if let ttl = arguments["ttl_minutes"] { params["ttlMinutes"] = ttl }
      return ("claim", params, 30)
    case "release_stack": return ("release", params, 30)
    case "recent_activity": return ("events", params, 30)
    case "validate_stack": return ("validate", params, 30)
    case "reload_stacks": return ("reload", [:], 30)
    case "stacks_guide": return ("local.guide", [:], 5)
    default: throw StackControlError(code: "unknown_tool", message: "Unknown tool \(tool)")
    }
  }

  /// Compact, model-friendly text for list-style results; JSON for the rest.
  private static func render(_ tool: String, _ result: JSONValue) -> String {
    switch tool {
    case "list_stacks":
      guard let snapshot = try? result.decode(StacksSnapshot.self) else { return result.prettyString() }
      if snapshot.stacks.isEmpty {
        return "No stacks are defined. Create TOML files in \(snapshot.stacksDirectory) (call stacks_guide for a template)."
      }
      return compact(snapshot.stacks).prettyString()
    case "read_logs":
      let lines = (result["lines"]?.arrayValue ?? []).map { line in
        "\(line["service"]?.stringValue ?? "") | \(line["text"]?.stringValue ?? "")"
      }
      let cursor = result["cursor"]?.doubleValue.map { String($0) } ?? ""
      let files = (result["files"]?.objectValue ?? [:]).map { "\($0.key): \($0.value.stringValue ?? "")" }.sorted().joined(separator: "\n")
      return (lines.isEmpty ? "(no output)" : lines.joined(separator: "\n")) + "\n\n[cursor: \(cursor)]\n[log files]\n" + files
    default:
      return result.prettyString()
    }
  }

  static func compact(_ stacks: [StackSnapshot]) -> JSONValue {
    .array(stacks.map { stack in
      var object: [String: JSONValue] = [
        "id": .string(stack.id), "name": .string(stack.name), "state": .string(stack.state),
        "services": .array(stack.services.map { service in
          var entry: [String: JSONValue] = ["name": .string(service.name), "status": .string(service.status)]
          if let url = service.url { entry["url"] = .string(url) }
          if let pid = service.pid { entry["pid"] = .number(Double(pid)) }
          if let owner = service.owner, service.pid != nil { entry["startedBy"] = .string(owner.label) }
          if let branch = service.branch { entry["branch"] = .string(branch) }
          if let detail = service.detail { entry["detail"] = .string(detail) }
          return .object(entry)
        }),
      ]
      if let operation = stack.operation { object["busy"] = .string(operation) }
      if let claim = stack.claim {
        object["claim"] = .object(["by": .string(claim.holder.label), "note": .string(claim.note ?? ""),
          "until": .string(ISO8601DateFormatter().string(from: claim.expiresAt))])
      }
      if !stack.issues.isEmpty { object["issues"] = .array(stack.issues.map { JSONValue.string($0) }) }
      if !stack.repos.isEmpty {
        object["repos"] = .array(stack.repos.map { repo -> JSONValue in
          var text = "\(repo.id): \(repo.branch)"
          if repo.dirty { text += " (\(repo.changedFiles) changed)" }
          if repo.ahead > 0 { text += " ↑\(repo.ahead)" }
          if repo.behind > 0 { text += " ↓\(repo.behind)" }
          return .string(text)
        })
      }
      return .object(object)
    })
  }
}
