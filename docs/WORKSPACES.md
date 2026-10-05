# Workspaces: services, tasks, and workflows

Open **Workspaces…** from the menu bar, or **History → Workspaces → Open Workspaces**. Launchers can use `cinderdeck://workspaces`. This is the new home for the existing Stacks feature.

The compact History panel shows up to three complete workspace cards per page. Use the previous/next buttons for more workspaces, or the arrow keys to move the selection across pages. Service details scroll within each card while Start/Stop and workspace actions stay visible. **Open Workspaces** opens the full workspace window.

Drag a workspace card or sidebar row from History or Workspaces into an editor chat (such as Cursor) or a text field to share a reference. You can also drag the workspace name or hand icon in the workspace header, or right-click and choose **Copy workspace reference**. The text includes the workspace ID, definition and project paths, lane, repository branches, and configured service addresses with their current status. It omits commands, environment variables, and secret values.

Drag the grip in History's header to move the floating window around your screen. It keeps your chosen location while switching sections, expanding/collapsing, and reopening during the app session. Selecting a preset History position in Settings while History is compact resets its placement.

An active **Agent lease** shows its holder above the workspace tabs. Choose **Cancel agent lease…** there, in the workspace or lane's sidebar menu, on its **Lanes** card, or in the lane map inspector. Cancellation frees only that checkout's claim for other agents; running services and tasks, worktrees, files, and logs stay in place. Agents can claim it again. **Agent access** also lists all active leases. CLI/MCP clients can use `services release <workspace-or-lane>` / `release_workspace` with the checkout's ID and `--force` / `force: true` when overriding another holder.

A **workspace** groups a project's folders, environment, and reusable commands:

- **Services** stay running: APIs, development servers, workers, databases. Start, stop, restart, readiness, automatic crash recovery, Git controls, and separate service terminals retain their existing behavior.
- **Tasks** run once: tests, builds, linting, migrations, or scripts. Exit 0 succeeds; any other exit code fails. Tasks never restart automatically. Output, start/end times, duration, and exit code are recorded.
- **Workflows** run an ordered sequence of task and service actions. Start waits for readiness; a task must succeed before the next step runs. A failure or cancellation skips remaining steps.
- **Lane map** opens an execution map with color-coded checkout bands, service dependencies, active workflows, and a separate rail for shared resources. Select a checkout to highlight what it uses, switch to **Used by** to trace a service's consumers, or choose **Focus** to hide unrelated blocks. Search by lane, branch, command, PID, or port; use the clickable overview, zoom, and **Fit width** to navigate. The inspector exposes actual process identities, launch commands, ports, owners, warnings, logs, and checkout/run navigation. Animated connectors indicate running processes and honor Reduce Motion; solid arrows show ownership/step order and dashed arrows show dependencies. Long workflows stack vertically. The map covers Cinderdeck-managed services and run steps.
- **Runs** shows live progress and past results for the selected workspace. Select a step to filter output, search the log, copy text, cancel an active run, or run again using the current definition.
- **Recordings** lists screen recordings saved with this workspace's logs, each with a `.log` file stamped with video times. **Record with Logs** records the screen, or records a task or workflow run with each step marked. It also sets which workspaces toolbar recordings capture. See [REPROS.md](REPROS.md).

Workspaces with lanes have a disclosure button in the sidebar. Expand it to see each lane and the current branch for every repository; search also matches branch names. Unavailable Git status is labeled, and saved branch fallbacks are marked “last known.”

Right-click a workspace and choose **Delete workspace…** to remove its definition. Confirmation preserves project files, Git branches, logs, and saved run results. Active services/runs, claims from other agents, existing lanes, and references from other workspaces block deletion with an explanation. Right-click a lane in the sidebar or execution map and choose **Delete lane…** to stop its services and remove its managed worktrees. The confirmation lists ignored files and offers optional log deletion; Git branches and adopted worktrees are kept, and worktree changes or active runs block deletion. The **Lanes** view also offers release while keeping worktrees. The same menu offers **Show lane map**.

## Create and edit

Under **Lanes without a workspace**, right-click a lane and choose **Add to workspace…** to pick its workspace, or **Delete lane…** to remove it. Adding a managed lane requires a workspace using its original repositories and keeps its ID, worktrees, branches, and assigned ports. Standalone lane definitions keep their commands and save their sidebar membership as `workspace = "workspace-id"` in TOML. Stop lane services and runs before changing membership. Unreadable lane records must be repaired before attachment; deleting an unreadable record or standalone entry removes only its saved entry and keeps project files and worktrees.

