---
name: cinderdeck-parallel-lanes
description: Run a branch of a project side by side with the original checkout using Cinderdeck worktree lanes, each with its own Git worktree, ports, environment, logs, and claim. Use when asked to work on a branch in parallel, run several agents on one project at once, test a pull request branch without disturbing the running app, run the app from your own worktree (Claude Code, Codex, Cursor, Conductor), or make a workspace definition work in lanes (ports, .env files, shared databases, setup and cleanup).
---

# Run branches in parallel with Cinderdeck lanes

A lane is a copy of a Cinderdeck workspace on another branch. It has its own Git worktree for each repository, its own ports, its own logs, and a claim in your name. The original checkout keeps running. A lane is addressed as `<workspace>/<branch>` with every command.

Use the `cinderdeck` CLI. If the `cinderdeck` MCP server is connected, the tools map one to one:

| CLI | MCP |
| --- | --- |
| `workspace list` / `services status <ws>` | `list_workspaces` / `workspace_details` |
| `lane list [ws]` | `list_lanes` |
| `lane create <ws> <branch>` | `create_lane` |
| `lane adopt <ws> [name] --path <dir>` | `adopt_lane` |
| `lane env <lane> [service] --export` | `lane_env` |
| `lane setup <lane>` | `run_lane_setup` |
| `services start\|stop\|restart\|logs <lane>` | `start_services` / `stop_services` / `restart_services` / `read_service_logs` |
| `lane remove <lane>` / `lane release <lane>` | `remove_lane` / `release_lane` |
| `lane prune [ws] --dry-run` | `prune_lanes` |

Every command takes `--json`. Pass `--as <your name> --session <id>` on the CLI so the user can tell parallel agents apart.

## 1. Pick the path

```bash
cinderdeck lane list shop          # the original checkout and existing lanes
git worktree list                  # is the branch already checked out somewhere?
```

| Situation | Do |
| --- | --- |
| You work in the main checkout and want another branch running too | `lane create` |
| You already work in your own worktree (Claude Code `.claude/worktrees`, Codex, Cursor, Conductor) | `lane adopt` from that folder |
| A lane for your branch already exists | use it: `services status shop/<branch>` |
| The user wants the original checkout switched | not a lane: `services switch` (it stops and restarts their services) |

Never switch branches in, stop, or remove a lane or workspace that another agent has claimed unless the user tells you to.

## 2. Create or adopt

```bash
cinderdeck lane create shop agent/codex-1 --as Codex --session codex-1
cinderdeck lane create shop feature/pr-123            # a branch that only exists on origin is tracked as it is
cinderdeck lane create shop agent/fix --from origin/main --env FEATURE_X=1
cinderdeck lane adopt shop --path "$PWD" --as "Claude Code"   # your own worktree; Cinderdeck never deletes it
```

- `create` makes the worktrees, copies the files listed in `[lanes] copy` (such as `.env`), runs `[lanes] setup` (such as `npm ci`), then starts the services and waits until they are ready. Pass `--no-start` to prepare first, or `--no-setup` to skip setup.
- `adopt` does not run setup unless you pass `--setup`. Other repositories of the workspace get worktrees on the same branch.
- A failed setup leaves the lane created but stopped. Read it: `cinderdeck workspace runs shop/<branch>` then `workspace logs <run-id>` (MCP `workspace_run_logs`). Fix it and run `cinderdeck lane setup shop/<branch>`.
- `already checked out in <path>`: that worktree belongs to someone. If it is yours, adopt it. Otherwise pick another branch.
- `problems` in the result names services that crashed, with their last output. Fix and `services restart shop/<branch>`.

## 3. Use the lane's ports and URLs

Services in a lane listen on assigned ports (blocks from 20000), never the ones in the definition. Never guess `localhost:3000`.

```bash
cinderdeck lane list shop --json                      # laneStatus.urls and each service's url
eval "$(cinderdeck lane env shop/agent/codex-1 --export)"
curl "$CINDERDECK_URL_API/health"
npm test                                              # your own shell now sees PORT, CINDERDECK_PORT_*, CINDERDECK_URL_*
```

- `lane env <lane> <service>` gives exactly what that service runs with, including its `PORT`. Secrets are left out.
- Shared services (for example the database) point at the original checkout's instance. `list_lanes` shows them with `sharedFrom`.
- A port warning (`bindWarning` in CLI JSON, `portWarning` in MCP results, a yellow line in `services status`) means the command ignored `$PORT` and listens elsewhere. Fix the definition (step 5) instead of working around it.
- Record the lane in the browser with the `cinderdeck-record-session` skill, using the lane's URL and `--workspace <workspace>/<branch>`.

## 4. Finish

