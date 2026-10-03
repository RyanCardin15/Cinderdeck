# Deckhand implementation checklist

Companion to the [full implementation plan](DECKHAND_IMPLEMENTATION_PLAN.md). Completion is tracked individually; unchecked items may contain partial implementation. Check an item only after its code, meaningful tests, required documentation and evidence are complete. Record implementation PRs/commits and evidence beside the item as work proceeds.

Phases P0–P11 and acceptance cases A01–A20 refer to the full plan. This is one full-release scope; finishing an early integration slice does not complete it.

## P0 — Fork and isolated baseline

- [x] **DH-001** Create the permanent T3-derived Deckhand repository; preserve history/license; pin the inspected baseline; record dependency/runtime versions. Gate: a reproducible clean build and standalone launch. A01.
- [ ] **DH-002** Separate branding, app ID, data/config/secrets namespaces, URL scheme, CLI, updater and diagnostics destinations. Audit inherited cloud/relay/telemetry dependencies. Gate: no writes to live T3/Cinderdeck stores and no accidental upstream service requirement. A01, A20.
- [ ] **DH-003** Establish the upstream patch manifest, focused CI, fixture application and isolated Cinderdeck Debug environment. Gate: baseline provider/terminal/Git flow and reproducible test roots. A01, A02.

## P1 — Contracts and persistent relationships

- [ ] **DH-004** Define typed environment/workspace/checkout/feature identities and provider capability projections. Gate: canonical physical checkout and fork/host identities survive rename/alias cases. A02, A08.
- [ ] **DH-005** Add namespaced migrations for feature/context/session/artifact relationships and attention/activity projections; retain upstream session and PR records. Gate: fresh/upgrade/replay fixtures preserve data. A19.
- [ ] **DH-006** Specify operation receipts, argument hashes, resource generations, events, cursor/resync and shared Swift/TypeScript contract fixtures. Gate: duplicate, stale, wrong-type, unknown-capability and generation-reuse cases pass. A06, A16, A19.

## P2 — Cinderdeck integration bridge

- [ ] **DH-007** Implement same-host discovery, identity/capability handshake, channel checks and connection state. Gate: wrong host/channel, missing app and older app produce correct recoverable states. A01, A17, A19.
- [ ] **DH-008** Implement the Cinderdeck integration projection/journal, atomic projection snapshot cursor, long-poll replay and startup reconciliation. Gate: gaps/repeated events/restarts remain coherent. A06.
- [ ] **DH-009** Implement operation submit/status plus per-operation lane/run/recording reconciliation; keep commands independent of long-poll connections. Gate: lost responses never blindly repeat mutations. A06.
- [ ] **DH-010** Add bounded session/artifact registration and Deckhand server/client projections with authorization, backoff and deduplication. Gate: spoofed managed identities and unauthorized resources are rejected. A15, A17.

## P3 — Checkout ownership and lane lifecycle

- [ ] **DH-011** Add standalone/connected workspace backend selection and route all create/adopt/setup/release/remove operations through it. Gate: no duplicate worktree per managed lane. A02, A07.
- [ ] **DH-012** Implement multi-repository checkout resolution, primary-checkout contexts, shared services and port/URL context. Gate: three real lanes run independently with the right source trees. A02.
- [ ] **DH-013** Implement reservations keyed by physical checkout; queue managed writers; preserve human override and advisory-boundary semantics. Gate: aliases cannot bypass coordination. A03.
- [ ] **DH-014** Audit and route Git/PR checkout, branch switch, reset/rebase/pull, checkpoint restoration, settlement/archive cleanup and worktree tools through connected preflight. Gate: active runs and dirty/adopted/shared worktrees remain protected. A05, A07, A10.
- [ ] **DH-015** Implement explicit standalone adoption and connected release transitions with retained session IDs and recovery receipts. Gate: connection loss alone never changes ownership. A06, A07.

## P4 — Workspace overview

- [ ] **DH-016** Build the shared Deckhand theme/components and workspace/lane navigation from the approved concept; implement responsive/light/dark/keyboard states. Gate: accessible navigation to all real contexts. A18.
- [ ] **DH-017** Build real lane rows with sessions, PRs, recordings, service summary, filters and inspector. Gate: accurate scoped counts and no transcript/log overfetch. A02, A08, A11, A18.
- [ ] **DH-018** Implement activity, loading/empty/stale/disconnected/invalid-definition/auth states and bounded subscriptions. Gate: errors never appear as empty successful workspaces. A06, A17, A19.