First launch opens **Get your project running**. The same setup is available from **+** in Workspaces. Choose a local repository and select **Discover project**. Cinderdeck reads manifests without running project scripts, proposes services and test/build tasks, and checks the selected commands against your login-shell tools and live TCP ports.

Review each command, its folder, required tools, and port. You can deselect suggestions or add commands manually. Discovery supports JavaScript package scripts and nested packages, Django/pytest, Cargo, Go, Swift packages, Xcode projects, Make targets, and Docker Compose. Inspection stops at three folder levels or 200 folders and skips generated dependencies and directory symlinks. Unrecognized projects can still become an empty workspace.

**Before starting** explains missing runtimes, missing JavaScript dependencies, conflicting/invalid ports, and environment keys mentioned by sample files. Sample keys are hints and may be optional. Values never appear in the review or saved TOML. Recognized dotenv-loading commands check local environment files; other commands should export required keys in the login shell or explicitly load them. Checks cannot infer every dependency of a custom script. Required tools are editable in the review.

Known Vite, Next.js, Astro, and Django development commands use port templates, so changing the proposed port updates their launch argument. For other scripts, update the command's port argument or the underlying script as well. Docker Compose is checked with its read-only `config` command, including fixed published TCP ports, and requires a working engine and Compose plugin. Its rendered configuration is never displayed. Dynamic published port ranges must be changed to fixed ports before using **Create & start**; container ports remain as authored in the Compose file.

**Save workspace** writes the selected services and tasks without executing them, even if launch requirements need attention. **Create & start** rechecks current requirements, saves, opens the workspace, and starts only its selected services. Tasks are saved for later and do not run during setup. Install project dependencies separately and use **Check again** before starting. Missing tools for a task are advisory; missing service tools/dependencies and port conflicts block **Create & start**. The capture walkthrough remains optional, and screen capture permissions are not needed to set up services.

An empty workspace is valid. **Edit workspace → Add project…** adds a long-running service. The **Tasks** tab has **New task**, with name, command, working folder, timeout, and required services. **New workflow** lets you add task/start/stop steps and move them up or down. The TOML editor remains available through **Edit workspace** for environment overrides and other advanced settings.

If you have been using a service for a build or test command, stop it, open **Tasks → Move service to Tasks**, choose the service, and save. This preserves its command, folder, repository association, environment, and required services. It removes the service entry; references from other services/tasks/workflows must be updated first. The file is validated before saving. Task/workflow menus also offer deletion; referenced tasks cannot be deleted until their workflows are updated. Prior run results are retained.

Saving a form does not run any command. If another editor changed the file while a form was open, saving fails with an explanation instead of overwriting those edits.

## Existing stacks

No file move or migration is needed. Existing `~/.config/cinderdeck/stacks/*.toml` files become workspaces with Services. Existing `[stacks]` preferences, custom definition folders, shortcuts, and saved running-service records still work. The CLI manages services with `cinderdeck services …`. The internal stack IDs and storage keys stay stable. Starting services never launches tasks or workflows.

## Definition example

```toml
name = "Shop"
root = "~/Src/shop"

[env]
NODE_ENV = "development"

[repos.app]
path = "."

[services.api]
repo = "app"
cmd = "npm run dev"
port = 3000
ready.port = 3000

[tasks.lint]
name = "Lint"
repo = "app"
cmd = "npm run lint"
timeout = 300

[tasks.test]
name = "Integration tests"
repo = "app"
cmd = "npm run test:integration"
requires_services = ["api"]
timeout = 600

[tasks.build]
name = "Build"
repo = "app"
cmd = "npm run build"

[workflows.verify]
name = "Verify changes"
steps = ["task:lint", "start:api", "task:test", "task:build"]
cleanup_services = true
```

