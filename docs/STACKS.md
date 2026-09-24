# Services (formerly Stacks)

Workspaces now groups **Services, Tasks, Workflows, and Runs** in a dedicated window. Existing Stacks definitions and service controls remain compatible. See [WORKSPACES.md](WORKSPACES.md) for the task/workflow model, editors, lifecycle, and agent API.

Stacks runs any collection of local development projects from **Workspaces… → Services**. Projects can be in different folders and use different languages or tools. Git is optional; several services can share one repository. Nothing starts automatically when you add a definition or open Cinderdeck.

## Add services to a workspace

1. Choose **+** in Workspaces, name the workspace and choose its project folder. Then choose **Edit workspace**.
2. Choose **Add project…**, select a folder, and enter the command you normally use to run it. Give each service a unique name. Add an optional port, and enable Git branch information if the folder is a Git working tree.
3. Repeat for the other projects. The editor writes ordinary TOML and lets you add dependencies, readiness checks, environment variables, and optional services.
4. Choose **Save workspace**, then **Start**. **Save & open in editor** opens the file in your default editor instead.

A new workspace starts empty. Add services here, or use the Tasks and Workflows tabs for commands that finish. Service IDs and file names use letters, numbers, hyphens, and underscores.

Compact cards show service state and repository branches. Expand with **⌘E** for repositories, per-service controls, logs, and recent activity. Pin with **⌘P** while watching logs. Clicking a port opens localhost in your browser. The actions menu opens project folders in Finder or VS Code, edits the definition, refreshes the shell environment, or restarts an individual service.

## Definition format

One file per stack lives in `~/.config/cinderdeck/stacks/<id>.toml`. Change the folder in **Settings → History → Workspaces**. Files reload shortly after saving; a running service keeps its original launch settings until restarted. Invalid definitions show an error instead of launching. Unknown keys show warnings.

This example uses arbitrary project names. Replace the paths and commands with yours:

```toml
name = "My projects"
root = "~/Src"
restart_on_branch_change = true

[env]
NODE_ENV = "development"

[secrets]
API_KEY = "development-api-key"

[repos.api]
path = "my-backend"

[repos.site]
path = "my-frontend"

[services.api]
repo = "api"
cmd = "npm run dev"
port = 4000
ready.http = "http://localhost:4000/health"

[services.site]
repo = "site"
cmd = "pnpm dev"
depends_on = ["api"]
port = 3000
ready.port = 3000
env.API_URL = "http://localhost:4000"

# A service does not need a Git repo.
[services.worker]
cwd = "my-worker"
cmd = "uv run python worker.py"
autostart = false
ready.log = "Ready for work"
```

Use double-quoted strings, arrays of strings, named tables, and dotted keys. This is Cinderdeck's TOML subset: array-of-tables, inline tables, and multiline strings are not supported. Duplicate keys and malformed values are rejected with line numbers.

| Field | Default | Behavior |
| --- | --- | --- |
| `name` | File name | Display name |
| `root` | Definition file's folder | Base for relative paths; expands `~` |
| `shell` | `$SHELL`, then `/bin/zsh` | Executable shell path |
| `restart_on_branch_change` | `true` | Restart affected running services around Git checkout/pull |
| `[env]` | Empty | Shared environment variables; string values |
| `[secrets]` | Empty | Environment variable → Keychain item name |
| `[repos.<id>] path` | Required | Git working tree; relative to `root` or absolute |
| `[services.<id>] cmd` | Required | Shell command; any local tool or language |
| `repo` | None | Repository ID; sets the default working directory and branch restart association |
| `cwd` | Repo path, then `root` | Relative to the repo if associated, otherwise `root`; absolute paths also work |
| `depends_on` | `[]` | Service IDs that must become ready first |
| `port` | None | Displayed localhost link and port-conflict check |
| `ready.port` | None | TCP connection to `127.0.0.1` |
| `ready.http` | None | HTTP response below 500 (including 404) |
| `ready.log` | None | Regular expression in this run's service output |
| `ready.timeout` | `90` seconds | Mark unhealthy and allow dependents to start; continue checking |
| `restart` | `"on-failure"` | Or `"no"`; at most 3 retries per 60 seconds, after 1, 2, and 4 seconds |
| `stop_signal` | `"TERM"` | Or `"INT"`; sent to the entire process group |
| `stop_timeout` | `10` seconds | Escalate to SIGKILL after this interval |
| `autostart` | `true` | `false` services require manual Start |
| `env.<name>` | None | Override shared environment variables for one service |

