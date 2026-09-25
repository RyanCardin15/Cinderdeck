# Lanes: audit and redesign

Status: implemented (all four phases). Sections 1–4 describe lanes as they were at `d42d4e86`; sections 5–7
describe the design as built, with the differences from the proposal listed in section 8. User documentation
is in [STACKS.md](STACKS.md#parallel-worktree-lanes).

## 1. Summary

Lanes work for one narrow case: one or more Git repositories, where every service reads `$PORT`, no
service needs a second port, nothing reads a `.env` file, nothing shares state such as a database or Docker, and
the lane is removed before anyone runs `npm install` in it. Outside that case, a lane
either fails or, worse, runs but quietly talks to the original checkout.

The most important problems:

| # | Problem | Effect | Severity |
|---|---|---|---|
| 1 | Environment values are copied verbatim, so `env.API_URL = "http://localhost:4000"` points every lane at the **original** API | A lane's frontend runs against the base checkout's backend and data, with no error | Critical |
| 2 | Removal refuses **ignored** files (`--ignored`) | After `npm install`, a build, or copying `.env`, the lane can't be removed through Cinderdeck. The documented `--no-start` + install flow leads to this every time | Critical |
| 3 | A lane can't be refreshed. Its definition is a snapshot, lane edits are refused, and "recreate" means removing it, which runs into #2 | Every source edit (new service, env change) leaves existing lanes stale | High |
| 4 | A branch that exists only on the remote gets a **new** local branch created from `HEAD` | "Open PR #33 in a lane" gives you an unrelated branch with the PR's name | High |
| 5 | There is no way to share part of a workspace. Every repo is worktreed and every service is copied; a non-Git `cwd` makes creation fail | You can't share Postgres/Redis/Docker or an unchanged backend. Four lanes run four copies of everything | High |
| 6 | Existing worktrees can't be adopted. A branch that is already checked out elsewhere is rejected | Agents that create their own worktrees (Claude Code, Codex, Cursor, Conductor, T3) can't run their branch as a lane | High |
| 7 | Only one lane operation can run at a time across all workspaces, and extra requests are **rejected**, not queued | Starting four agents at once: three `create_lane` calls fail with "try again" | High |
| 8 | Worktree folders are named `repo-1`, `repo-2` and sit inside the definitions folder | Docker Compose project names collide, the folders are hard to recognise in editors, and worktrees can end up inside a synced dotfiles folder or a source repo | Medium |
| 9 | Each service gets exactly one port, and ports are assigned even to services that don't have one | Vite HMR, debuggers, and gRPC with HTTP are unsupported. Workers get a `PORT` and a meaningless link | Medium |
| 10 | Nothing checks that a process actually listens on its assigned port | A command that ignores `$PORT` binds 3000, which collides with the base checkout or quietly takes its place | Medium |
| 11 | No setup or teardown hooks, and `.env` files aren't copied | Every lane needs manual setup, and databases and containers are left behind after removal | Medium |
| 12 | The base checkout gets no `PORT` or `CINDERDECK_PORT_*` | Commands need `${CINDERDECK_PORT_API:-4000}` fallbacks, so each value is written twice | Low |

The fix in one sentence: **describe lane-sensitive values once, as templates, and resolve them at
launch for the base checkout and for every lane. Add a `[lanes]` table for setup, sharing, and cleanup
policy, and derive each lane from the current source definition instead of a frozen copy.**

## 2. How lanes work today

- `StackLaneStore.create` ([StackLaneStore.swift](../Cinderdeck/Services/Stacks/Lanes/StackLaneStore.swift))
  - finds the Git top level of every repo, service, and task folder
  - creates one worktree per root at `<stacks-dir>/.lanes/<id>/repo-N`
  - allocates one port per service, sequentially from 20000
  - rewrites folders, `port`, and localhost readiness checks
  - writes a full `StackDefinition` snapshot to `lane.json`
- `StackLaunchDefinition.environment` ([StackDefinition.swift:123](../Cinderdeck/Services/Stacks/Models/StackDefinition.swift:123)) adds `CINDERDECK_LANE`, `CINDERDECK_SOURCE_STACK`, `CINDERDECK_PORT_<SVC>` for every service, and `PORT`. These values override the shell, the TOML, and secrets. The base checkout gets none of them.
- The lane then behaves like any other workspace: same supervisor, logs, claims, and runs, keyed by `<source>--lane-<uuid>` and addressable as `<source>/<branch>`.
- Removal ([StackLaneStore.swift:226](../Cinderdeck/Services/Stacks/Lanes/StackLaneStore.swift:226)) requires `git status --porcelain --untracked-files=all --ignored` to be empty, then runs `git worktree remove`.

What already works well and should stay: the journal is written before any Git change, rollback on
failure never deletes user files, port reservations persist across restarts, a lane can be addressed
as `<source>/<branch>`, claims and actor attribution apply, and the tests use throwaway repos.

## 3. Findings

### 3.1 Environment and configuration

**E1. Environment values that contain a port aren't lane-aware (critical).** Only `PORT` and
`CINDERDECK_PORT_*` change. `env.API_URL`, `DATABASE_URL`, `NEXT_PUBLIC_*`, `VITE_*`, CORS allowlists,
and callback URLs are copied unchanged. The first example in [STACKS.md](STACKS.md) (`env.API_URL =
"http://localhost:4000"`) is exactly this bug: the lane's `site` calls the base checkout's `api`. The docs'
workaround, `${CINDERDECK_PORT_API:-4000}` inside `cmd`, works, but only in `cmd`, it repeats every port, and
nothing points it out.

**E2. `.env` files aren't in the worktree.** They're ignored by Git, so they aren't in the new checkout.
Most Node, Rails, Django, and .NET projects fail to start or silently use defaults. There is no copy or link option.

**E3. Nothing identifies the lane in a form that's safe for names.** `CINDERDECK_LANE` is the raw branch
name (`agent/codex-1`), which can't be used as a database name, Compose project, Redis prefix, or hostname. Scripts
have to sanitize it themselves.

**E4. Lanes have no environment overrides.** You can't give one lane `FEATURE_X=1` or a different
seed. Lane assignments also override TOML, so even `PORT` can't be pinned deliberately.

**E5. The snapshot goes stale, and there's no way out.** [WorkspaceDefinitionControl.swift:58](../Cinderdeck/Services/Workspaces/WorkspaceDefinitionControl.swift:58)
says "Edit the source, then recreate the lane." Recreating means removing it, which fails once ignored files
exist (R1). Adding a service, env var, or task to the source never reaches existing lanes.

**E6. The base checkout and lanes use different contracts.** The base checkout gets no `PORT` or
`CINDERDECK_PORT_*`, so every command has to handle both cases.

### 3.2 Ports and URLs

**P1. Ports are assigned to services that have none** ([StackLaneStore.swift:159](../Cinderdeck/Services/Stacks/Lanes/StackLaneStore.swift:159)).
Workers get a `PORT` (some frameworks will bind it), a port-conflict check on a random port, and a
clickable `:20007` link in the Lanes view ([StackLanesView.swift:96](../Cinderdeck/Features/Stacks/Components/StackLanesView.swift:96)).

**P2. Each service gets one port.** Services that need a second port aren't supported: Vite HMR (24678),
the Node inspector (9229), .NET HTTP and HTTPS, gRPC with HTTP, Storybook next to an app, metrics endpoints, or
an emulator suite. Readiness on a different port is rejected at creation.

**P3. Nothing checks which port a service binds.** A command that ignores `$PORT` either crashes with
EADDRINUSE (if the base checkout is running) or binds the base port while its readiness check on the assigned port fails. In the second
case the user opens `localhost:3000` and is looking at the **lane**, thinking it's the base checkout. `PortInspector` can already
find listeners by PID.

**P4. Lanes on different ports still share cookies.** Browsers scope cookies by host, not port, so
logging in on a lane logs out the base checkout, and two lanes overwrite each other's session. OAuth redirect URIs and
CORS allowlists registered for `localhost:3000` reject lane ports.

**P5. Port numbers are hard to predict.** The first free port from 20000 is used, in service-name order. A lane's
ports depend on creation order and whatever else happens to be listening. Recreating a lane may
change its ports.

**P6. Tasks can't request ports.** A test task that starts its own server (Playwright `webServer`,
Storybook tests) has no port assigned and collides between lanes.

