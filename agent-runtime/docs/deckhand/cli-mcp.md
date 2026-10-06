# Cinderdeck integration tools

A managed agent can inspect its lane through either MCP or the same authenticated terminal fallback. Both use Cinderdeck's domain services and the calling provider session's saved context. They never select a different workspace when that context becomes unavailable.

```sh
deckhand integration tools
deckhand integration call deckhand_context '{}'
deckhand integration call deckhand_services_runs '{}'
deckhand integration call deckhand_recordings '{}'
deckhand integration call deckhand_recording_logs '{"recordingID":"<recording-id>","around":12}'
```

`tools` prints names, descriptions and input JSON schemas. `call` needs the running agent terminal's injected `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION`. These transport compatibility names remain stable across runtime updates. Credentials stay in the environment; never copy them into prompts or command arguments. This command is currently provider scoped; a regular shell without an issued provider credential cannot use it.

Read tools cover lane context, native services/readiness, task and workflow definitions, recent runs, run output, scoped PR associations, recordings, markers, capture provenance and synchronized logs. `deckhand_context_pull_requests({offset?,limit?})` reads one page of the calling agent’s current managed workspace/lane PR associations, including historical contributors. Offset defaults to 0 (0–10000); limit defaults to 20 (1–50). Follow `nextOffset`; `total` counts that exact context. Installation, generation, workspace and project cannot be selected by the caller. An unavailable current context is refused rather than replaced. This read does not refresh hosting status or write to a PR. Recording IDs and run IDs are explicit; there is no implicit latest-recording selection.

`deckhand_recording_windows` lists available targets. Explicitly start capture with `deckhand_recording_start({windowID,title,operationKey})`; logs are scoped to the caller lane. Get the user’s agreement before computer/browser capture when the project requires it. `deckhand_recording_control({recordingID,action})` accepts pause/resume/stop for that provider’s capture. `deckhand_recording_mark({recordingID,label,outcome})` records pass/fail/info markers; stopping does not imply a passed check.

For a local service/task mutation, explicitly call `deckhand_operation_submit` with `method`, `arguments`, the current overview `revision`, and an original durable `operationKey`. Allowed methods are `services.start`, `services.stop`, `services.restart`, `runs.start`, `runs.cancel`, and `runs.rerun`. Native validation checks argument shapes, dependencies and revision. The calling provider must still own an active run. The adapters have no dedicated publish, merge, push, release, lane deletion or hosted PR mutation endpoint. Tasks execute saved native definitions, so review their commands before explicitly starting them.

After an interrupted reply, inspect `deckhand_operation_get` with the same key. If retry is needed, preserve the exact original key and arguments. Changing the key can create a different operation. Provider session ownership is distinct from the signed-in UI actor: use the same provider session to recover its operations and evidence preparations.

Prepare a local evidence bundle with `deckhand_evidence_prepare({recordingID,operationKey})`; keep the key after interruption. Poll `deckhand_evidence_get({recordingID,preparationID})` until ready. Assets report actual byte sizes, SHA256 hashes and ready/missing/failed states. Preparation includes video by default.

`deckhand_evidence_read({recordingID,preparationID,resourceID,offset,length})` returns a provider-owned chunk as base64, at most 64 KiB. Follow `nextOffset`, reconstruct the bytes and verify the complete asset SHA256 before consuming them. These tools do not create a UI HTTP grant or send attachments to a provider. Use the PR Verification draft flow to review and send actual supported files. An asset receipt is not proof that a provider accepted an attachment.

Source snapshots, dirty state and clock quality remain explicit. A matching capture-time source commit does not establish which build was served. Missing build stamps and legacy provenance remain unknown.

## Reported external sessions

External registration is visibility only. It creates an `external:<UUID>` record, never a managed thread, transcript, process handle, approval queue,. Provider name, session ID, execution and capabilities are registrant reports; a declared reviewer/read-only role does not enforce process permissions. The calling authenticated provider actor owns its reports. MCP/CLI derive installation, checkout, feature and repository scope from the current managed context; requests cannot select another lane. The direct environment RPC validates explicit identities against the same domain service.

Use `deckhand_external_session_register` with an original operation key, provider name/session ID, title, role, reported execution and capability list. Then use `deckhand_external_session_heartbeat` roughly every 60 seconds with the current `lastSequence` as `expectedSequence` and a higher `sequence`. An exact retry is safe and does not extend the original 120-second lease. Expiry means connection lost/last seen, never finished execution.

