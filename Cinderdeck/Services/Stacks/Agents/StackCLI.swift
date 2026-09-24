import Darwin
import Foundation

/// `cinderdeck services …` — the command-line face of the workspace control API.
/// Runs inside the app binary before any UI starts, so agents in any
/// terminal (Cursor, Codex, Claude Code, …) can manage workspace services.
nonisolated enum StackCLI {
  /// Returns an exit code when the arguments are a CLI invocation, nil to launch the app normally.
  static func runIfRequested(_ arguments: [String]) -> Int32? {
    guard arguments.count > 1 else { return nil }
    switch arguments[1] {
    case "services", "service": return run(Array(arguments.dropFirst(2)))
    case "workspace", "workspaces": return WorkspaceCLI.run(Array(arguments.dropFirst(2)))
    case "prs", "pull-requests": return PRViewsCLI.run(Array(arguments.dropFirst(2)))
    case "repro", "repros": return ReproCLI.run(Array(arguments.dropFirst(2)))
    case "skills", "skill": return StackAgentSkills.run(Array(arguments.dropFirst(2)))
    case "lane", "lanes": return run(["lane"] + arguments.dropFirst(2))
    case "mcp": return CinderdeckMCPServer.run()
    case "help", "--help", "-h":
      guard isCommandName(arguments[0]) else { return nil }
      print(usage); return 0
    default: return nil
    }
  }

  private static func isCommandName(_ argument: String) -> Bool {
    (argument as NSString).lastPathComponent.lowercased() == "cinderdeck"
  }

  // MARK: Options

  struct Options {
    var positionals: [String] = []
    var flags = Set<String>()
    var values: [String: String] = [:]
    var json: Bool { flags.contains("json") }
    func has(_ name: String) -> Bool { flags.contains(name) }
    subscript(name: String) -> String? { values[name] }
  }

  private static let valueFlags: Set<String> = ["timeout", "lines", "n", "grep", "note", "ttl", "repo", "as", "session", "port", "pid", "dir", "dirty", "limit"]

  static func parse(_ arguments: [String]) -> Options {
    var options = Options()
    var index = 0
    while index < arguments.count {
      let argument = arguments[index]
      index += 1
      if argument == "--" { options.positionals += arguments[index...]; break }
      if argument.hasPrefix("-"), argument.count > 1, Int(argument) == nil {
        var name = String(argument.drop(while: { $0 == "-" }))
        var inline: String?
        if let equals = name.firstIndex(of: "=") { inline = String(name[name.index(after: equals)...]); name = String(name[..<equals]) }
        if name == "f" { name = "follow" }
        if valueFlags.contains(name) {
          if let inline { options.values[name] = inline }
          else if index < arguments.count { options.values[name] = arguments[index]; index += 1 }
        } else { options.flags.insert(name) }
      } else { options.positionals.append(argument) }
    }
    if let lines = options.values["n"] { options.values["lines"] = lines }
    return options
  }

  // MARK: Entry

  static func run(_ arguments: [String]) -> Int32 {
    let options = parse(arguments)
    var positionals = options.positionals
    let command = positionals.isEmpty ? "status" : positionals.removeFirst()
    if ["lane", "lanes"].contains(command), options.has("help") || positionals.first == "help" {
      print(usage); return 0
    }
    do {
      switch command {
      case "help", "-h": print(usage)
      case "where", "paths": printPaths(options)
      case "agent-help", "instructions": print(StackAgentGuide.instructions(command: preferredCommandPath()))
      case "install-cli": try installCLI(options)
      case "setup-agents", "setup": try StackAgentSetup.run(options)
      case "validate": try validate(positionals, options)
      default: try remote(command, positionals, options)
      }
      return 0
    } catch let error as StackControlError {
      emitError(error.message, code: error.code, options)
      return error.code == "claimed" ? 3 : 1
    } catch {
      emitError(error.localizedDescription, code: "failed", options)
      return 1
    }
  }

  private static func emitError(_ message: String, code: String, _ options: Options) {
    if options.json {
      let value = JSONValue.object(["error": .object(["code": .string(code), "message": .string(message)])])
      FileHandle.standardError.write(Data((value.prettyString() + "\n").utf8))
    } else {
      FileHandle.standardError.write(Data((paint("error: ", .red) + message + "\n").utf8))
    }
  }

  // MARK: Connection

  static func clientInfo(_ options: Options) -> StackControlClientInfo {
    let environment = ProcessInfo.processInfo.environment
    var name = options["as"] ?? environment["CINDERDECK_AGENT"]
    if name == nil {
      if environment["CLAUDECODE"] == "1" { name = "Claude Code" }
      else if environment.keys.contains(where: { $0.hasPrefix("CODEX_") }) { name = "Codex" }
      else if environment["CURSOR_AGENT"] != nil { name = "Cursor" }
    }
    return StackControlClientInfo(name: name, session: options["session"] ?? environment["CINDERDECK_AGENT_SESSION"],
      cwd: FileManager.default.currentDirectoryPath)
  }

  /// Connects to the running app, launching it in the background if needed.
  static func connect(_ client: StackControlClientInfo, launch: Bool = true) throws -> StackControlConnection {
    let path = StackControlPaths.socket.path
    if let connection = try? StackControlConnection(path: path, client: client) { return connection }
    guard launch, let bundle = appBundlePath() else {
      throw StackControlError(code: "not_running", message: "Cinderdeck is not running and could not be launched. Open Cinderdeck, then try again.")
    }
    let open = Process()
    open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    open.arguments = ["-g", "-j", bundle]
    try? open.run()
    open.waitUntilExit()
    let deadline = Date().addingTimeInterval(20)
    while Date() < deadline {
      if let connection = try? StackControlConnection(path: path, client: client) { return connection }
      usleep(250_000)
    }
    throw StackControlError(code: "not_running", message: "Launched Cinderdeck but its control socket did not appear at \(path).")
  }

  static func executablePath() -> String {
    var buffer = [CChar](repeating: 0, count: 4096)
    if proc_pidpath(getpid(), &buffer, UInt32(buffer.count)) > 0 { return String(cString: buffer) }
    return URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().path
  }

  static func appBundlePath() -> String? {
    let components = executablePath().components(separatedBy: "/")
    guard let index = components.firstIndex(where: { $0.hasSuffix(".app") }) else { return nil }
    return components[...index].joined(separator: "/")
  }

  /// The app bundle this binary belongs to. `Bundle.main` misses it when the binary runs through
  /// the `~/.local/bin` link, because it looks beside the link instead of the real executable.
  static var appBundle: Bundle { appBundlePath().flatMap { Bundle(path: $0) } ?? .main }

  static var installedLink: URL {
    FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/cinderdeck")
  }

  /// The command agents should call: the installed link if it points at this app, else the app's executable.
  static func preferredCommandPath() -> String {
    let link = installedLink
    if let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: link.path),
      URL(fileURLWithPath: destination).resolvingSymlinksInPath().path == URL(fileURLWithPath: executablePath()).resolvingSymlinksInPath().path {
      return link.path
    }
    return executablePath()
  }

  // MARK: Commands

  private static func remote(_ command: String, _ arguments: [String], _ options: Options) throws {
    let connection = try connect(clientInfo(options))
    var params: [String: JSONValue] = [:]
    func workspaceParam(required: Bool = true) throws {
      if let workspace = arguments.first { params["workspace"] = .string(workspace) }
      else if required { throw StackControlError.invalid("Usage: cinderdeck services \(command) <workspace> …") }
    }
    if options.has("force") { params["force"] = .bool(true) }
    let waitTimeout = Double(options["timeout"] ?? "") ?? 180
    switch command {
    case "lane", "lanes":
      try lane(arguments, options, connection: connection)
    case "status", "ls", "list":
      if let stack = arguments.first {
        let result = try connection.call("services.status", ["workspace": .string(stack)])
        if options.json { printJSON(result) } else { printStacks([try result.decode(StackSnapshot.self)], detailed: true) }
      } else {
        let result = try connection.call("snapshot")
        if options.json { printJSON(result); return }
        let snapshot = try result.decode(StacksSnapshot.self)
        if snapshot.workspaces.isEmpty { print("No workspaces yet. Create one in Workspaces, or add TOML files to \(snapshot.workspacesDirectory) — see `cinderdeck services agent-help`.") }
        printStacks(snapshot.workspaces, detailed: snapshot.workspaces.count == 1)
      }
    case "start", "up", "stop", "down", "restart":
      try workspaceParam()
      let services = Array(arguments.dropFirst())
      let method = ["start", "up"].contains(command) ? "services.start" : ["stop", "down"].contains(command) ? "services.stop" : "services.restart"
      if !services.isEmpty {
        if method == "services.restart" { params["service"] = .string(services[0]) }
        else { params["services"] = .array(services.map { JSONValue.string($0) }) }
      }
      params["wait"] = .bool(!options.has("no-wait"))
      params["timeout"] = .number(waitTimeout)
      if options.has("dependents") { params["dependents"] = .bool(true) }
      if !options.json && !options.has("no-wait") {
        FileHandle.standardError.write(Data((paint("… ", .dim) + "\(command) \(arguments.joined(separator: " "))\n").utf8))
      }
      let result = try connection.call(method, params, timeout: waitTimeout + 30)
      if options.json { printJSON(result); return }
      if let stack = try result["workspace"]?.decode(StackSnapshot.self) { printStacks([stack], detailed: true) }
      if result["timedOut"]?.boolValue == true { print(paint("Timed out waiting; services are still starting.", .yellow)) }
      if let problems = result["problems"]?.objectValue {
        for (service, problem) in problems.sorted(by: { $0.key < $1.key }) {
          print(paint("\n\(service): \(problem["status"]?.stringValue ?? "") \(problem["detail"]?.stringValue ?? "")", .red))
          for line in problem["lastLines"]?.arrayValue ?? [] { print("  " + (line.stringValue ?? "")) }
        }
        throw StackControlError(code: "service_failed", message: "One or more services are not healthy")
      }
    case "logs", "log":
      try workspaceParam()
      if arguments.count > 1 { params["service"] = .string(arguments[1]) }
      params["lines"] = .number(Double(options["lines"] ?? "") ?? (options.has("follow") ? 50 : 200))
      if let grep = options["grep"] { params["grep"] = .string(grep) }
      var result = try connection.call("logs", params)
      var cursor = result["cursor"]?.doubleValue
      if options.json && !options.has("follow") { printJSON(result); return }
      printLogLines(result, json: options.json, showService: arguments.count < 2)
      guard options.has("follow") else { return }
      while true {
        usleep(700_000)
        if let cursor { params["after"] = .number(cursor) }
        params["lines"] = .number(5000)
        result = try connection.call("logs", params)
        cursor = result["cursor"]?.doubleValue ?? cursor
        printLogLines(result, json: options.json, showService: arguments.count < 2)
      }
    case "ports":
      if let port = arguments.first.flatMap(Int.init) ?? options["port"].flatMap(Int.init) { params["port"] = .number(Double(port)) }
      if options.has("external") { params["external"] = .bool(true) }
      if options.has("managed") { params["managed"] = .bool(true) }
      let result = try connection.call("ports", params, timeout: 30)
      if options.json { printJSON(result) } else { printPorts(try result.decode([StackPortListener].self)) }
    case "kill-port":
      guard let port = arguments.first.flatMap(Int.init), let pid = (arguments.dropFirst().first ?? options["pid"]).flatMap(Int.init) else {
        throw StackControlError.invalid("Usage: cinderdeck services kill-port <port> <pid>   (see `cinderdeck services ports`)")
      }
      let result = try connection.call("port.kill", ["port": .number(Double(port)), "pid": .number(Double(pid))], timeout: 30)
      if options.json { printJSON(result) } else { print("Stopped \(result["process"]?.stringValue ?? "process") (PID \(pid)) on port \(port).") }
    case "git":
      try workspaceParam()
      let result = try connection.call("git.status", params, timeout: 90)
      if options.json { printJSON(result) } else { printRepos(try result.decode([StackRepoSnapshot].self)) }
    case "branches":
      try workspaceParam()
      if let repo = options["repo"] ?? arguments.dropFirst().first { params["repo"] = .string(repo) }
      let result = try connection.call("git.branches", params, timeout: 90)
      if options.json { printJSON(result); return }
      for (repo, info) in (result.objectValue ?? [:]).sorted(by: { $0.key < $1.key }) {
        print(paint(repo, .bold) + "  on " + paint(info["current"]?.stringValue ?? "?", .cyan))
        let recent = (info["recent"]?.arrayValue ?? []).compactMap(\.stringValue)
        if !recent.isEmpty { print("  recent: " + recent.joined(separator: ", ")) }
        print("  local:  " + (info["local"]?.arrayValue ?? []).compactMap(\.stringValue).joined(separator: ", "))
        let remote = (info["remote"]?.arrayValue ?? []).compactMap(\.stringValue)
        if !remote.isEmpty { print("  remote: " + remote.prefix(30).joined(separator: ", ") + (remote.count > 30 ? " …" : "")) }
      }
    case "switch", "checkout":
      guard arguments.count >= 2 else { throw StackControlError.invalid("Usage: cinderdeck services switch <workspace> <branch> [--repo id] [--stash|--carry]") }
      params["workspace"] = .string(arguments[0]); params["branch"] = .string(arguments[1])
      if let repo = options["repo"] { params["repo"] = .string(repo) }
      params["dirty"] = .string(options["dirty"] ?? (options.has("stash") ? "stash" : options.has("carry") ? "carry" : "fail"))
      let result = try connection.call("git.switch", params, timeout: 300)
      if options.json { printJSON(result); return }
      for line in result["switched"]?.arrayValue ?? [] { print(paint("✓ ", .green) + (line.stringValue ?? "")) }
      for line in result["skipped"]?.arrayValue ?? [] { print(paint("– skipped ", .dim) + (line.stringValue ?? "")) }
    case "fetch", "pull":
      try workspaceParam()
      if let repo = options["repo"] ?? arguments.dropFirst().first { params["repo"] = .string(repo) }
      let result = try connection.call(command == "pull" ? "git.pull" : "git.fetch", params, timeout: 300)
      if options.json { printJSON(result) } else { printRepos(try (result["repos"] ?? .array([])).decode([StackRepoSnapshot].self)) }
    case "claim":
      try workspaceParam()
      if let note = options["note"] ?? (arguments.count > 1 ? arguments.dropFirst().joined(separator: " ") : nil) { params["note"] = .string(note) }
      if let ttl = options["ttl"].flatMap(Double.init) { params["ttlMinutes"] = .number(ttl) }
      let result = try connection.call("claim", params)
      if options.json { printJSON(result); return }
      let claim = try result.decode(StackClaim.self)
      print("Claimed \(claim.stackID) as \(claim.holder.label) until \(timeString(claim.expiresAt)).")
    case "release":
      try workspaceParam()
      let result = try connection.call("release", params)
      if options.json { printJSON(result) } else { print("Released \(result["released"]?.stringValue ?? "workspace").") }
    case "events", "activity":
      try workspaceParam()
      if let limit = options["limit"] ?? options["lines"] { params["limit"] = .number(Double(limit) ?? 40) }
      let result = try connection.call("events", params)
      if options.json { printJSON(result); return }
      for event in (result.arrayValue ?? []).reversed() {
        let at = event["at"]?.stringValue.flatMap { ISO8601DateFormatter().date(from: $0) }
        let parts = [event["service"]?.stringValue, event["kind"]?.stringValue, event["detail"]?.stringValue].compactMap { $0 }
        let when: String = at.map { timeString($0) } ?? ""
        let by: String = event["by"]?.stringValue.map { paint("  by " + $0, .dim) } ?? ""
        print(paint(when, .dim) + "  " + parts.joined(separator: " · ") + by)
      }
    case "reload":
      _ = try connection.call("reload")
      print("Reloaded workspace definitions.")
    case "ping":
      let result = try connection.call("ping")
      if options.json { printJSON(result) } else { print("Cinderdeck is running (PID \(result["pid"]?.stringValue ?? "?")). You are \(result["you"]?.stringValue ?? "?").") }
    default:
      throw StackControlError.invalid("Unknown command \"\(command)\".\n\n" + usage)
    }
  }

  private static func validate(_ arguments: [String], _ options: Options) throws {
    guard let path = arguments.first else { throw StackControlError.invalid("Usage: cinderdeck services validate <file.toml>") }
    let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    let source: String
    do { source = try String(contentsOf: url, encoding: .utf8) } catch { throw StackControlError.notFound("Cannot read \(url.path)") }
    let file = StackDefinitionLoader.load(source, file: url)
    let errors = file.issues.filter { $0.severity == .error }
    if options.json {
      printJSON(.object([
        "valid": .bool(file.definition != nil && errors.isEmpty),
        "issues": .array(file.issues.map { .string("\($0.severity.rawValue): \($0.message)") }),
        "services": .array((file.definition?.services ?? []).map { .string($0.id) }),
      ]))
    } else {
      for issue in file.issues { print(paint(issue.severity == .error ? "error: " : "warning: ", issue.severity == .error ? .red : .yellow) + issue.message) }
      if let definition = file.definition, errors.isEmpty {
        let order = ((try? definition.dependencyLayers()) ?? []).map { $0.joined(separator: " + ") }.joined(separator: " → ")
        print(paint("✓ ", .green) + "\(definition.name): \(definition.services.count) services, \(definition.tasks.count) tasks, \(definition.workflows.count) workflows, start order \(order)")
      }
    }
    if file.definition == nil || !errors.isEmpty { throw StackControlError(code: "invalid_definition", message: "\(url.lastPathComponent) is not valid") }
  }

  private static func lane(_ arguments: [String], _ options: Options, connection: StackControlConnection) throws {
    let command = arguments.first ?? "list"
    if options.has("help") || command == "help" { print(usage); return }
    let args = Array(arguments.dropFirst())
    var params: [String: JSONValue] = [:]
    if options.has("force") { params["force"] = .bool(true) }
    switch command {
    case "list", "ls", "status":
      if let source = args.first { params["workspace"] = .string(source) }
      let result = try connection.call("lane.list", params)
      if options.json { printJSON(result) }
      else { printStacks(try result.decode([StackSnapshot].self), detailed: true) }
    case "create":
      guard args.count == 2 else { throw StackControlError.invalid("Usage: cinderdeck lane create <workspace> <branch> [--no-start] [--no-wait]") }
      params["workspace"] = .string(args[0]); params["branch"] = .string(args[1])
      params["start"] = .bool(!options.has("no-start")); params["wait"] = .bool(!options.has("no-wait"))
      let timeout = min(max(Double(options["timeout"] ?? "") ?? 180, 1), 900)
      params["timeout"] = .number(timeout)
      let result = try connection.call("lane.create", params, timeout: timeout + 300)
      if options.json { printJSON(result) }
      else if let snapshot = try result["workspace"]?.decode(StackSnapshot.self) {
        printStacks([snapshot], detailed: true)
        if let lane = snapshot.lane {
          print("Lane: \(lane.reference)\nWorktrees: \(lane.directory.path)")
          print("Use `cinderdeck services logs|stop|restart \(lane.reference)` to manage this lane.")
        }
      }
      if result["problems"] != nil { throw StackControlError(code: "service_failed", message: "Lane created, but one or more services failed. Inspect its logs, then restart the lane.") }
      if result["timedOut"]?.boolValue == true { throw StackControlError(code: "timeout", message: "Lane created; still waiting for readiness. Inspect lane status.") }
    case "remove", "rm":
      guard args.count == 1 || args.count == 2 else { throw StackControlError.invalid("Usage: cinderdeck lane remove <workspace>/<branch> (or <workspace> <branch>)") }
      params["workspace"] = .string(args.joined(separator: "/"))
      let result = try connection.call("lane.remove", params, timeout: 300)
      if options.json { printJSON(result) } else { print("Removed lane worktrees. Git branches were kept.") }
    default: throw StackControlError.invalid("Unknown lane command. Use create, list or remove.")
    }
  }

  private static func printPaths(_ options: Options) {
    let values: [(String, String)] = [
      ("command", preferredCommandPath()), ("app", appBundlePath() ?? "?"),
      ("socket", StackControlPaths.socket.path), ("state", StackControlPaths.state.path),
      ("workspaces", StackDefinitionLoader.directory().path),
      ("logs", FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Cinderdeck/Stacks").path),
    ]
    if options.json { printJSON(.object(Dictionary(uniqueKeysWithValues: values.map { ($0.0, JSONValue.string($0.1)) }))); return }
    for (name, value) in values { print(paint(name.padding(toLength: 11, withPad: " ", startingAt: 0), .dim) + value) }
  }

  /// Links `<directory>/cinderdeck` to this app's executable. Returns the link.
  @discardableResult
  static func install(in directory: URL = StackCLI.installedLink.deletingLastPathComponent()) throws -> URL {
    let link = directory.appendingPathComponent("cinderdeck")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if (try? FileManager.default.destinationOfSymbolicLink(atPath: link.path)) != nil { try FileManager.default.removeItem(at: link) }
    else if FileManager.default.fileExists(atPath: link.path) { throw StackControlError.invalid("\(link.path) exists and is not a symlink; remove it first") }
    try FileManager.default.createSymbolicLink(atPath: link.path, withDestinationPath: executablePath())
    return link
  }

  static var isInstalled: Bool { preferredCommandPath() == installedLink.path }

  private static func installCLI(_ options: Options) throws {
    let directory = URL(fileURLWithPath: ((options["dir"] ?? "~/.local/bin") as NSString).expandingTildeInPath, isDirectory: true)
    let link = try install(in: directory)
    print(paint("✓ ", .green) + "Installed \(link.path) → \(executablePath())")
    let path = ProcessInfo.processInfo.environment["PATH"] ?? ""
    if !path.split(separator: ":").contains(where: { URL(fileURLWithPath: String($0)).standardizedFileURL == directory.standardizedFileURL }) {
      print(paint("Add \(directory.path) to your PATH, e.g. in ~/.zshrc:  export PATH=\"\(directory.path):$PATH\"", .yellow))
    }
  }

  // MARK: Printing

  enum Color: String { case red = "31", green = "32", yellow = "33", blue = "34", cyan = "36", dim = "2", bold = "1" }
  static let useColor = isatty(STDOUT_FILENO) == 1 && ProcessInfo.processInfo.environment["NO_COLOR"] == nil
  static func paint(_ text: String, _ color: Color) -> String { useColor ? "\u{1B}[\(color.rawValue)m\(text)\u{1B}[0m" : text }

  static func printJSON(_ value: JSONValue) { print(value.prettyString()) }

  private static func dot(_ phase: String) -> String {
    switch phase {
    case "ready": return paint("●", .green)
    case "starting", "waiting", "stopping": return paint("◐", .yellow)
    case "unhealthy": return paint("▲", .yellow)
    case "crashed": return paint("✕", .red)
    default: return paint("○", .dim)
    }
  }

  static func age(_ date: Date?) -> String {
    guard let date else { return "" }
    let seconds = Int(Date().timeIntervalSince(date))
    if seconds < 60 { return "\(seconds)s" }
    if seconds < 3600 { return "\(seconds / 60)m" }
    if seconds < 86400 { return "\(seconds / 3600)h\(seconds % 3600 / 60)m" }
    return "\(seconds / 86400)d"
  }

  static func timeString(_ date: Date) -> String { DateFormatter.localizedString(from: date, dateStyle: .none, timeStyle: .short) }

  private static func pad(_ text: String, _ width: Int) -> String {
    text.count >= width ? text + " " : text + String(repeating: " ", count: width - text.count)
  }

  static func printStacks(_ stacks: [StackSnapshot], detailed: Bool) {
    for (index, stack) in stacks.enumerated() {
      if index > 0 { print("") }
      let started = stack.services.compactMap(\.startedAt).min()
      var header = paint(stack.name, .bold) + paint("  (\(stack.id))", .dim) + "  " + stack.state
      if let lane = stack.lane { header += "  lane " + lane.reference + " · " + lane.owner.label }
      if let started { header += paint("  up " + age(started), .dim) }
      if let operation = stack.operation { header += paint("  " + operation + "…", .yellow) }
      print(header)
      if let claim = stack.claim {
        let note: String = claim.note.map { " — " + $0 } ?? ""
        let until: String = paint("  until " + timeString(claim.expiresAt), .dim)
        print("  " + paint("⚑ claimed by " + claim.holder.label, .cyan) + note + until)
      }
      for issue in stack.issues { print("  " + paint(issue, .yellow)) }
      if stack.definitionChanged { print("  " + paint("definition changed — restart to apply", .yellow)) }
      let width = max(8, (stack.services.map(\.name.count).max() ?? 0) + 2)
      for service in stack.services {
        var line = "  " + dot(service.phase) + " " + pad(service.name, width) + pad(service.status, 18)
        line += pad(service.port.map { ":\($0)" } ?? "", 8)
        line += pad(service.pid.map { "pid \($0)" } ?? "", 11)
        if let branch = service.branch { line += paint("⎇ " + branch + " ", .cyan) }
        if let started = service.startedAt { line += paint("up " + age(started) + " ", .dim) }
        if let owner = service.owner, service.pid != nil { line += paint("by " + owner.label, .dim) }
        print(line)
        if detailed, let detail = service.detail, !detail.isEmpty { print("      " + paint(detail, service.phase == "crashed" ? .red : .dim)) }
      }
      if detailed {
        for repo in stack.repos {
          var line = "  " + paint("⎇", .cyan) + " " + pad(repo.id, width) + paint(repo.branch, .cyan)
          if repo.dirty { line += paint("  \(repo.changedFiles) changed", .yellow) }
          if repo.ahead > 0 { line += "  ↑\(repo.ahead)" }
          if repo.behind > 0 { line += "  ↓\(repo.behind)" }
          if let problem = repo.operation ?? repo.error { line += paint("  " + problem, .red) }
          print(line)
        }
      }
    }
  }

  private static func printRepos(_ repos: [StackRepoSnapshot]) {
    for repo in repos {
      let upstream: String = repo.upstream.map { paint("  → " + $0, .dim) } ?? ""
      var line = pad(repo.id, 16) + paint(repo.branch, .cyan) + upstream
      line += repo.dirty ? paint("  \(repo.changedFiles) changed", .yellow) : paint("  clean", .dim)
      if repo.ahead > 0 { line += "  ↑\(repo.ahead)" }
      if repo.behind > 0 { line += "  ↓\(repo.behind)" }
      if let problem = repo.operation ?? repo.error { line += paint("  " + problem, .red) }
      print(line)
    }
  }

  private static func printLogLines(_ result: JSONValue, json: Bool, showService: Bool) {
    for line in result["lines"]?.arrayValue ?? [] {
      if json { print(line.prettyString().replacingOccurrences(of: "\n", with: "")); continue }
      let text = line["text"]?.stringValue ?? ""
      print(showService ? paint((line["service"]?.stringValue ?? "") + " | ", .blue) + text : text)
    }
    fflush(stdout)
  }

  private static func printPorts(_ listeners: [StackPortListener]) {
    guard !listeners.isEmpty else { print("No TCP listeners."); return }
    print(paint(pad("PORT", 7) + pad("PID", 8) + pad("PROCESS", 16) + pad("OWNER", 34) + "CWD", .dim))
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    for listener in listeners {
      let owner: String
      if let managed = listener.managed { owner = paint("Cinderdeck · \(managed.stackName)/\(managed.service)", .green) }
      else { owner = (listener.launchedFrom ?? "unknown") + (listener.tty.map { " (\($0))" } ?? "") }
      let cwd = listener.cwd.map { $0.hasPrefix(home) ? "~" + $0.dropFirst(home.count) : $0 } ?? ""
      let ownerWidth = listener.managed == nil ? 34 : 34 + (useColor ? 9 : 0)
      print(pad(String(listener.port), 7) + pad(String(listener.pid), 8) + pad(listener.process, 16) + pad(owner, ownerWidth) + cwd)
    }
  }

  static let usage = """
  cinderdeck services — manage Cinderdeck workspace services from any terminal or agent

  USAGE
    cinderdeck services [status] [workspace]          Workspaces, services, ports, owners, branches
    cinderdeck services start <workspace> [service…]  Start in dependency order; waits until ready
    cinderdeck services stop <workspace> [service…]
    cinderdeck services restart <workspace> [service] --dependents also restarts dependents
    cinderdeck services logs <workspace> [service]    -n 200  --grep <regex>  -f (follow)
    cinderdeck services ports [port]                  Who owns each listening port (--external)
    cinderdeck services kill-port <port> <pid>        Stop a stray non-Cinderdeck listener
    cinderdeck services git <workspace>               Branch, dirty state, ahead/behind per repo
    cinderdeck services branches <workspace> [repo]
    cinderdeck services switch <workspace> <branch>   --repo <id>  --stash | --carry
    cinderdeck services fetch|pull <workspace> [repo]
    cinderdeck services claim <workspace> [note]      --ttl <minutes> (default 30); advisory lock
    cinderdeck services release <workspace>
    cinderdeck services events <workspace>            Recent activity and who caused it
    cinderdeck services validate <file.toml>          Check a workspace definition
    cinderdeck services reload | where | ping
    cinderdeck services install-cli                   Link ~/.local/bin/cinderdeck to this app
    cinderdeck services setup-agents                  Add the Cinderdeck MCP server to Cursor, Codex, Claude Code, VS Code Copilot
                                                      (--skills also installs the agent skills)
    cinderdeck services agent-help                    Instructions to paste into AGENTS.md

  WORKTREE LANES
    cinderdeck lane create <workspace> <branch>       Create and start an isolated worktree lane
    cinderdeck lane list [workspace]                  Original checkout and parallel lanes
    cinderdeck lane remove <workspace>/<branch>       Stop and remove clean worktrees; keep branches
    --no-start                                        Create only, for dependency setup before starting
    Use services status|logs|start|stop|restart <workspace>/<branch> to manage a lane.

  MORE
    cinderdeck workspace --help                       Tasks, workflows, and runs
    cinderdeck repro --help                           Screen recordings with synced logs
    cinderdeck prs views                              Configure Pull Request tabs (prs --help)
    cinderdeck skills [list|install]                  Agent skills that ship with Cinderdeck
    cinderdeck mcp                                    Run as an MCP server over stdio

  OPTIONS
    --json          Machine-readable output        --no-wait     Don't wait for readiness
    --timeout <s>   Wait limit (default 180)       --force       Override another agent's claim
    --as <name>     Name to show as the actor      --session <id> Distinguish parallel agents
  """
}
