import Darwin
import Foundation

/// `cinderdeck mcp` — a Model Context Protocol server over stdio that forwards tool calls to the
/// running Cinderdeck app. The client's name (from `initialize`) becomes the actor shown on the
/// services, runs, and recordings it starts. Tool calls run concurrently, each on its own control
/// connection, so a long wait never holds up pings or other calls.
nonisolated enum CinderdeckMCPServer {
  struct Tool {
    /// read: no changes. additive: creates or starts without removing anything. destructive: may stop, replace, or delete.
    enum Effect { case read, additive, destructive }
    let name: String
    let title: String
    let effect: Effect
    let description: String
    let properties: [String: JSONValue]
    let required: [String]
    let idempotent: Bool
  }

  private static func tool(_ name: String, _ title: String, _ effect: Tool.Effect, _ description: String,
    _ properties: [String: JSONValue] = [:], required: [String] = [], idempotent: Bool = false) -> Tool {
    Tool(name: name, title: title, effect: effect, description: description, properties: properties, required: required,
      idempotent: idempotent || effect == .read)
  }

  private static func property(_ type: String, _ description: String, items: String? = nil, values: [String]? = nil) -> JSONValue {
    var object: [String: JSONValue] = ["type": .string(type), "description": .string(description)]
    if let items { object["items"] = .object(["type": .string(items)]) }
    if let values { object["enum"] = .array(values.map { JSONValue.string($0) }) }
    return .object(object)
  }

  // MARK: Shared arguments

  private static let workspace = property("string", "Workspace id or name, or a lane as <workspace>/<branch> (see list_workspaces)")
  private static let force = property("boolean", "Override another agent's claim. Only with the user's approval.")
  private static let wait = property("boolean", "Wait until services are ready (default true)")
  private static let waitTimeout = property("number", "Seconds to wait (default 180, max 900)")
  private static let runID = property("string", "Run UUID returned when the task or workflow started")
  private static let environment: JSONValue = .object(["type": .string("object"), "additionalProperties": .object(["type": .string("string")]),
    "description": .string("Environment variables as NAME: \"value\". Replaces the existing set; {} clears it.")])
  private static let repo = property("string", "Repo id from the workspace's repos; sets the default folder and branch tracking. \"\" removes it")
  private static let cwd = property("string", "Working folder: absolute, ~/…, or relative to the repo (or the workspace folder)")

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

  // MARK: Tools

  private static let workspaceTools: [Tool] = [
    tool("list_workspaces", "List workspaces", .read,
      "Every workspace with its services (status, URL, PID, who started each, branch), tasks, workflows, active run, claim, lane, and Git state. Start here."),
    tool("workspace_details", "Workspace details", .read,
      "One workspace in full: services (phase, pid, port, url, owner, log file, command, cwd), repos, claim, task and workflow definitions, and its 20 most recent runs.",
      ["workspace": workspace], required: ["workspace"]),
    tool("open_workspace", "Show a workspace to the user", .additive,
      "Open Cinderdeck's Workspaces window on a workspace and section so the user can look. Brings Cinderdeck to the front: use it only when the user wants to see something.",
      ["workspace": workspace, "section": property("string", "Section to show", values: ["services", "tasks", "workflows", "runs", "recordings"])],
      idempotent: true),
  ]

  private static let serviceTools: [Tool] = [
    tool("start_services", "Start services", .additive,
      "Start a workspace's services, or only some, in dependency order. Waits until they are ready and returns the last output of any that crashed.",
      ["workspace": workspace, "services": property("array", "Only these services (and nothing else)", items: "string"),
        "wait": wait, "timeout": waitTimeout, "force": force], required: ["workspace"], idempotent: true),
    tool("stop_services", "Stop services", .destructive,
      "Stop a workspace's services, or only some, in reverse dependency order. Stops whole process groups. Refuses (in_use) when running lanes or other workspaces use them, unless force=true.",
      ["workspace": workspace, "services": property("array", "Only these services", items: "string"),
        "wait": property("boolean", "Wait until they have stopped (default true)"), "timeout": waitTimeout, "force": force],
      required: ["workspace"], idempotent: true),
    tool("restart_services", "Restart services", .destructive,
      "Restart every service in a workspace, or one service. Waits for readiness and returns the last output of any that crashed.",
      ["workspace": workspace, "service": property("string", "Restart just this service"),
        "dependents": property("boolean", "Also restart services that depend on it"), "wait": wait, "timeout": waitTimeout, "force": force],
      required: ["workspace"]),
    tool("read_service_logs", "Read service logs", .read,
      "Recent service output with ANSI codes removed. Pass the returned cursor as after to read only new lines.",
      ["workspace": workspace, "service": property("string", "One service; omit for all, interleaved"),
        "lines": property("number", "Maximum lines (default 200, max 5000)"), "grep": property("string", "Case-insensitive regex filter"),
        "after": property("number", "Cursor from a previous read_service_logs call")],
      required: ["workspace"]),
    tool("recent_activity", "Recent activity", .read,
      "Recent service starts, crashes, stops, and branch switches in a workspace, each with who caused it.",
      ["workspace": workspace, "limit": property("number", "Default 40")], required: ["workspace"]),
    tool("list_ports", "List listening ports", .read,
      "Every listening TCP port with its process, working directory, terminal (tty), and the app it was started from (Cursor, Terminal, Codex…), or the Cinderdeck workspace service that owns it.",
      ["port": property("number", "Only this port"), "external_only": property("boolean", "Hide ports owned by Cinderdeck services")]),
    tool("stop_port_process", "Stop a stray port process", .destructive,
      "Stop a non-Cinderdeck process listening on a port, such as a dev server left in another terminal. Requires the pid from list_ports. Ask the user first if you did not start it.",
      ["port": property("number", "Port"), "pid": property("number", "Process ID from list_ports")], required: ["port", "pid"]),
    tool("claim_workspace", "Claim a workspace", .additive,
      "Take an advisory claim on a workspace while you depend on it (tests, debugging, a lane you work in). Other agents must ask before changing it. Call again to renew.",
      ["workspace": workspace, "note": property("string", "What you are doing, shown to the user"),
        "ttl_minutes": property("number", "Default 30, max 480"), "force": force], required: ["workspace"], idempotent: true),
    tool("release_workspace", "Release a claim", .additive, "Release your claim on a workspace.",
      ["workspace": workspace, "force": force], required: ["workspace"], idempotent: true),
  ]

  private static let runTools: [Tool] = [
    tool("run_workspace_task", "Run a task", .destructive,
      "Run a configured task once, after its required services are ready. Returns a durable run id immediately; follow it with wait_for_workspace_run. Never start it again just because a wait ended. No automatic retries.",
      ["workspace": workspace, "task": property("string", "Configured task id"), "force": force], required: ["workspace", "task"]),
    tool("run_workspace_workflow", "Run a workflow", .destructive,
      "Run a configured workflow's task and service steps in order. A failure skips later steps; optional cleanup stops only services this run started. Returns a durable run id immediately.",
      ["workspace": workspace, "workflow": property("string", "Configured workflow id"), "force": force], required: ["workspace", "workflow"]),
    tool("wait_for_workspace_run", "Wait for a run", .read,
      "Wait for a task or workflow run to finish. Returns its status, step results, exit codes, and, when it failed, the failing step's last output. finished=false means the wait ended first: wait again, never start the run again.",
      ["run": runID, "timeout": property("number", "Seconds to wait (default 600, max 3600)")], required: ["run"]),
    tool("workspace_run_status", "Run status", .read,
      "A run's current status, step results, exit codes, timestamps, and actor, including runs that finished before the app relaunched.",
      ["run": runID], required: ["run"]),
    tool("workspace_run_logs", "Run output", .read,
      "Task output for a run, ANSI codes removed; optionally one step. Does not start or replay commands.",
      ["run": runID, "step": property("string", "Optional step UUID from the run's steps"), "lines": property("number", "Maximum lines, 1–5000; default 200")],
      required: ["run"]),
    tool("list_workspace_runs", "List runs", .read, "Recent task and workflow runs, newest first, optionally for one workspace.",
      ["workspace": workspace, "limit": property("number", "Default 20, max 200")]),
    tool("cancel_workspace_run", "Cancel a run", .destructive,
      "Cancel a task or workflow run, stop its process group, and skip remaining steps. Services running before the workflow keep running unless it already ran an explicit stop step.",
      ["run": runID, "force": force], required: ["run"]),
  ]

  private static let definitionTools: [Tool] = [
    tool("create_workspace", "Create a workspace", .additive,
      "Create an empty workspace for a project folder. Then add services, tasks, and workflows with the save_workspace_* tools. Nothing starts.",
      ["name": property("string", "Display name, e.g. \"Shop\""), "folder": property("string", "Project folder commands run in by default (absolute or ~/…)"),
        "id": property("string", "File name id (default: derived from name)")],
      required: ["name", "folder"]),
    tool("save_workspace_service", "Save a service", .destructive,
      "Add a long-running service to a workspace, or change one. Omitted settings keep their current values. A new service in a Git working tree also tracks its branch unless add_repo=false. Nothing starts; restart the service to apply changes. The command must stay in the foreground.",
      ["workspace": workspace, "service": property("string", "Service id (letters, numbers, hyphens, underscores)"),
        "cmd": property("string", "Shell command, e.g. \"npm run dev\". Required for a new service"), "cwd": cwd, "repo": repo,
        "port": property("number", "Port shown as a localhost link and checked for conflicts; 0 removes it"),
        "ready": property("string", "Readiness check: port:<port or port name>, an http(s) URL answering below 500 (may use {{url.<service>}}), log:<regex>, or none. New services with a port default to port:<port>"),
        "ready_timeout": property("number", "Seconds to wait for readiness (default 90)"),
        "depends_on": property("array", "Service ids that must be ready first", items: "string"),
        "env": environment, "autostart": property("boolean", "Start with the whole workspace (default true)"),
        "add_repo": property("boolean", "For a new service in a Git working tree without repo, track its branch (default true)"),
        "ports": .object(["type": .string("object"), "additionalProperties": .object(["type": .string("number")]),
          "description": .string("Extra named ports, e.g. {\"hmr\": 24678}; replaces the existing set. Lanes assign their own values.")]),
        "lane": property("string", "In worktree lanes: isolate (own copy, default), shared (use the original checkout's), or off; \"\" resets", values: ["isolate", "shared", "off", ""]),
        "force": force],
      required: ["workspace", "service"], idempotent: true),
    tool("save_workspace_task", "Save a task", .destructive,
      "Add a task (a command that finishes, such as tests, a build, or a migration) to a workspace, or change one. Omitted settings keep their values. from_service moves a stopped service to Tasks, keeping its command, folder, repo, and environment.",
      ["workspace": workspace, "task": property("string", "Task id (letters, numbers, hyphens, underscores)"), "name": property("string", "Display name (default: the id)"),
        "cmd": property("string", "Shell command. Required for a new task unless from_service is set"), "cwd": cwd, "repo": repo,
        "requires_services": property("array", "Services that must be ready before the task starts", items: "string"),
        "timeout": property("number", "Seconds before the task is stopped (default 600, max 3600)"), "env": environment,
        "from_service": property("string", "Convert this stopped service into the task and remove the service"), "force": force],
      required: ["workspace", "task"], idempotent: true),
    tool("save_workspace_workflow", "Save a workflow", .destructive,
      "Add a workflow to a workspace, or change one. Steps run in order: task:<id>, start:<service>, or stop:<service>; up to 100.",
      ["workspace": workspace, "workflow": property("string", "Workflow id (letters, numbers, hyphens, underscores)"), "name": property("string", "Display name (default: the id)"),
        "steps": property("array", "Ordered steps, e.g. [\"task:lint\", \"start:api\", \"task:test\"]. Required for a new workflow", items: "string"),
        "cleanup_services": property("boolean", "Stop services this run started when it ends (default false)"), "force": force],
      required: ["workspace", "workflow"], idempotent: true),
    tool("delete_workspace_item", "Delete a service, task, or workflow", .destructive,
      "Remove a service, task, or workflow from a workspace's definition. Refuses while something still references it, and a service must be stopped. Saved run results are kept.",
      ["workspace": workspace, "kind": property("string", "What to delete", values: ["service", "task", "workflow"]),
        "id": property("string", "Id of the service, task, or workflow"), "force": force],
      required: ["workspace", "kind", "id"]),
    tool("workspace_guide", "Workspace file guide", .read,
      "Where workspace TOML files, logs, and live state live, plus a definition template and format rules. Use before editing a definition file by hand."),
    tool("validate_workspace", "Validate a definition", .read,
      "Validate a workspace definition (file path or TOML text) and show its services, tasks, workflows, and start order. Call reload_workspaces after saving a file.",
      ["path": property("string", "Path to a .toml file"), "source": property("string", "TOML text")]),
    tool("reload_workspaces", "Reload definitions", .additive, "Reload workspace definitions from disk.", idempotent: true),
  ]

  private static let gitAndLaneTools: [Tool] = [
    tool("git_status", "Git status", .read, "Current branch, uncommitted files, and ahead/behind counts for each repo in a workspace.",
      ["workspace": workspace], required: ["workspace"]),
    tool("list_branches", "List branches", .read, "Recent, local, and remote branches for a workspace's repos.",
      ["workspace": workspace, "repo": property("string", "One repo id")], required: ["workspace"]),
    tool("switch_branch", "Switch branch", .destructive,
      "Check out a branch in one repo, or in every repo of a workspace that has it. Stops affected running services first and restarts them after. For parallel work, prefer create_lane.",
      ["workspace": workspace, "branch": property("string", "Branch name, or origin/name for a remote branch"),
        "repo": property("string", "Only this repo; omit for all repos that have the branch"),
        "dirty": property("string", "What to do with uncommitted changes (default fail)", values: ["fail", "stash", "carry"]), "force": force],
      required: ["workspace", "branch"]),
    tool("pull_repos", "Pull repos", .destructive,
      "Fast-forward pull a workspace's repos (or one repo), restarting affected services. fetch=true only fetches.",
      ["workspace": workspace, "repo": property("string", "One repo id"), "fetch": property("boolean", "Fetch only; do not pull"), "force": force],
      required: ["workspace"]),
    tool("list_lanes", "List lanes", .read,
      "Original checkouts and their parallel worktree lanes: ports and URLs, owner, folders, service state, setup status, shared services, and whether each lane's branch was merged or its upstream deleted.",
      ["workspace": workspace]),
    tool("create_lane", "Create a lane", .additive,
      "Create an isolated Git worktree copy of a workspace on a branch, claim it for you, run its [lanes] setup, and start its services on unique ports. The source keeps running. A branch that only exists on the remote is tracked; a new branch starts at from (default each repo's HEAD). Values written as {{port.<service>}} / {{url.<service>}} resolve to this lane's ports; services marked shared use the original checkout's instance. start=false creates without starting. If the branch is already checked out in your own worktree, use adopt_lane.",
      ["workspace": workspace, "branch": property("string", "Existing (local or remote) or new branch, also the lane name, e.g. agent/codex-1"),
        "from": property("string", "Start point for a new branch, e.g. origin/main (default: [lanes] from, else HEAD)"),
        "env": .object(["type": .string("object"), "additionalProperties": .object(["type": .string("string")]),
          "description": .string("Lane-only environment variables as NAME: \"value\"; they win over the definition")]),
        "copy": property("array", "Extra untracked files to copy from each original checkout, e.g. [\".env.local\"]", items: "string"),
        "setup": property("boolean", "Run the workspace's [lanes] setup before starting (default true)"),
        "start": property("boolean", "Start services after creation (default true)"), "wait": wait,
        "timeout": waitTimeout], required: ["workspace", "branch"]),
    tool("adopt_lane", "Adopt a worktree as a lane", .additive,
      "Run an existing Git worktree (for example the one you are working in) as a lane of a workspace, with its own ports. Cinderdeck never deletes an adopted worktree; other repos of the workspace get worktrees on the same branch or stay shared.",
      ["workspace": workspace, "path": property("string", "Worktree folder (default: your current folder)"),
        "name": property("string", "Lane name (default: the worktree's branch)"),
        "setup": property("boolean", "Run [lanes] setup (default false)"),
        "start": property("boolean", "Start services (default true)"), "wait": wait, "timeout": waitTimeout], required: ["workspace"]),
    tool("lane_env", "Lane environment", .read,
      "The ports, URLs and variables a lane (or original checkout) gives its services: PORT, CINDERDECK_PORT_*, CINDERDECK_URL_*, lane values and definition env. Use them when you run tests or curl from your own shell. Secrets are omitted.",
      ["workspace": workspace, "service": property("string", "A service or task, for its PORT and own env")], required: ["workspace"]),
    tool("run_lane_setup", "Run lane setup", .additive,
      "Run the workspace's [lanes] setup task or workflow in a lane again, e.g. after it failed, and wait for it.",
      ["workspace": property("string", "Lane id or <workspace>/<branch>"), "force": force], required: ["workspace"]),
    tool("remove_lane", "Remove a lane", .destructive,
      "Stop a lane, run its [lanes] teardown, and remove its worktrees. Refuses tracked or untracked changes and respects claims. Ignored files (node_modules, build output, .env) block removal unless discard_ignored=true; ask the user before discarding. Keeps Git branches and adopted worktrees. Never removes the original checkout.",
      ["workspace": property("string", "Lane id or <workspace>/<branch> from create_lane"), "force": force,
        "discard_ignored": property("boolean", "Also delete ignored files in the lane's worktrees"),
        "force_teardown": property("boolean", "Remove even if teardown fails"),
        "delete_logs": property("boolean", "Also delete the lane's service logs")], required: ["workspace"]),
    tool("release_lane", "Release a lane", .destructive,
      "Stop a lane and forget it, keeping every worktree on disk. Use for adopted worktrees you keep working in.",
      ["workspace": property("string", "Lane id or <workspace>/<branch>"), "force": force], required: ["workspace"]),
    tool("prune_lanes", "Prune merged lanes", .destructive,
      "Remove lanes whose branches were merged into the default remote branch or whose upstream branch was deleted. Lanes with changes, or claimed by others, are kept and reported. dry_run lists them first.",
      ["workspace": workspace, "dry_run": property("boolean", "Only list what would be removed"),
        "missing": property("boolean", "Also remove lanes whose worktrees are missing"),
        "discard_ignored": property("boolean", "Also delete ignored files"), "force": force]),
    tool("unpin_lane", "Unpin a lane", .additive,
      "Make a lane created by an older Cinderdeck follow its source workspace definition instead of its saved copy.",
      ["workspace": property("string", "Lane id or <workspace>/<branch>"), "force": force], required: ["workspace"]),
  ]

  private static let prTools: [Tool] = [
    tool("list_pr_views", "List Pull Request tabs", .read,
      "List local Pull Request tabs, their filters and generated queries, active selection, hostname, and current GitHub account. Use before configuring PR views.",
      ["hostname": prHost]),
    tool("upsert_pr_view", "Save a Pull Request tab", .destructive,
      "Create or patch a custom Pull Request tab by stable id, without duplicates. Name is required on creation. Omitted fields stay unchanged; select=true activates it. Updates to an active saved view refresh its filters unless the user has unsaved changes. Built-ins cannot be edited. Local configuration only.",
      ["hostname": prHost, "account": prAccount, "id": prID, "name": property("string", "Tab name, 1–40 characters"), "filters": prFilters,
        "select": property("boolean", "Activate after saving, replacing current unsaved filters (default false)")],
      required: ["account", "id"], idempotent: true),
    tool("select_pr_view", "Select a Pull Request tab", .destructive,
      "Activate a built-in or custom PR tab, replacing current unsaved filters. Built-in tabs retain the current repository and organization; custom tabs restore their saved repository.",
      ["hostname": prHost, "account": prAccount, "id": prID], required: ["account", "id"], idempotent: true),
    tool("delete_pr_view", "Delete a Pull Request tab", .destructive,
      "Delete a custom PR tab. Deleting the active tab selects Active and retains repository and organization scope. Built-ins are protected; deleting an already absent custom id is safe to repeat.",
      ["hostname": prHost, "account": prAccount, "id": prID], required: ["account", "id"], idempotent: true),
    tool("reorder_pr_views", "Reorder Pull Request tabs", .destructive,
      "Set the custom PR tab order. Include every custom id exactly once; built-in tabs retain their positions.",
      ["hostname": prHost, "account": prAccount, "ids": property("array", "Complete ordered list of custom view ids", items: "string")],
      required: ["account", "ids"], idempotent: true),
  ]

  private static let reproTools: [Tool] = [
    tool("start_repro_recording", "Start a repro recording", .additive,
      "Record the screen while capturing workspace service and task output on the same timeline, for reproducing bugs and automated UI testing. Records the main display by default, or one window (window_id from list_repro_windows is exact; window matches app name or title). A recorded window is followed if it moves, and its app's menus and dropdowns are included. The user sees floating controls and can stop it. To record a test run, pass workspace plus task or workflow: recording starts, the run starts, step results become markers, and recording stops shortly after the run ends. Returns the repro id immediately.",
      ["title": property("string", "What is being reproduced or tested"),
        "workspace": property("string", "Workspace id or name. Limits captured output to it; required with task or workflow"),
        "workspaces": property("array", "Capture output only from these workspaces (default: every workspace with output)", items: "string"),
        "logs": property("boolean", "false records a plain video with no workspace output; your markers and add_repro_logs lines are still kept (default true)"),
        "task": property("string", "Run this configured task while recording"), "workflow": property("string", "Run this configured workflow while recording"),
        "window": property("string", "Record one window: application name or window title, e.g. Safari or \"localhost:3000\". The frontmost match wins"),
        "window_id": property("number", "Record exactly this window, by id from list_repro_windows"),
        "display": property("string", "\"main\" (default) or a 1-based display number"),
        "max_seconds": property("number", "Stop automatically after this many seconds (default 300, max 3600)"),
        "system_audio": property("boolean", "Also record system audio (default false)"),
        "note": property("string", "Optional first marker, e.g. the steps you are about to perform"), "force": force]),
    tool("mark_repro", "Mark a repro step", .additive,
      "Add a marker at the current moment of the recording. Use one per test step or action. Set outcome to pass or fail to record a check; failed checks make the repro's verdict failed.",
      ["label": property("string", "Step, action, or expectation, e.g. \"Click Pay\" or \"Order total shows $42\""),
        "detail": property("string", "Optional detail, e.g. what you observed"),
        "outcome": property("string", "Check result; omit for a plain step marker", values: ["pass", "fail", "info"]),
        "repro": property("string", "Repro id, to mark one that already stopped (placed at its end). Default: the recording, or the one that stopped in the last 2 minutes")],
      required: ["label"]),
    tool("list_repro_windows", "List recordable windows", .read,
      "Windows that can be recorded, frontmost first, with id, app, title, frame, display, and pid. Pass an id to start_repro_recording as window_id to record exactly that window.",
      ["query": property("string", "Only windows whose app or title contains this text")]),
    tool("add_repro_logs", "Add lines to a repro log", .additive,
      "Add your own output to the recording's log on the video timeline, for example browser console messages, failed network requests, or test runner output. Lines that look like errors count toward the verdict like workspace output. Safe to send in parallel with stop_repro_recording; lines that arrive after the stop are added to the saved log at the end of the video.",
      ["lines": property("array", "Lines to add, in order. Each is stamped with the current moment of the video", items: "string"),
        "text": property("string", "Alternatively, text to add; each line becomes a log line"),
        "source": property("string", "Source name shown in the log, e.g. browser or console (default agent)"),
        "level": property("string", "Level for every line; by default it is detected from the text", values: ["debug", "info", "warning", "error"]),
        "repro": property("string", "Repro id, to add to one that already stopped. Default: the recording, or the one that stopped in the last 2 minutes")]),
    tool("stop_repro_recording", "Stop a repro recording", .additive,
      "Stop the repro you started and save it. Returns the verdict (clean, errors, failed), error highlights with video timestamps, markers, and run results. Safe to call again: returns the saved repro.",
      ["repro": repro], idempotent: true),
    tool("cancel_repro_recording", "Discard a repro recording", .destructive,
      "Stop and discard the recording you started, deleting its video and captured output."),
    tool("repro_status", "Repro status", .read,
      "Whether a repro is recording, with elapsed time and live line, error, and marker counts, plus which workspaces the user's toolbar recordings capture."),
    tool("wait_for_repro", "Wait for a repro", .read,
      "Wait until a repro finishes recording (for example one recording a workflow run) and return its summary.",
      ["repro": repro, "timeout": property("number", "Seconds to wait (default 600, max 3600)")]),
    tool("list_repros", "List repros", .read,
      "Recent repros, newest first, with verdicts and counts. Includes recordings people made while workspace services ran.",
      ["workspace": property("string", "Only repros that captured this workspace"), "limit": property("number", "Default 20, max 200")]),
    tool("repro_summary", "Repro summary", .read,
      "Full result of a repro: verdict, headline, distinct errors with timestamps, crashes, failed checks and steps, markers, runs, per-source counts, the Git branch, commit, and uncommitted files of each workspace when recording started, and logFile: a plain-text log with every line stamped with its video time and clock time.",
      ["repro": repro]),
    tool("repro_logs", "Repro logs", .read,
      "Captured output on the video timeline. Filter by time (around a moment, or from/to), source, minimum level, or text/regex. Each line has t (seconds into the video).",
      ["repro": repro, "around": reproTime, "window": property("number", "Seconds either side of around (default 5)"),
        "from": reproTime, "to": reproTime, "source": property("array", "Service or task names", items: "string"),
        "level": property("string", "Minimum level", values: ["debug", "info", "warning", "error"]),
        "grep": property("string", "Case-insensitive text or regex"), "lines": property("number", "Maximum lines (default 300, max 5000)"),
        "offscreen": property("boolean", "Include output from just before recording or while paused (default true)")]),
    tool("repro_frame", "Repro video frames", .read,
      "Look at the recording: returns the video frame at a moment as an image, plus the log lines and markers just before it. Defaults to the first error, or the final frame when there are none. Pass times for up to 6 frames to see a sequence.",
      ["repro": repro, "at": reproTime, "times": property("array", "Up to 6 moments (seconds, mm:ss, first_error, marker:<label>)", items: "string"),
        "marker": property("string", "Marker label or id"), "max_size": property("number", "Longest side in pixels (default 1280, or 960 for several)"),
        "window": property("number", "Seconds of output before each frame to include (default 3)")]),
    tool("export_repro", "Export a repro", .additive,
      "Write a shareable repro folder (or .zip): video, README.md summary, recording.log (every line stamped with its video time), per-source logs, markers, frames at failures, and uncommitted diffs. Defaults to ~/Downloads/Cinderdeck Repros.",
      ["repro": repro, "destination": property("string", "Folder to write into"), "zip": property("boolean", "Create a .zip instead of a folder"),
        "video": property("boolean", "Include the video (default true)")]),
    tool("open_repro", "Open a repro", .additive,
      "Open a repro in Cinderdeck's video editor for the user, with its logs synced to the playhead.", ["repro": repro], idempotent: true),
    tool("delete_repro", "Delete a repro", .destructive,
      "Delete a saved repro and its captured output. Videos saved in the user's own capture folder are kept. Requires the exact id.",
      ["repro": property("string", "Exact repro id")], required: ["repro"]),
    tool("repro_recording_scope", "Toolbar recording scope", .additive,
      "Show or change which workspaces' output the user's own toolbar screen recordings capture: running (every running workspace), selected (only workspaces), or off (plain video). Omit mode to read it. Change it only when the user asks.",
      ["mode": property("string", "New scope", values: ["running", "selected", "off"]),
        "workspaces": property("array", "Workspaces to capture with mode selected", items: "string")],
      idempotent: true),
  ]

  static let tools: [Tool] = workspaceTools + serviceTools + runTools + definitionTools + gitAndLaneTools + prTools + reproTools
  private static let toolsByName = Dictionary(uniqueKeysWithValues: tools.map { ($0.name, $0) })

  static var toolDescriptions: [JSONValue] { tools.map(describe) }

  private static func describe(_ tool: Tool) -> JSONValue {
    var schema: [String: JSONValue] = ["type": .string("object"), "properties": .object(tool.properties), "additionalProperties": .bool(false)]
    if !tool.required.isEmpty { schema["required"] = .array(tool.required.map { JSONValue.string($0) }) }
    return .object([
      "name": .string(tool.name), "title": .string(tool.title), "description": .string(tool.description), "inputSchema": .object(schema),
      "annotations": .object(["title": .string(tool.title), "readOnlyHint": .bool(tool.effect == .read),
        "destructiveHint": .bool(tool.effect == .destructive), "idempotentHint": .bool(tool.idempotent), "openWorldHint": .bool(false)]),
    ])
  }

  // MARK: Loop

  static let supportedProtocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

  static func run() -> Int32 {
    signal(SIGPIPE, SIG_IGN)
    let environment = ProcessInfo.processInfo.environment
    let session = MCPSession(name: environment["CINDERDECK_AGENT"], session: environment["CINDERDECK_AGENT_SESSION"],
      cwd: FileManager.default.currentDirectoryPath)
    while let line = readLine(strippingNewline: true) { session.receive(line) }
    // Answer calls already in flight before exiting, as a client that closed its input still reads them.
    session.finish()
    return 0
  }

  static func initializeResult(_ params: JSONValue) -> JSONValue {
    let requested = params["protocolVersion"]?.stringValue ?? ""
    return .object([
      "protocolVersion": .string(supportedProtocolVersions.contains(requested) ? requested : supportedProtocolVersions[0]),
      "capabilities": .object(["tools": .object(["listChanged": .bool(false)])]),
      "serverInfo": .object(["name": .string("cinderdeck"), "title": .string("Cinderdeck"), "version": .string(version)]),
      "instructions": .string(StackAgentGuide.mcpInstructions),
    ])
  }

  private static var version: String {
    StackCLI.appBundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
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

  // MARK: Tool calls

  /// Rejects unknown and missing arguments with the valid names, before anything reaches the app.
  static func validate(_ name: String, _ arguments: [String: JSONValue]) throws {
    guard let tool = toolsByName[name] else {
      throw StackControlError(code: "unknown_tool", message: "Unknown tool \(name). Call tools/list for the current tools.")
    }
    let unknown = arguments.keys.filter { tool.properties[$0] == nil }.sorted()
    guard unknown.isEmpty else {
      let valid = tool.properties.keys.sorted()
      throw StackControlError.invalid("Unknown argument \(unknown.joined(separator: ", ")) for \(name). " +
        (valid.isEmpty ? "It takes no arguments." : "Arguments: " + valid.joined(separator: ", ")))
    }
    let missing = tool.required.filter { arguments[$0] == nil || arguments[$0] == .null }
    guard missing.isEmpty else { throw StackControlError.invalid("Missing \(missing.joined(separator: ", ")) for \(name)") }
  }

  fileprivate static func call(_ params: JSONValue, session: MCPSession) -> JSONValue {
    let name = params["name"]?.stringValue ?? ""
    let arguments = params["arguments"]?.objectValue ?? [:]
    do {
      try validate(name, arguments)
      let (method, request, timeout) = try self.request(for: name, arguments)
      let result = try session.perform(method, request, timeout: timeout, retryable: toolsByName[name]?.effect == .read)
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

  /// The control method, its parameters, and how long to wait for the app's answer.
  static func request(for tool: String, _ arguments: [String: JSONValue]) throws -> (String, [String: JSONValue], TimeInterval) {
    var params = arguments
    let wait = min(max(arguments["timeout"]?.doubleValue ?? 180, 1), 900)
    switch tool {
    case "list_workspaces": return ("workspace.list", ["detail": .bool(true)], 30)
    case "workspace_details": return ("workspace.get", params, 30)
    case "open_workspace": return ("workspace.open", params, 30)
    case "run_workspace_task": return ("workspace.task.run", params, 30)
    case "run_workspace_workflow": return ("workspace.workflow.run", params, 30)
    case "wait_for_workspace_run":
      let timeout = min(max(arguments["timeout"]?.doubleValue ?? 600, 1), 3600)
      return ("workspace.run.wait", params, timeout + 30)
    case "workspace_run_status": return ("workspace.run.get", params, 30)
    case "workspace_run_logs": return ("workspace.run.logs", params, 30)
    case "list_workspace_runs":
      if params["limit"] == nil { params["limit"] = .number(20) }
      return ("workspace.runs", params, 30)
    case "cancel_workspace_run": return ("workspace.run.cancel", params, 120)
    case "create_workspace": return ("workspace.create", params, 60)
    case "save_workspace_service": return ("workspace.service.save", params, 60)
    case "save_workspace_task": return ("workspace.task.save", params, 60)
    case "save_workspace_workflow": return ("workspace.workflow.save", params, 60)
    case "delete_workspace_item": return ("workspace.item.delete", params, 60)
    case "workspace_guide": return ("paths", [:], 30)
    case "validate_workspace": return ("validate", params, 30)
    case "reload_workspaces": return ("reload", [:], 30)
    case "start_services": return ("services.start", params, wait + 30)
    case "stop_services": return ("services.stop", params, wait + 30)
    case "restart_services": return ("services.restart", params, wait + 60)
    case "read_service_logs": return ("logs", params, 30)
    case "recent_activity": return ("events", params, 30)
    case "list_ports":
      if params.removeValue(forKey: "external_only")?.boolValue == true { params["external"] = .bool(true) }
      return ("ports", params, 30)
    case "stop_port_process": return ("port.kill", params, 30)
    case "claim_workspace":
      if let ttl = params.removeValue(forKey: "ttl_minutes") { params["ttlMinutes"] = ttl }
      return ("claim", params, 30)
    case "release_workspace": return ("release", params, 30)
    case "git_status": return ("git.status", params, 90)
    case "list_branches": return ("git.branches", params, 90)
    case "switch_branch": return ("git.switch", params, 300)
    case "pull_repos": return (arguments["fetch"]?.boolValue == true ? "git.fetch" : "git.pull", params, 300)
    case "list_lanes": return ("lane.list", params, 120)
    case "create_lane": return ("lane.create", params, wait + 3900)
    case "adopt_lane": return ("lane.adopt", params, wait + 3900)
    case "lane_env": return ("lane.env", params, 30)
    case "run_lane_setup": return ("lane.setup", params, 3900)
    case "remove_lane": return ("lane.remove", params, 4200)
    case "release_lane": return ("lane.release", params, 600)
    case "prune_lanes": return ("lane.prune", params, 4200)
    case "unpin_lane": return ("lane.unpin", params, 60)
    case "list_pr_views": return ("prs.views.list", params, 90)
    case "upsert_pr_view": return ("prs.views.upsert", params, 90)
    case "select_pr_view": return ("prs.views.select", params, 90)
    case "delete_pr_view": return ("prs.views.delete", params, 90)
    case "reorder_pr_views": return ("prs.views.reorder", params, 90)
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
    case "repro_recording_scope": return ("repro.scope", params, 30)
    default: throw StackControlError(code: "unknown_tool", message: "Unknown tool \(tool)")
    }
  }

  // MARK: Results

  /// Each frame as an image block followed by its timestamp, markers, and output.
  static func frameContent(_ result: JSONValue) -> [JSONValue] {
    var content: [JSONValue] = []
    for frame in result["frames"]?.arrayValue ?? [] {
      if let data = frame["imageBase64"]?.stringValue {
        content.append(.object(["type": .string("image"), "data": .string(data), "mimeType": .string(frame["mimeType"]?.stringValue ?? "image/jpeg")]))
      }
      var text = "Frame at \(frame["time"]?.stringValue ?? "?") (\(frame["width"]?.intValue ?? 0)×\(frame["height"]?.intValue ?? 0)), saved to \(frame["path"]?.stringValue ?? "")"
      if let note = frame["note"]?.stringValue { text += "\n" + note }
      let markers = (frame["markers"]?.arrayValue ?? []).map { marker in
        "  [\(marker["time"]?.stringValue ?? "")] ▶ \(marker["label"]?.stringValue ?? "")" + (marker["outcome"]?.stringValue.map { " [\($0.uppercased())]" } ?? "")
      }
      if !markers.isEmpty { text += "\nMarkers:\n" + markers.joined(separator: "\n") }
      let logs = (frame["logs"]?.arrayValue ?? []).map(logText)
      text += logs.isEmpty ? "\n(no output in this window)" : "\nOutput before this frame:\n" + logs.joined(separator: "\n")
      content.append(.object(["type": .string("text"), "text": .string(text)]))
    }
    return content.isEmpty ? [.object(["type": .string("text"), "text": .string(result.compactString())])] : content
  }

  private static func logText(_ line: JSONValue) -> String {
    let level = line["level"]?.stringValue ?? "info"
    let badge = level == "error" ? " ERROR" : level == "warning" ? " WARN" : ""
    return "[\(line["time"]?.stringValue ?? "")]\(badge) \(line["source"]?.stringValue ?? "") | \(line["text"]?.stringValue ?? "")"
  }

  /// Plain text for logs, compact JSON for everything else. Workspace status is trimmed to what agents act on;
  /// workspace_details keeps every field.
  static func render(_ tool: String, _ result: JSONValue) -> String {
    switch tool {
    case "repro_logs":
      let lines = (result["lines"]?.arrayValue ?? []).map(logText)
      let header = "\(result["returned"]?.intValue ?? lines.count) of \(result["total"]?.intValue ?? 0) lines · video \(ReproFormat.timestamp(result["duration"]?.doubleValue ?? 0))"
      return header + "\n" + (lines.isEmpty ? "(no matching output)" : lines.joined(separator: "\n"))
    case "read_service_logs":
      let lines = (result["lines"]?.arrayValue ?? []).map { line in
        "\(line["service"]?.stringValue ?? "") | \(line["text"]?.stringValue ?? "")"
      }
      let cursor = result["cursor"]?.doubleValue.map { String($0) } ?? ""
      let files = (result["files"]?.objectValue ?? [:]).map { "\($0.key): \($0.value.stringValue ?? "")" }.sorted().joined(separator: "\n")
      return (lines.isEmpty ? "(no output)" : lines.joined(separator: "\n")) + "\n\n[cursor: \(cursor)]\n[log files]\n" + files
    case "list_workspaces":
      let entries = result.arrayValue ?? []
      if entries.isEmpty { return "No workspaces yet. Create one with create_workspace (workspace_guide shows the file format)." }
      return JSONValue.array(entries.map(compactWorkspace)).compactString()
    case "list_lanes":
      guard let snapshots = try? result.decode([StackSnapshot].self) else { return result.compactString() }
      return JSONValue.array(snapshots.map { .object(compact($0)) }).compactString()
    case "start_services", "stop_services", "restart_services", "create_lane", "adopt_lane", "run_lane_setup", "unpin_lane", "switch_branch", "create_workspace",
      "save_workspace_service", "save_workspace_task", "save_workspace_workflow", "delete_workspace_item":
      guard var object = result.objectValue, let snapshot = try? object["workspace"]?.decode(StackSnapshot.self) else { return result.compactString() }
      object["workspace"] = .object(compact(snapshot))
      return JSONValue.object(object).compactString()
    case "workspace_guide":
      var object = result.objectValue ?? [:]
      object["cli"] = .string(StackCLI.preferredCommandPath())
      object["rules"] = .string("One TOML file per workspace; the file name is its id. Services must run in the foreground. Use double-quoted strings, [services.<id>], [tasks.<id>] and [workflows.<id>] tables, and dotted keys (ready.port, env.NAME). No inline tables, arrays of tables, or multiline strings. Write ports and URLs as {{port.<service>}} / {{url.<service>}} (also {{port.<service>.<name>}} for ports.<name>, {{url.<workspace>:<service>}}, {{lane.slug}}, {{lane.ident}}, {{repo.<id>}}) so values follow each worktree lane; literal localhost ports keep pointing at the original checkout. A [lanes] table sets copy (.env files), setup and teardown (task:<id> or workflow:<id>), from, env and hosts; lane = \"shared\" or \"off\" on a service or repo controls whether lanes run their own copy.")
      object["socket"] = nil
      return JSONValue.object(object).compactString()
    default:
      return result.compactString()
    }
  }

  private static func compactWorkspace(_ entry: JSONValue) -> JSONValue {
    var object = (entry["status"].flatMap { try? $0.decode(StackSnapshot.self) }.map(compact))
      ?? ["id": entry["id"] ?? .null, "name": entry["name"] ?? .null]
    for key in ["tasks", "workflows"] where !(entry[key]?.arrayValue ?? []).isEmpty { object[key] = entry[key] }
    if let run = entry["activeRun"], run != .null {
      object["activeRun"] = .object(["id": run["id"] ?? .null, "kind": run["kind"] ?? .null, "name": run["name"] ?? .null, "status": run["status"] ?? .null])
    }
    if object["issues"] == nil, let issues = entry["issues"], !(issues.arrayValue ?? []).isEmpty { object["issues"] = issues }
    return .object(object)
  }

  static func compact(_ workspace: StackSnapshot) -> [String: JSONValue] {
    var object: [String: JSONValue] = [
      "id": .string(workspace.id), "name": .string(workspace.name), "state": .string(workspace.state),
      "services": .array(workspace.services.map { service in
        var entry: [String: JSONValue] = ["name": .string(service.name), "status": .string(service.status)]
        if let url = service.url { entry["url"] = .string(url) }
        if let pid = service.pid { entry["pid"] = .number(Double(pid)) }
        if let owner = service.owner, service.pid != nil { entry["startedBy"] = .string(owner.label) }
        if let branch = service.branch { entry["branch"] = .string(branch) }
        if let detail = service.detail { entry["detail"] = .string(detail) }
        if let warning = service.bindWarning { entry["portWarning"] = .string(warning) }
        if let source = service.sharedFrom { entry["sharedFrom"] = .string(source) }
        if let ports = service.ports { entry["ports"] = (try? JSONValue(encoding: ports)) ?? .null }
        return .object(entry)
      }),
    ]
    if let operation = workspace.operation { object["busy"] = .string(operation) }
    if workspace.definitionChanged { object["definitionChanged"] = .string("Restart to apply definition changes") }
    if let lane = workspace.lane { object["lane"] = try? JSONValue(encoding: lane) }
    if let status = workspace.laneStatus {
      var summary: [String: JSONValue] = ["folder": .string(status.directory)]
      if let setup = status.setup { summary["setup"] = .string(setup.status.rawValue + (setup.detail.map { ": " + $0 } ?? "")) }
      if status.merged == true { summary["merged"] = .bool(true) }
      if status.upstreamGone == true { summary["upstreamDeleted"] = .bool(true) }
      if status.pinned { summary["pinned"] = .bool(true) }
      if status.adopted { summary["adopted"] = .bool(true) }
      if !status.shared.isEmpty { summary["sharedServices"] = .array(status.shared.map(JSONValue.string)) }
      summary["worktrees"] = .array(status.worktrees.map { .string($0.path.path + ($0.managed ? "" : " (adopted)")) })
      object["laneStatus"] = .object(summary)
    }
    if let claim = workspace.claim {
      object["claim"] = .object(["by": .string(claim.holder.label), "note": .string(claim.note ?? ""),
        "until": .string(ISO8601DateFormatter().string(from: claim.expiresAt))])
    }
    if !workspace.issues.isEmpty { object["issues"] = .array(workspace.issues.map { JSONValue.string($0) }) }
    if !workspace.repos.isEmpty {
      object["repos"] = .array(workspace.repos.map { repo -> JSONValue in
        var text = "\(repo.id): \(repo.branch)"
        if repo.dirty { text += " (\(repo.changedFiles) changed)" }
        if repo.ahead > 0 { text += " ↑\(repo.ahead)" }
        if repo.behind > 0 { text += " ↓\(repo.behind)" }
        return .string(text)
      })
    }
    return object
  }
}

/// One MCP client over stdio. Requests are read in order; tool calls run concurrently on a pool of
/// control connections, and responses are written whole, one per line, as they finish.
nonisolated final class MCPSession: @unchecked Sendable {
  private let lock = NSLock()
  private let output = NSLock()
  private var client: StackControlClientInfo
  private let namedByEnvironment: Bool
  private var idle: [StackControlConnection] = []
  private var inFlight = Set<String>()
  private var cancelled = Set<String>()
  private let calls = DispatchGroup()
  private let queue = DispatchQueue(label: "cinderdeck.mcp.calls", qos: .userInitiated, attributes: .concurrent)
  private let write: @Sendable (Data) -> Void

  init(name: String?, session: String?, cwd: String?, write: @escaping @Sendable (Data) -> Void = { FileHandle.standardOutput.write($0) }) {
    client = StackControlClientInfo(name: name, session: session, cwd: cwd)
    namedByEnvironment = name != nil
    self.write = write
  }

  func receive(_ line: String) {
    guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    guard let message = try? StackControlCoding.decoder().decode(JSONValue.self, from: Data(line.utf8)) else {
      return send(["jsonrpc": .string("2.0"), "id": .null, "error": .object(["code": .number(-32700), "message": .string("Parse error")])])
    }
    guard message.objectValue != nil else {
      return send(["jsonrpc": .string("2.0"), "id": .null, "error": .object(["code": .number(-32600), "message": .string("Send one JSON-RPC object per line")])])
    }
    // Responses to server requests: this server sends none.
    guard let method = message["method"]?.stringValue else { return }
    let params = message["params"] ?? .object([:])
    guard let id = message["id"], id != .null else { return notification(method, params) }
    switch method {
    case "initialize":
      if !namedByEnvironment, let name = params["clientInfo"]?["name"]?.stringValue {
        lock.withLock { client.name = CinderdeckMCPServer.displayName(name) }
      }
      respond(id, result: CinderdeckMCPServer.initializeResult(params))
    case "ping": respond(id, result: .object([:]))
    case "tools/list": respond(id, result: .object(["tools": .array(CinderdeckMCPServer.toolDescriptions)]))
    case "tools/call":
      let key = id.compactString()
      lock.withLock { _ = inFlight.insert(key) }
      calls.enter()
      queue.async { [self] in
        defer { calls.leave() }
        respond(id, result: CinderdeckMCPServer.call(params, session: self))
      }
    case "resources/list": respond(id, result: .object(["resources": .array([])]))
    case "resources/templates/list": respond(id, result: .object(["resourceTemplates": .array([])]))
    case "prompts/list": respond(id, result: .object(["prompts": .array([])]))
    default:
      send(["jsonrpc": .string("2.0"), "id": id, "error": .object(["code": .number(-32601), "message": .string("Method not found: \(method)")])])
    }
  }

  /// Waits for tool calls in flight to answer.
  func finish() { calls.wait() }

  private func notification(_ method: String, _ params: JSONValue) {
    // The app finishes a cancelled action, but its response is dropped as the protocol requires.
    guard method == "notifications/cancelled", let id = params["requestId"] else { return }
    let key = id.compactString()
    lock.withLock { if inFlight.contains(key) { cancelled.insert(key) } }
  }

  private func respond(_ id: JSONValue, result: JSONValue) {
    let key = id.compactString()
    let wasCancelled = lock.withLock { () -> Bool in
      _ = inFlight.remove(key)
      return cancelled.remove(key) != nil
    }
    guard !wasCancelled else { return }
    send(["jsonrpc": .string("2.0"), "id": id, "result": result])
  }

  private func send(_ object: [String: JSONValue]) {
    guard var data = try? StackControlCoding.encoder().encode(JSONValue.object(object)) else { return }
    data.append(10)
    output.withLock { write(data) }
  }

  // MARK: Control connections

  /// Calls the app on a pooled connection. A request that never reached the app is retried once on a new
  /// connection (launching Cinderdeck if needed); read-only calls are also retried after a dropped answer.
  func perform(_ method: String, _ params: [String: JSONValue], timeout: TimeInterval, retryable: Bool) throws -> JSONValue {
    let client = lock.withLock { self.client }
    let connection = try checkout(client)
    do {
      let result = try connection.call(method, params, timeout: timeout)
      checkin(connection)
      return result
    } catch let error as StackControlError {
      // The app answered, so the connection is healthy, unless the wait timed out with the answer still pending.
      if error.code != "timeout" { checkin(connection) }
      throw error
    } catch {
      guard (error as? StackControlTransportError) == .notSent || retryable else { throw error }
      let fresh = try StackCLI.connect(client)
      let result = try fresh.call(method, params, timeout: timeout)
      checkin(fresh)
      return result
    }
  }

  private func checkout(_ client: StackControlClientInfo) throws -> StackControlConnection {
    if let pooled = lock.withLock({ idle.popLast() }) {
      pooled.client = client
      return pooled
    }
    return try StackCLI.connect(client)
  }

  private func checkin(_ connection: StackControlConnection) {
    lock.withLock { if idle.count < 4 { idle.append(connection) } }
  }
}