## P5 — Managed and external agents

- [ ] **DH-019** Bind upstream thread creation to feature/checkout context and launch real Codex/Claude Code sessions with provider/account identity. Gate: process cwd and resource attribution match the lane. A02, A03.
- [ ] **DH-020** Implement state normalization, per-session tabs, turn-versus-feature completion and provider capability presentation. Gate: working/input/approval/idle/error/disconnected states reflect events. A04, A05, A06.
- [ ] **DH-021** Complete follow-ups, steering/queueing where supported, attachments, approval answers, questions, interruption, native resume and handoff fallbacks. Gate: no stale approval or wrong-thread input. A04, A05, A14.
- [ ] **DH-022** Implement reviewer scheduling and enforce read-only or isolated-review behavior, with reviewed-revision attribution. Gate: a queued reviewer cannot edit the implementer's active checkout. A03.
- [ ] **DH-023** Implement external-session registration, capabilities, last-seen expiry and child-agent attribution where available. Gate: unsupported controls remain unavailable and missing heartbeat never means completed. A15.
- [ ] **DH-024** Integrate preview/diff/file/terminal panels and persist lane/session drafts/selections safely. Gate: switching contexts cannot retarget ongoing work or leak attachments. A05, A17.

## P6 — Pull requests

- [ ] **DH-025** Extend upstream persistent PR links to features/checkouts and session reverse lookup; preserve host/head/base identity. Gate: zero/one/multiple PRs and multiple repositories work. A08.
- [ ] **DH-026** Link managed PR creation results and implement external PR suggestions, explicit association and ambiguous-match handling. Gate: same branch name in a fork/other repo does not misattach. A08.
- [ ] **DH-027** Implement coordinated PR freshness/check/review reads, rate-limit behavior and revision/account preflight for writes. Gate: force-push, account switch and uncertain results are handled correctly. A09, A17.

## P7 — Capture, media and handoff

- [ ] **DH-028** Complete a real T3-preview capture/export compatibility spike. Record codec/container, capture coverage, clock mapping and fallback decision. Gate: a playable exported video with measured synchronization. A12, A13.
- [ ] **DH-029** Integrate existing Cinderdeck screen/window/CDP recording controls and explicit primary versus captured-workspace scope. Gate: actual included/excluded sources match every interface. A11.
- [ ] **DH-030** Implement external begin/finalize, staging ownership, media validation/normalization, import receipts and abandoned-capture recovery. Gate: pause/stop/disconnect/disk-full failures remain honest. A13.
- [ ] **DH-031** Implement authorized opaque media resources, range playback, hashes/thumbnail cache and bounded log reads on the execution host. Gate: local and authenticated remote clients cannot read arbitrary files. A17, A18.
- [ ] **DH-032** Build the recording library, frame/annotation references and draft evidence preparation with actual media capability checks. Gate: complete video-inclusive bundle or explicit provider fallback. A11, A14.

## P8 — Revision-aware verification and review

- [ ] **DH-033** Persist immutable provenance manifests for repositories, tracked/untracked source fingerprints, definitions, runs, service/build identity and capture quality. Gate: legacy/missing provenance is unknown, not inferred. A09, A10, A19.
- [ ] **DH-034** Run full-confidence verification against a reserved or isolated pinned checkout/build and record named actual checks. Gate: changing code, stale server builds and dirty trees cannot receive a false exact-commit badge. A10, A12.
- [ ] **DH-035** Implement evidence association/freshness classification and invalidate currentness on PR/repository/environment changes without rewriting history. Gate: failed-but-current and passed-but-old are distinct. A09, A10.
- [ ] **DH-036** Build PR verification player, timeline, synchronized filtered logs, before/after scenario links and agent/PR inspector. Gate: the third approved screen works on real failed-then-fixed evidence. A12, A14, A18.

## P9 — Complete product surfaces and agent interfaces

- [ ] **DH-037** Complete Services/Runs views: dependencies, start/stop/restart, tasks/workflows, cancellation, past results, rerun, recording and validated definition edits. Gate: operations and statuses match Cinderdeck's owner. A02, A06, A16.
- [ ] **DH-038** Build the attention inbox with approval/input/failure/review items and authoritative resolution/snooze behavior. Gate: wrong-context or stale actions are rejected. A04, A17.
- [ ] **DH-039** Add native Cinderdeck Agents & linked work, PR/recording associations and validated bidirectional deep links. Gate: correct workspace/lane/session opens after restart and missing targets recover cleanly. A08, A16.
- [ ] **DH-040** Complete standalone/connected onboarding and provider/connection/recording/retention/notification/update settings. Gate: setup doesn't launch unrelated work or mutate source stores. A01, A19.
- [ ] **DH-041** Expose integration/context/evidence operations through the shared CLI/MCP domain services and update help, schemas and canonical installed skills. Gate: real UI/CLI/MCP results and validation agree. A16.