### 3.3 Shared projects and shared resources

**S1. Every service runs in every lane.** Postgres, Redis, Kafka, `docker compose up`, a mock
server, or a backend you aren't changing all get copied. Copying stateful infrastructure either fails
(fixed ports, data folders) or silently shares state. You can't say "this lane uses the base checkout's DB".

**S2. Every repo gets a worktree.** In a frontend plus backend workspace where only the frontend changes,
the backend is worktreed too, a `feature-x` branch is created in it, and it's rebuilt and run.
Unused branches pile up in repos nobody touched.

**S3. A non-Git folder stops creation.** `rev-parse --show-toplevel` fails for any service or task
`cwd` outside Git (a local tool folder, a vendored binary folder), so the whole lane is refused.

**S4. A lane can't use a service from another workspace.** "Frontend workspace uses the backend
workspace's API" can't be expressed. With lanes, the frontend lane should use the backend lane on the
same branch if there is one, and the backend's base checkout otherwise.

**S5. Workspaces that share a repo can't share a worktree.** Two workspaces over the same repo (for example
`shop-web` and `shop-full`) can't both have a `feature-x` lane: the second is rejected because the branch
is already checked out.

**S6. Worktrees made by other tools can't be adopted.** Claude Code desktop, Codex, Cursor background agents,
Conductor, and T3/Deckhand all create worktrees. `lane create` rejects the branch because it's
checked out, so an agent working in its own worktree can't get isolated ports for that
worktree. [DECKHAND_DESIGN.md](DECKHAND_DESIGN.md) already assumes `lane.adopt` and `lane.release`.

