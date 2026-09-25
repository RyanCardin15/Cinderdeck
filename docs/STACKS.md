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
cmd = "npm run dev -- --port {{port.api}}"
port = 4000
ready.http = "{{url.api}}/health"

[services.site]
repo = "site"
cmd = "pnpm dev --port {{port.site}}"
depends_on = ["api"]
port = 3000
ready.port = 3000
env.API_URL = "{{url.api}}"

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
| `[repos.<id>] lane` | `"worktree"` | `"shared"`: lanes use the original checkout of this repo |
| `shell` | `$SHELL`, then `/bin/zsh` | Executable shell path |
| `restart_on_branch_change` | `true` | Restart affected running services around Git checkout/pull |
| `[env]` | Empty | Shared environment variables; string values |
| `[secrets]` | Empty | Environment variable → Keychain item name |
| `[repos.<id>] path` | Required | Git working tree; relative to `root` or absolute |
| `[services.<id>] cmd` | Required | Shell command; any local tool or language |
| `repo` | None | Repository ID; sets the default working directory and branch restart association |
| `cwd` | Repo path, then `root` | Relative to the repo if associated, otherwise `root`; absolute paths also work |
| `depends_on` | `[]` | Service IDs that must become ready first; `"<workspace>:<service>"` for another workspace's service, which starts first |
| `port` | None | Displayed localhost link and port-conflict check; also sets `PORT` |
| `ports.<name>` | None | Extra named ports, such as `ports.hmr = 24678`; `CINDERDECK_PORT_<SERVICE>_<NAME>` |
| `lane` | `"isolate"` | In lanes: `"shared"` uses the original checkout's instance, `"off"` leaves it out |
| `ready.port` | None | TCP connection to `127.0.0.1`; a number or a port name |
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

Precedence is shell → shared environment → service environment → lane environment → Keychain secrets. Cinderdeck then sets color/buffering flags, `CINDERDECK_STACK` / `CINDERDECK_WORKSPACE` / `CINDERDECK_SERVICE`, `CINDERDECK_HOST`, and for every service with a port `CINDERDECK_PORT_<SERVICE>` and `CINDERDECK_URL_<SERVICE>`. A service with a `port` gets `PORT` unless the definition sets `env.PORT` itself.

### Templates

Commands, environment values and `ready.http` can contain `{{…}}` values. They are filled in for the original checkout and again for each lane, so one definition describes both:

| Template | Original checkout | Lane |
| --- | --- | --- |
| `{{port.api}}`, `{{port.web.hmr}}` | Configured port | Assigned port |
| `{{url.api}}` | `http://localhost:4000` | `http://<host>:<assigned port>` |
| `{{port.backend:api}}`, `{{url.backend:api}}` | Another workspace's service | That workspace's lane on the same branch, if there is one |
| `{{host}}` | `localhost` | `localhost`, or the lane hostname with `[lanes] hosts = true` |
| `{{lane.slug}}`, `{{lane.ident}}`, `{{lane.name}}`, `{{lane.dir}}` | Empty | `agent-codex-1`, `agent_codex_1`, `agent/codex-1`, lane folder |
| `{{repo.<id>}}` | Repo path | Worktree path |
| `{{workspace}}` | Workspace ID | Source workspace ID |

