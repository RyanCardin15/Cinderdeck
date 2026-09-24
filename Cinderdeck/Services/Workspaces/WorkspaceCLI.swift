import Foundation

nonisolated enum WorkspaceCLI {
  static func run(_ arguments: [String]) -> Int32 {
    if arguments.isEmpty || arguments.contains("--help") || arguments == ["help"] { print(usage); return 0 }
    do {
      let options = try parse(arguments)
      let request = try request(options)
      let connection = try StackCLI.connect(StackCLI.clientInfo(options))
      let result = try connection.call(request.method, request.params, timeout: 120)
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
      return 0
    } catch {
      let error = error as? StackControlError ?? .init(code: "failed", message: error.localizedDescription)
      FileHandle.standardError.write(Data((JSONValue.object(["error": .object(["code": .string(error.code), "message": .string(error.message)])]).prettyString() + "\n").utf8))
      return 1
    }
  }
  static func parse(_ arguments: [String]) throws -> StackCLI.Options {
    let valued: Set<String> = ["as", "session", "timeout", "lines", "n"]
    let flags: Set<String> = ["wait", "force", "json"]
    var index = 0
    while index < arguments.count {
      let value = arguments[index]; index += 1
      if value == "--" { break }
      if !value.hasPrefix("-") { continue }
      let parts = value.drop(while: { $0 == "-" }).split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
      guard let key = parts.first, valued.contains(key) || flags.contains(key) else { throw StackControlError.invalid("Unknown option: \(value)") }
      if valued.contains(key), parts.count == 1 {
        guard index < arguments.count, !arguments[index].hasPrefix("--") else { throw StackControlError.invalid("\(value) requires a value") }
        index += 1
      } else if flags.contains(key), parts.count != 1 { throw StackControlError.invalid("\(value) does not accept a value") }
    }
    return StackCLI.parse(arguments)
  }
  static func request(_ options: StackCLI.Options) throws -> (method: String, params: [String: JSONValue]) {
    let args = options.positionals
    let command = args.first ?? "list"
    var params: [String: JSONValue] = [:]
    if options.has("force") { params["force"] = .bool(true) }
    if let lines = options["lines"], let count = Int(lines) { params["lines"] = .number(Double(count)) }
    if let timeout = options["timeout"], Double(timeout).map({ $0.isFinite && $0 > 0 && $0 <= 86400 }) != true {
      throw StackControlError.invalid("--timeout must be a number from 1 to 86400 seconds")
    }
    switch command {
    case "list": guard args.count == 1 else { throw StackControlError.invalid("Use workspace list") }; return ("workspace.list", params)
    case "show": guard args.count == 2 else { throw StackControlError.invalid("Use workspace show <workspace>") }; params["workspace"] = .string(args[1]); return ("workspace.get", params)
    case "task", "workflow":
      guard args.count == 3 else { throw StackControlError.invalid("Use workspace \(command) <workspace> <\(command)>") }
      params["workspace"] = .string(args[1]); params[command] = .string(args[2]); return ("workspace.\(command).run", params)
    case "runs":
      guard args.count <= 2 else { throw StackControlError.invalid("Use workspace runs [workspace]") }
      if args.count == 2 { params["workspace"] = .string(args[1]) }; return ("workspace.runs", params)
    case "status", "logs", "cancel":
      guard args.count == 2, UUID(uuidString: args[1]) != nil else { throw StackControlError.invalid("Use workspace \(command) <run-uuid>") }
      params["run"] = .string(args[1]); return ("workspace.run.\(command == "status" ? "get" : command)", params)
    default: throw StackControlError.invalid("Unknown command. See cinderdeck workspace --help")
    }
  }
  static let usage = """
  cinderdeck workspace — services, finite tasks, and ordered workflows

    list                              List workspaces and configured components
    show <workspace>                  Show services, tasks, workflows, and recent runs
    task <workspace> <task>            Start a task; returns a run UUID immediately
    workflow <workspace> <workflow>    Start an ordered workflow; returns a run UUID
    runs [workspace]                  List saved results and active runs
    status <run-uuid>                 Inspect progress, step results, and exit codes
    logs <run-uuid> [-n 200]           Read saved or live output
    cancel <run-uuid>                 Cancel a run and its remaining steps

  Add --wait to task/workflow to wait for completion (exit 0 for success, 1 otherwise).
  --timeout <seconds> limits waiting only (default 600); expiry does not cancel the run.
  --as <agent> / --session <id> identify the caller. --force overrides an advisory claim.
  All output is JSON. cinderdeck services manages long-running services.
  Definitions remain in ~/.config/cinderdeck/stacks/*.toml; see docs/WORKSPACES.md.
  """
}