**S7. Nested repos and submodules.** Nested repos are rejected. Submodules aren't initialized in
new worktrees, so the lane is missing their content.

### 3.4 Lifecycle

**R1. Removal refuses ignored files (critical).** `node_modules`, `.next`, `dist`, `.venv`, `bin/obj`, and
copied `.env` files are all "ignored", so removal fails for any lane that has actually been used. The docs
say "move or clean those files yourself first", which in practice means `rm -rf` by hand in a hidden
folder.

**R2. No setup step.** Installing dependencies, generating code, running migrations, and seeding all happen by hand after
`--no-start`. That's not repeatable, agents skip it, and the first start fails.

**R3. No teardown step.** Per-lane databases, Compose projects, volumes, and caches outlive the lane.

**R4. The start point is always each repo's current `HEAD`.** If the original checkout is on a
feature branch, new lanes branch from that feature branch. There's no `--from origin/main`.

**R5. A branch that exists only on the remote gets a new branch from `HEAD`** ([StackLaneStore.swift:193](../Cinderdeck/Services/Stacks/Lanes/StackLaneStore.swift:193)).
Only `refs/heads/` is checked, so the branch isn't set up to track the remote.

**R6. Lanes don't get cleaned up.** Nothing detects merged or upstream-deleted branches. Lane logs
under `~/Library/Logs/Cinderdeck/Stacks/<lane-id>/` are kept forever.

### 3.5 Location and naming

**L1. Worktrees live inside the definitions folder** (`~/.config/cinderdeck/stacks/.lanes`). That
folder is user-configurable and often sits in a dotfiles repo, a synced folder, or even inside the
project (`<repo>/.cinderdeck`). In the last case, lanes are **inside the source repo**: `git status`
and the file watchers in Jest, TypeScript, Vite, and ESLint pick up a full second copy.