## P10 — Reliability, migration and quality

- [ ] **DH-042** Run the complete failure/reconnect/operation-reconciliation matrix, including interrupted writes, provider exit, expired replay cursor, source deletion and resource generation reuse. Gate: no duplicate/lost ownership or false status. A06, A13, A15.
- [ ] **DH-043** Implement/test optional read-only T3 import, backward-compatible Cinderdeck metadata, legacy evidence and compatible upgrade/rollback paths. Gate: old data retained and unsupported downgrade refused safely. A19.
- [ ] **DH-044** Complete keyboard/VoiceOver, focus, text scaling, contrast, reduced motion, narrow layout and error-state walkthroughs. Gate: critical actions remain usable in all supported modes. A18.
- [ ] **DH-045** Measure/fix overview, live-event, video/log, memory, process/descriptor, and energy budgets on supported hardware with large fixtures. Gate: recorded results meet the full plan's budgets. A18.
- [ ] **DH-046** Execute A01–A19 using real providers, real capture, controlled hosting writes and isolated data stores; rehearse development packaging checks. Reserve final signed install/update acceptance A20 for P11. Gate: every applicable external/manual test has actual evidence; no mocked success substitution.

## P11 — Release and sustainable maintenance

- [ ] **DH-047** Produce independently signed/notarized Deckhand and compatible Cinderdeck release candidates with notices, own feeds, version compatibility and support diagnostics. Gate: clean-machine installation works. A20.
- [ ] **DH-048** Test real update, failed update and binary/store rollback procedures, including simultaneous Deckhand/T3/Cinderdeck installation. Gate: unrelated app settings/data survive. A19, A20.
- [ ] **DH-049** Rehearse a real upstream update in a staging branch; run patch-boundary, stored-event migration, provider and connected-journey tests. Gate: documented update procedure succeeds without unreviewed production promotion.
- [ ] **DH-050** Package release notes, setup/operator docs, exact revisions, acceptance videos, test/migration/performance results and known capability limits. Gate: A01–A20 and the full plan's definition of complete are satisfied.

## Evidence record template

For each completed item append:

```text
Implementation: repository + PR/commit
Validation: meaningful automated checks + real/manual checks
Environment: OS, app versions, provider versions and isolated data roots
Evidence: recordings, logs, reports and fixture revisions
Remaining limits: none, or explicit unresolved release blocker
```

Do not check a parent phase complete while any required item is unfinished. App compilation, generated mockups and reported agent success are insufficient evidence for a completed connected workflow.

## Foundation checkpoint — 2026-10-03

DH-001: permanent full-history fork, pinned upstream revision, runtime/dependency versions, frozen install, clean upstream build and actual isolated standalone web/Electron launches. Deckhand commit `5189cd544d`. Evidence and remaining limits: [foundation validation](DECKHAND_FOUNDATION_EVIDENCE.md).

DH-002–DH-009 contain partial foundation work. They remain unchecked because branding/distribution assets, complete contracts/registration, discovery/reconnect, all mutation reconciliations and the full acceptance gates remain open. No parent phase is complete.

Additional Deckhand commits: `3c9ba03da0` (launcher lifecycle) and `b7f3cd3100` (session persistence and physical binding guards). Native integration commit: `d47ab9c1`. Relationship tests/typecheck/lint/build and two captured-PID launcher shutdown checks passed; [foundation validation](DECKHAND_FOUNDATION_EVIDENCE.md) records the scope. All additional DH items remain unchecked.

## Connected workspace checkpoint — 2026-10-03