`{{x:-default}}` uses `default` when `x` is empty and `{{x:+text}}` writes `text` only when it is not, e.g. `"shop{{lane.ident:+_}}{{lane.ident}}"` is `shop` in the original checkout and `shop_agent_codex_1` in a lane. Only these names are templates; other `{{…}}` text such as `{{.State}}` is left as written. Unknown services, ports and names are errors with the field that uses them. A literal `localhost:<port>` pointing at another service's port is reported as a warning, because lanes would keep calling the original checkout. `DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1` is supplied unless you explicitly set it. Commands run with `shell -c` using that resolved environment; startup files are not run a second time over your overrides.

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
cinderdeck lane create shop agent/claude-2 --from origin/main --as "Claude Code" --session claude-2
cinderdeck lane list shop
cinderdeck services logs shop/agent/codex-1
eval "$(cinderdeck lane env shop/agent/codex-1 --export)"
cinderdeck lane remove shop/agent/codex-1
```

`lane create <workspace> <branch>` creates a worktree for each independent repository, claims the lane for the caller, runs the workspace's `[lanes] setup`, and starts its services in dependency order. A local branch is checked out as it is; a branch that only exists on a remote is checked out tracking it; otherwise a new branch starts at `--from` (default: `[lanes] from`, then each repository's `HEAD`). The original checkout, its local edits, and its running services stay in place. A lane can be addressed by its returned ID or `<workspace>/<branch>` with all commands, including claims, logs, Git status, and restart.

Worktrees go in `~/.cinderdeck/lanes/<workspace>/<lane>/<repository folder>` (change it in **Settings → History → Workspaces → Lane worktrees**, or per workspace with `[lanes] dir`). Lane folders are never created inside a source repository.

Open **Lanes** from any section of the Workspaces window, the expanded stack view, or the branch icon in compact view to see the original checkout and its lanes side by side, with owners, claims, setup state, merged branches, service states, and links. Each card controls only that lane and can open its folder in Finder, Terminal, VS Code or Cursor, or copy shell exports of its ports.

### Lanes follow their workspace

A lane stores only what differs from its workspace: worktrees, assigned ports, and per-lane choices. Its definition is derived from the current workspace file whenever it loads, so services, tasks, and environment changes reach existing lanes; restart a lane's services to apply them, as in the original checkout. Services added later get ports next to the lane's others. Lanes created by Cinderdeck 1.1 keep their saved definition and show **Pinned**; choose **Unpin** (`cinderdeck lane unpin`) to make them follow their workspace.

### Ports and environment

Only services with a `port`, `ports.<name>` or `ready.port` get lane ports. A lane reserves a block of ten ports from 20000 (larger when it needs more), excluding configured ports, other lanes, live launches, and occupied IPv4/IPv6 ports; assignments persist while the lane exists. Services receive `PORT`, `CINDERDECK_PORT_<SERVICE>[_<NAME>]` and `CINDERDECK_URL_<SERVICE>` for every service, plus `CINDERDECK_LANE` (the branch), `CINDERDECK_LANE_SLUG`, `CINDERDECK_LANE_DIR`, `CINDERDECK_SOURCE_STACK`, and `COMPOSE_PROJECT_NAME=<workspace>-<slug>` unless you set it. Lane values override shell, TOML, and secret values. Readiness checks on a service's own localhost ports follow the lane automatically; use `{{url.<service>}}` everywhere else.

Commands must use these values. Cinderdeck fills in `{{…}}` templates but does not rewrite literal ports. If a service listens, but not on any of its assigned ports, its port chip turns orange and the lane shows which port it used and that its command ignores `$PORT`.

```toml
[services.api]
repo = "app"
cmd = "npm run dev -- --port {{port.api}}"
port = 4000
ready.http = "{{url.api}}/health"

[services.web]
repo = "app"
cmd = "npm run dev -- --port {{port.web}}"
port = 3000
ports.hmr = 24678
env.API_URL = "{{url.api}}"
env.VITE_HMR_PORT = "{{port.web.hmr}}"
depends_on = ["api"]
```

With `[lanes] hosts = true`, lanes use `http://<lane>.<workspace>.localhost:<port>`, so browser cookies and logins stay separate per lane. Chrome, Firefox and curl resolve `*.localhost` to your Mac; some dev servers need the host added to their allowed hosts.

### Shared services and repositories

`lane = "shared"` on a service (or on its repository) makes lanes use the original checkout's instance: lanes do not run their own copy, `{{port.db}}` and `CINDERDECK_PORT_DB` point at it, starting a lane starts it there if needed, and stopping a lane leaves it running. Stopping it in the original checkout while lanes use it asks first (agents get an `in_use` error unless they pass `force`). `lane = "off"` leaves a service out of lanes. Service and task folders outside Git are shared automatically.

```toml
[services.db]
cmd = "docker compose up postgres"
port = 5432
ready.port = 5432
lane = "shared"

[services.api]
repo = "app"
cmd = "npm run dev -- --port {{port.api}}"
port = 4000
depends_on = ["db"]
env.DATABASE_URL = "postgres://localhost:{{port.db}}/shop{{lane.ident:+_}}{{lane.ident}}"
```

A workspace can depend on another workspace's service with `depends_on = ["backend:api"]` and `{{url.backend:api}}`. In a lane, it uses the backend's lane on the same branch when there is one, otherwise the backend's original checkout. Workspaces that share a repository share its worktree for the same branch; it is removed with the last lane that uses it.

### Setup, copied files, and adoption

