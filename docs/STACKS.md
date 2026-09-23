# Stacks

Stacks runs any collection of local development projects from **⌘⇧H → Stacks**. Projects can be in different folders and use different languages or tools. Git is optional; several services can share one repository. Nothing starts automatically when you add a definition or open Snapzy.

## Create your first stack

1. Choose **Create stack** or **+**.
2. Choose **Add project…**, select a folder, and enter the command you normally use to run it. Give each service a unique name. Add an optional port, and enable Git branch information if the folder is a Git working tree.
3. Repeat for the other projects. The editor writes ordinary TOML and lets you add dependencies, readiness checks, environment variables, and optional services.
4. Choose **Save stack**, then **Start**. **Save & open in editor** opens the file in your default editor instead.

The initial commented template also works on its own: its harmless `hello` service prints a readiness message and waits. Adding your first project replaces that starter service. Service IDs and file names use letters, numbers, hyphens, and underscores.

Compact cards show service state and repository branches. Expand with **⌘E** for repositories, per-service controls, logs, and recent activity. Pin with **⌘P** while watching logs. Clicking a port opens localhost in your browser. The actions menu opens project folders in Finder or VS Code, edits the definition, refreshes the shell environment, or restarts an individual service.

## Definition format

One file per stack lives in `~/.config/snapzy/stacks/<id>.toml`. Change the folder in **Settings → History → Stacks**. Files reload shortly after saving; a running service keeps its original launch settings until restarted. Invalid definitions show an error instead of launching. Unknown keys show warnings.

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

Use double-quoted strings, arrays of strings, named tables, and dotted keys. This is Snapzy's TOML subset: array-of-tables, inline tables, and multiline strings are not supported. Duplicate keys and malformed values are rejected with line numbers.

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

Snapzy captures your login/interactive shell environment, including tool paths configured by Homebrew, nvm, dotnet, uv, and pnpm. A five-second timeout falls back to a noninteractive login shell. The actions menu can refresh the cached environment after tool changes.

Precedence is shell → shared environment → service environment → Keychain secrets. Snapzy then sets color/buffering flags and `SNAPZY_STACK` / `SNAPZY_SERVICE`. `DOTNET_WATCH_RESTART_ON_RUDE_EDIT=1` is supplied unless you explicitly set it. Commands run with `shell -c` using that resolved environment; startup files are not run a second time over your overrides.

**Settings → History → Stacks → Manage secrets** adds, replaces, or removes generic-password items in the Keychain service `Snapzy Stacks`. Missing secrets prevent startup and name the missing reference. Values are never included in Snapzy configuration exports or run records. As with a terminal, a service can print its own environment, so treat its output files as local development logs.

## Running, stopping, and recovery

- Green: ready. Yellow: starting/waiting/stopping. Orange triangle: running with a failing readiness check. Red: crashed or unable to start. Hollow circle: stopped.
- Independent services start together. A dependent starts as soon as its prerequisites are ready, even if an unrelated service is still starting.
- Stop stack uses reverse dependency order. Stop service leaves its dependents running. **Option-click Restart** also restarts dependents.
- Occupied ports show the owner and offer **Kill & start** or **Cancel**. Snapzy confirms and rechecks owner identity before signaling it. Remaining listeners after Stop are shown with a Kill action.
- **Quit** offers Stop stacks and quit, Quit and leave running, or Cancel. Remembering the choice changes Settings → History → Stacks. Under Leave, stdout/stderr remain connected to files and services continue running.
- On relaunch, Snapzy matches the saved process ID, process-group ID, and kernel start time before reconnecting. Dead/reused PIDs are discarded. Even a removed or invalid definition leaves controls for stopping an already running service.
- Crash retries stop after three attempts within a minute. Crash notifications include recent output and a **Restart** action when notifications are allowed. For a reattached process, the original exit code is unavailable because Snapzy is no longer its parent; an unexpected exit is treated as a failure.

