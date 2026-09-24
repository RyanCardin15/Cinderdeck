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

  private static let stack = property("string", "Stack/lane id or name, or <source-stack>/<lane-branch> (see list_stacks)")
  private static let force = property("boolean", "Override another agent's claim. Only with the user's approval.")

  private static let prHost = property("string", "GitHub hostname from list_pr_views. Defaults to the server selected in Cinderdeck. Specify it to pin the target server without switching the UI.")
  private static let prAccount = property("string", "Account returned by list_pr_views; must still be the active GitHub account")
  private static let prID = property("string", "Exact view id from list_pr_views, or a new stable id (letters, numbers, hyphens, underscores)")
  private static let prFilters: JSONValue = .object([
    "type": .string("object"), "additionalProperties": .bool(false),
    "description": .string("Partial filter update. Omitted fields are preserved; new views default to open, anyone, updated, My work."),
    "properties": .object([
      "repository": .object(["type": .array([.string("string"), .string("null")]), "description": .string("owner/name, or null for My work (involves the account by default)")]),
      "organization": .object(["type": .array([.string("string"), .string("null")]), "description": .string("Organization login, or null. Applies when repository is null.")]),
      "state": property("string", "Ignored in advanced mode; closed means unmerged", values: PRViewAPI.states.keys.sorted()),
      "role": property("string", "Personal scope; applies in both simple and advanced mode", values: PRViewAPI.roles.keys.sorted()),
      "sort": property("string", "Result ordering", values: PRViewAPI.sorts.keys.sorted()),
      "text": property("string", "Simple search text, or GitHub qualifiers when advanced=true. @me resolves to the account in query mode."),
      "label": property("string", "Simple-mode label; empty string clears"),
      "advanced": property("boolean", "Use text as a GitHub query instead of simple state/label/text. Repository, organization, and role scope still apply."),
    ]),
  ])

  private static let repro = property("string", "Repro id (or unique prefix) from start_repro_recording or list_repros. Defaults to the latest.")
  private static let reproTime = property("string", "Seconds or mm:ss.sss on the video, or first_error, last_error, end, marker:<label>")

  private static let reproTools: [Tool] = [
    Tool(name: "start_repro_recording", description: "Record the screen while capturing workspace service and task output on the same timeline, for reproducing bugs and automated UI testing. Records the main display by default, or one window (window_id from list_repro_windows is exact; window matches app name or title). A recorded window is followed if it moves, and its app's menus and dropdowns are included. The user sees floating controls and can stop it. To record a test run, pass workspace plus task or workflow: recording starts, the run starts, step results become markers, and recording stops shortly after the run ends. Returns the repro id immediately.",
      properties: ["title": property("string", "What is being reproduced or tested"),
        "workspace": property("string", "Workspace id or name. Limits captured output to it; required with task or workflow"),
        "workspaces": property("array", "Capture output only from these workspaces (default: every workspace with output)", items: "string"),
        "logs": property("boolean", "false records a plain video with no workspace output; your markers and add_repro_logs lines are still kept (default true)"),
        "task": property("string", "Run this configured task while recording"), "workflow": property("string", "Run this configured workflow while recording"),
        "window": property("string", "Record one window: application name or window title, e.g. Safari or \"localhost:3000\". The frontmost match wins"),
        "window_id": property("number", "Record exactly this window, by id from list_repro_windows"),
        "display": property("string", "\"main\" (default) or a 1-based display number"),
        "max_seconds": property("number", "Stop automatically after this many seconds (default 300, max 3600)"),
        "system_audio": property("boolean", "Also record system audio (default false)"),
        "note": property("string", "Optional first marker, e.g. the steps you are about to perform"), "force": force],
      required: [], readOnly: false),
    Tool(name: "mark_repro", description: "Add a marker at the current moment of the recording. Use one per test step or action. Set outcome to pass or fail to record a check; failed checks make the repro's verdict failed.",
      properties: ["label": property("string", "Step, action, or expectation, e.g. \"Click Pay\" or \"Order total shows $42\""),
        "detail": property("string", "Optional detail, e.g. what you observed"),
        "outcome": property("string", "Check result; omit for a plain step marker", values: ["pass", "fail", "info"])],
      required: ["label"], readOnly: false),
    Tool(name: "list_repro_windows", description: "Windows that can be recorded, frontmost first, with id, app, title, frame, display, and pid. Pass an id to start_repro_recording as window_id to record exactly that window.",
      properties: ["query": property("string", "Only windows whose app or title contains this text")], required: [], readOnly: true),
    Tool(name: "add_repro_logs", description: "Add your own output to the recording's log on the video timeline, for example browser console messages, failed network requests, or test runner output. Lines that look like errors count toward the verdict like workspace output.",
      properties: ["lines": property("array", "Lines to add, in order. Each is stamped with the current moment of the video", items: "string"),
        "text": property("string", "Alternatively, text to add; each line becomes a log line"),
        "source": property("string", "Source name shown in the log, e.g. browser or console (default agent)"),
        "level": property("string", "Level for every line; by default it is detected from the text", values: ["debug", "info", "warning", "error"])],
      required: [], readOnly: false),
    Tool(name: "stop_repro_recording", description: "Stop the repro you started and save it. Returns the verdict (clean, errors, failed), error highlights with video timestamps, markers, and run results. Safe to call again: returns the saved repro.",
      properties: ["repro": repro], required: [], readOnly: false),
    Tool(name: "cancel_repro_recording", description: "Stop and discard the recording you started, deleting its video and captured output.",
      properties: [:], required: [], readOnly: false),
    Tool(name: "repro_status", description: "Whether a repro is recording, with elapsed time and live line, error, and marker counts.",
      properties: [:], required: [], readOnly: true),
    Tool(name: "wait_for_repro", description: "Wait until a repro finishes recording (for example one recording a workflow run) and return its summary.",
      properties: ["repro": repro, "timeout": property("number", "Seconds to wait (default 600)")], required: [], readOnly: true),
    Tool(name: "list_repros", description: "Recent repros, newest first, with verdicts and counts. Includes recordings people made while workspace services ran.",
      properties: ["workspace": property("string", "Only repros that captured this workspace"), "limit": property("number", "Default 20")],
      required: [], readOnly: true),
    Tool(name: "repro_summary", description: "Full result of a repro: verdict, headline, distinct errors with timestamps, crashes, failed checks and steps, markers, runs, per-source counts, the Git branch, commit, and uncommitted files of each workspace when recording started, and logFile: a plain-text log with every line stamped with its video time and clock time.",
      properties: ["repro": repro], required: [], readOnly: true),
    Tool(name: "repro_logs", description: "Captured output on the video timeline. Filter by time (around a moment, or from/to), source, minimum level, or text/regex. Each line has t (seconds into the video).",
      properties: ["repro": repro, "around": reproTime, "window": property("number", "Seconds either side of around (default 5)"),
        "from": reproTime, "to": reproTime, "source": property("array", "Service or task names", items: "string"),
        "level": property("string", "Minimum level", values: ["debug", "info", "warning", "error"]),
        "grep": property("string", "Case-insensitive text or regex"), "lines": property("number", "Maximum lines (default 300, max 5000)"),
        "offscreen": property("boolean", "Include output from just before recording or while paused (default true)")],
      required: [], readOnly: true),
    Tool(name: "repro_frame", description: "Look at the recording: returns the video frame at a moment as an image, plus the log lines and markers just before it. Defaults to the first error, or the final frame when there are none. Pass times for up to 6 frames to see a sequence.",
      properties: ["repro": repro, "at": reproTime, "times": property("array", "Up to 6 moments (seconds, mm:ss, first_error, marker:<label>)", items: "string"),
        "marker": property("string", "Marker label or id"), "max_size": property("number", "Longest side in pixels (default 1280, or 960 for several)"),
        "window": property("number", "Seconds of output before each frame to include (default 3)")],
      required: [], readOnly: true),
    Tool(name: "export_repro", description: "Write a shareable repro folder (or .zip): video, README.md summary, recording.log (every line stamped with its video time), per-source logs, markers, frames at failures, and uncommitted diffs. Defaults to ~/Downloads/Cinderdeck Repros.",
      properties: ["repro": repro, "destination": property("string", "Folder to write into"), "zip": property("boolean", "Create a .zip instead of a folder"),
        "video": property("boolean", "Include the video (default true)")],
      required: [], readOnly: false),
    Tool(name: "open_repro", description: "Open a repro in Cinderdeck's video editor for the user, with its logs synced to the playhead.",
      properties: ["repro": repro], required: [], readOnly: false),
    Tool(name: "delete_repro", description: "Delete a saved repro and its captured output. Videos saved in the user's own capture folder are kept. Requires the exact id.",
      properties: ["repro": property("string", "Exact repro id")], required: ["repro"], readOnly: false),
  ]

  private static let tools: [Tool] = [
    Tool(name: "list_workspaces", description: "List workspaces and their services, finite tasks, workflows, and active runs. Existing stacks are workspaces.", properties: [:], required: [], readOnly: true),
    Tool(name: "workspace_details", description: "Get service status, task commands and requirements, workflow steps, and recent runs for a workspace.",
      properties: ["workspace": stack], required: ["workspace"], readOnly: true),
    Tool(name: "run_workspace_task", description: "Run a configured task once, after its required services are ready. Returns a durable run id immediately. Poll workspace_run_status; never repeat a start just because a wait timed out. No automatic retries.",
      properties: ["workspace": stack, "task": property("string", "Configured task id"), "force": force], required: ["workspace", "task"], readOnly: false),
    Tool(name: "run_workspace_workflow", description: "Run configured task and service steps in order. Failure skips later steps; optional cleanup stops only services started by this run. Returns a durable run id immediately.",
      properties: ["workspace": stack, "workflow": property("string", "Configured workflow id"), "force": force], required: ["workspace", "workflow"], readOnly: false),
    Tool(name: "workspace_run_status", description: "Read a run's current status, step results, exit codes, timestamps, and actor, including completed runs after app relaunch.",
      properties: ["run": property("string", "Run UUID returned at start")], required: ["run"], readOnly: true),
    Tool(name: "workspace_run_logs", description: "Read bounded task output for a run; optionally select a step UUID. ANSI is removed. Does not start or replay commands.",
      properties: ["run": property("string", "Run UUID"), "step": property("string", "Optional step UUID"), "lines": property("number", "Maximum lines, 1–5000; default 200")], required: ["run"], readOnly: true),
    Tool(name: "list_workspace_runs", description: "List recent task and workflow runs, optionally scoped to a workspace.",
      properties: ["workspace": stack], required: [], readOnly: true),
    Tool(name: "cancel_workspace_run", description: "Cancel a finite run, stop its process group, and skip remaining workflow steps. Does not stop pre-existing services unless the workflow already executed an explicit stop step.",
      properties: ["run": property("string", "Run UUID"), "force": force], required: ["run"], readOnly: false),
    Tool(name: "list_pr_views", description: "List local Pull Request tabs, their filters and generated queries, active selection, hostname, and current GitHub account. Use before configuring PR views.",
      properties: ["hostname": prHost], required: [], readOnly: true),
    Tool(name: "upsert_pr_view", description: "Create or patch a custom Pull Request tab by stable id, without duplicates. Name is required on creation. Omitted fields stay unchanged; select=true activates it. Updates to an active saved view refresh its filters unless the user has unsaved changes. Built-ins cannot be edited. Local configuration only.",
      properties: ["hostname": prHost, "account": prAccount, "id": prID, "name": property("string", "Tab name, 1–40 characters"), "filters": prFilters,
        "select": property("boolean", "Activate after saving, replacing current unsaved filters (default false)")],
      required: ["account", "id"], readOnly: false),
    Tool(name: "select_pr_view", description: "Activate a built-in or custom PR tab, replacing current unsaved filters. Built-in tabs retain the current repository and organization; custom tabs restore their saved repository.",
      properties: ["hostname": prHost, "account": prAccount, "id": prID], required: ["account", "id"], readOnly: false),
    Tool(name: "delete_pr_view", description: "Delete a custom PR tab. Deleting the active tab selects Active and retains repository and organization scope. Built-ins are protected; deleting an already absent custom id is safe to repeat.",
      properties: ["hostname": prHost, "account": prAccount, "id": prID], required: ["account", "id"], readOnly: false),
    Tool(name: "reorder_pr_views", description: "Set the custom PR tab order. Include every custom id exactly once; built-in tabs retain their positions.",
      properties: ["hostname": prHost, "account": prAccount, "ids": property("array", "Complete ordered list of custom view ids", items: "string")],
      required: ["account", "ids"], readOnly: false),
    Tool(name: "list_lanes", description: "Show original checkouts and parallel worktree lanes, including each lane's ports, owner, paths and service state.",
      properties: ["stack": stack], required: [], readOnly: true),
    Tool(name: "create_lane", description: "Create an isolated Git worktree copy of a stack on an existing or new local branch, claim it, and start its services with unique ports. Leaves the source running. Commands must use PORT and CINDERDECK_PORT_<UPPERCASE_SERVICE>. Use start=false to install dependencies in the returned paths first. Branch must not already be checked out.",
      properties: ["stack": stack, "branch": property("string", "Existing or new local branch, also the lane name, e.g. agent/codex-1"),
        "start": property("boolean", "Start services after creation (default true)"), "wait": property("boolean", "Wait for readiness (default true)"),
        "timeout": property("number", "Seconds to wait for services (default 180)")], required: ["stack", "branch"], readOnly: false),
    Tool(name: "remove_lane", description: "Stop a lane and remove its worktrees. Refuses tracked, untracked or ignored changes and respects claims. Keeps Git branches. Never removes the original checkout.",
      properties: ["stack": property("string", "Lane id or <source-stack>/<branch> from create_lane"), "force": force], required: ["stack"], readOnly: false),
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
  ] + reproTools

  static var toolDescriptions: [JSONValue] { tools.map(describe) }

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
          "serverInfo": .object(["name": .string("cinderdeck-stacks"), "title": .string("Cinderdeck"), "version": .string(version)]),
          "instructions": .string(StackAgentGuide.mcpInstructions),
        ])
      case "ping":
        response["result"] = .object([:])
      case "tools/list":
        response["result"] = .object(["tools": .array(toolDescriptions)])
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

  private static let nonDestructive: Set<String> = ["claim_stack", "start_repro_recording", "mark_repro", "add_repro_logs", "stop_repro_recording",
    "export_repro", "open_repro"]

  private static func describe(_ tool: Tool) -> JSONValue {
    var schema: [String: JSONValue] = ["type": .string("object"), "properties": .object(tool.properties)]
    if !tool.required.isEmpty { schema["required"] = .array(tool.required.map { JSONValue.string($0) }) }
    return .object([
      "name": .string(tool.name), "description": .string(tool.description), "inputSchema": .object(schema),
      "annotations": .object(["readOnlyHint": .bool(tool.readOnly), "destructiveHint": .bool(!tool.readOnly && !nonDestructive.contains(tool.name)),
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
      if name == "repro_frame" { return .object(["content": .array(frameContent(result)), "isError": .bool(false)]) }
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

  static func request(for tool: String, _ arguments: [String: JSONValue]) throws -> (String, [String: JSONValue], TimeInterval) {
    var params = arguments
    let wait = min(max(arguments["timeout"]?.doubleValue ?? 180, 1), 900)
    switch tool {
    case "list_workspaces": return ("workspace.list", params, 30)
    case "workspace_details": return ("workspace.get", params, 30)
    case "run_workspace_task": return ("workspace.task.run", params, 30)
    case "run_workspace_workflow": return ("workspace.workflow.run", params, 30)
    case "workspace_run_status": return ("workspace.run.get", params, 30)
    case "workspace_run_logs": return ("workspace.run.logs", params, 30)
    case "list_workspace_runs": return ("workspace.runs", params, 30)
    case "cancel_workspace_run": return ("workspace.run.cancel", params, 120)
    case "list_pr_views": return ("prs.views.list", params, 90)
    case "upsert_pr_view": return ("prs.views.upsert", params, 90)
    case "select_pr_view": return ("prs.views.select", params, 90)
    case "delete_pr_view": return ("prs.views.delete", params, 90)
    case "reorder_pr_views": return ("prs.views.reorder", params, 90)
    case "list_lanes": return ("lane.list", params, 30)
    case "create_lane": return ("lane.create", params, wait + 300)
    case "remove_lane": return ("lane.remove", params, 300)
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
    case "start_repro_recording": return ("repro.start", params, 90)
    case "mark_repro": return ("repro.mark", params, 30)
    case "list_repro_windows": return ("repro.windows", params, 30)
    case "add_repro_logs": return ("repro.log", params, 30)
    case "stop_repro_recording": return ("repro.stop", params, 240)
    case "cancel_repro_recording": return ("repro.cancel", params, 60)
    case "repro_status": return ("repro.status", params, 30)
    case "wait_for_repro":
      let timeout = min(max(arguments["timeout"]?.doubleValue ?? 600, 1), 3600)
      return ("repro.wait", params, timeout + 60)
    case "list_repros": return ("repro.list", params, 30)
    case "repro_summary": return ("repro.get", params, 60)
    case "repro_logs": return ("repro.logs", params, 60)
    case "repro_frame": return ("repro.frame", params, 120)
    case "export_repro": return ("repro.export", params, 600)
    case "open_repro": return ("repro.open", params, 30)
    case "delete_repro": return ("repro.delete", params, 60)
    default: throw StackControlError(code: "unknown_tool", message: "Unknown tool \(tool)")
    }
  }

  /// Each frame as an image block followed by its timestamp, markers, and output.
  static func frameContent(_ result: JSONValue) -> [JSONValue] {
    var content: [JSONValue] = []
    for frame in result["frames"]?.arrayValue ?? [] {
      if let data = frame["imageBase64"]?.stringValue {
        content.append(.object(["type": .string("image"), "data": .string(data), "mimeType": .string(frame["mimeType"]?.stringValue ?? "image/jpeg")]))
      }
      var text = "Frame at \(frame["time"]?.stringValue ?? "?") (\(frame["width"]?.intValue ?? 0)×\(frame["height"]?.intValue ?? 0)), saved to \(frame["path"]?.stringValue ?? "")"
      let markers = (frame["markers"]?.arrayValue ?? []).map { marker in
        "  [\(marker["time"]?.stringValue ?? "")] ▶ \(marker["label"]?.stringValue ?? "")" + (marker["outcome"]?.stringValue.map { " [\($0.uppercased())]" } ?? "")
      }
      if !markers.isEmpty { text += "\nMarkers:\n" + markers.joined(separator: "\n") }
      let logs = (frame["logs"]?.arrayValue ?? []).map(logText)
      text += logs.isEmpty ? "\n(no output in this window)" : "\nOutput before this frame:\n" + logs.joined(separator: "\n")
      content.append(.object(["type": .string("text"), "text": .string(text)]))
    }
    return content.isEmpty ? [.object(["type": .string("text"), "text": .string(result.prettyString())])] : content
  }

  private static func logText(_ line: JSONValue) -> String {
    let level = line["level"]?.stringValue ?? "info"
    let badge = level == "error" ? " ERROR" : level == "warning" ? " WARN" : ""
    return "[\(line["time"]?.stringValue ?? "")]\(badge) \(line["source"]?.stringValue ?? "") | \(line["text"]?.stringValue ?? "")"
  }

  /// Compact, model-friendly text for list-style results; JSON for the rest.
  private static func render(_ tool: String, _ result: JSONValue) -> String {
    switch tool {
    case "repro_logs":
      let lines = (result["lines"]?.arrayValue ?? []).map(logText)
      let header = "\(result["returned"]?.intValue ?? lines.count) of \(result["total"]?.intValue ?? 0) lines · video \(ReproFormat.timestamp(result["duration"]?.doubleValue ?? 0))"
      return header + "\n" + (lines.isEmpty ? "(no matching output)" : lines.joined(separator: "\n"))
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
      if let lane = stack.lane { object["lane"] = try? JSONValue(encoding: lane) }
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