If multiple readiness checks are configured, precedence is port, HTTP, then log. Without a check, staying alive for two seconds counts as ready. Timeouts must be positive and no greater than 3,600 seconds; ports must be integers from 1 to 65,535. A dependent of an optional, stopped service waits until you manually start that dependency.

### Environment and secrets

Cinderdeck captures your login/interactive shell environment, including tool paths configured by Homebrew, nvm, dotnet, uv, and pnpm. A five-second timeout falls back to a noninteractive login shell. The actions menu can refresh the cached environment after tool changes.

Precedence is shell → shared environment → service environment → Keychain secrets. Cinderdeck then sets color/buffering flags and `CINDERDECK_STACK` / `CINDERDECK_SERVICE`. `DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1` is supplied unless you explicitly set it. Commands run with `shell -c` using that resolved environment; startup files are not run a second time over your overrides.

**Settings → History → Workspaces → Manage secrets** adds, replaces, or removes generic-password items in the Keychain service `Cinderdeck Stacks`. Missing secrets prevent startup and name the missing reference. Values are never included in Cinderdeck configuration exports or run records. As with a terminal, a service can print its own environment, so treat its output files as local development logs.

## Running, stopping, and recovery

- Green: ready. Yellow: starting/waiting/stopping. Orange triangle: running with a failing readiness check. Red: crashed or unable to start. Hollow circle: stopped.
- Independent services start together. A dependent starts as soon as its prerequisites are ready, even if an unrelated service is still starting.
- Stop stack uses reverse dependency order. Stop service leaves its dependents running. **Option-click Restart** also restarts dependents.
- Occupied ports show the owner and offer **Kill & start** or **Cancel**. Cinderdeck confirms and rechecks owner identity before signaling it. Remaining listeners after Stop are shown with a Kill action.
- **Quit** offers Stop stacks and quit, Quit and leave running, or Cancel. Remembering the choice changes Settings → History → Workspaces. Under Leave, stdout/stderr remain connected to files and services continue running.
- On relaunch, Cinderdeck matches the saved process ID, process-group ID, and kernel start time before reconnecting. Dead/reused PIDs are discarded. Even a removed or invalid definition leaves controls for stopping an already running service.
- Crash retries stop after three attempts within a minute. Crash notifications include recent output and a **Restart** action when notifications are allowed. For a reattached process, the original exit code is unavailable because Cinderdeck is no longer its parent; an unexpected exit is treated as a failure.

Services must remain in the foreground. A daemon that calls `setsid`, or `docker compose up -d`, escapes normal group ownership. Use `docker compose up` without `-d` and configure ports so surviving listeners can be identified. Cinderdeck does not otherwise manage containers. The console is read-only; commands that require terminal input need to be configured for unattended development use.

## Parallel worktree lanes

Use a lane when agents need different branches running at the same time:

```sh
cinderdeck lane create shop agent/codex-1 --as Codex --session codex-1
cinderdeck lane create shop agent/claude-2 --as "Claude Code" --session claude-2
cinderdeck lane list shop
cinderdeck stacks logs shop/agent/codex-1
cinderdeck stacks stop shop/agent/codex-1
cinderdeck stacks start shop/agent/codex-1
cinderdeck lane remove shop/agent/codex-1
```

`lane create <stack> <branch>` snapshots the stack definition, creates a worktree for each independent repository, claims the lane for the caller, and starts its services in dependency order. It uses an existing local branch or creates one from each repository's current `HEAD`. A branch already checked out in another worktree is rejected. The original checkout, local edits, and running services stay in place. A lane can be addressed by its returned ID or `<source-stack>/<branch>` with all stack commands, including claims, logs, Git status, and restart.

