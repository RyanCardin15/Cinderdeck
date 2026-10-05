# Development

Use the pinned Node and pnpm versions in package.json. From `agent-runtime/`, run `pnpm install --frozen-lockfile`, then `node scripts/dev-runner.ts dev --home-dir /absolute/path/to/disposable-state`. Read the actual ports from the dev-runner output. Leave VITE_HTTP_URL and VITE_WS_URL unset so API and WebSocket traffic stays on the browser’s origin.

The native macOS host owns runtime storage for an installed app. Never start a development backend against that store. Linked worktrees use their own ignored `.t3` compatibility directory; an explicit `--home-dir` takes precedence. Provider authentication remains with the installed CLI.

Build the complete app with [the root packaging guide](../../../docs/UNIFIED_APP.md). `apps/desktop` is the private AgentShell; `apps/mobile` is the companion. Whole-app updates and releases use the root repository workflows. Do not merge or release the former standalone agent product.

Use package typechecks and focused tests for the changed behavior. Socket/process tests may require an environment that permits local Unix sockets. Browser and physical device checks require user authorization and isolated fixture state.