Tasks support `name`, `cmd`, `repo`, `cwd`, `env`, `requires_services`, `timeout`, and `port` / `ports.<name>` for a server the task starts itself (set as `PORT`, `CINDERDECK_TASK_PORT` and `CINDERDECK_TASK_PORT_<NAME>`; lanes assign their own). Commands and env values can use `{{…}}` templates such as `{{url.api}}` (see [STACKS.md](STACKS.md#templates)). Name defaults to the ID. Folder resolution and environment/Keychain precedence match services. Timeout defaults to 600 seconds, must be positive, and is capped at 3,600 seconds. Task launches additionally set `CINDERDECK_WORKSPACE`, `CINDERDECK_TASK`, and `CINDERDECK_RUN`. Resolved environment values and Keychain secret values are not written into run history. Commands may print their own secrets, so treat output as local development logs.

Workflow steps are `task:<id>`, `start:<service-id>`, or `stop:<service-id>`. Up to 100 steps run sequentially, and repeated steps are allowed. References must exist. Workflows do not call other workflows. An explicit stop step stops its named service, including one that was running before this workflow.

Required services include their transitive dependencies, including optional services. Every required service must be **Ready** before a task starts; the legacy service supervisor's degraded state is not sufficient. Existing service readiness probes keep their configured semantics (including the legacy HTTP status behavior). Tasks are not health monitors once they start.

`cleanup_services = true` stops only service process identities started by that run, on success, failure, or cancellation. Pre-existing services and services subsequently replaced by another operation are preserved. The default is false, so a workflow can prepare a development environment and leave it running. Standalone tasks leave required services running. Cancelling a service-start step stops incomplete new launches.

## Run lifecycle

One task or workflow may run in each workspace at a time; different workspaces can run concurrently. Task and workflow definitions are captured at submission. If the workspace definition changes before a later service-start step, that step fails rather than silently using changed service settings. Git checkout/pull through Cinderdeck is blocked while an affected workspace has an active run.

Tasks run with stdin closed and own a process group. Cancellation and timeout stop the group, escalating if needed. A successful command also cleans up any background children: use Services for persistent processes. Failures are not retried automatically.

Quitting while tasks/workflows are active offers cancellation before exit. Choosing to leave services running does not leave an unattended workflow running. After an app crash or forced exit, saved active task processes are identity-checked and stopped, and the run is marked **Interrupted**. Remaining workflow steps are never replayed. Launching a task again is explicit.

Run metadata is saved atomically, with private permissions, under `Application Support/Cinderdeck/Stacks/Runs/` (Debug: `Stacks-Debug/Runs/`). Each step has its own log. The latest 100 completed runs plus all active runs are retained; older run logs are removed. Live output is bounded to 5,000 lines and log files rotate at 50 MB; saved output reads the last 512 KiB. Completed results retain the original step commands and working folders, but not resolved environments. Storage failures appear in the workspace and block new launches until resolved.

## CLI and agents

The existing CLI install and MCP setup provide the new controls too. Reload the MCP tool list in a connected client.

```sh
cinderdeck workspace list
cinderdeck workspace show shop
cinderdeck workspace create --name Shop --folder ~/Src/shop --id shop
cinderdeck workspace edit shop --name "Shop development"
cinderdeck workspace save-service shop api --data '{"cmd":"npm run dev","port":3000}'
cinderdeck workspace save-task shop test --data '{"cmd":"npm test"}'
cinderdeck workspace save-workflow shop verify --data '{"steps":["task:test"]}'
cinderdeck workspace task shop lint --wait
cinderdeck workspace workflow shop verify --as Codex
cinderdeck workspace runs shop
cinderdeck workspace status <run-uuid>
cinderdeck workspace wait <run-uuid> --timeout 600
cinderdeck workspace logs <run-uuid> -n 200
cinderdeck workspace cancel <run-uuid>
```

Starts return a durable run UUID immediately. `--wait` waits for completion and exits 0 on success or nonzero on failure/cancellation. `--timeout` limits only the CLI wait; it does not cancel the underlying run. Keep the UUID and inspect it after a wait timeout. Never retry a start just because a response was lost.

MCP tools: `list_workspaces`, `workspace_details`, `run_workspace_task`, `run_workspace_workflow`, `wait_for_workspace_run`, `list_workspace_runs`, `workspace_run_status`, `workspace_run_logs`, `cancel_workspace_run`. `wait_for_workspace_run` waits in the app (default 600 seconds, at most 3,600) and returns the run with `finished`; a failed run also includes the failing step's last 30 lines. A wait that ends first returns `finished: false` and never cancels the run. Run logs accept an optional step UUID. Runs record the same agent identity used by services; starts and cancellation honor workspace claims. The human UI remains in control.

Both interfaces can create and edit components, with the same validation and stale-file protection as the forms: `create_workspace` (name and project folder), `save_workspace_service`, `save_workspace_task` (`from_service` moves a stopped service to Tasks), `save_workspace_workflow`, and `delete_workspace_item`. Saving creates or updates one component and keeps every setting the call omits. Nothing starts on save, invalid results are refused without touching the file, component edits belong to the source workspace, and edits honor workspace claims. `open_workspace` shows a workspace and section to the user.

For a lane with independent repositories, use `lane create <workspace> <new-branch> --repo-from app=<commit> --repo-from api=origin/main`, or MCP `create_lane` with `repositoryRefs: {"app": "<commit>", "api": "origin/main"}`. Each selected branch must be new. Cinderdeck pins each revision before creating worktrees, keeps other repositories on their normal defaults, and reports the resolved commits in the lane's `repositoryRefs`. Missing/shared repositories, existing local branches and conflicting aliases are refused. This option applies to creation; adoption preserves the existing checkout.

### Complete definition and lifecycle controls

`workspace_definition` (`workspace definition <id>`) returns the authored TOML, file path and a content `revision`. `save_workspace` can patch `name` and/or `folder`, or replace the whole `source` with that revision. Complete source replacement supports **every definition setting**: repositories and their lane modes, workspace environment, secret references, shell, service restart/stop settings, task ports, lane setup/teardown/copy/link/host defaults, and component additions, edits and removals. It also repairs invalid definitions. It does not read secret values from Keychain.

```sh
cinderdeck workspace definition shop
# Save the returned source to a local file, edit it, and use the returned revision:
cinderdeck workspace save shop --file ./shop.toml --revision <revision>
cinderdeck workspace delete-item shop workflow verify
cinderdeck workspace remove shop --revision <revision>
```

A full save or metadata edit requires stopped services and finished/cancelled runs in the workspace and its lanes. It respects claims on all affected lanes, validates references across workspaces before writing, and refuses a stale revision. Changing the display name keeps the workspace id. Changing the folder re-resolves relative paths. Nothing starts automatically. `delete_workspace` removes just the definition, requires stopped work, refuses remaining lanes or dependent workspace references, and keeps project folders, branches, logs and saved run results. `force` overrides claims only; it never bypasses these checks.

`update_lane` (`lane edit <lane> --name <name>`, `--env KEY=VALUE` repeated, or `--clear-env`) edits a stopped lane. Environment values replace the lane override set; omitted fields stay unchanged. Renaming keeps its stable id, worktrees, branches, slug and ports, while its `<workspace>/<name>` reference changes. Pinned lanes must be unpinned first. `remove_lane` and `release_lane` retain their existing worktree protections; release keeps all worktrees.

### One operation catalog for CLI and MCP

```sh
cinderdeck tools                         # Full JSON catalog and schemas; no app connection needed
cinderdeck tools save_workspace_service  # All accepted settings for one operation
cinderdeck call list_workspaces --arguments '{"detail":false}'  # Compact inventory
cinderdeck call update_lane --arguments '{"workspace":"shop/review","env":{"MODE":"review"}}'
cinderdeck call save_workspace --file ./arguments.json
```

`cinderdeck call` exposes **every MCP tool**, using the same catalog, argument validation, control route and timeout. New tools automatically become available to CLI agents. JSON file input avoids shell quoting and supports nested settings. The dedicated `workspace save-service`, `save-task` and `save-workflow` commands accept the same settings in `--data` or a JSON `--file`, with workspace/id supplied as positionals. Unknown arguments, wrong JSON types and invalid enum values are rejected before connecting. JSON results go to stdout; JSON errors go to stderr (exit 3 for a claim conflict, 1 for other errors). Generic calls return the control result; inspect run status and service problems, since a successfully delivered call can report failed work.

For large installations, call `list_workspaces` with `detail: false` to discover workspace IDs, service names, tasks, workflows, issues, and active runs, then request `workspace_details` for the selected workspace. Omitting `detail` preserves the existing detailed inventory. Log requests bound merging and file reads to the requested tail; passing the numeric service-log cursor as `after` avoids returning unchanged output. Live console searches reuse matches for existing lines, and large combined log merges run off the UI thread. See [performance measurements and reproduction steps](PERFORMANCE.md).

## Validation

Focused XCTest suites cover task-only/empty definitions, invalid references, older launch record decoding, component edits, conversion, stale-save protection, real process exit results and output, sequential failure handling, timeout, process-group cancellation, readiness, cleanup ownership, history reload, recovery, CLI parsing, and MCP/control access.

Run `bash scripts/stacks-verify.sh test` for the workspace, lane and agent contract suites. After a Debug build, `python3 scripts/agent-controls-e2e.py` verifies workspace/component/lane lifecycles across the real CLI and MCP transports in a temporary preview environment. `python3 scripts/lanes-e2e.py` also checks running HTTP services in three parallel environments. Neither smoke test installs an app or edits your saved workspaces.