Open **Lanes** in the expanded stack view (or the branch icon in compact view) to see the original checkout and its lanes side by side, with owners, claims, service states, and ports. Each card controls only that lane. You can also create a lane there and inspect its services in the main view. MCP exposes `create_lane`, `list_lanes`, and `remove_lane`.

Every lane service receives its own `PORT`, plus `CINDERDECK_PORT_<SERVICE>` for **every service in that lane**, including services that are not started. Service names are uppercased and hyphens become underscores: `web-app` becomes `CINDERDECK_PORT_WEB_APP`. These assignments override shell, TOML, and secret values. `CINDERDECK_LANE` contains the branch name; `CINDERDECK_SOURCE_STACK` identifies the source stack. Assignments persist while a lane exists, including across stops and app restarts. The allocator excludes configured base ports, other lanes, live launches, and occupied IPv4/IPv6 ports. If an outside process later takes a saved port, normal conflict handling reports it without killing that process.

Service commands must consume these variables. Cinderdeck remaps working directories and port/localhost HTTP readiness checks; it does not rewrite shell commands or arbitrary environment values. For example:

```toml
[services.api]
repo = "app"
cmd = "npm run dev -- --port \"$PORT\""
port = 4000
env.PORT = "4000" # Original checkout; overridden in lanes
ready.http = "http://localhost:4000/health"

[services.web]
repo = "app"
cmd = "API_URL=http://localhost:${CINDERDECK_PORT_API:-4000} npm run dev -- --port \"$PORT\""
port = 3000
env.PORT = "3000"
ready.port = 3000
depends_on = ["api"]
```

Use `--no-start` (MCP `start=false`) to create the worktrees first, then install dependencies or prepare local configuration in the returned service directories before calling `stacks start`. Uncommitted files, ignored files such as `.env` and `node_modules`, and external databases or Docker resources are not copied or isolated automatically. Avoid hardcoded checkout paths and fixed container ports/names. Lanes currently support independent Git repositories and one port per service; nested repositories and HTTP readiness against a different host/port are rejected.

Tasks and workflows are copied into the lane snapshot too. Task working directories and named port variables point into the lane, and lane removal waits for finite runs to finish or be cancelled.

Lane definitions are snapshots, stored with worktree metadata under `<stacks-directory>/.lanes/<lane-id>/lane.json`; editing the original TOML affects future lanes. Services, logs, saved process identities, and claims use the lane's unique ID. Claims are advisory leases (30 minutes by default); renew them while using a lane. The creation owner remains visible after a lease expires.

`lane remove` stops only that lane, removes its clean worktrees, and releases its claim. It preserves Git branches and logs. Removal refuses tracked changes, untracked files, and ignored files; move or clean those files yourself first. `--force` only overrides another agent's claim, never Git's data protection. Failed starts keep the lane for inspection; interrupted creation leaves a recovery record. The original stack cannot be removed with this command.

## Branches

Branch chips show `*` for local changes and `↑n ↓n` for upstream differences. Click a chip or press **⌘B** for Recent, Local, and Remote branches. Remote-only branches create local tracking branches. Merge, rebase, cherry-pick, and revert operations block checkout.

With local changes, choose **Stash & switch**, **Switch anyway**, or **Cancel**. Stash includes untracked files. Switch anyway lets Git preserve changes that do not conflict; it never forces a checkout. Cinderdeck stops the affected running services before checkout and starts them again afterward, including after a failed checkout. This includes other stacks using the same physical project folder, according to each stack's restart setting. Services that were already stopped stay stopped. Cinderdeck stashes never pop automatically; use the stash menu to Pop or confirm Drop.

Expanded mode includes Fetch, Pull, and **Switch stack to branch…**. A whole-stack switch shows how many repositories contain the branch and confirms which repositories will stay unchanged. One stop/start cycle covers the affected services. If one repository fails after others switched, the error names the completed repositories and leaves the remaining repositories untouched. Pull is fast-forward-only; divergence must be resolved in a terminal.