```bash
cinderdeck services stop shop/agent/codex-1           # frees the ports; the lane and its files stay
cinderdeck lane remove shop/agent/codex-1             # runs teardown, removes the worktrees, keeps the branch
cinderdeck lane release shop/agent/own                # an adopted lane: forget it, keep the worktree
```

- Commit or push your work first. Removal refuses tracked or untracked changes, and reports branches with commits on no remote.
- `ignored_files`: the worktree has `node_modules`, build output, or a changed `.env`. The error lists them with sizes. **Ask the user** before passing `--discard-ignored` (MCP `discard_ignored: true`).
- `teardown_failed`: the lane is kept. Read the run's output and fix it; use `--force-teardown` only if the user agrees.
- `in_use` when stopping the original checkout: running lanes use its shared services. Stop those lanes first, or pass `--force` with the user's approval.
- `cinderdeck lane prune --dry-run` lists lanes whose branch was merged or whose upstream branch was deleted. Show the list to the user before running `lane prune`.
- Release your claim when you are done with a lane you keep: `cinderdeck services release shop/<branch>`.

## 5. Make a workspace work in lanes

Lanes derive their definition from the workspace file every time it loads, so fix the workspace, not the lane (lane edits are refused). Check a file with `cinderdeck services validate <file>` (MCP `validate_workspace`); its warnings point out values lanes cannot follow. Edit with the MCP `save_workspace_*` tools or by hand, then `services reload`.

| Symptom in a lane | Fix in the workspace file |
| --- | --- |
| The lane's frontend calls the original checkout's API | `env.API_URL = "{{url.api}}"` instead of `"http://localhost:4000"` |
| A service ignores its assigned port | `cmd = "npm run dev -- --port {{port.web}}"`, or read `$PORT` |
| Readiness never passes in a lane | `ready.http = "{{url.api}}/health"`, or `ready.port = "<port name>"` |
| HMR, debugger, or a second listener collides | `ports.hmr = 24678` and `{{port.web.hmr}}` in the command or env |
| Missing `.env` | `[lanes] copy = [".env", "apps/*/.env"]` |
| Dependencies not installed | `[lanes] setup = "task:install"` with `[tasks.install] cmd = "npm ci"` |
| Every lane starts its own database, or the ports clash | `lane = "shared"` on the database service; per-lane data with `{{lane.ident}}` |
| Per-lane database or containers are left behind | create them in setup, drop them in `[lanes] teardown` |
| A service should not run in lanes | `lane = "off"` |
| Another workspace's service is needed | `depends_on = ["backend:api"]`, `env.API = "{{url.backend:api}}"` |
| Browser logins in two lanes overwrite each other | `[lanes] hosts = true` (`http://<lane>.<workspace>.localhost:<port>`) |

Templates: `{{port.<service>}}`, `{{port.<service>.<name>}}`, `{{url.<service>}}`, `{{port.<workspace>:<service>}}`, `{{host}}`, `{{lane.slug}}`, `{{lane.ident}}`, `{{lane.name}}`, `{{lane.dir}}`, `{{repo.<id>}}`, `{{workspace}}`. `{{x:-default}}` fills an empty value; `{{x:+text}}` writes `text` only in lanes. For example `"postgres://localhost:{{port.db}}/shop{{lane.ident:+_}}{{lane.ident}}"` is `shop` in the original checkout and `shop_agent_codex_1` in a lane. Other `{{…}}` text is left alone.

```toml
[services.db]
cmd = "docker compose up postgres"      # foreground, no -d
port = 5432
ready.port = 5432
lane = "shared"

[services.api]
repo = "app"
cmd = "npm run dev -- --port {{port.api}}"
port = 4000
ready.http = "{{url.api}}/health"
depends_on = ["db"]
env.DATABASE_URL = "postgres://localhost:{{port.db}}/shop{{lane.ident:+_}}{{lane.ident}}"

[tasks.install]
repo = "app"
cmd = "npm ci && (createdb shop{{lane.ident:+_}}{{lane.ident}} 2>/dev/null || true)"

[tasks.drop-db]                          # only runs as a lane's teardown
cmd = "dropdb --if-exists shop_{{lane.ident}}"

[lanes]
copy = [".env"]
setup = "task:install"
teardown = "task:drop-db"
```

Ask the user before changing their workspace file, and say what each change does in the original checkout (templates give the same values there as the literals they replace).

## Checklist

- [ ] Checked `lane list` and `git worktree list`; chose create, adopt, or an existing lane
- [ ] Used the lane's URLs and `lane env`, never the original checkout's ports
- [ ] Setup succeeded and services are ready (`problems`, port warnings, and setup status checked)
- [ ] Work committed or pushed before removal; asked before `--discard-ignored`, `--force`, or `prune`
- [ ] Removed, released, or stopped the lane, and released the claim when done
