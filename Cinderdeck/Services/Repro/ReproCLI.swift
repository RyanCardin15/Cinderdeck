import Foundation

/// `cinderdeck repro …` — record the screen with synchronized workspace output.
nonisolated enum ReproCLI {
  struct Options: Equatable {
    var positionals: [String] = []
    var values: [String: String] = [:]
    var flags = Set<String>()
    func has(_ name: String) -> Bool { flags.contains(name) }
    subscript(name: String) -> String? { values[name] }
    var json: Bool { has("json") }
  }

  static let valued: Set<String> = ["title", "workspace", "window", "display", "max", "note", "detail", "outcome", "from", "to",
    "around", "span", "source", "level", "grep", "lines", "n", "at", "marker", "size", "dest", "out", "timeout", "limit",
    "as", "session", "window-id", "repro"]
  static let booleans: Set<String> = ["audio", "wait", "json", "zip", "no-video", "pass", "fail", "force", "first-error", "help",
    "task", "workflow", "path", "no-logs"]

  static func parse(_ arguments: [String]) throws -> Options {
    var options = Options()
    var index = 0
    while index < arguments.count {
      let argument = arguments[index]; index += 1
      if argument == "--" { options.positionals += arguments[index...]; break }
      guard argument.hasPrefix("-"), argument.count > 1, Double(argument) == nil else { options.positionals.append(argument); continue }
      var name = String(argument.drop(while: { $0 == "-" }))
      var inline: String?
      if let equals = name.firstIndex(of: "=") { inline = String(name[name.index(after: equals)...]); name = String(name[..<equals]) }
      if name == "h" { name = "help" }
      if valued.contains(name) {
        if let inline { options.values[name] = inline; continue }
        guard index < arguments.count else { throw StackControlError.invalid("--\(name) requires a value") }
        options.values[name] = arguments[index]; index += 1
      } else if booleans.contains(name) {
        guard inline == nil else { throw StackControlError.invalid("--\(name) does not take a value") }
        options.flags.insert(name)
      } else {
        throw StackControlError.invalid("Unknown option \(argument). See cinderdeck repro --help")
      }
    }
    if let lines = options.values["n"] { options.values["lines"] = lines }
    return options
  }

  static func number(_ options: Options, _ name: String) throws -> JSONValue? {
    guard let raw = options[name] else { return nil }
    guard let value = Double(raw), value.isFinite, value >= 0 else { throw StackControlError.invalid("--\(name) must be a number") }
    return .number(value)
  }

  /// Maps a command line to a control method, parameters, and a response timeout.
  static func request(_ options: Options) throws -> (method: String, params: [String: JSONValue], timeout: TimeInterval) {
    var args = options.positionals
    let command = args.isEmpty ? "status" : args.removeFirst()
    var params: [String: JSONValue] = [:]
    func take(_ key: String, _ name: String? = nil) { if let value = options[name ?? key] { params[key] = .string(value) } }
    func repro() { if let first = args.first { params["repro"] = .string(first) } }
    func noExtra(_ allowed: Int, _ usage: String) throws { guard args.count <= allowed else { throw StackControlError.invalid("Use: cinderdeck repro \(usage)") } }
    if options.has("force") { params["force"] = .bool(true) }
    switch command {
    case "start", "record":
      try noExtra(0, "start [--title T] [--workspace W[,W…] | --no-logs] [--window APP | --window-id ID | --display N] [--max SECONDS]")
      take("title"); take("window"); take("display"); take("note")
      if let workspace = options["workspace"] {
        let names = workspace.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        if names.count > 1 { params["workspaces"] = .array(names.map { .string($0) }) } else { params["workspace"] = .string(workspace) }
      }
      if options.has("no-logs") {
        guard options["workspace"] == nil else { throw StackControlError.invalid("Pass --workspace or --no-logs, not both") }
        params["logs"] = .bool(false)
      }
      if let id = options["window-id"] {
        guard let value = Int(id), value > 0 else { throw StackControlError.invalid("--window-id must be a window id from `cinderdeck repro windows`") }
        params["window_id"] = .number(Double(value))
      }
      if let max = try number(options, "max") { params["max_seconds"] = max }
      if options.has("audio") { params["system_audio"] = .bool(true) }
      return ("repro.start", params, 90)
    case "run", "test":
      guard args.count == 2 else { throw StackControlError.invalid("Use: cinderdeck repro run <workspace> <task-id> (or <workflow-id> --workflow)") }
      params["workspace"] = .string(args[0])
      params[options.has("workflow") ? "workflow" : "task"] = .string(args[1])
      take("title"); take("window"); take("display"); take("note")
      if let max = try number(options, "max") { params["max_seconds"] = max }
      return ("repro.start", params, 90)
    case "windows":
      try noExtra(1, "windows [text]")
      if let first = args.first { params["query"] = .string(first) }
      return ("repro.windows", params, 30)
    case "append", "add":
      try noExtra(1, "append \"<text>\" [--source NAME] [--level error]   (or pipe lines: … | cinderdeck repro append --source NAME)")
      if let first = args.first, first != "-" { params["text"] = .string(first) }
      params["source"] = .string(options["source"] ?? "agent")
      take("level"); take("repro")
      return ("repro.log", params, 30)
    case "stop":
      try noExtra(1, "stop [repro]"); repro(); return ("repro.stop", params, 240)
    case "cancel", "discard":
      try noExtra(0, "cancel"); return ("repro.cancel", params, 60)
    case "status":
      try noExtra(0, "status"); return ("repro.status", params, 30)
    case "mark", "check", "step":
      guard args.count == 1 else { throw StackControlError.invalid("Use: cinderdeck repro mark \"<label>\" [--pass|--fail] [--detail TEXT]") }
      params["label"] = .string(args[0]); take("detail"); take("repro")
      if options.has("pass") { params["outcome"] = .string("pass") }
      if options.has("fail") { params["outcome"] = .string("fail") }
      take("outcome")
      return ("repro.mark", params, 30)
    case "list", "ls":
      try noExtra(1, "list [workspace]")
      if let first = args.first { params["workspace"] = .string(first) }
      if let limit = try number(options, "limit") { params["limit"] = limit }
      return ("repro.list", params, 30)
    case "show", "summary":
      try noExtra(1, "show [repro]"); repro(); return ("repro.get", params, 60)
    case "wait":
      try noExtra(1, "wait [repro] [--timeout SECONDS]"); repro()
      let timeout = try number(options, "timeout")?.doubleValue ?? 600
      params["timeout"] = .number(timeout)
      return ("repro.wait", params, timeout + 60)
    case "logs", "log":
      try noExtra(1, "logs [repro] [--around T] [--from T] [--to T] [--level error] [--source api] [--grep TEXT]"); repro()
      take("around"); take("from"); take("to"); take("grep"); take("level")
      if let span = try number(options, "span") { params["window"] = span }
      if let lines = try number(options, "lines") { params["lines"] = lines }
      if let source = options["source"] { params["source"] = .array(source.split(separator: ",").map { .string(String($0)) }) }
      return ("repro.logs", params, 60)
    case "frame", "frames":
      try noExtra(1, "frame [repro] [--at T[,T…] | --marker LABEL | --first-error] [--out FILE]"); repro()
      if let at = options["at"] {
        let times = at.split(separator: ",").map { JSONValue.string(String($0)) }
        params["times"] = .array(times)
      }
      take("marker")
      if options.has("first-error") { params["at"] = .string("first_error") }
      if let size = try number(options, "size") { params["max_size"] = size }
      if let span = try number(options, "span") { params["window"] = span }
      return ("repro.frame", params, 120)
    case "export":
      try noExtra(1, "export [repro] [--dest FOLDER] [--zip] [--no-video]"); repro()
      if let destination = options["dest"] ?? options["out"] { params["destination"] = .string(destination) }
      if options.has("zip") { params["zip"] = .bool(true) }
      if options.has("no-video") { params["video"] = .bool(false) }
      return ("repro.export", params, 600)
    case "open":
      try noExtra(1, "open [repro]"); repro(); return ("repro.open", params, 30)
    case "dump":
      try noExtra(1, "dump [repro] [--path]"); repro(); return ("repro.dump", params, 60)
    case "scope":
      if let first = args.first {
        switch first.lowercased() {
        case "running", "all", "auto", "off", "none": params["mode"] = .string(first.lowercased())
        default: params["mode"] = .string("selected"); params["workspaces"] = .array(args.map { .string($0) })
        }
      }
      return ("repro.scope", params, 30)
    case "delete", "rm":
      guard args.count == 1 else { throw StackControlError.invalid("Use: cinderdeck repro delete <repro-id>") }
      repro(); return ("repro.delete", params, 60)
    default:
      throw StackControlError.invalid("Unknown command \"\(command)\". See cinderdeck repro --help")
    }
  }

  static func run(_ arguments: [String]) -> Int32 {
    if arguments.first == "help" || arguments.contains("--help") || arguments.contains("-h") { print(usage); return 0 }
    do {
      let options = try parse(arguments)
      let request = try request(options)
      let connection = try StackCLI.connect(clientInfo(options))
      if request.method == "repro.log", request.params["text"] == nil {
        return try appendStandardInput(connection, params: request.params, options: options)
      }
      let result = try connection.call(request.method, request.params, timeout: request.timeout)
      let command = options.positionals.first ?? "status"
      if options.has("wait"), ["run", "test", "start", "record"].contains(command), let id = result["repro"]?.stringValue {
        FileHandle.standardError.write(Data("Recording \(id)… waiting for it to finish\n".utf8))
        let timeout = Double(options["timeout"] ?? "1800") ?? 1800
        let final = try connection.call("repro.wait", ["repro": .string(id), "timeout": .number(timeout)], timeout: timeout + 60)
        return finish(final, options: options)
      }
      switch request.method {
      case "repro.logs" where !options.json:
        let lines = result["lines"]?.arrayValue ?? []
        for line in lines { print(text(line)) }
        if lines.isEmpty { FileHandle.standardError.write(Data("(no matching output)\n".utf8)) }
      case "repro.frame":
        var frames = result["frames"]?.arrayValue ?? []
        if let out = options["out"], frames.count == 1, let path = frames[0]["path"]?.stringValue {
          let destination = URL(fileURLWithPath: (out as NSString).expandingTildeInPath)
          try? FileManager.default.removeItem(at: destination)
          try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: destination)
          frames[0] = .object((frames[0].objectValue ?? [:]).merging(["path": .string(destination.path)]) { $1 })
        }
        // Image data is for MCP clients; the CLI prints file paths.
        let trimmed = frames.map { JSONValue.object(($0.objectValue ?? [:]).filter { $0.key != "imageBase64" }) }
        print(JSONValue.object(["repro": result["repro"] ?? .null, "frames": .array(trimmed)]).prettyString())
      case "repro.stop", "repro.wait":
        return finish(result, options: options)
      case "repro.dump" where !options.json:
        guard let path = result["path"]?.stringValue else { throw StackControlError.notFound("No log file") }
        if options.has("path") { print(path); return 0 }
        guard let handle = FileHandle(forReadingAtPath: path) else { throw StackControlError.notFound("Cannot read \(path)") }
        defer { try? handle.close() }
        // Stream large logs instead of loading them whole.
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { FileHandle.standardOutput.write(chunk) }
      case "repro.scope" where !options.json:
        print(result["summary"]?.stringValue.map { "Toolbar recordings save logs from: \($0)" } ?? result.prettyString())
      default:
        print(result.prettyString())
      }
      return 0
    } catch {
      let error = error as? StackControlError ?? .init(code: "failed", message: error.localizedDescription)
      FileHandle.standardError.write(Data((JSONValue.object(["error": .object(["code": .string(error.code), "message": .string(error.message)])]).prettyString() + "\n").utf8))
      return error.code == "claimed" ? 3 : 1
    }
  }

  /// Streams standard input into the recording, stamping each line when it is read, until
  /// input ends or the recording stops. For example: `tail -F app.log | cinderdeck repro append --source app`.
  private static func appendStandardInput(_ connection: StackControlConnection, params: [String: JSONValue], options: Options) throws -> Int32 {
    // A reader thread stamps lines as they arrive; this loop sends them every 0.2 s, so a
    // quiet stream never holds lines back.
    final class Inbox: @unchecked Sendable {
      let lock = NSLock()
      var lines: [JSONValue] = []
      var finished = false
    }
    let inbox = Inbox()
    Thread.detachNewThread {
      while let line = Swift.readLine(strippingNewline: true) {
        let entry = JSONValue.object(["text": .string(line), "at": .number(Date().timeIntervalSince1970)])
        inbox.lock.lock(); inbox.lines.append(entry); inbox.lock.unlock()
      }
      inbox.lock.lock(); inbox.finished = true; inbox.lock.unlock()
    }
    var total = 0
    var params = params
    var stopped = false
    while !stopped {
      inbox.lock.lock()
      let pending = inbox.lines, finished = inbox.finished
      inbox.lines.removeAll(keepingCapacity: true)
      inbox.lock.unlock()
      for start in stride(from: 0, to: pending.count, by: ReproRecorder.externalBatchLimit) {
        var request = params
        request["lines"] = .array(Array(pending[start..<min(start + ReproRecorder.externalBatchLimit, pending.count)]))
        let result = try connection.call("repro.log", request, timeout: 30)
        total += result["added"]?.intValue ?? 0
        // Stay with this recording, and stop once it has: lines read up to then are still
        // added to its saved log with the time they were read.
        if params["repro"] == nil, let id = result["repro"]?.stringValue, !id.isEmpty { params["repro"] = .string(id) }
        if result["late"]?.boolValue == true { stopped = true }
      }
      if finished { break }
      if !stopped { Thread.sleep(forTimeInterval: 0.2) }
    }
    if options.json { print(JSONValue.object(["added": .number(Double(total)), "stopped": .bool(stopped)]).prettyString()) }
    else {
      let note = stopped ? "; the recording stopped, so later input was not read" : ""
      FileHandle.standardError.write(Data("Added \(total) line\(total == 1 ? "" : "s")\(note)\n".utf8))
    }
    return 0
  }

  /// Prints the result and exits 0 for clean or error-only repros, 1 when something failed.
  private static func finish(_ result: JSONValue, options: Options) -> Int32 {
    print(result.prettyString())
    if let headline = result["headline"]?.stringValue, !options.json {
      FileHandle.standardError.write(Data("\(result["verdict"]?.stringValue ?? "done"): \(headline)\n".utf8))
    }
    return result["verdict"]?.stringValue == "failed" ? 1 : 0
  }

  private static func text(_ line: JSONValue) -> String {
    let level = line["level"]?.stringValue ?? "info"
    let time = line["time"]?.stringValue ?? ""
    let source = line["source"]?.stringValue ?? ""
    let body = line["text"]?.stringValue ?? ""
    let prefix = "[\(time)] \(source) | "
    switch level {
    case "error": return StackCLI.paint(prefix, .red) + body
    case "warning": return StackCLI.paint(prefix, .yellow) + body
    default: return StackCLI.paint(prefix, .dim) + body
    }
  }

  private static func clientInfo(_ options: Options) -> StackControlClientInfo {
    var stackOptions = StackCLI.Options()
    if let name = options["as"] { stackOptions.values["as"] = name }
    if let session = options["session"] { stackOptions.values["session"] = session }
    return StackCLI.clientInfo(stackOptions)
  }

  static let usage = """
  cinderdeck repro — screen recordings with workspace output on the same timeline

    start [--title T] [--workspace W[,W…]] Record the main display (or --window APP|TITLE,
          [--max SECONDS] [--note TEXT]      --window-id ID, --display N); stops after --max (default 300)
          [--no-logs]                      Plain video: no workspace output (agent lines and marks still kept)
    windows [text]                         Windows you can record, frontmost first, with ids and titles
    run <workspace> <task> [--workflow]    Record while a task (or workflow) runs; stops after it ends
    mark "<label>" [--pass|--fail]         Add a step marker or a check result at this moment
    append "<text>" [--source NAME]        Add your own output (e.g. a browser console) to the log; pipe
           [--level error] [--repro ID]      lines on stdin to stream them until input ends or the
                                             recording stops. Right after a stop, lines go to the saved log
    stop [repro]                           Stop and save; prints verdict, errors, and markers
    cancel                                 Stop and discard the recording
    status                                 What is recording now
    wait [repro] [--timeout S]             Wait for a recording (e.g. a run) to finish
    list [workspace]                       Recent repros with verdicts
    show [repro]                           Full summary: errors, markers, runs, Git state
    logs [repro] [--around T] [--span S]   Output on the video timeline; also --from, --to,
         [--level error] [--source api]      --grep TEXT, -n LINES, --json
    frame [repro] [--at T,T…|--marker L]   Save video frames (default: first error) with nearby output
          [--first-error] [--out FILE]
    export [repro] [--dest DIR] [--zip]    Shareable folder: video, README, log file, diffs
    dump [repro] [--path]                  Print the recording's .log file (or just its path)
    scope [running|off|<workspace>…]       Show or set which workspaces toolbar recordings capture
    open [repro]                           Open in the video editor with synced logs
    delete <repro-id>                      Delete a saved repro

  Times are seconds or mm:ss.sss on the video, or first_error, last_error, end, marker:<label>.
  repro defaults to the latest; ids may be shortened to a unique prefix.
  Add --wait to start/run to block until the repro is saved. Exit status is 1 when the
  verdict is failed (a crash, failed check, or failed run), so `repro run … --wait` works in scripts.
  --as <agent> / --session <id> identify the caller. All other output is JSON.
  """
}