Git operations are serialized per repository, use the resolved shell environment and credential helpers, disable terminal prompts, and time out after 60 seconds. Git metadata watchers detect external checkouts, including linked worktrees. Dirty counts refresh when Stacks opens, every 30 seconds while visible, and after Git actions. Optional background fetch defaults to off.

## Logs and shortcuts

Terminals stay closed by default. Choose **Terminal** in an expanded stack, **Open terminal** in its actions menu, or the terminal button on a service to open a separate window. Each window stays attached to its stack when you navigate elsewhere. Stack and service badges identify the output, and colored service tabs switch between streams. Closing the window leaves the services running.

Each service retains the latest 5,000 lines in memory. The All view interleaves services by ingestion time with colored service prefixes. The console renders 16/256-color ANSI, bold, and dim, and strips cursor/terminal-control sequences. Use the terminal's text filter, Auto-scroll, Copy, and Clear. Clear affects the in-memory console only. The Activity tab shows stack events.

| Shortcut | Action |
| --- | --- |
| Arrow keys | Select a stack |
| Return | Start/stop the selected stack |
| ⌘R | Restart the selected stack |
| ⌘⇧R | Restart the selected service in expanded mode |
| ⌘. | Stop the selected stack |
| ⌘B | Open the first repo's branch picker, or the selected service's repo |
| ⌘L | Open and focus the selected stack or service terminal |
| ⌘E | Toggle compact/expanded |
| ⌘P | Pin/unpin |
| Delete | Does nothing on Stacks |

## Agents (MCP and CLI)

Coding agents can run and inspect stacks, so they stop spawning their own dev servers in scattered terminals. Everything goes through one local control socket owned by Cinderdeck; services an agent starts appear in the panel with a purple ✦ badge naming it.

**Set up:** Stacks → ✦ (or Settings → History → Workspaces → **Agent access…**). Install the CLI, then **Add** Cursor, Codex and/or Claude Code. From a terminal the same thing is:

```sh
/Applications/Cinderdeck.app/Contents/MacOS/Cinderdeck stacks install-cli   # links ~/.local/bin/cinderdeck
cinderdeck stacks setup-agents --instructions                           # Cursor, Codex, Claude Code (+ AGENTS.md/CLAUDE.md notes)
cinderdeck stacks setup-agents --print                                  # just show the config snippets
```

`setup-agents` backs up each file it edits (`*.cinderdeck-backup`), writes `mcpServers.cinderdeck` in `~/.cursor/mcp.json`, `[mcp_servers.cinderdeck]` in `~/.codex/config.toml` (with a 15-minute tool timeout because starts wait for readiness), and runs `claude mcp add --scope user` when the Claude CLI is installed. `--instructions` adds a marked block to `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`; re-running replaces the block instead of duplicating it.

### What agents get

| MCP tool | CLI | Purpose |
| --- | --- | --- |
| `list_stacks`, `stack_status` | `cinderdeck stacks status [stack] [--json]` | Services, phases, PIDs, ports/URLs, who started each one, branches, claims |
| `start_stack`, `stop_stack`, `restart_stack` | `start`, `stop`, `restart` | Dependency-ordered; start/restart **wait for readiness** and return the last output of anything that crashed |
| `read_logs` | `logs <stack> [service] -n 200 --grep re -f` | Plain-text output; pass the returned `cursor` as `after` to tail |
| `list_ports`, `stop_port_process` | `ports [port] [--external]`, `kill-port <port> <pid>` | Every listening port with process, cwd, tty and the app it came from (Cursor, Terminal, Codex, Android Studio…) or the Cinderdeck service that owns it |
| `git_status`, `list_branches`, `switch_branch`, `pull_repos` | `git`, `branches`, `switch <stack> <branch> [--stash|--carry]`, `fetch`, `pull` | Same stop → checkout → restart flow as the panel; uncommitted work fails unless `dirty=stash|carry` |
| `claim_stack`, `release_stack` | `claim <stack> [note] --ttl 30`, `release` | Advisory lease: other agents get a `claimed` error (CLI exit 3) unless they pass `force` |
| `recent_activity` | `events <stack>` | Starts, crashes, stops, branch switches — each with who caused it |
| `stacks_guide`, `validate_stack`, `reload_stacks` | `agent-help`, `validate <file>`, `reload`, `where` | Authoring stacks: paths, a template, validation and start order |

