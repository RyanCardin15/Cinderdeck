import Foundation

/// Text shown to coding agents: MCP server instructions, `cinderdeck services agent-help`,
/// and the block written into AGENTS.md / CLAUDE.md by `setup-agents`.
nonisolated enum StackAgentGuide {
  static let mcpInstructions = """
  Cinderdeck runs the user's local development environment. A workspace groups Services (long-running: APIs, frontends, \
  databases, emulators), Tasks (commands that finish with an exit status), and Workflows (ordered task, start, and stop steps). \
  What you start appears in the user's Cinderdeck window, attributed to you.
  Services: list_workspaces → claim_workspace while you depend on one → start_services (waits until ready and returns crash \
  output) → read_service_logs to debug → release_workspace when done. Prefer this over running dev servers in your own terminal, \
  and call list_ports before starting one yourself. Never stop, restart, or switch branches in a workspace someone else claimed \
  without asking the user. Claims expire; renew yours while you work.
  Tasks and workflows: run_workspace_task and run_workspace_workflow return a run id immediately. wait_for_workspace_run \
  returns the result with the failing step's output; workspace_run_status and workspace_run_logs read progress. A wait that \
  ends first is not a failure: wait again, never start the run again. cancel_workspace_run stops a run.
  Definitions: create_workspace, save_workspace_service, save_workspace_task, save_workspace_workflow, and delete_workspace_item \
  edit a workspace's TOML file with validation; nothing starts on save. For other settings, edit the file (workspace_guide has \
  paths and a template), then validate_workspace and reload_workspaces.
  Parallel branches: create_lane makes an isolated Git worktree copy of a workspace on a branch (tracking a remote-only branch), \
  runs its [lanes] setup, and starts it on unique ports with a claim in your name, leaving the original running. Already in \
  your own worktree? adopt_lane runs it as a lane without moving it. Use the returned <workspace>/<branch> id with every tool. \
  Services read PORT, CINDERDECK_PORT_<SERVICE> and CINDERDECK_URL_<SERVICE>; definition values written as {{port.api}} or \
  {{url.api}} resolve per lane. lane_env gives those values for your own shell or tests. Services marked shared (databases) \
  run once in the original checkout. remove_lane keeps branches, refuses uncommitted work, and needs discard_ignored=true to \
  delete ignored files such as node_modules (ask the user first). switch_branch changes the original checkout and refuses \
  uncommitted work unless dirty=stash or dirty=carry.
  Repros record the screen with every service and task log on the video timeline, to reproduce bugs or test UI end to end: \
  start_repro_recording (window_id from list_repro_windows records exactly one window, followed if it moves; workspace plus \
  task or workflow records a run; logs=false records no workspace output) → drive the app → mark_repro at each step, with \
  outcome pass/fail for checks, and add_repro_logs for browser console output → stop_repro_recording, or wait_for_repro for a \
  run. Results have a verdict (clean, errors, failed), error highlights with video times, and logFile, a plain-text log stamped \
  with video times. Investigate with repro_frame (images at first_error or a marker, with the output just before), repro_logs, \
  and repro_summary; export_repro hands the user a bundle. The user sees floating controls and can stop a recording, so keep \
  recordings short. repro_recording_scope sets which workspaces the user's own toolbar recordings capture; change it only when asked.
  Pull Request tabs: list_pr_views, then upsert_pr_view, select_pr_view, reorder_pr_views, or delete_pr_view with the returned \
  account and hostname. Use stable ids to avoid duplicate tabs. These change local tabs only and never post to GitHub.
  """

  static let template = """
  # ~/.config/cinderdeck/stacks/<id>.toml  (id: letters, numbers, - and _)
  name = "My project"
  root = "~/Src/my-project"       # base for relative paths

  [repos.api]                     # optional: Git working trees shown with branches
  path = "api"

  [services.db]
  cmd = "docker compose up db"    # stay in the foreground (no -d)
  port = 5432
  ready.port = 5432

  [services.api]
  repo = "api"                    # cwd defaults to the repo path
  cmd = "npm run dev"
  depends_on = ["db"]
  port = 4000
  ready.http = "{{url.api}}/health"   # or ready.log = "listening"
  env.DATABASE_URL = "postgres://localhost:{{port.db}}/app{{lane.ident:+_}}{{lane.ident}}"

  [tasks.test]                    # finite command: exit 0 succeeds
  repo = "api"
  cmd = "npm test"
  requires_services = ["db"]
  timeout = 600

  [workflows.verify]              # ordered steps: task:<id>, start:<service>, stop:<service>
  steps = ["start:api", "task:test"]
  cleanup_services = true

  # Optional: how parallel worktree lanes are prepared. {{…}} values resolve per lane.
  # [services.db] lane = "shared" runs one database for every lane.
  # [lanes]
  # copy = [".env"]               # untracked files copied from the original checkout
  # setup = "task:install"        # runs after the worktrees are created, before start
  # teardown = "task:drop-db"     # runs before removal
  """

  static func instructions(command: String) -> String {
    """
    ## Local dev environment (Cinderdeck Workspaces)

    This machine runs dev services through Cinderdeck. A workspace groups services that stay running, tasks that finish, \
    and workflows that run steps in order. Use it instead of starting long-running servers in your own terminal, so \
    services are shared, visible to the user, and attributed to you.

    - MCP: the `cinderdeck` server (`list_workspaces`, `start_services`, `read_service_logs`, `run_workspace_task`, `list_ports`, …).
    - CLI: `\(command) services <command> [--json]`
      - `status` — every workspace, service state, ports, owners and branches
      - `start <workspace> [service…]` — starts in dependency order and waits until ready (`--no-wait` to return early)
      - `restart <workspace> [service]`, `stop <workspace> [service…]`
      - `logs <workspace> [service] -n 200 [--grep regex] [-f]`
      - `ports` — who owns each listening port (Cinderdeck service, or which app/terminal started it)
      - `claim <workspace> --note "running e2e" --ttl 30` / `release <workspace>` while you depend on a workspace
      - `switch <workspace> <branch> [--repo id] [--stash|--carry]`, `git <workspace>`, `branches <workspace>`
    - Parallel work: `\(command) lane create <workspace> <branch> [--from origin/main]` creates, sets up and starts a worktree lane
      - Already in your own worktree: `\(command) lane adopt <workspace>` (from that folder) runs it as a lane; Cinderdeck never deletes it
      - `\(command) lane list [workspace]` / `\(command) lane remove <workspace>/<branch>` (branches are kept; `--discard-ignored` also deletes node_modules and build output — ask first)
      - Use `<workspace>/<branch>` with every command; each service receives its assigned `PORT`, every `CINDERDECK_PORT_<UPPERCASE_SERVICE>` and `CINDERDECK_URL_<SERVICE>`
      - `eval "$(\(command) lane env <workspace>/<branch> --export)"` gives your shell the lane's ports and URLs for tests and curl
    - Live state without any call: `\(StackControlPaths.state.path)`; log files: `~/Library/Logs/Cinderdeck/Stacks/<workspace>/<service>.log`
    - Definitions are TOML files in `~/.config/cinderdeck/stacks/`. Edit them with the MCP `save_workspace_*` tools, or by hand and \
      validate with `\(command) services validate <file>`.
    - Respect claims held by other agents. Do not kill processes you did not start without asking the user.

    ## Tasks and workflows

    - Discover: `list_workspaces`, `workspace_details`; CLI `\(command) workspace list` / `workspace show <id>`.
    - Run: `run_workspace_task`, `run_workspace_workflow`; CLI `workspace task <workspace> <task>` / `workspace workflow <workspace> <workflow>`.
    - Keep the returned run UUID. `wait_for_workspace_run` returns the result, with the failing step's output. Inspect it with \
      `workspace_run_status`, `workspace_run_logs`, or CLI `workspace status <uuid>` / `workspace logs <uuid>`.
    - Cancel with `cancel_workspace_run` or `workspace cancel <uuid>`. Never replay a run just because a wait timed out.
    - Add or change them with `save_workspace_task` and `save_workspace_workflow`, or `[tasks.<id>] cmd = "..."` and \
      `[workflows.<id>] steps = ["start:api", "task:test"]` in the workspace file.
    - Tasks can set `requires_services = ["api"]` and `timeout = 600`. Workflows can set `cleanup_services = true` to stop only services started by that run.
    - Optional CLI `--wait` waits and returns a nonzero exit code for failure; its `--timeout` stops waiting without cancelling the run.

    ## Repros: screen recordings with synced logs

    A repro is a screen recording plus all workspace output captured on the video's timeline, with markers for service \
    starts, crashes, workflow steps, and your own checks. Use it to reproduce bugs and to test UI changes end to end.
    - Record: `start_repro_recording` (MCP) or `\(command) repro start --title "Checkout" [--window Safari] [--max 120]`.
    - Pick a window exactly: `list_repro_windows` / `\(command) repro windows`, then `window_id` / `--window-id <id>`. The capture follows the window \
      if it moves and includes its app's menus and dropdowns. A headless browser has no window and cannot be recorded; run it headed.
    - Choose logs: `workspace`/`workspaces` (CLI `--workspace a,b`), all running workspaces by default, or `logs: false` / `--no-logs` for none.
    - Add your own output, such as browser console messages: `add_repro_logs` or `\(command) repro append "text" --source browser` \
      (pipe lines on stdin to stream them). Lines and marks sent in parallel with the stop, or up to 2 minutes after it, still reach \
      that repro's log; after that pass `repro`. Lines added after the stop without a time are placed at the end of the video.
    - Record a test run: pass `workspace` and `task` or `workflow`, or `\(command) repro run <workspace> <workflow> --workflow --wait` \
      (exit status 1 when a service crashed, a check failed, or the run failed).
    - While recording, mark each step: `mark_repro` with `label`, and `outcome` pass/fail for checks; CLI `repro mark "Total shows $42" --pass`.
    - Finish: `stop_repro_recording` / `repro stop`, or `wait_for_repro` / `repro wait` for a run. Read the verdict and highlights.
    - Investigate: `repro_frame` (`at`: first_error, seconds, mm:ss, or marker:<label>) returns the frame as an image with the output just \
      before it; `repro_logs` filters by `around`, `from`/`to`, `source`, `level`, `grep`; `repro_summary` includes Git state and uncommitted files.
    - Share: `export_repro` writes video, README.md, recording.log, per-source logs, frames, and diffs (`--zip` for an archive).
    - Every repro has a plain-text log file (`logFile` in results; CLI `\(command) repro dump`) with each line stamped `[video time  clock time]`.
    - Recordings people make with the toolbar while workspaces run are repros too: `list_repros` shows them, so you can read the log for what they saw.
    - `repro_recording_scope` / `\(command) repro scope` shows or sets which workspaces the user's toolbar recordings capture; change it only when asked.
    - The user sees floating controls while you record and can stop it at any time. Keep recordings short and focused.

    ## Pull Request views

    - Use `list_pr_views` to inspect saved tabs, queries, active filters, and the current GitHub account.
    - `upsert_pr_view` creates or patches a custom tab using a stable id, a name (required on creation), and optional filters.
    - `select_pr_view`, `reorder_pr_views`, and `delete_pr_view` manage selection and custom tabs. Supply the account and hostname returned by the list tool for every change. CLI `--host` pins the server; omitting it uses the server selected in Cinderdeck.
    - CLI: `\(command) prs views list`, then `\(command) prs views upsert my-review-queue --account <login> --name "My reviews" --role review --select`. Use `prs --help` for all options.
    - Filters support repository (owner/name, or null), organization (login, or null), state, role, sort, text, label, and advanced query mode. Omitted fields are preserved. To use GitHub search qualifiers, set advanced=true and text to the query, or use CLI `--query`.
    - Query mode replaces simple state/label/text; repository, organization, and role scope still apply. My work defaults to PRs involving the account. `@me` resolves to that account.
    - Changes appear live and persist locally per GitHub host and account. Built-in tabs cannot be edited, deleted, or reordered. Selecting a tab replaces unsaved filters. These tools do not post reviews or modify GitHub repositories.
    """
  }
}
