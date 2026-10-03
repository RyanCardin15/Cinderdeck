# Developing Deckhand

Deckhand is a standalone fork pinned to T3 revision `4f7760e6a0037b06917adaae1b8a220e3ee6e5cc`. Upstream history and the MIT license remain intact. The local branch is `deckhand/main`; `upstream` refers to T3. A hosted fork and release feeds are not configured yet.

Use Node 24.19.0 and pnpm 11.10.0. Install with `pnpm install --frozen-lockfile`, then build with `pnpm run build:desktop`. `pnpm dev` retains upstream's single-origin server/web proxy arrangement. Runtime state belongs to `~/.deckhand`; linked Git worktrees use their own `.deckhand` directory. `DECKHAND_HOME` or `--base-dir` selects an explicit test root. `T3CODE_HOME` does not select a Deckhand store.

For isolated desktop tests, also set `DECKHAND_PROFILE_ROOT` to a throwaway directory. The Electron profile, preview browser sessions and settings are separate from the server's state root. Never run acceptance scenarios against a live T3, Deckhand or Cinderdeck store.

The CLI alias is `deckhand`. Desktop identifiers are `com.cardinlabs.deckhand` / `.dev`, with `deckhand://` / `deckhand-dev://` schemes. Web storage is namespaced separately. Internal workspace package names, upstream wire protocols and provider adapters retain their compatibility names.

Vendor relay/account configuration is stripped from builds. Analytics defaults to disabled; enabling it requires an explicit `DECKHAND_POSTHOG_KEY` and `DECKHAND_POSTHOG_HOST`. OTLP exporters use `DECKHAND_OTLP_*`. Desktop feeds require `DECKHAND_DESKTOP_UPDATE_REPOSITORY`; an ambient GitHub repository no longer configures a feed. Upstream's public update and support-agent commands are not exposed by the fork. The boot-service runtime installer refuses an unspecified Deckhand feed. Release packaging, branded assets, independent install/uninstall, and actual update acceptance remain unfinished.

Run `node scripts/deckhand/check-upstream-patches.mjs` before committing. New fork modules belong to owned Deckhand directories. Each changed upstream file is explicitly inventoried; expanding an allowlist requires a reason. The manifest's revision changes only as part of a tested upstream update. Focused tests and package typechecks are in the Deckhand CI workflow; a workflow definition is not evidence of a successful remote run.

Cinderdeck integration work is isolated in `/Users/ryancardin/.codex/worktrees/deckhand-integration/Cinderdeck`. The release scope and execution checklist remain in Cinderdeck's `docs/DECKHAND_IMPLEMENTATION_PLAN.md` and `docs/DECKHAND_IMPLEMENTATION_CHECKLIST.md`. No full-release item is complete on bootstrap evidence alone.