Services must remain in the foreground. A daemon that calls `setsid`, or `docker compose up -d`, escapes normal group ownership. Use `docker compose up` without `-d` and configure ports so surviving listeners can be identified. Snapzy does not otherwise manage containers. The console is read-only; commands that require terminal input need to be configured for unattended development use.

## Branches

Branch chips show `*` for local changes and `↑n ↓n` for upstream differences. Click a chip or press **⌘B** for Recent, Local, and Remote branches. Remote-only branches create local tracking branches. Merge, rebase, cherry-pick, and revert operations block checkout.

With local changes, choose **Stash & switch**, **Switch anyway**, or **Cancel**. Stash includes untracked files. Switch anyway lets Git preserve changes that do not conflict; it never forces a checkout. Snapzy stops the affected running services before checkout and starts them again afterward, including after a failed checkout. This includes other stacks using the same physical project folder, according to each stack's restart setting. Services that were already stopped stay stopped. Snapzy stashes never pop automatically; use the stash menu to Pop or confirm Drop.

Expanded mode includes Fetch, Pull, and **Switch stack to branch…**. A whole-stack switch shows how many repositories contain the branch and confirms which repositories will stay unchanged. One stop/start cycle covers the affected services. If one repository fails after others switched, the error names the completed repositories and leaves the remaining repositories untouched. Pull is fast-forward-only; divergence must be resolved in a terminal.

Git operations are serialized per repository, use the resolved shell environment and credential helpers, disable terminal prompts, and time out after 60 seconds. Git metadata watchers detect external checkouts, including linked worktrees. Dirty counts refresh when Stacks opens, every 30 seconds while visible, and after Git actions. Optional background fetch defaults to off.

## Logs and shortcuts

Each service retains the latest 5,000 lines in memory. The All view interleaves services by ingestion time with colored service prefixes. The console renders 16/256-color ANSI, bold, and dim, and strips cursor/terminal-control sequences. Use the service picker, text filter, Auto-scroll, Copy, and Clear. Clear affects the in-memory console only. With the log pane focused, the top search field filters logs.

| Shortcut | Action |
| --- | --- |
| Arrow keys | Select a stack |
| Return | Start/stop the selected stack |
| ⌘R | Restart the selected stack |
| ⌘⇧R | Restart the selected service in expanded mode |
| ⌘. | Stop the selected stack |
| ⌘B | Open the first repo's branch picker, or the selected service's repo |
| ⌘L | Expand and focus logs |
| ⌘E | Toggle compact/expanded |
| ⌘P | Pin/unpin |
| Delete | Does nothing on Stacks |

## Local storage

| Location | Contents |
| --- | --- |
| `~/.config/snapzy/stacks/*.toml` | User-owned definitions |
| `~/Library/Logs/Snapzy/Stacks/<stack>/<service>.log` | Output; truncated on start and at 50 MB, with append-mode writers |
| `~/Library/Application Support/Snapzy/snapzy.db` | Live process records and up to 1,000 recent events |
| Keychain service `Snapzy Stacks` | Secret values |

The global configuration's `[stacks]` table exports `enabled`, `directory`, `quit_behavior`, `notify_on_crash`, and `auto_fetch_minutes`. Stack files, Keychain values, run records, and activity are not embedded in that export. Existing clipboard history and preferences are preserved; the old clipboard-selected flag migrates once to `history.selectedSection`.

## Development verification

See [the implementation record](STACKS_IMPLEMENTATION.md) for test evidence. Tests use temporary repositories, processes, and databases. They never switch branches in your own projects. The optional Debug environment variable `SNAPZY_STACKS_PREVIEW_ROOT=/absolute/fixture/folder` launches the real panel with definitions in that folder's `stacks/` subfolder and separate database/log folders, without normal capture startup or configuration sync. This harness is absent from Release builds.

Process group creation follows [Apple's POSIX spawn API](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/posix_spawn.2.html); status parsing follows [Git's porcelain v2 format](https://git-scm.com/docs/git-status#_porcelain_format_version_2).