Deckhand commit `2ea01a3a34`: authenticated same-host discovery, a persisted shared projection, durable actor-bound operation intents and the first real workspace overview now provide partial DH-005–DH-010 and DH-016–DH-018 implementation. Real web controls created a three-repository lane and started/stopped its two isolated services; Electron connected to the same catalog and passed a light-mode/Settings-return walkthrough. Thirty-seven focused tests and scoped typechecks/build passed. [Validation and remaining gaps](DECKHAND_FOUNDATION_EVIDENCE.md#connected-workspace-checkpoint--2026-10-03) distinguish this checkpoint from the still-open full gates. No additional item is checked complete.

## Managed checkout admission checkpoint — 2026-10-03

Deckhand commit `7c4990036a` adds explicit repository scope, separate native checkout generation, physical writer queues and provider admission checks. A shared provider process can hold independent thread/checkouts without treating its first cwd as every thread's cwd. Seventy-six focused tests, server typecheck, changed-module lint, desktop build and patch-boundary verification passed. Real Codex resumed its existing disposable fixture thread after restart; its thread-scoped reservation was held during residency and released after normal provider/server shutdown. [Validation and limits](DECKHAND_FOUNDATION_EVIDENCE.md#managed-checkout-admission-checkpoint--2026-10-03) record this as partial P2–P5 progress. Full native ownership/preflight, launch/registration UI, queued-state projection, recovery controls and the rest of P0–P11 remain required. No additional item or phase is complete.

## Native checkout reservation checkpoint — 2026-10-03

Deckhand implementation: `ca2b242a93`. Native implementation is included with this checkpoint in the isolated `codex/deckhand-integration` checkout.

Native finite runs and central Git changes now share a durable physical barrier with managed Deckhand providers. Deckhand persists native intent before transport, reconciles lost replies, verifies held ownership before managed calls and releases only after actual process shutdown. Eighty-seven focused Deckhand tests and 25 native tests passed; a real resumed Codex fixture held the same lease in both stores, blocked native admission after turn completion, and released both leases on confirmed shutdown. [Validation and remaining work](DECKHAND_FOUNDATION_EVIDENCE.md#native-checkout-reservation-checkpoint--2026-10-03) record the offline fixture binding separately from the still-unimplemented managed lane launch UI. Native lifecycle delegation/coverage, remaining mutation routes, ownership recovery/override controls, queue/status projections and the complete release scope remain open. This is progress in P2–P5; only DH-001 remains checked.


## Managed lane launch and live sessions checkpoint — 2026-10-03

Deckhand commit `7b26fac1d8` adds durable managed launch into an explicit existing lane repository, exact-request recovery, saved feature/session/thread attribution and bounded live control projections in the context inspector. Seventy-nine focused tests, four scoped typechecks, lint, server/web builds and patch-boundary verification passed. Real Codex launched from the UI and resumed the same conversation after both isolated apps restarted. A live catalog-teardown shutdown defect was found and fixed; two repeated normal shutdowns released native and local ownership, and native admission changed from refused while resident to successful after release. [Evidence and remaining gates](DECKHAND_FOUNDATION_EVIDENCE.md#managed-lane-launch-and-live-sessions-checkpoint--2026-10-03) distinguish the exact isolated recovery repair from still-required product recovery controls. DH-019–DH-021 remain partial, and only DH-001 is checked complete.

## Git and file mutation ownership checkpoint — 2026-10-03

Deckhand `245c058b49` and native `9dfd4b6f` coordinate both Git drivers and checkpoint restoration with physical local/native ownership. Shared refs include actual unbound linked worktrees; native held claims survive definition removal. Coordinated rollback refuses ownership before rewinding the conversation or files. Two hundred eleven focused Deckhand tests and 28 native tests passed, along with scoped typechecks/lint/build and the patch audit. An authenticated production RPC and actual native task verified refusal while held and success after release, with no remaining claims/listeners. [Evidence and required remaining work](DECKHAND_FOUNDATION_EVIDENCE.md#git-and-file-mutation-ownership-checkpoint--2026-10-03) record incomplete backend lifecycle delegation, multistep workflow admission and resident-provider rollback handoff. DH-011–DH-014 remain partial; only DH-001 is checked complete.

## Workspace backend selection checkpoint — 2026-10-03

Deckhand `826631a044` routes mutation inspection, authenticated inventory/connected creation and managed launch context lookup through the common WorkspaceBackend. Missing Git metadata retains native ownership; standalone/native transfer remains explicit, and shared refs preserve separately owned worktrees. Three hundred twelve focused tests, server typecheck/build, scoped lint and the patch audit passed. Real authenticated native inventory, stale creation refusal, held-owner Git refusal and scoped release were verified with all test processes stopped. [Evidence and remaining lifecycle work](DECKHAND_FOUNDATION_EVIDENCE.md#workspace-backend-selection-checkpoint--2026-10-03) distinguish this partial interface from complete backend lifecycle delegation and native lane lifecycle reservations. DH-011–DH-014 remain open; only DH-001 is checked.

### Native lane lifecycle ownership evidence (partial DH-011–DH-014)

Native `3d4a72fb`; 88 focused native tests plus fresh real-app Unix-socket lifecycle verification passed. Physical writer conflicts, borrowed teardown attribution, unstopped process retention, task-only checkouts and missing registered cleanup are covered. Evidence and remaining interface/concurrency/recovery work are recorded in `DECKHAND_FOUNDATION_EVIDENCE.md`; these items remain unchecked.

### Connected lifecycle delegation evidence (partial DH-009/DH-011)

Deckhand `06ae9a939c` and native `bbfc9463` add connected adopt/setup/release/remove beside create, precise capability gates, strict native inputs, final context preflight, setup attribution and conservative interrupted lifecycle inspection. Ninety-one native tests, 35 focused Deckhand tests, affected typechecks/build/patch audit and real authenticated production RPC lifecycle verification passed. See `DECKHAND_FOUNDATION_EVIDENCE.md` for evidence and remaining standalone/surface/concurrency/recovery gates. These full items remain unchecked.


### Standalone worktree lifecycle evidence (partial DH-011–DH-014)

Deckhand `f66b5985ca` makes WorkspaceBackend own finite admission and keeps standalone worktree creation/removal/pruning under one lifecycle reservation. New checkout identities are included before configuration; collisions preserve files/other owners, missing registrations retain writer barriers, and inherited authorization expires with its operation. The final 197 focused tests, server typecheck/build, scoped lint/patch audit and fresh authenticated standalone/native lifecycle verification passed with zero remaining claims or listeners. [Evidence and remaining boundaries](DECKHAND_FOUNDATION_EVIDENCE.md#standalone-worktree-lifecycle-ownership-checkpoint--2026-10-03) retain future-target admission, higher-level workflow atomicity, connected surface delegation and transition/recovery gates. Only DH-001 remains checked complete.


### Repository-specific lane start evidence (partial DH-011/DH-012/DH-041)

Deckhand `b25cf17f98` and native `bc4dcc43` pin explicit starts by repository ID before creation effects, retain defaults for other repositories, expose repeatable CLI `--repo-from` and bounded MCP `repositoryRefs`, and reject unsupported peers or invalid inputs with definitive refusal handling. Forty-one focused Deckhand tests, 88 native tests, affected typechecks/build/lint/patch audit and fresh authenticated RPC plus real CLI/MCP verification passed. All test apps/listeners stopped and both reservation stores had zero active claims. [Evidence and remaining lifecycle boundaries](DECKHAND_FOUNDATION_EVIDENCE.md#repository-specific-lane-starts-checkpoint--2026-10-03) retain upstream automatic delegation, future target admission, multistep atomicity and the full release gates. No additional checklist item is complete.


### Bounded receipt wait evidence (partial DH-006/DH-009/DH-011)

Deckhand `7c65c9e785` and native `cb282ac6` provide capability-gated bounded receipt observation through WorkspaceBackend and authenticated RPC, retaining actor/key identity and conservative timeout/restart outcomes. Thirty-seven focused Deckhand tests, 13 native tests, scoped typechecks/build/lint/patch audit and a real FIFO-blocked setup wait with concurrent commands passed. Both test apps/listeners stopped with zero active claims. [Evidence and remaining connected routing work](DECKHAND_FOUNDATION_EVIDENCE.md#bounded-operation-receipt-waits-checkpoint--2026-10-03) retain automatic creation/removal delegation, frontend consumption, transport shutdown/performance and the full release matrix. No additional full checklist item is complete.


### Connected creation API checkpoint — 2026-10-03

- Combined creation persists the original request before native effects, waits on the same native operation and launches in the returned existing checkout. Read-only lookup does not launch; uncertain/setup/provider failures retain recoverable lane identity. Deckhand `bcc548cebb`, native `1ff39bf1`.
- Explicit durable managed-writer handoff avoids a creator advisory claim blocking the provider thread; legacy creation claims and physical removal guards are verified.
- Fifty focused Deckhand tests and thirteen native tests passed. Authenticated real Codex 0.160.0 verification proved exact checkout, approval state, one lane/thread after retry and server restart, and zero remaining writer claims after shutdown. See the foundation evidence checkpoint and `output/deckhand-session-create-2026-10-03/live-verification.json`.
- New client creation controls, pre-creation feature/context reservations, stale resolved-launch recovery and the complete remaining acceptance scope are still open. No additional checklist item is complete.
