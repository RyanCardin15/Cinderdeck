import Foundation

/// Text shown to coding agents: MCP server instructions, `cinderdeck stacks agent-help`,
/// and the block written into AGENTS.md / CLAUDE.md by `setup-agents`.
nonisolated enum StackAgentGuide {
  static let mcpInstructions = """
  Cinderdeck Workspaces contains Services (long-running processes), Tasks (finite commands with exit status), and Workflows (ordered steps).
  Use list_workspaces and workspace_details to discover configured tasks and workflows. run_workspace_task and run_workspace_workflow
  return a run UUID immediately; poll workspace_run_status and workspace_run_logs. A waiting timeout is not a failed run: inspect
  the existing UUID rather than starting another. cancel_workspace_run stops the command group and skips later steps.
  Workflows stop on failure and can clean up only services they started. Task and workflow runs are recorded locally.
  Existing stack tools continue controlling services. Cinderdeck Stacks runs the user's local dev services (APIs, frontends, emulators) as named stacks. \
  Prefer these tools over starting long-running dev servers in your own terminal: services started here keep running, \
  show up in the user's Cinderdeck panel, and are attributed to you. \
  Typical flow: list_stacks → claim_stack (while you depend on it) → start_stack (waits until ready and returns \
  crash output if something fails) → read_logs when debugging → release_stack when done. \
  Before starting your own server, call list_ports to see who already owns the port (another agent's terminal, \
  a Cinderdeck service, or the user). Never stop a stack claimed by someone else without asking the user. \
  For concurrent branch work, prefer create_lane over switch_branch: it creates an independent worktree stack \
  with unique ports and a claim in your name, leaving the original services running. Use the returned lane id or \
  <source-stack>/<branch> with all stack tools. Commands must consume PORT and CINDERDECK_PORT_<UPPERCASE_SERVICE> \
  (hyphens become underscores). Set start=false to install dependencies or prepare local configuration first. \
  Claims expire; renew yours while using the lane. remove_lane preserves branches and refuses local or ignored files. \
  switch_branch refuses to touch uncommitted work unless you pass dirty=stash or dirty=carry.
  To configure local Pull Request tabs, call list_pr_views, then upsert_pr_view, select_pr_view, \
  reorder_pr_views, or delete_pr_view with the returned account and hostname. Use stable ids to avoid duplicate tabs. \
  These tools share the PR window's saved views and do not post to GitHub. Built-in tabs are read-only except selection.
  Repros record the screen while capturing every service and task log on the video's timeline. Use them to reproduce \
  a bug or to test UI end to end: start_repro_recording (optionally with workspace + task/workflow to record a run; \
  list_repro_windows then window_id=<id> records exactly one window, followed if it moves; logs=false records no workspace output) → \
  drive the app → mark_repro at each step, with outcome pass/fail for checks, and add_repro_logs for browser console output → \
  stop_repro_recording (or wait_for_repro for a run). The result has a verdict (clean, errors, failed) and error highlights \
  with video timestamps, and logFile: a plain-text log with every line stamped with its video time. Then use repro_frame to see the screen at first_error or any marker (returns images plus the \
  log lines just before), repro_logs to read output around a moment, and export_repro to hand the user a bundle. \
  The user sees floating controls while you record and can stop it. Do not record longer than the task needs.
  """

  static let template = """
  # ~/.config/cinderdeck/stacks/<id>.toml  (id: letters, numbers, - and _)
  name = "My project"
  root = "~/Src"                  # base for relative paths

  [repos.api]                     # optional: Git working trees shown with branches
  path = "my-api"

  [services.db]
  cmd = "docker compose up db"    # stay in the foreground (no -d)
  port = 5432
  ready.port = 5432

  [services.api]
  repo = "api"                    # cwd defaults to the repo path
  cmd = "npm run dev"
  depends_on = ["db"]
  port = 4000
  ready.http = "http://localhost:4000/health"   # or ready.log = "listening"
  env.DATABASE_URL = "postgres://localhost:5432/app"
  """

  static func instructions(command: String) -> String {
    """
    ## Local dev services (Cinderdeck Stacks)

    This machine runs dev services through Cinderdeck Stacks. Use it instead of starting \
    long-running servers in your own terminal, so services are shared, visible to the user, and attributed to you.

    - MCP: the `cinderdeck` server (tools `list_stacks`, `start_stack`, `read_logs`, `list_ports`, `switch_branch`, …).
    - CLI: `\(command) stacks <command> [--json]`
      - Parallel work: `\(command) lane create <stack> <branch>` creates and starts a worktree lane; use `--no-start` for setup first
      - `\(command) lane list [stack]` / `\(command) lane remove <stack>/<branch>` (clean worktrees only; branches are kept)
      - Use `<stack>/<branch>` with all stack commands; each service receives its assigned `PORT` and every `CINDERDECK_PORT_<UPPERCASE_SERVICE>`
      - `status` — every stack, service state, ports, owners and branches
      - `start <stack> [service…]` — starts in dependency order and waits until ready (`--no-wait` to return early)
      - `restart <stack> [service]`, `stop <stack> [service…]`
      - `logs <stack> [service] -n 200 [--grep regex] [-f]`
      - `ports` — who owns each listening port (Cinderdeck service, or which app/terminal started it)
      - `claim <stack> --note "running e2e" --ttl 30` / `release <stack>` while you depend on a stack
      - `switch <stack> <branch> [--repo id] [--stash|--carry]`, `git <stack>`, `branches <stack>`
    - Live state without any call: `\(StackControlPaths.state.path)`; log files: `~/Library/Logs/Cinderdeck/Stacks/<stack>/<service>.log`
    - Stack definitions are TOML files in `~/.config/cinderdeck/stacks/`. Validate with `\(command) stacks validate <file>`.
    - Respect claims held by other agents. Do not kill processes you did not start without asking the user.

    ## Tasks and workflows

    Workspaces contain services that stay running, tasks that finish, and workflows that run steps in order.
    - Discover: `list_workspaces`, `workspace_details`; CLI `\(command) workspace list` / `workspace show <id>`.
    - Run: `run_workspace_task`, `run_workspace_workflow`; CLI `workspace task <workspace> <task>` / `workspace workflow <workspace> <workflow>`.
    - Keep the returned run UUID. Inspect it with `workspace_run_status`, `workspace_run_logs`, or CLI `workspace status <uuid>` / `workspace logs <uuid>`.
    - Cancel with `cancel_workspace_run` or `workspace cancel <uuid>`. Never replay a run just because a wait timed out.
    - Definitions use `[tasks.<id>] cmd = "..."` and `[workflows.<id>] steps = ["start:api", "task:test"]` in the existing stack TOML files.
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
      (pipe lines on stdin to stream them).
    - Record a test run: pass `workspace` and `task` or `workflow`, or `\(command) repro run <workspace> <workflow> --workflow --wait` \
      (exit status 1 when a service crashed, a check failed, or the run failed).
    - While recording, mark each step: `mark_repro` with `label`, and `outcome` pass/fail for checks; CLI `repro mark "Total shows $42" --pass`.
    - Finish: `stop_repro_recording` / `repro stop`, or `wait_for_repro` / `repro wait` for a run. Read the verdict and highlights.
    - Investigate: `repro_frame` (`at`: first_error, seconds, mm:ss, or marker:<label>) returns the frame as an image with the output just \
      before it; `repro_logs` filters by `around`, `from`/`to`, `source`, `level`, `grep`; `repro_summary` includes Git state and uncommitted files.
    - Share: `export_repro` writes video, README.md, recording.log, per-source logs, frames, and diffs (`--zip` for an archive).
    - Every repro has a plain-text log file (`logFile` in results; CLI `\(command) repro dump`) with each line stamped `[video time  clock time]`.
    - Recordings people make with the toolbar while workspaces run are repros too: `list_repros` shows them, so you can read the log for what they saw.
    - `\(command) repro scope` shows or sets which workspaces the user's toolbar recordings capture; change it only when asked.
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
