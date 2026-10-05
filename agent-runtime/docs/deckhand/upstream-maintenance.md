# Keeping Deckhand current with T3

Deckhand retains T3 history and its provider/runtime architecture. Upstream updates enter a review branch, while Deckhand owns its product, local stores, Cinderdeck integration and release decisions. The tested upstream revision lives in `upstream-patches.json`; neither fetching nor a clean merge changes a running installation.

## Rehearse an update

Fetch the desired upstream branch, then resolve the candidate and the committed Deckhand source to full commit SHAs. Rehearsal deliberately excludes uncommitted implementation work. Commit that work first when it needs to be part of the candidate.

```sh
git fetch upstream main
node scripts/deckhand/upstream-maintenance.mjs rehearse \
  "$(git rev-parse upstream/main)" "$(git rev-parse HEAD)" \
  /absolute/new/temporary/deckhand-worktree /absolute/evidence/upstream-report.json
```

This creates a detached temporary Git worktree and performs a real merge without committing. Original branches and history remain intact. Conflicts remain in the temporary checkout, and the report lists every unresolved path. Resolve conflicts there against the recorded ownership policies. Never choose `ours` or `theirs` for all files: doing so can silently discard Deckhand integration or upstream migration behavior. Do not promote a conflicted report.

After resolution, set the manifest's `upstreamRevision` to the exact candidate SHA, adapt affected patch entries and tests, and commit the merge with both histories. Run the patch audit from that checkout. The audit rejects unregistered upstream edits and missing owners, reasons, focused proofs or conflict policies. Deckhand directories remain separately owned; the inventory counts the actual upstream patch surface rather than promising a fixed small number.

## Prove compatibility before promotion

The report starts with every compatibility gate pending. A clean merge proves only that Git could combine the text. Run focused candidate checks, record the exact merge commit on each gate, and preserve evidence artifacts:

| Gate              | Required evidence                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| contracts         | Server/client schema and stream compatibility, bounded payloads, capability negotiation and unsupported operations                                                 |
| migrations        | Fresh and prior Deckhand databases, stored-event/schema changes, interrupted migration and rollback using copies or fixtures                                       |
| providers         | Codex and Claude standalone plus connected lifecycle, approvals, stop/resume, follow-up and settlement; record exact CLI versions                                  |
| connectedJourney  | Real Cinderdeck feature/lane creation, correct repository/branch/cwd, unique writer ownership, conversation, PR/verification/media navigation, restart and cleanup |
| standaloneJourney | Ordinary T3-derived project/thread, worktree, terminal, Git and provider functionality with Cinderdeck unavailable                                                 |
| identity          | Deckhand app/protocol/profile/store/CLI/feed destinations; vendor auth, relay, telemetry and publishing remain disabled                                            |
| dependencies      | Frozen-lockfile installation, packaging/runtime dependencies, security/native API changes and license notices                                                      |
| accessibility     | Actual keyboard/focus/zoom/narrow-window UI and the approved Deckhand visual design after upstream component changes                                               |

Each report gate has `status`, `sourceCommit`, and absolute `evidence` artifact paths. Set `status` to `passed` only after reviewing those results, at the final merge commit. Then run:

```sh
node scripts/deckhand/upstream-maintenance.mjs verify /absolute/evidence/upstream-report.json
```

Verification requires the candidate and original fork histories to be ancestors of HEAD, the manifest baseline to equal the candidate, all patch policies to be valid, and every required gate to have evidence at that exact commit. It is a maintainer evidence gate, not an automatic interpretation of videos or logs. A failed or unavailable provider/manual check remains pending. Verification does not publish, install, sign, or promote an update. Use the full release acceptance gates before merging staging into the release line.

The [bounded Overview gates](performance-gates.md) are part of the transport/provider/product focused proofs. Preserve selected-context detail lookup, the 100-context summary cap and the shared transactional event watermark when adapting an upstream projector or RPC change.

## Scheduled staging reviews

The `deckhand-upstream-sync` workflow is disabled until `DECKHAND_UPSTREAM_SYNC_ENABLED=true` is configured on the hosted fork. It resolves `upstream/main` once to an immutable SHA and uploads the isolated merge report weekly or on manual dispatch. Conflicts are preserved as review evidence and are never auto-resolved.

Automatic draft reviews require an additional deliberate setup: `DECKHAND_UPSTREAM_PR_ENABLED=true`, `DECKHAND_UPSTREAM_STAGING_BRANCH=deckhand/staging`, that existing staging branch, and a repository-scoped `DECKHAND_UPSTREAM_STAGING_TOKEN` with branch/PR permissions. Clean updates are committed to `deckhand/upstream-<sha>` and draft PRs target staging. Gate results remain pending. There is no automatic merge or release promotion. Publishing credentials belong only to the independent Deckhand release workflow and must not be shared with this maintenance workflow.

Inherited T3 release, relay, mobile, preview publishing and webhook workflows retain their source history but execute only in `pingdotgg/t3code`. Deckhand builds use its own app identity and never acquire a vendor updater from ambient GitHub configuration. `DECKHAND_DESKTOP_UPDATE_REPOSITORY` must name the independently managed Deckhand feed; the T3 repository is refused. The inherited server build CLI exposes build commands only; its T3 npm publishing subcommand is removed. Internal workspace package names remain compatible with upstream and are not a public Deckhand npm release namespace. A hosted fork/feed is not yet configured by this checkout.

Remove only your temporary rehearsal worktree when its evidence has been archived:

```sh
git worktree remove /absolute/new/temporary/deckhand-worktree
```

For a conflicted worktree, preserve the report and needed resolutions before explicitly discarding it. Never remove the main checkout, another agent's worktree, or live application stores.