```toml
[lanes]
from = "origin/main"          # start point for new branches
copy = [".env", "apps/*/.env"] # untracked files copied from each original checkout (never over files the branch has)
link = []                      # symlinks instead of copies, for large caches you accept sharing
setup = "task:install"         # task or workflow run after the worktrees are created, before services start
teardown = "task:drop-db"      # run before removal; removal stops if it fails
hosts = false
env.FEATURE_FLAGS = "lanes"    # lane-only values, after [env]
```

Setup runs as a normal run in the lane (see its output under Runs). If it fails, services are not started; fix it and choose **Run setup** (`cinderdeck lane setup`, MCP `run_lane_setup`). `lane create --no-setup` skips it, `--env KEY=VALUE` adds lane-only variables, and `--copy <glob>` copies more files. Submodules are initialized in new worktrees. Databases, Docker volumes and other outside resources are not created per lane automatically; do that in setup and teardown with `{{lane.ident}}`.

Agents that already work in their own worktree (Claude Code, Codex, Cursor, Conductor) can run it as a lane: `cinderdeck lane adopt shop` from that folder, or MCP `adopt_lane`. Cinderdeck never deletes an adopted worktree; other repositories of the workspace get worktrees on the same branch or stay shared. When a branch is already checked out in another worktree, `lane create` suggests adopting it.

### Removing and cleaning up

`lane remove` runs teardown, stops only that lane, removes its worktrees, and releases its claim. It keeps Git branches, adopted worktrees, and worktrees another lane still uses, and reports branches with commits on no remote. Tracked or untracked changes block removal. Ignored files (`node_modules`, build output, a changed `.env`) block it too, with their sizes listed, until you pass `--discard-ignored` (MCP `discard_ignored`); the Lanes view asks with a checkbox. Unchanged files Cinderdeck copied are removed without asking. `--force` only overrides another agent's claim, never Git's data protection. `lane release` forgets a lane but keeps its worktrees. Failed starts keep the lane for inspection; interrupted creation leaves a recovery record.

The Lanes view marks lanes whose branch was merged into the default remote branch, or whose upstream branch was deleted. `cinderdeck lane prune [workspace] --dry-run` lists them and `lane prune` removes the clean ones (MCP `prune_lanes`); `--missing` also removes lanes whose worktrees are gone. Logs of removed lanes are deleted after 14 days, or right away with `--delete-logs`.

If you switch branches inside a lane later, its name stays the same and the Lanes view shows the differing repository branch. Switching to a branch already checked out in another worktree is rejected before services are stopped or local changes are stashed. Lane records are stored in `<stacks-directory>/.lanes/<lane-id>/lane.json`. Services, logs, saved process identities, and claims use the lane's unique ID. Claims are advisory leases (30 minutes by default); renew them while using a lane. Nested repositories are not supported; mark the inner one `lane = "shared"`.

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

**Set up:** Stacks → ✦ (or Settings → History → Workspaces → **Agent access…**). Install the CLI, then **Add** Cursor, Codex, Claude Code, and/or VS Code Copilot. The **Agent skills** section installs the skills that ship with Cinderdeck, such as recording a browser session with its logs, or running a branch in a worktree lane, for each agent. From a terminal the same thing is:

```sh
/Applications/Cinderdeck.app/Contents/MacOS/Cinderdeck services install-cli   # links ~/.local/bin/cinderdeck
cinderdeck services setup-agents --instructions                           # Cursor, Codex, Claude Code, VS Code Copilot (+ AGENTS.md/CLAUDE.md notes)
cinderdeck services setup-agents --skills                                 # also install the agent skills
cinderdeck services setup-agents --print                                  # just show the config snippets
cinderdeck skills list                                                  # bundled skills and where each agent has them
cinderdeck skills install --all                                         # or --claude, --codex, --cursor, --copilot
```

`setup-agents` backs up each file it edits (`*.cinderdeck-backup`), writes `mcpServers.cinderdeck` in `~/.cursor/mcp.json`, `[mcp_servers.cinderdeck]` in `~/.codex/config.toml` (with a 15-minute tool timeout because starts wait for readiness), runs `claude mcp add --scope user` when the Claude CLI is installed, and writes `servers.cinderdeck` in VS Code's user `mcp.json` (`~/Library/Application Support/Code/User/`, and `Code - Insiders` when installed). `--instructions` adds a marked block to `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`; re-running replaces the block instead of duplicating it.