`deckhand_external_sessions` accepts `limit` (1–50) and optional `includeArchived`. `deckhand_external_session_visibility` accepts `id`, `expectedSequence`, and `archived`; archiving/restoring changes only saved visibility and advances the sequence. It does not renew the lease or stop/resume the external process. An archived record refuses new heartbeats until its owner restores visibility. Overview summarizes reported external registrations in one page batch; the selected lane inspector lists the newest 20.

```sh
deckhand integration tools
deckhand integration call deckhand_external_session_register '{"operationKey":"external-review-1","providerName":"Claude","providerSessionId":"claimed-external-id","title":"External review","role":"reviewer","reportedExecution":"working","reportedCapabilities":["read_only"]}'
deckhand integration call deckhand_external_sessions '{"limit":20}'
```

These commands use existing authenticated provider invocation credentials. Standalone callers without a managed invocation context receive an explicit failure; registration never invents a context or provider authority.

## Retained run detail and failures

`deckhand_run_detail({runID,stepOffset?,stepLimit?})` reads one exact run in the caller's lane. Step pages default to 16, never exceed 16, and report `totalSteps` and `nextStepOffset`. It returns actual named steps, outcomes and saved source provenance; unavailable history is an explicit error. `deckhand_run_failures({runIDs?})` reads a compact inventory with at most 100 failed/interrupted runs and positive matching-rerun resolution proofs. An optional list of at most 100 exact IDs revalidates retained failures. Absence, truncation and storage errors do not resolve a failure.

```sh
deckhand integration call deckhand_run_detail '{"runID":"<run-id>","stepOffset":0,"stepLimit":16}'
deckhand integration call deckhand_run_failures '{}'
```

## Pinned verification attempts

`deckhand_verification_attempt_preview({reference,serviceID})` reads a fresh authoritative PR head and validates the current calling feature/checkout, canonical repositories, physical identities, native installation/generation, clean source and declared build/check definitions. It does not start a build. `reference` uses the shared PR reference schema; `serviceID` is the configured service name.

Pass that exact preview and an original durable `operationKey` to `deckhand_verification_attempt_start`. Starting persists immutable intent before running the named build. Other agents can continue using the same checkout; source snapshots detect changes during the build. A failed receipt is not a started or verified build. Inspect `phase`, `detail`,.

Use `deckhand_verification_attempt_get({operationKey})` for one saved attempt or `deckhand_verification_attempt_list({reference})` for up to 30 compact summaries with actual build/check run IDs. List phases are last observed; get reconciles native durable state. The calling provider actor and exact feature/checkout/installation/generation must still match. No input can choose another lane.

`deckhand_verification_attempt_advance({operationKey,action,recordingID?})` accepts `launch`, `checks`, `finalize`, or `cancel`. Launch/checks revalidate the fresh PR head; finalize requires an actual scoped playable recording and stores its immutable proof. Each phase uses its saved deterministic key. Unknown outcomes must be recovered with get; repeating or replacing an uncertain key is not a recovery strategy. A first explicit cancel may stop proven owned processes; checkout ownership is released only after native process death is proved. A cancellation that remains failed/unknown after manual process recovery permits an explicit new `cancellationKey` with `action:"cancel"`. The server saves that distinct cleanup intent before invoking native stop; it never automatically resends the uncertain cancellation. Reuse the same new key if its response is lost. Native bounded receipts and actual owned process-death checks still decide release. None of these tools writes to the hosting provider or creates a PR.

A generic native window cannot prove that its video depicts the declared service. The full verdict therefore stays **incomplete**, even when `buildAndChecksMatch` confirms clean pinned source, actual named successful checks, and matching declared served artifact/stamp/process at capture endpoints. Earlier PR revisions, failed checks, missing assets, changed source and missing build proof stay explicit. These facts do not assert application behavior or provider attachment acceptance.

## Before and after comparisons

`deckhand_verification_scenarios({reference})` lists the calling feature’s saved comparisons with immutable recording IDs and manifest hashes. `deckhand_verification_scenario_save({reference,scenarioID,title,baselineArtifactID,followupArtifactID})` links two distinct, chronological recordings already associated with that same feature. Exact retries preserve the original pair; a changed pair requires a new scenario identity. `deckhand_verification_scenario_remove({reference,scenarioID})` removes only the comparison association, preserving both recordings. Mutations require current provider ownership; none writes to the hosting provider. Comparison preserves failed, stale, dirty and unknown evidence rather than inferring that the depicted build matches a PR.