**L2. Worktree folders are named `repo-N`.** Docker Compose uses the folder name as the default project name, so every lane of
every workspace is `repo-1`, and a compose file in a subfolder (`infra/`) even shares its project name with the base checkout.
Editor window titles, terminal tabs, and `ps` output all show `repo-1`.

### 3.6 Concurrency, UX, and agents

**C1. Lane operations are rejected instead of queued** ([StackSupervisor.swift:437](../Cinderdeck/Services/Stacks/StackSupervisor.swift:437)).
Removal holds the same lock while it waits for services to stop, which blocks every other workspace's lane creation.

**C2. Agents can't get a lane's environment.** Agents usually run `npm test` or `curl` in their own
terminal. There's no `cinderdeck lane env <lane>` to export the lane's resolved ports, URLs, and
variables.

**C3. The Lanes view leaves out what matters.** It doesn't show resolved URLs, environment differences from the base checkout, setup
status, whether the source changed, disk usage, or merged status.

## 4. Use cases

| Use case | Today | Target |
|---|---|---|
| Single repo, single web service reading `$PORT` | Works | Works, same config |
| Frontend and API in one repo, frontend reads `API_URL` from env | **Silently calls the base API** | `env.API_URL = "{{url.api}}"` resolves per lane and in the base checkout |
| App needs `.env` / `.env.local` | Manual copy, then removal is blocked | `[lanes] copy = [".env*"]`, and cleanup removes it |
| `pnpm install` / `uv sync` / `dotnet restore` before start | Manual `--no-start` | `[lanes] setup = "workflow:setup"` runs as a visible run before start |
| Shared Postgres, one database per lane | Impossible without scripts | `services.db.lane = "shared"`, `DATABASE_URL = ".../shop{{lane.ident:+_}}{{lane.ident}}"`, setup creates the DB and teardown drops it |
| `docker compose up` per lane | Project name and port collisions | `COMPOSE_PROJECT_NAME` defaults per lane; compose ports via `{{port.x}}` in env |
| Frontend lane against an unchanged backend | Backend copied and rebuilt | `repos.api.lane = "shared"`, so lanes use the base checkout's API |
| Frontend workspace depends on backend workspace | Not expressible | `depends_on = ["backend:api"]`, matched to a same-branch lane when one exists |
| Review a PR branch that exists only on the remote | **Creates the wrong branch** | Tracks `origin/<branch>` |
| Agent already in its own worktree (Claude Code, Codex, Cursor) | Rejected | `lane adopt <workspace> --path .`, never deleted by Cinderdeck |
| Four agents create lanes at the same moment | Three fail | Queued; all four succeed |
| Vite HMR, debugger, or gRPC with HTTP | Unsupported | Named ports: `ports.hmr`, `ports.debug` |
| Service ignores `$PORT` | Collision or silent substitution | Detected: "listening on 3000, assigned 20004" |
| Log in on two lanes at once | Cookies overwrite each other | Optional `<slug>.<workspace>.localhost` hosts |
| Add a service to the source workspace | Lanes never get it | Lanes derive from the source live |
| Remove a used lane | Blocked by `node_modules` | Ignored files are discarded after confirmation; tracked or untracked work is still protected |
| Non-Git helper folder in the workspace | Creation fails | Treated as shared, with a warning |
| Repo with submodules | Submodules empty | Initialized during creation |
| Clean up merged lanes | Manual | Lanes view flags merged branches; `lane prune --merged` |

## 5. Design

### 5.1 One environment contract for the base checkout and lanes

These are set for **every** launch, base or lane, after shell, TOML, and secrets:

| Variable | Base | Lane |
|---|---|---|
| `PORT` | Service's primary port, if it has one | Assigned primary port |
| `CINDERDECK_PORT_<SVC>[_<NAME>]` | Configured ports | Assigned ports |
| `CINDERDECK_URL_<SVC>` | `http://localhost:<port>` | `http://<host>:<port>` |
| `CINDERDECK_WORKSPACE` | Workspace ID | Lane ID, so commands can address it (`CINDERDECK_SOURCE_STACK` has the source) |
| `CINDERDECK_LANE` | Unset (unchanged) | Branch name (unchanged) |
| `CINDERDECK_LANE_SLUG` | Unset | `agent-codex-1` (hostname-safe, unique within the workspace) |
| `CINDERDECK_LANE_DIR` | Unset | Lane root |
| `COMPOSE_PROJECT_NAME` | Unchanged | `<workspace>-<slug>`, **unless** it's set in the shell, TOML, or lane env |

`PORT` only for services that declare a port (fixes P1). Keeping `CINDERDECK_LANE` unset in the base checkout preserves
existing `-n "$CINDERDECK_LANE"` checks.

Compatibility risk: a base service whose app reads `PORT` for something other than its configured `port`
would change behavior. Mitigation: set `PORT` for the base checkout only when TOML doesn't set it (`env.PORT` still
wins in the base checkout, never in lanes), and note it in the changelog.

### 5.2 Templates

Resolved at **launch** (not at snapshot time), with the same inputs for the base checkout and lanes. Allowed in `env.*`,
service and task `cmd`, `ready.http`, and `[lanes]` paths. `{{…}}` avoids clashing with shell `${…}`,
which is still passed through unchanged.

| Template | Base | Lane |
|---|---|---|
| `{{port.api}}`, `{{port.web.hmr}}` | Configured port | Assigned port |
| `{{url.api}}` | `http://localhost:4000` | `http://<host>:20004` |
| `{{host}}` | `localhost` | `localhost`, or `<slug>.<workspace>.localhost` with `lanes.hosts = true` |
| `{{lane.slug}}`, `{{lane.ident}}` | Empty | `codex-1`, `codex_1` |
| `{{lane.name}}` | Empty | `agent/codex-1` |
| `{{repo.app}}` | Repo path | Worktree path |
| `{{workspace}}` | ID | Source ID |
| `{{x:-default}}`, `{{x:+alt}}` | Shell-style fallback or alternate value | Same |

Validation happens at load time. An unknown key, or a `{{port.x}}` on a service without a port, is an error with a line
number. Secret values are never templated or shown. The example from STACKS.md becomes:

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
env.API_URL = "{{url.api}}"
depends_on = ["api"]
```

Plain literal values keep today's behavior, so existing files don't change meaning. The loader
**warns** when an env value contains `localhost:<port of another service>` and suggests `{{url.x}}`
(this catches E1 in existing definitions).

### 5.3 The `[lanes]` table

```toml
[lanes]
dir = "~/Src/.lanes"            # where worktrees go; default below
from = "origin/main"            # start point for new branches; default: each repo's HEAD (today's behavior)
copy = [".env", ".env.local", "apps/*/.env"]   # per repo, only ignored/untracked files, never overwrite tracked files
link = []                       # symlinks for large caches you accept sharing; warns
setup = "workflow:lane-setup"   # or "task:install"; runs after worktrees, before start
teardown = "task:drop-db"       # runs before removal; failure blocks removal unless forced
hosts = false                   # per-lane *.localhost hostnames (P4)
env.FEATURE_FLAGS = "lanes"     # applies in lanes only, after [env]

[repos.api]
path = "backend"
lane = "shared"                 # "worktree" (default) | "shared"

