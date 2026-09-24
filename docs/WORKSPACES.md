# Workspaces: services, tasks, and workflows

Open **Workspaces…** from the menu bar, or **History → Workspaces → Open Workspaces**. Launchers can use `cinderdeck://workspaces`. This is the new home for the existing Stacks feature.

The compact History panel shows up to three complete workspace cards per page. Use the previous/next buttons for more workspaces, or the arrow keys to move the selection across pages. Service details scroll within each card while Start/Stop and workspace actions stay visible. **Open Workspaces** opens the full workspace window.

A **workspace** groups a project's folders, environment, and reusable commands:

- **Services** stay running: APIs, development servers, workers, databases. Start, stop, restart, readiness, automatic crash recovery, Git controls, and separate service terminals retain their existing behavior.
- **Tasks** run once: tests, builds, linting, migrations, or scripts. Exit 0 succeeds; any other exit code fails. Tasks never restart automatically. Output, start/end times, duration, and exit code are recorded.
- **Workflows** run an ordered sequence of task and service actions. Start waits for readiness; a task must succeed before the next step runs. A failure or cancellation skips remaining steps.
- **Runs** shows live progress and past results for the selected workspace. Select a step to filter output, search the log, copy text, cancel an active run, or run again using the current definition.
- **Recordings** lists screen recordings saved with this workspace's logs, each with a `.log` file stamped with video times. **Record with Logs** records the screen, or records a task or workflow run with each step marked. It also sets which workspaces toolbar recordings capture. See [REPROS.md](REPROS.md).

## Create and edit

Choose **+** in Workspaces, give the workspace a name and project folder, and create it. An empty workspace is valid. **Edit workspace → Add project…** adds a long-running service. The **Tasks** tab has **New task**, with name, command, working folder, timeout, and required services. **New workflow** lets you add task/start/stop steps and move them up or down. The TOML editor remains available through **Edit workspace** for environment overrides and other advanced settings.

If you have been using a service for a build or test command, stop it, open **Tasks → Move service to Tasks**, choose the service, and save. This preserves its command, folder, repository association, environment, and required services. It removes the service entry; references from other services/tasks/workflows must be updated first. The file is validated before saving. Task/workflow menus also offer deletion; referenced tasks cannot be deleted until their workflows are updated. Prior run results are retained.

Saving a form does not run any command. If another editor changed the file while a form was open, saving fails with an explanation instead of overwriting those edits.

## Existing stacks

No file move or migration is needed. Existing `~/.config/cinderdeck/stacks/*.toml` files become workspaces with Services. Existing `[stacks]` preferences, custom definition folders, `cinderdeck stacks …`, MCP service tools, shortcuts, and saved running-service records still work. The internal stack IDs and storage keys stay stable. Starting services never launches tasks or workflows.

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

Tasks support `name`, `cmd`, `repo`, `cwd`, `env`, `requires_services`, and `timeout`. Name defaults to the ID. Folder resolution and environment/Keychain precedence match services. Timeout defaults to 600 seconds, must be positive, and is capped at 3,600 seconds. Task launches additionally set `CINDERDECK_WORKSPACE`, `CINDERDECK_TASK`, and `CINDERDECK_RUN`. Resolved environment values and Keychain secret values are not written into run history. Commands may print their own secrets, so treat output as local development logs.

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
cinderdeck workspace task shop lint --wait
cinderdeck workspace workflow shop verify --as Codex
cinderdeck workspace runs shop
cinderdeck workspace status <run-uuid>
cinderdeck workspace logs <run-uuid> -n 200
cinderdeck workspace cancel <run-uuid>
```

Starts return a durable run UUID immediately. `--wait` waits for completion and exits 0 on success or nonzero on failure/cancellation. `--timeout` limits only the CLI wait; it does not cancel the underlying run. Keep the UUID and inspect it after a wait timeout. Never retry a start just because a response was lost.

MCP tools: `list_workspaces`, `workspace_details`, `run_workspace_task`, `run_workspace_workflow`, `list_workspace_runs`, `workspace_run_status`, `workspace_run_logs`, `cancel_workspace_run`. Run logs accept an optional step UUID. Runs record the same agent identity used by services; starts and cancellation honor workspace claims. The human UI remains in control.

## Validation

Focused XCTest suites cover task-only/empty definitions, invalid references, older launch record decoding, component edits, conversion, stale-save protection, real process exit results and output, sequential failure handling, timeout, process-group cancellation, readiness, cleanup ownership, history reload, recovery, CLI parsing, and MCP/control access.