## External application debugging

The `deckhand_debug_*` tools attach to selected native Mac windows with `mac://local`, independently of a Cinderdeck lane. Sessions belong to the calling thread and can be recovered with `deckhand_debug_sessions`. Session side-panel attachments share the calling thread’s namespace, so its agent can inspect the same selected windows. Other agent threads cannot read, control, or detach them. The authenticated UI can show accessible blocking connections in **Resolve window connection** and, after an explicit user choice, release them through their owning thread before reconnecting here. Legacy RPC callers that omit threadId retain separate signed-in actor sessions.

```sh
deckhand integration call deckhand_debug_open '{"bundleId":"com.microsoft.Excel"}'
deckhand integration call deckhand_debug_targets '{"endpoint":"mac://local"}'
deckhand integration call deckhand_debug_attach '{"endpoint":"mac://local","targetId":"mac:<pid>:<window-id>"}'
deckhand integration call deckhand_debug_read '{"sessionId":"<session>","after":0,"screenshot":true}'
deckhand integration call deckhand_debug_command '{"sessionId":"<session>","action":"permissions"}'
deckhand integration call deckhand_debug_command '{"sessionId":"<session>","action":"click","x":0.4,"y":0.5}'
deckhand integration call deckhand_debug_detach '{"sessionId":"<session>"}'
```

`deckhand_debug_open` opens an installed application by exact bundle ID on the thread’s Mac and attaches a single available window, reusing the thread’s existing connection. Several windows require an explicit target choice. Agent attachments appear beside chat. Launch only within the user’s request; use an isolated test document for checks. Native input events record accepted/failed dispatch without typed contents. Always read a subsequent screenshot or actual app logs to verify behavior.

Native commands are `permissions`, `focus`, `click`, `scroll`, `type`, and `key`. Click/scroll coordinates are normalized to the full captured window, including its title bar. Controls activate that window on its Mac and require Accessibility; viewing requires Screen Recording. Discover and select the application's actual WebKit Inspector to use its console and debugger. Native Mac sessions do not implement structured `evaluate`, `sources`, or stepping commands; send text and keys to the real Inspector instead. Do not claim Office API or OAuth success from a window title or a simulated fixture.

MCP reads deliver screenshots as JPEG image blocks, keeping base64 out of text and metadata. The CLI JSON fallback and web RPC retain the encoded image field; prefer `screenshot:false` in CLI diagnostics.

Advance `after` using `nextSequence`; each read holds at most 100 events. Pass the returned `imageSequence` as `afterImage` to receive image data only when it changes. `image:null` with the same sequence and `imageUnavailable:false` means the last image is unchanged; discard it on disconnection or unavailable status. Always detach when finished. Debugger previews are transient diagnostics, separate from saved recordings and build evidence.

An explicit loopback HTTP endpoint selects the separate CDP adapter for a Chromium runtime. CDP supports `sources`, `source`, `evaluate`, breakpoints, and pause/resume/stepping. Expressions execute in the live app and can change its data. See [Mac external app setup](external-apps.md).

## Move the current conversation to a lane

`t3_worktree_handoff({branch, continuationPrompt})` creates a Cinderdeck lane for a primary-checkout conversation and transfers the same chat. It updates the thread directory and managed binding atomically, so agent lists, services, preview/capture controls and subsequent provider turns use the lane. The primary checkout is eligible even though its chat has a saved working directory. `t3_worktree_status` distinguishes primary checkout from lane and reads the live branch when available.

To adopt an agent-created worktree, use `{branch, path, adoptExisting: true, continuationPrompt}`. The path must identify a separate worktree of the selected repository with that exact branch. Native Cinderdeck owns creation, adoption and setup; new lane paths are not supplied by the caller. Connected handoffs start from the current local branch unless `baseRef` or `startFromOrigin: true` is supplied. Standalone defaults retain their existing server setting. Existing uncommitted source files and terminal processes are not moved.

Call handoff as the last action of the turn. A successful transfer detaches the old provider and queues `continuationPrompt`, if supplied. Read-only chats and conversations already in lanes cannot use this transfer. Retry the same input after a pending/unknown native result; the durable native operation is reused and the original chat stays in place until a verified lane is ready.
