import Foundation

nonisolated enum WorkspaceCLI {
  static func run(_ arguments: [String]) -> Int32 {
    if arguments.isEmpty || arguments.contains("--help") || arguments == ["help"] { print(usage); return 0 }
    do {
      let options = try parse(arguments)
      let request = try request(options)
      let connection = try StackCLI.connect(StackCLI.clientInfo(options))
      let result = try connection.call(request.method, request.params, timeout: request.method == "workspace.run.wait" ? (request.params["timeout"]?.doubleValue ?? 600) + 30 : 120)
      if options.has("wait"), request.method == "workspace.task.run" || request.method == "workspace.workflow.run" {
        let started = try result.decode(WorkspaceRun.self)
        print(result.prettyString())
        let deadline = Date().addingTimeInterval(Double(options["timeout"] ?? "600") ?? 600)
        while Date() < deadline {
          let current = try connection.call("workspace.run.get", ["run": .string(started.id.uuidString)])
          let run = try current.decode(WorkspaceRun.self)
          if !run.status.isActive { print(current.prettyString()); return run.status == .succeeded ? 0 : 1 }
          Thread.sleep(forTimeInterval: 0.25)
        }
        throw StackControlError(code: "wait_timeout", message: "Stopped waiting. Run \(started.id) may still be active; inspect its status or cancel it. Do not start it again.")
      }
      print(result.prettyString())
      if request.method == "workspace.run.wait" {
        return result["finished"]?.boolValue == true && result["run"]?["status"]?.stringValue == "succeeded" ? 0 : 1
      }
      return 0
    } catch { return AgentToolCLI.report(error) }
  }
  static func parse(_ arguments: [String]) throws -> StackCLI.Options {
    let parsed = try AgentToolCLI.parse(arguments,
      valued: ["as", "session", "name", "folder", "id", "revision", "file", "data", "section", "timeout", "limit", "lines", "step"],
      flags: ["json", "force", "wait"])
    let command = parsed.positionals.first ?? "list"
    var valued: Set<String> = ["as", "session"]
    var flags: Set<String> = ["json"]
    switch command {
    case "create": valued.formUnion(["name", "folder", "id"])
    case "edit": valued.formUnion(["name", "folder", "revision"]); flags.insert("force")
    case "save": valued.formUnion(["file", "revision"]); flags.insert("force")
    case "remove", "delete": valued.insert("revision"); flags.insert("force")
    case "save-service", "save-task", "save-workflow": valued.formUnion(["data", "file"]); flags.insert("force")
    case "delete-item", "cancel": flags.insert("force")
    case "open": valued.insert("section")
    case "task", "workflow": valued.insert("timeout"); flags.formUnion(["wait", "force"])
    case "wait": valued.insert("timeout")
    case "runs": valued.insert("limit")
    case "logs": valued.formUnion(["lines", "step"])
    default: break
    }
    let unknown = Set(parsed.values.keys).subtracting(valued).union(parsed.flags.subtracting(flags))
    guard unknown.isEmpty else { throw StackControlError.invalid("Unsupported option for \(command): " + unknown.sorted().map { "--" + $0 }.joined(separator: ", ")) }
    return parsed
  }

  static func request(_ options: StackCLI.Options) throws -> (method: String, params: [String: JSONValue]) {
    let args = options.positionals
    let command = args.first ?? "list"
    var params: [String: JSONValue] = [:]
    let tool: String
    func count(_ range: ClosedRange<Int>, _ hint: String) throws {
      guard range.contains(args.count) else { throw StackControlError.invalid("Use workspace " + hint) }
    }
    func number(_ key: String, max: Int) throws {
      if let raw = options[key] {
        guard let value = Int(raw), (1...max).contains(value) else { throw StackControlError.invalid("--\(key) must be an integer from 1 to \(max)") }
        params[key] = .number(Double(value))
      }
    }
    if options.has("force") { params["force"] = .bool(true) }
    if let timeout = options["timeout"], Double(timeout).map({ $0.isFinite && $0 >= 1 && $0 <= 3600 }) != true {
      throw StackControlError.invalid("--timeout must be a number from 1 to 3600 seconds")
    }
    switch command {
    case "list": try count(1...1, "list"); tool = "list_workspaces"
    case "show", "definition":
      try count(2...2, "\(command) <workspace>"); params["workspace"] = .string(args[1])
      tool = command == "show" ? "workspace_details" : "workspace_definition"
    case "create":
      try count(1...1, "create --name <name> --folder <path> [--id <id>]")
      for key in ["name", "folder", "id"] { if let value = options[key] { params[key] = .string(value) } }
      tool = "create_workspace"
    case "edit", "save", "remove", "delete":
      try count(2...2, "\(command) <workspace>"); params["workspace"] = .string(args[1])
      for key in ["name", "folder", "revision"] { if let value = options[key] { params[key] = .string(value) } }
      if command == "save" {
        guard let path = options["file"], options["revision"] != nil else { throw StackControlError.invalid("Use workspace save <workspace> --file <definition.toml> --revision <revision from definition>") }
        params["source"] = .string(try String(contentsOfFile: (path as NSString).expandingTildeInPath, encoding: .utf8))
      }
      tool = ["remove", "delete"].contains(command) ? "delete_workspace" : "save_workspace"
    case "save-service", "save-task", "save-workflow":
      let kind = String(command.dropFirst(5))
      try count(3...3, "\(command) <workspace> <id> --data '<json>' (or --file <args.json>)")
      let data = try AgentToolCLI.object(options)
      guard data["workspace"] == nil, data[kind] == nil, data["force"] == nil else { throw StackControlError.invalid("Set workspace and component id with positionals, and force with --force") }
      params.merge(data) { _, new in new }
      params["workspace"] = .string(args[1]); params[kind] = .string(args[2])
      tool = "save_workspace_" + kind
    case "delete-item":
      try count(4...4, "delete-item <workspace> <service|task|workflow> <id>")
      params["workspace"] = .string(args[1]); params["kind"] = .string(args[2]); params["id"] = .string(args[3])
      tool = "delete_workspace_item"
    case "open":
      try count(1...2, "open [workspace] [--section <section>]")
      if args.count == 2 { params["workspace"] = .string(args[1]) }
      if let section = options["section"] { params["section"] = .string(section) }
      tool = "open_workspace"
    case "task", "workflow":
      try count(3...3, "\(command) <workspace> <\(command)>")
      params["workspace"] = .string(args[1]); params[command] = .string(args[2]); tool = "run_workspace_" + command
    case "runs":
      try count(1...2, "runs [workspace]")
      if args.count == 2 { params["workspace"] = .string(args[1]) }
      try number("limit", max: 200); tool = "list_workspace_runs"
    case "status", "logs", "cancel", "wait":
      try count(2...2, "\(command) <run-uuid>")
      guard UUID(uuidString: args[1]) != nil else { throw StackControlError.invalid("Pass a run UUID") }
      params["run"] = .string(args[1])
      tool = ["status": "workspace_run_status", "logs": "workspace_run_logs", "cancel": "cancel_workspace_run", "wait": "wait_for_workspace_run"][command]!
      if command == "logs" {
        try number("lines", max: 5000)
        if let step = options["step"] { params["step"] = .string(step) }
      }
      if command == "wait", let timeout = options["timeout"].flatMap(Double.init) { params["timeout"] = .number(timeout) }
    default: throw StackControlError.invalid("Unknown command. See cinderdeck workspace --help")
    }
    let request = try AgentToolCLI.request(name: tool, arguments: params)
    return (request.0, request.1)
  }
  static let usage = """
  cinderdeck workspace — services, finite tasks, and ordered workflows

    list                              List workspaces and configured components
    show <workspace>                  Show services, tasks, workflows, and recent runs
    create --name <name> --folder <path> [--id <id>]
    edit <workspace> --name <name> / --folder <path>
    definition <workspace>            Read complete TOML and its revision
    save <workspace> --file <toml> --revision <revision>
    remove <workspace> [--revision <revision>]
    save-service <workspace> <id> --data '<json>' (or --file <args.json>)
    save-task <workspace> <id> --data '<json>'
    save-workflow <workspace> <id> --data '<json>'
    delete-item <workspace> <service|task|workflow> <id>
    open [workspace] [--section services|tasks|workflows|runs|recordings]
    task <workspace> <task>            Start a task; returns a run UUID immediately
    workflow <workspace> <workflow>    Start an ordered workflow; returns a run UUID
    wait <run-uuid> [--timeout 600]    Wait for an existing run without starting another
    runs [workspace]                  List saved results and active runs
    status <run-uuid>                 Inspect progress, step results, and exit codes
    logs <run-uuid> [-n 200]           Read saved or live output
    cancel <run-uuid>                 Cancel a run and its remaining steps

  Add --wait to task/workflow to wait for completion (exit 0 for success, 1 otherwise).
  --timeout <seconds> limits waiting only (default 600); expiry does not cancel the run.
  --as <agent> / --session <id> identify the caller. --force overrides an advisory claim.
  All output is JSON. Use cinderdeck tools <tool-name> for component JSON fields.
  Full saves and removal require stopped services/runs; removal keeps projects and run history. cinderdeck services manages long-running services.
  Definitions remain in ~/.config/cinderdeck/stacks/*.toml; see docs/WORKSPACES.md.
  """
}
