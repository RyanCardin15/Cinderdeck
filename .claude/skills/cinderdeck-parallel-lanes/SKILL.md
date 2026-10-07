---
name: cinderdeck-parallel-lanes
description: Run a branch of a project side by side with the original checkout using Cinderdeck worktree lanes, each with its own Git worktree, ports, environment, and logs. Use when asked to work on a branch in parallel, run several agents on one project at once, test a pull request branch without disturbing the running app, run the app from your own worktree (Claude Code, Codex, Cursor, Conductor), or make a workspace definition work in lanes (ports, .env files, shared databases, setup and cleanup).
---

# Run branches in parallel with Cinderdeck lanes

A lane runs a Cinderdeck workspace from another checkout. Choose a new Git worktree for each repository that needs isolated changes. Other repositories can stay as references to the primary checkout, with no checkout or branch creation. Worktrees have separate service ports and logs. The original checkout keeps running. Agent, CLI, MCP and managed feature creation or adoption execute directly without opening a modal or waiting for manual confirmation. Supply `--name` (MCP `name`) for a useful lane name. Omit the branch for a generated `codex/` branch; omit both branch and name for Lane 1, Lane 2, etc. Manual **New lane** actions use the creation sheet, where the user can edit the name and each repository's checkout and base. Cancelling that sheet creates nothing. Each worktree checkout allows four minutes; setup and submodule initialization retain their separate budgets. Always use the returned stable lane ID or returned `<workspace>/<name>`; renaming leaves the Git branch unchanged.

Use the `cinderdeck` CLI. If the `cinderdeck` MCP server is connected, the tools map one to one:

| CLI | MCP |
| --- | --- |
| `workspace list` / `services status <ws>` | `list_workspaces` / `workspace_details` |
| `lane list [ws]` | `list_lanes` |
| `lane create <ws> [branch]` | `create_lane` |
| `lane adopt <ws> [name] --path <dir>` | `adopt_lane` |
| `lane env <lane> [service] --export` | `lane_env` |
| `lane edit <lane> --name <name>` / `--env KEY=VALUE` / `--clear-env` | `update_lane` |
| `lane setup <lane>` | `run_lane_setup` |
| `lane unpin <lane>` | `unpin_lane` |
| `services start\|stop\|restart\|logs <lane>` | `start_services` / `stop_services` / `restart_services` / `read_service_logs` |
| `lane remove <lane>` / `lane release <lane>` | `remove_lane` / `release_lane` |
| `lane prune [ws] --dry-run` | `prune_lanes` |

Every command takes `--json`. Pass `--as <your name> --session <id>` on the CLI so the user can tell parallel agents apart.

## 1. Pick the path

Repository defaults live in `[repos.<id>] lane_from = "main"` (or `"develop"`). Workspace settings exposes a branch picker for each isolated repository. `[lanes] from` is the fallback, then HEAD. Tool `repositoryRefs`, CLI `--repo-from` and `--from` apply overrides directly. The manual sheet shows current workspace branches as context and preserves shared folders. Use a new Git branch when choosing explicit bases. Agents create the lane themselves through the tools and use the returned result to continue.

```bash
cinderdeck lane list shop          # the original checkout and existing lanes
git worktree list                  # is the branch already checked out somewhere?
```

| Situation | Do |
| --- | --- |
| You work in the main checkout and want another branch running too | `lane create` |
| You already work in your own worktree (Claude Code `.claude/worktrees`, Codex, Cursor, Conductor) | `lane adopt` from that folder |
| A lane for your branch already exists | use its returned ID or name: `services status shop/<name>` |
| The user wants the original checkout switched | not a lane: `services switch` (it stops and restarts their services) |

Agents can use any lane or checkout without claiming it. Use distinct branches when independent edits need separate files.

## 2. Create or adopt

```bash
cinderdeck lane create shop agent/codex-1 --as Codex --session codex-1
cinderdeck lane create shop feature/pr-123            # a branch that only exists on origin is tracked as it is
cinderdeck lane create shop agent/fix --from origin/main --env FEATURE_X=1
cinderdeck lane adopt shop --path "$PWD" --as "Claude Code"   # your own worktree; Cinderdeck never deletes it
cinderdeck lane adopt shop review/pr-123 --path "$PWD" --env FEATURE_X=1
```

- `create` makes the worktrees, copies the files listed in `[lanes] copy` (such as `.env`), runs `[lanes] setup` (such as `npm ci`), then starts the services and waits until they are ready. Pass `--no-start` to prepare first, or `--no-setup` to skip setup.
- Choose each repository's checkout through the tool arguments, or **New worktree** / **Reference** in the manual creation sheet. Workspace settings supply the defaults; choices are saved for this lane only. References use primary-checkout files as context; do not edit them or run checks that modify those files.
- CLI: repeat `--repo-mode app=worktree --repo-mode api=reference`; MCP: `repositoryModes: {app: "worktree", api: "reference"}` on `create_lane` or `adopt_lane`. Omitted repos keep their workspace defaults. The adopted repository must remain a worktree.
- For a code review, inspect the changed repository set first. If a workspace has four repositories and only one has changes under review, create a worktree only for that repository and explicitly select references for the other three. Supply `repositoryRefs` only for the worktree repositories.
- For independent repository revisions, repeat `--repo-from app=<commit> --repo-from api=origin/main` (MCP `repositoryRefs: {app: "<commit>", api: "origin/main"}`). Each selected branch must be new. Cinderdeck resolves the references to commits before creating anything, refuses conflicting aliases and leaves unselected repositories on their normal defaults. Never pass a commit from one repository as the global `--from` for another.
- `adopt` does not run setup unless you pass `--setup`. Other repositories selected as worktrees use the same branch; select references for repositories needed only as context.
- An optional adopted lane name changes its address, not its Git branch. Other repositories use the adopted worktree's actual branch. Use **Existing worktree** in the Lanes panel for the same flow; its Open menu targets the actual repositories.
- A detached HEAD needs an explicit name (for example `review/pr-123`). If other repositories need worktrees too, they use that name as their branch. `--from`, `--env` and `--copy` also work with adoption (MCP `from`, `env`, `copy`); copying only touches newly created worktrees of other repositories, leaving the adopted folder alone.
- Workspaces using the same repository and branch share files, though their services and ports are separate. Use different branches for independent edits. Adopted or released worktrees stay external even when another workspace borrows them.
- A failed setup leaves the lane created but stopped. Read it: `cinderdeck workspace runs shop/<name>` then `workspace logs <run-id>` (MCP `workspace_run_logs`). Fix it and run `cinderdeck lane setup shop/<name>`.
- `already checked out in <path>`: that worktree belongs to someone. If it is yours, adopt it. Otherwise pick another branch.
- `problems` in the result names services that crashed, with their last output. Fix and `services restart shop/<name>`.