[services.db]
cmd = "docker compose up postgres"
lane = "shared"                 # "isolate" (default) | "shared" | "off"
```

**Service modes**
- `isolate` (default): the lane runs its own copy with its own ports.
- `shared`: the lane does **not** run it. `{{port.db}}` and `CINDERDECK_PORT_DB` resolve to the base
  checkout's port, and `depends_on = ["db"]` waits for the base checkout's runtime. Starting a lane starts the shared base
  service if it's stopped, and records the lane's actor. Stopping a lane never stops a shared service. Stopping it in the base checkout
  while lanes use it asks first ("3 lanes use db").
- `off`: not in lanes. Dependents that aren't also `off` or `shared` are a load error.

Services in a `shared` repo default to `shared`. `isolate` is allowed only for services that don't write into
their folder (the load warns, because two processes share one working tree). Service and task folders outside Git
are treated as `shared` repos with a warning, instead of failing (S3).

**Cross-workspace dependencies (S4).** `depends_on = ["backend:api"]` and `{{url.backend:api}}`. In a lane,
this resolves to `backend/<same branch>` if that lane exists, otherwise to the backend's base checkout. The launch
record stores which one was used, so a restart doesn't switch silently.

### 5.4 Lanes follow the source definition

Replace the full snapshot with an **overlay** in `lane.json`:

```
source, name, slug, owner, createdAt, from
worktrees: [{ repoRoot, path, branch, owned: true|false }]
ports: { "web": 20004, "web.hmr": 20005, "api": 20006 }
env: { … }                  # per-lane overrides from create --env
setup: { status, runID }
sourceFingerprint           # source definition hash at the last derivation
```

When the source workspace loads, each lane is **derived**: the current source definition, with folders remapped,
ports applied (new services get ports allocated and saved), templates resolved, and modes applied. Source edits reach lanes
the same way they reach the base checkout: running services keep their launch definition, and the existing
"definition changed, restart to apply" indicator covers the rest. This removes E5 and the recreate step.

If the source becomes invalid, lanes show the source's errors and can still be stopped (as with a removed
definition today). If the source is deleted, lanes stay under **Lanes without a workspace**, using their last
derived definition cached in the record, for stop and remove only.

Migration: existing `lane.json` files that contain `definition` load as **pinned** lanes (today's behavior),
with an **Unpin to follow `<source>`** action that converts them to an overlay and keeps their ports and worktrees.

### 5.5 Worktrees: location, naming, sharing, adoption

- **Location:** `lanes.dir`, otherwise the app setting, otherwise `~/.cinderdeck/lanes`. Lane records stay in
  `<stacks-dir>/.lanes/<id>/lane.json`. Refuse any `dir` inside a source repo, and warn for iCloud
  or Dropbox folders.
- **Layout:** `<dir>/<workspace>/<slug>/<repo-folder-name>` (numbered only if two names collide). This fixes L2 and
  makes paths readable.
- **Registry:** worktrees are keyed by `(git common dir, branch)` and reference-counted by lanes. A second
  workspace's lane on the same branch reuses the worktree (S5). Removal deletes the worktree only when the last
  owning lane releases it.
- **Adoption (S6):** `lane adopt <workspace> [--path <dir>] [--name <n>]` (MCP `adopt_lane`). It checks that the path is a
  worktree (or the main checkout) of one of the workspace's repos, and records `owned: false`. Other repos in the workspace use
  their `lane` mode, and `worktree` repos get a Cinderdeck-owned worktree on the same branch. `lane release`
  stops services and deletes the record, **never** the worktree. The MCP server can detect an agent
  running in a worktree (caller cwd) and suggest adoption.
- **Git details:** a local branch uses it (today's behavior). A branch only on the remote runs `git worktree add --track -b <b> <path> <remote>/<b>` (R5).
  Otherwise `-b <b> <path> <from>`. Initialize submodules when `.gitmodules` exists (S7). Nested repos: create the outer
  worktree first, then the inner one at its mapped path. Defer this until someone needs it.

### 5.6 Ports

- **Named ports:** `ports.http = 3000`, `ports.hmr = 24678` (dotted keys, so no inline tables are needed).
  `port = 3000` stays as shorthand for the primary port. `ready.port` accepts a number or a port name, and HTTP
  readiness may target any of the service's own ports.
- **Allocation:** only for declared ports. Each lane reserves a block (10 ports by default, rounded to the
  next multiple of 10) starting at 20000. Ports inside the block are ordered by service and port name, so
  lane N's ports are easy to predict and stay stable when services are added (they use unused slots in the block, or a
  new block). Existing exclusions stay: base ports, other lanes, live launches, and occupied IPv4/IPv6 ports.
- **Tasks:** `tasks.<id>.ports.server = 6006`. In lanes these come from the lane's block. In the base checkout they're
  assigned when the run starts.
- **Bind check (P3):** once a service is ready or unhealthy, list the listeners of its process group. If
  none match an assigned port, show `"web is listening on 3000, not its assigned 20004. Its command
  ignores $PORT; use {{port.web}}"` on the service, in the snapshot, and in the MCP start result. In the base checkout, the same check
  catches a wrong `port` value.