Skills are copied to `~/.claude/skills` (Claude Code), `~/.agents/skills` (Codex), `~/.cursor/skills` (Cursor), and `~/.copilot/skills` (VS Code Copilot). Cursor and VS Code Copilot also read the Claude Code and Codex folders, so a copy already there counts and is updated in place rather than duplicated. Each copy has a `.cinderdeck-skill` file. **Update** appears when a newer Cinderdeck ships a changed skill, and only copies with that file are replaced. A skill you manage yourself, such as a link to a clone of this repository, is never replaced. New skills added to `skills/` in the repository ship with the next build and appear in the list automatically.

### What agents get

| MCP tool | CLI (`cinderdeck services …`) | Purpose |
| --- | --- | --- |
| `list_workspaces`, `workspace_details` | `status [workspace] [--json]` | Services, phases, PIDs, ports/URLs, who started each one, branches, claims, tasks, workflows, and active runs |
| `start_services`, `stop_services`, `restart_services` | `start`, `stop`, `restart` | Dependency-ordered; each **waits** (start/restart for readiness) and returns the last output of anything that crashed |
| `read_service_logs` | `logs <workspace> [service] -n 200 --grep re -f` | Plain-text output; pass the returned `cursor` as `after` to tail |
| `list_ports`, `stop_port_process` | `ports [port] [--external]`, `kill-port <port> <pid>` | Every listening port with process, cwd, tty and the app it came from (Cursor, Terminal, Codex, Android Studio…) or the Cinderdeck service that owns it |
| `git_status`, `list_branches`, `switch_branch`, `pull_repos` | `git`, `branches`, `switch <stack> <branch> [--stash|--carry]`, `fetch`, `pull` | Same stop → checkout → restart flow as the panel; uncommitted work fails unless `dirty=stash|carry` |
| `claim_workspace`, `release_workspace` | `claim <workspace> [note] --ttl 30`, `release` | Advisory lease: other agents get a `claimed` error (CLI exit 3) unless they pass `force` |
| `recent_activity` | `events <workspace>` | Starts, crashes, stops, branch switches — each with who caused it |
| `create_workspace`, `save_workspace_service`, `save_workspace_task`, `save_workspace_workflow`, `delete_workspace_item` | Workspaces window | Validated definition edits; nothing starts on save |
| `workspace_guide`, `validate_workspace`, `reload_workspaces` | `agent-help`, `validate <file>`, `reload`, `where` | Authoring by hand: paths, a template, validation and start order |
| `create_lane`, `adopt_lane`, `list_lanes`, `lane_env`, `run_lane_setup`, `remove_lane`, `release_lane`, `prune_lanes`, `unpin_lane` | `cinderdeck lane …` | Parallel Git worktree lanes |

`cinderdeck mcp` is a stdio MCP server; if Cinderdeck isn't running, the first call launches it in the background. The CLI does the same. Tool calls run concurrently on pooled connections, so a long wait never blocks other calls or pings, and unknown or misspelled arguments are rejected with the valid names. Reload the tool list in connected clients after updating Cinderdeck.

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
| `~/.cinderdeck/lanes/<workspace>/<lane>/` | Lane worktrees; records in `<stacks-directory>/.lanes/` |

The global configuration's `[stacks]` table exports `enabled`, `directory`, `lanes_directory`, `quit_behavior`, `notify_on_crash`, and `auto_fetch_minutes`. Stack files, Keychain values, run records, and activity are not embedded in that export. Existing clipboard history and preferences are preserved; the old clipboard-selected flag migrates once to `history.selectedSection`.

## Development verification

Lane integration tests are included in `bash scripts/stacks-verify.sh test`. After building Debug, run `python3 scripts/lanes-e2e.py` for a real app/socket/CLI/MCP smoke test with throwaway Git repositories and HTTP services. `--inspect` pauses with the fixture UI open for checking the Lanes view; creating the printed continuation file verifies removal and cleans up the app and services.

See [the implementation record](STACKS_IMPLEMENTATION.md) for test evidence. Tests use temporary repositories, processes, and databases. They never switch branches in your own projects. The optional Debug environment variable `CINDERDECK_STACKS_PREVIEW_ROOT=/absolute/fixture/folder` launches the real panel with definitions in that folder's `stacks/` subfolder and separate database/log folders, without normal capture startup or configuration sync. This harness is absent from Release builds.

Process group creation follows [Apple's POSIX spawn API](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/posix_spawn.2.html); status parsing follows [Git's porcelain v2 format](https://git-scm.com/docs/git-status#_porcelain_format_version_2).
