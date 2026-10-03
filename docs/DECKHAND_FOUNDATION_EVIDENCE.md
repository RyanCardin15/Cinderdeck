# Deckhand foundation validation — 2026-10-03

This records implementation progress against the full [plan](DECKHAND_IMPLEMENTATION_PLAN.md). It does not certify the full product or release. P0–P2 are partly implemented; downstream product phases remain open.

## Source and environment

- Deckhand: `/Users/ryancardin/Src/Deckhand`, branch `deckhand/main`, foundation commit `5189cd544d`, derived from T3 `4f7760e6a0037b06917adaae1b8a220e3ee6e5cc` with complete upstream history and license.
- Cinderdeck: isolated `codex/deckhand-integration` worktree at `/Users/ryancardin/.codex/worktrees/deckhand-integration/Cinderdeck`, based on `d838773a9bbca82732abbe5f9c5739f1693294ad`. The original checkout's unrelated work was preserved.
- macOS 26.3, arm64; Xcode 26.3; Node 24.19.0, pnpm 11.10.0, Electron 44.4.2; local Deckhand version `0.1.0-alpha.1`.
- Codex 0.159.0 installed under Deckhand's ignored test root. The globally installed Codex 0.141.0 was preserved. Claude 2.1.281 connected, but its weekly account limit prevented execution.

## Implemented foundation

Deckhand has separate app/profile/data/environment/storage/URL identities, disabled inherited cloud/analytics defaults, an explicit release-feed guard, a patch-boundary manifest, focused CI, physical Git checkout identity, typed bindings and namespaced persistence. Its server owns the Cinderdeck Unix adapter. A new native integration namespace provides an installation/host/channel handshake, coherent paged projection with replay cursor, resource generations/revisions, bounded long-poll events and persistent lane/service operation receipts.

The native journal reconciles from the existing supervisor, retains tombstones and stable event IDs, bounds page sizes and snapshot bytes, refuses unsupported store versions, and leaves legacy source timestamps unknown. Receipts persist intents before effects, reject argument-key conflicts, preserve terminal results, and never restart uncertain operations. Lane manifests retain the operation ID before Git mutations. Recovery can inspect a created lane while keeping its original operation outcome uncertain.

These are additive APIs. Existing CLI/MCP lane and service behavior remains in the original owner. Deckhand's new relationship services are not yet wired into the product screens or thread launch orchestration.

## Real execution evidence

Evidence files live under Deckhand's ignored `.deckhand/evidence/` directory:

- `native-restarted-bridge.json`: actual Swift hello/projection/replay decoded by the TypeScript adapter.
- `native-three-lanes-isolated.json`: three real lanes, nine distinct linked Git worktrees, six independent HTTP ports, verified per-repository physical identities, served source/build hashes and commits, duplicate submissions resolving to the original receipt, and commands completing while a separate event connection waits. Nine receipts record lane creation, service start and service stop. The service processes were stopped through their owner after the test.
- `payment-before-result.json`: authoritative Cinderdeck workflow failure from the deliberately unrepaired retry scenario, including the actual step exit code. A repaired run and captured video remain to be produced.
- Standalone web test: a real Codex session ran `pwd` and Git root lookup in the frontend fixture, created `deckhand-smoke.txt`, then appended its follow-up line in the same native session. Actual contents were checked on disk. Thread `6177903f-7bf8-4721-83ee-30ea09e39cb5` resides in the isolated server store.
- Claude test: thread `30f4d860-01ac-4de2-9a5f-659a3af8f7c2` displayed the provider's real weekly-limit response and paused state. This is failure-state evidence, not a successful Claude run.
- Actual Electron window: `Deckhand (Alpha)` opened at `deckhand://app/#/welcome`, using `.deckhand/desktop-smoke` for its server and `.deckhand/desktop-profile/deckhand-v2` for its profile. The deliberately supplied `T3CODE_HOME` sentinel remained unused.

An initial lane smoke test exposed a stored lane-directory preference escaping the preview root. Only the three fixture-owned, clean worktrees were removed through the native API. `StackPreviewHarness` now overrides that preference in its volatile test configuration; the complete rerun verified all nine worktree paths under `.deckhand/cinderdeck-smoke/lanes/`. The earlier result is not isolation acceptance evidence.

## Automated validation

- 360 focused Deckhand tests passed across 24 files, including transport framing/refusals, lost-response receipt recovery, persistence and packaging isolation. The feed-refusal tests were rerun after fixing a test-only TypeScript narrowing error: 11 passed.
- 65 focused native tests passed: journal, operation receipts, existing control and lane behavior. Result bundle: `.build/deckhand-integration/Logs/Test/Test-Cinderdeck-2026.10.03_08-10-48--0500.xcresult`.
- Server, web, desktop, contracts and shared package typechecks passed; targeted foundation lint passed; bundled desktop build passed; patch-boundary audit covered 309 files; both repository whitespace checks passed. CI is configured but has not run remotely.
- A restarted desktop initially contacted an orphaned test backend occupying its configured port. Its exact listener and checkout were verified before stopping it. The fresh direct Electron launch then returned to onboarding with the own product mark. Graceful launcher/process shutdown remains part of P10 reliability acceptance.

## Current limits

The full workspace/feature/agent/verification screens, managed session binding and reservations, exhaustive connected Git preflight, PR/evidence/media integration, external registration, complete CLI/MCP/native navigation, import/migration matrix, accessibility/performance acceptance and independently signed distribution/update/upstream-sync rehearsal remain incomplete. Durable mutations currently cover lane creation and service start/stop/restart; other mutation capabilities are refused explicitly. Operation recovery retains uncertainty rather than claiming exactly-once effects.

Local checks do not establish remote CI, successful Claude execution, real capture/export, signed install/update or the A01–A20 release acceptance matrix. No implementation PR or hosted Deckhand release repository has been created.