### 5.7 Setup, teardown, and removal

**Creation** moves through `creating → setting up → ready`, with `failed` possible at each step, and every step is visible:

1. Queue, then allocate the slug and ports (under the lane lock). The lock covers only the record and allocation, **not**
   Git, setup, or stop. Requests wait in a FIFO queue instead of failing (C1).
2. Create worktrees (Git runs in parallel for different repos), initialize submodules, and copy or link files.
3. Run `setup` as a normal workspace run in the lane (logs, cancel, run history). If it fails, the lane stays
   `setup failed`, with **Retry setup** and **Start anyway** actions.
4. Start services, unless `start = false`.

**Removal:**

1. Run `teardown` if one is defined. If it fails, stop, unless `force_teardown`.
2. Stop the lane's own services. Shared services are left running.
3. Git safety check per owned worktree: **tracked or untracked changes** block removal (unchanged). **Ignored files**
   are listed by top-level folder and size. They're removed with `git clean -fdX` only when the caller passes
   `discard_ignored` (the UI shows a checkbox, pre-checked, with the list and total size). Files Cinderdeck copied
   are removed without asking unless they were modified after copying.
4. `git worktree remove`. Branches are kept. Unpushed commits are reported ("`agent/codex-1` has 3 commits
   on no remote"), but don't block removal because the branch still exists.
5. Delete the record. Optionally delete lane logs (default: logs age out after 14 days).

**Cleanup:** the Lanes view shows **Merged** or **Upstream deleted** from existing Git status.
`cinderdeck lane prune [--merged] [--dry-run]` removes clean merged lanes.

### 5.8 Agent and UI surface

- `lane create` / `create_lane`: add `from`, `env` (KEY=VALUE, repeatable), `setup` (default true), `copy`
  (extra patterns), and `adopt_path`.
- New: `lane env <lane> [--export|--json]` / `lane_env` returns the resolved environment for the lane, or for a service in it,
  with secrets redacted (C2). `eval "$(cinderdeck lane env shop/codex-1 --export)"` gives an agent's terminal
  the lane's ports and URLs.
- New: `lane adopt`, `lane release`, `lane prune`, `lane setup` (rerun setup).
- `list_lanes` returns resolved URLs, the mode for each service, setup status, `sourceChanged` (pinned lanes),
  merged status, and bind warnings.
- Lanes view cards: URLs per service (host-aware), shared services dimmed with "from base checkout",
  setup status and a Retry button, a bind warning badge, merged status, and disk usage for the remove dialog. **Open
  in** Terminal, VS Code, or Cursor at the lane root.

### 5.9 Hostnames per lane (optional)

With `lanes.hosts = true`, `{{host}}` is `<slug>.<workspace>.localhost`. Chrome, Firefox, and curl resolve
`*.localhost` to the loopback address, which isolates cookies per lane (P4). Before this becomes a default, verify
Safari's behavior on the minimum supported macOS, and check dev servers that validate the Host header (Vite's `server.allowedHosts`,
webpack-dev-server's `allowedHosts`). Stable per-lane OAuth callbacks would need a local reverse proxy; that's out of
scope here.

## 6. Implementation plan

Each phase ships on its own and keeps existing lane records working.

**Phase 1: correctness, no new config.** Low risk; fixes #4, #7, #9 (partly), #12, and makes #1 detectable.
- Track branches that exist only on the remote (R5).
- Allocate ports only to services that have ports; drop the port link for workers (P1).
- Set `PORT` and `CINDERDECK_PORT_*` in the base checkout; add `CINDERDECK_LANE_SLUG` and `CINDERDECK_LANE_DIR`; default `COMPOSE_PROJECT_NAME` in lanes (E3, E6).
- Queue lane operations; keep Git and stop outside the lock (C1).
- New lanes use `<workspace>/<slug>/<repo-folder-name>` under `~/.cinderdeck/lanes`; refuse a lanes folder inside a repo (L1, L2).
- `lane env` (C2).
- Loader warning for literal `localhost:<sibling port>` in env; fix the STACKS.md example (E1).
- Tests: remote-only branch, worker without a port, base env, concurrent creates, folder naming, warning text.

**Phase 2: templates, setup, removal.** Fixes #1, #2, #3, #11.
- `{{…}}` resolver shared by services, tasks, and readiness; load-time validation.
- `[lanes]` with `from`, `copy`, `link`, `setup`, `teardown`, `env`; per-lane `--env`.
- Overlay records and live derivation; pinned migration with Unpin.
- Removal with `discard_ignored` and a report of ignored files; teardown; log age-out.
- Bind check (P3).
- Tests: templates in base and lane; source edit reaches the lane; setup failure and retry; removal after `npm install`
  fixture; teardown blocks removal; bind mismatch detected.

**Phase 3: sharing and adoption.** Fixes #5, #6.
- Repo and service `lane` modes; non-Git folders treated as shared; shared dependency on base checkout runtime; "N lanes use it" on stop.
- Cross-workspace `depends_on` and `{{url.ws:svc}}`, preferring a lane on the same branch.
- Worktree registry with reference counts; `lane adopt` and `lane release`; MCP detection of the caller's worktree.
- Submodule initialization.
- Tests: shared DB with two lanes; stopping a lane leaves the shared service running; adopt a worktree Cinderdeck doesn't own and release it
  without deleting it; two workspaces sharing one worktree.

**Phase 4: ports and browsing.** Fixes the rest of #9 and #10.
- Named ports, port blocks per lane, task ports.
- `lanes.hosts`, merged-lane detection, `lane prune`, disk usage, UI work.

## 7. Decisions

1. **Lanes follow their source by default.** Records from 1.1 load pinned, with Unpin.
2. **Worktrees live in `~/.cinderdeck/lanes`**, configurable in Settings (`stacks.lanes_directory`) and per workspace
   with `[lanes] dir`. A lanes folder inside a source repository or the definitions folder is refused.
3. **Templates use `{{…}}`.** Only the `port`, `url`, `host`, `lane`, `repo` and `workspace` namespaces are templates,
   so other `{{…}}` text (Go templates, Handlebars) passes through.
4. **Starting a lane starts stopped shared services** in the original checkout, attributed to the caller.
5. **`discard_ignored` is explicit for agents** and a pre-checked checkbox in the Lanes view, which lists the files and sizes first.

## 8. Differences from the proposal

- `CINDERDECK_WORKSPACE` stays the lane's own ID (it is what every command accepts); `CINDERDECK_SOURCE_STACK` gives the source.
- Slugs come from the whole branch name (`agent/codex-1` → `agent-codex-1`), not its last component, to stay unique.
- Task ports in the original checkout use their configured values; lanes assign them from the lane's block.
- `lane create` never adopts silently. When the branch is checked out in another worktree it names the `lane adopt` command, and it
  reuses the worktree automatically only when another workspace's lane owns it.
- Nested repositories are still rejected; mark the inner repository `lane = "shared"`.
- Lane records stay in `<definitions>/.lanes/<id>/lane.json`; only worktrees moved.
- Submodule initialization has no automated test: local `file://` submodules need `protocol.file.allow`, which the test fixture cannot set globally.