`cinderdeck mcp` is a stdio MCP server; if Cinderdeck isn't running, the first call launches it in the background. The CLI does the same.

### Who owns what

- **Actor identity.** Cinderdeck reads the caller's PID from the socket and walks its parent processes to find the app or agent CLI it runs inside (Cursor, Terminal, iTerm, Codex, Claude Code…). MCP clients add their own name from `initialize`; CLI callers can pass `--as <name>` / `--session <id>` or set `CINDERDECK_AGENT` / `CINDERDECK_AGENT_SESSION`. Labels look like `Codex · e2e in Cursor`.
- **Ownership persists.** The owner is saved with the run record, survives relaunch/reattach and branch-switch restarts, and is cleared when the service stops. Activity rows show a chip for who did what.
- **Claims** appear as a purple lock chip on the stack. You are never blocked by them; click the ✕ on the chip (or the menu) to release one.
- **Live state without calls:** `~/Library/Application Support/Cinderdeck/Stacks/state.json` is rewritten within ~300 ms of any change (stacks, services, owners, branches, claims, log paths). Log files stay at `~/Library/Logs/Cinderdeck/Stacks/<stack>/<service>.log`.

### Security

The control socket is `~/Library/Application Support/Cinderdeck/Stacks/control.sock`, mode 0600 inside a 0700 folder, and Cinderdeck rejects peers with a different user ID. Anything that can run as your user can drive stacks — the same trust level as your shell. Secret values never appear in state, snapshots or API responses. `stop_port_process` only signals a PID after re-checking it still owns the port with the same start time, and refuses Cinderdeck-managed services.

## Local storage

| Location | Contents |
| --- | --- |
| `~/.config/cinderdeck/stacks/*.toml` | User-owned definitions |
| `~/Library/Logs/Cinderdeck/Stacks/<stack>/<service>.log` | Output; truncated on start and at 50 MB, with append-mode writers |
| `~/Library/Application Support/Cinderdeck/cinderdeck.db` | Live process records and up to 1,000 recent events |
| Keychain service `Cinderdeck Stacks` | Secret values |
| `~/Library/Application Support/Cinderdeck/Stacks/` | `control.sock`, `state.json`, `claims.json` for agents |

The global configuration's `[stacks]` table exports `enabled`, `directory`, `quit_behavior`, `notify_on_crash`, and `auto_fetch_minutes`. Stack files, Keychain values, run records, and activity are not embedded in that export. Existing clipboard history and preferences are preserved; the old clipboard-selected flag migrates once to `history.selectedSection`.

## Development verification

Lane integration tests are included in `bash scripts/stacks-verify.sh test`. After building Debug, run `python3 scripts/lanes-e2e.py` for a real app/socket/CLI/MCP smoke test with throwaway Git repositories and HTTP services. `--inspect` pauses with the fixture UI open for checking the Lanes view; creating the printed continuation file verifies removal and cleans up the app and services.

See [the implementation record](STACKS_IMPLEMENTATION.md) for test evidence. Tests use temporary repositories, processes, and databases. They never switch branches in your own projects. The optional Debug environment variable `CINDERDECK_STACKS_PREVIEW_ROOT=/absolute/fixture/folder` launches the real panel with definitions in that folder's `stacks/` subfolder and separate database/log folders, without normal capture startup or configuration sync. This harness is absent from Release builds.

Process group creation follows [Apple's POSIX spawn API](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/posix_spawn.2.html); status parsing follows [Git's porcelain v2 format](https://git-scm.com/docs/git-status#_porcelain_format_version_2).
