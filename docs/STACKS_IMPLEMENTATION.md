# Stacks implementation record

Specification: `Snapzy Stacks — Implementation Plan.md`, September 23, 2026.
Branch: `feat/stacks`, based on `codex/clipboard-text-history` (`6a9ddcb1`).

## Delivery checklist

- [x] History section migration, tab routing, keyboard and focus handling
- [x] Validated TOML definitions, live reload, template and configuration of arbitrary local projects
- [x] Isolated process groups, readiness, dependency ordering, port conflicts, restart limits
- [x] Durable run records, identity-checked reattachment, quit choices
- [x] Git status/watchers, branches, stash/switch/recovery, whole-stack switching
- [x] Compact cards, expanded controls, bounded ANSI logs and activity
- [x] Settings, configuration round-trip, Keychain management, user documentation
- [x] Unit/integration tests, regression suite, build, live UI verification

## Interpretation

- File-backed stdout/stderr take precedence over the architecture table's older pipe description.
- Resolve a login-shell environment once, then launch with `shell -c`; this avoids startup files overwriting service and secret overrides.
- Preserve the exact launch definition in the run record as well as its hash so stop behavior and change indicators survive relaunch. Secret **references** may persist; secret values never do.
- Optional services are started manually. A service whose dependency is disabled waits until that dependency is started manually.
- Definitions, Git and process fixtures can be exercised without checking out or stashing the user's working repositories.
- User clarification: Track repositories are examples and do not exist. Support arbitrary sets of projects; verify using temporary sample projects, without requiring any named repository.

## Verification evidence

Completed locally on September 23, 2026. Named repositories in the original plan were examples; no Track checkout or credentials were required.

### Automated coverage

**193 tests passed, 0 failures** in the final combined run: 57 Stacks tests and 136 existing regression tests.

The combined targeted suite covers the existing capture/clipboard/database/history/configuration behavior and the Stacks implementation. The final test log is `.build/stacks-final-tests.log`; the Xcode result bundle is under `.build/stacks-tests/Logs/Test/`.

Stacks coverage includes:

- TOML validation, dependency cycles, typed settings, unknown-key warnings, environment precedence, and one-time section migration.
- Real process groups, escalation, port ownership, HTTP/TCP/log readiness, bounded output, identity-checked reattachment, stale PIDs, and damaged saved definitions.
- Independent starts, optional dependencies, reverse shutdown, stop during startup/retry, shared repositories across stacks, failed-checkout recovery, and the three-retry limit.
- Temporary Git remotes and clones: local/remote checkout, dirty carry/stash, exact stash identity, divergence, in-progress merge blocking, and linked-worktree watchers.
- Atomic and in-place definition saves, ANSI state, UTF-8 chunks, ring limits, readiness after noisy output, and fresh-run logs.
- Shell environment cache/refresh/fallback; a uniquely named test Keychain item was created, updated, read, and removed.
- Keyboard routing, Delete isolation, editable versus read-only text, and auxiliary UI suppression.

### Live desktop checks

Used the actual floating panel with temporary projects and an isolated Debug database:

- Created a stack through **Add project…** twice, chose folders and commands, saved it, and started both services. No Git repository is required.
- Ran two stacks simultaneously; compact badges, dependency readiness, optional services, and expanded controls updated correctly.
- Checked ANSI logs, filtering, activity, service PIDs/ports, and compact/expanded transitions. Fixed a transition that canceled log updates.
- Switched a dirty sample Git project with **Stash & switch**; its service restarted, the other service kept its PID, the stash appeared, and branch activity named the old/new branches.
- Verified the unpinned panel stays open during the branch picker, the dirty-tree dialog, and after confirmation. Fixed deferred focus-loss dismissal.
- Chose **Quit and leave running**, rebuilt, reopened, and reattached to the same service PIDs. Stop still worked.
- Chose **Stop stacks and quit**; both fixture ports were clear and all fixture service processes exited.
- Screenshot evidence: `.build/stacks-expanded-verification.png`.

### Release

Signed Release build 194 uses the same Apple Development identity/team as build 193. Built using the documented Swift compiler workaround; `codesign --verify --deep --strict` passed. Installed in `/Applications/Snapzy.app`; the previous application is preserved at `.build/install-backups/Snapzy-build193-20260923.app`. Personal stack definitions were not populated with examples.

The previous derived-data folder referenced an obsolete checkout path, so this build uses `.build/stacks-release/`. Build log: `.build/stacks-release-build.log`.

### Scope notes

External Azure/Git Credential Manager accounts and particular nvm/dotnet/uv/pnpm installations were not exercised; portable shell resolution and temporary Git remotes were verified. Native notification delivery depends on the user's macOS permission; crash/retry behavior is covered without prompting during tests. The optional Stacks deep-link extension in the plan is deferred. Services must run in the foreground as described in `STACKS.md`.
