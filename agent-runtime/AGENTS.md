# Cinderdeck agent runtime

This directory is part of the Cinderdeck super app, the private runtime of the native host. The native macOS host owns app identity, permissions, workspaces, services, lanes, logs, runs, recordings, and Sparkle updates. The embedded runtime owns agent threads, providers, diffs, terminals, and Chromium previews. The mobile app is a companion client, not an independent desktop product.

## Development

- Read the root README and docs/UNIFIED_APP.md. Build the complete app with ../scripts/build-unified.sh. Never install or launch a second desktop product as part of packaging.
- Workspace packages use @cinderdeck/*. The server is @cinderdeck/server. Use the pinned Node and pnpm versions in package.json.
- Run pnpm install --frozen-lockfile, then node scripts/dev-runner.ts dev for an isolated web/server development session. Do not bake VITE_HTTP_URL or VITE_WS_URL into dev bundles; Vite proxies same-origin API and WebSocket requests.
- Internal deckhand module paths, DECKHAND_* environment variables, wire identifiers and persisted keys are compatibility details. Do not rename or migrate them merely to change displayed branding. Preserve provider protocol fixtures and all original licenses/copyright notices.
- Never point a development server at live user data. Use an explicit --home-dir in temporary storage. The native host supplies its AgentRuntime directory; linked worktrees use their own ignored .t3 compatibility directory. Copy test data read-only into an isolated directory; never symlink it to a live store.
- Preserve other contributors' uncommitted work. Never kill processes by name, path matching, or pkill -f. Stop only a process you captured at spawn.
- Vendor-hosted accounts, telemetry, update feeds, deployment credentials and T3 release installers do not belong in this product. Whole-app releases are built and published manually; see ../docs/RELEASES.md. This repository does not use GitHub Actions, and there is no upstream patch allowlist or subtree sync gate.

## Architecture

- apps/server: typed RPC, event-sourced orchestration, providers and checkpoints. Commands commit before effects run; tests await persisted events or drain the effect worker.
- apps/web: React UI. apps/desktop: the private Electron runtime and preview runtime. apps/mobile: React Native companion.
- packages/contracts: schemas and wire contracts. packages/client-runtime: shared client state and operations. packages/shared: small runtime helpers with explicit subpath imports.
- Keep orchestration pure, service methods reusable by transports and MCP, and complexity at provider adapters. See docs/internals/effect-services.md and docs/internals/overview.md.
- Check changes across relevant clients, providers, entry points, remote/local connections, and reverse actions. Native authority stays with Cinderdeck.
- UI component variants own appearance. Avoid unnecessary animation, blocking main-thread work, unbounded logs and redundant WebSocket payloads.

## Verification and delivery

- Use focused tests and package typechecks appropriate to the change. Backend behavior changes require meaningful tests; do not add tests that mirror implementation or merely assert markup.
- Full checks are appropriate when explicitly requested for a repository-wide change. Run checks locally; there is no hosted CI suite.
- Do not run browsers/computer use without user authorization. Do not publish, merge or create a PR unless requested.
- Update inaccurate docs in place. Do not commit implementation plans or scratch notes. PR evidence belongs in the PR, not the source tree.