## 3. Use the lane's ports and URLs

Services in a lane listen on assigned ports (blocks from 20000), never the ones in the definition. Never guess `localhost:3000`.

```bash
cinderdeck lane list shop --json                      # laneStatus.urls and each service's url
eval "$(cinderdeck lane env shop/agent/codex-1 api --export)"
curl "$CINDERDECK_URL_API/health"
# Run tests from the API's actual worktree path reported by laneStatus.worktrees.
npm test                                              # shell sees the API's PORT, env, and workspace ports/URLs
```

- `lane env <lane> <service>` exports its `PORT` and resolved definition variables. Shell variables and secrets are left out.
- Without a service, `lane env <lane>` exports workspace-wide variables and ports/URLs; it does not select a service's `PORT` or environment. Change into the repository's actual worktree folder before running commands; an adopted worktree may be outside the lane directory. Prefer `workspace task <lane> <task> --wait` for configured tests so Cinderdeck resolves the task's folder and environment.
- Shared services (for example the database) point at the original checkout's instance. `list_lanes` shows them with `sharedFrom`.
- A port warning (`bindWarning` in CLI JSON, `portWarning` in MCP results, a yellow line in `services status`) means the command ignored `$PORT` and listens elsewhere. Fix the definition (step 5) instead of working around it.
- Record the lane in the browser with the `cinderdeck-record-session` skill, using the lane's URL and `--workspace <workspace>/<name>`.

For a different feature flag, stop the lane and use `lane edit <lane> --env FEATURE_X=1` (MCP `update_lane`). The supplied environment **replaces** its lane overrides; include every override you want to keep. `--clear-env` (MCP `env: {}`) clears them. `--name` works while services and runs are active, and changes its address while preserving its ID, branches, worktrees, slug and ports. Click the name in the lane header for the same action. MCP `update_lane` accepts `expectedName` to protect a name changed by someone else. In the embedded harness, `t3_worktree_status` reports `laneName` and `t3_worktree_rename` renames only your current native lane. On the first session, you may replace a default branch name with a concise task name; preserve custom names and leave the default if context is insufficient. Omitted fields stay unchanged; restart after environment edits when ready.

## 4. Finish

```bash
cinderdeck services stop shop/agent/codex-1           # frees the ports; the lane and its files stay
cinderdeck lane remove shop/agent/codex-1             # runs teardown, removes the worktrees, keeps the branch
cinderdeck lane release shop/agent/own                # an adopted lane: forget it, keep the worktree
```

- Commit or push your work first. Removal refuses tracked or untracked changes, and reports branches with commits on no remote.
- Removal checks for running dependents and local changes before stopping services, then runs teardown with the lane stopped. Failed teardown keeps the stopped lane available for repair.
- Unchanged copied files and links can be cleaned up automatically. Copied directories, changed copies, and replaced links require explicit discard; review their contents first.
- `ignored_files`: the worktree has `node_modules`, build output, or a changed `.env`. The error lists them with sizes. **Ask the user** before passing `--discard-ignored` (MCP `discard_ignored: true`).
- `teardown_failed`: the lane is kept. Read the run's output and fix it; use `--force-teardown` only if the user agrees.
- `in_use` when stopping the original checkout: running lanes use its shared services. Stop those lanes first, or pass `--force` with the user's approval.
- `in_use` when removing or releasing a lane: another workspace or lane uses its services. Stop those dependents first.
- `cinderdeck lane prune --dry-run` lists lanes whose branch was merged or whose upstream branch was deleted. Show the list to the user before running `lane prune`.
- `lane release --delete-logs` (MCP `release_lane` with `delete_logs: true`) also removes saved service logs while keeping worktrees.

## 5. Make a workspace work in lanes

Lanes derive their component definitions from the workspace file every time it loads. Change services, tasks, workflows and `[lanes]` defaults in that source file; `lane edit` changes lane display names while running, and environment overrides while stopped. Check a file with `cinderdeck services validate <file>` (MCP `validate_workspace`); its warnings point out values lanes cannot follow. Edit with the MCP `save_workspace_*` tools or by hand, then `services reload`.

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
| Another workspace's service is needed | `depends_on = ["backend:api"]`, `env.API = "{{url.backend:api}}"`; give both lanes the same name to pair them |
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
- [ ] Removed, released, or stopped the lane when done
