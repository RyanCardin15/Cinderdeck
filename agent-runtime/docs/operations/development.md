# Development

Use the pinned Node and pnpm versions in package.json. From `agent-runtime/`, run `pnpm install --frozen-lockfile`, then `node scripts/dev-runner.ts dev --home-dir /absolute/path/to/disposable-state`. This starts the private desktop runtime and a loopback renderer guarded by a per-launch main-process credential. The launcher sets the renderer and API URLs; do not open the renderer port in a browser. `--browser` and `--share` are unsupported. `dev:server` runs a headless companion API backend. Without a selected home or worktree, state is temporary.

The native macOS host owns runtime storage for an installed app. Never start a development backend against that store. Linked worktrees use their own ignored `.t3` compatibility directory; an explicit `--home-dir` takes precedence. Provider authentication remains with the installed CLI.

Build the complete app with [the root packaging guide](../../../docs/UNIFIED_APP.md). `apps/desktop` is the private runtime; `apps/mobile` is the companion. Whole-app updates and releases use the root repository workflows. Do not merge or release the former standalone agent product.

Use package typechecks and focused tests for the changed behavior. Socket/process tests may require an environment that permits local Unix sockets. Browser and physical device checks require user authorization and isolated fixture state.
