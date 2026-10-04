# Deckhand integration tools

A managed agent can inspect its lane through either MCP or the same authenticated terminal fallback. Both use Deckhand's domain services and the calling provider session's saved context. They never select a different workspace when that context becomes unavailable.

```sh
deckhand integration tools
deckhand integration call deckhand_context '{}'
deckhand integration call deckhand_services_runs '{}'
deckhand integration call deckhand_recordings '{}'
deckhand integration call deckhand_recording_logs '{"recordingID":"<recording-id>","around":12}'
```

`tools` prints names, descriptions and input JSON schemas. `call` needs the running agent terminal's injected `T3_ACP_MCP_ENDPOINT` and `T3_ACP_MCP_AUTHORIZATION`. These transport compatibility names remain stable across T3 updates. Credentials stay in the environment; never copy them into prompts or command arguments. This command is currently provider scoped; a regular shell without an issued provider credential cannot use it.

Read tools cover lane context, native services/readiness, task and workflow definitions, recent runs, run output, recordings, markers, capture provenance and synchronized logs. Recording IDs and run IDs are explicit; there is no implicit latest-recording selection.

`deckhand_recording_windows` lists available targets. Explicitly start capture with `deckhand_recording_start({windowID,title,operationKey})`; logs are scoped to the caller lane. Get the user’s agreement before computer/browser capture when the project requires it. `deckhand_recording_control({recordingID,action})` accepts pause/resume/stop for that provider’s capture. `deckhand_recording_mark({recordingID,label,outcome})` records pass/fail/info markers; stopping does not imply a passed check.

For a local service/task mutation, explicitly call `deckhand_operation_submit` with `method`, `arguments`, the current overview `revision`, and an original durable `operationKey`. Allowed methods are `services.start`, `services.stop`, `services.restart`, `runs.start`, `runs.cancel`, and `runs.rerun`. Native validation checks argument shapes, dependencies, revision and writer ownership. The calling provider must still own an active run. The adapters have no dedicated publish, merge, push, release, lane deletion or hosted PR mutation endpoint. Tasks execute saved native definitions, so review their commands before explicitly starting them.

After an interrupted reply, inspect `deckhand_operation_get` with the same key. If retry is needed, preserve the exact original key and arguments. Changing the key can create a different operation. Provider session ownership is distinct from the signed-in UI actor: use the same provider session to recover its operations and evidence preparations.

Prepare a local evidence bundle with `deckhand_evidence_prepare({recordingID,operationKey})`; keep the key after interruption. Poll `deckhand_evidence_get({recordingID,preparationID})` until ready. Assets report actual byte sizes, SHA256 hashes and ready/missing/failed states. Preparation includes video by default.

`deckhand_evidence_read({recordingID,preparationID,resourceID,offset,length})` returns a provider-owned chunk as base64, at most 64 KiB. Follow `nextOffset`, reconstruct the bytes and verify the complete asset SHA256 before consuming them. These tools do not create a UI HTTP grant or send attachments to a provider. Use the PR Verification draft flow to review and send actual supported files. An asset receipt is not proof that a provider accepted an attachment.

Source snapshots, dirty state and clock quality remain explicit. A matching capture-time source commit does not establish which build was served. Missing build stamps and legacy provenance remain unknown.

## Reported external sessions

External registration is visibility only. It creates an `external:<UUID>` record, never a managed thread, transcript, process handle, approval queue, or writer reservation. Provider name, session ID, execution and capabilities are registrant claims; a declared reviewer/read-only role does not enforce process permissions. The calling authenticated provider actor owns its reports. MCP/CLI derive installation, checkout, feature and repository scope from the current managed context; requests cannot select another lane. The direct environment RPC validates explicit identities against the same domain service.

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

Pass that exact preview and an original durable `operationKey` to `deckhand_verification_attempt_start`. Starting persists immutable intent before acquiring a separate native reservation or running the named build. The provider's existing writer token is never borrowed. An agent currently owning the checkout may receive a failed receipt explaining `checkout_reserved`; finish/stop that writer deliberately through the product before preparing a new attempt. A failed receipt is not a started or verified build. Inspect `phase`, `detail`, and the native `reservationState`.

Use `deckhand_verification_attempt_get({operationKey})` for one saved attempt or `deckhand_verification_attempt_list({reference})` for up to 30 compact summaries with actual build/check run IDs. List phases are last observed; get reconciles native durable state. The calling provider actor and exact feature/checkout/installation/generation must still match. No input can choose another lane.

`deckhand_verification_attempt_advance({operationKey,action,recordingID?})` accepts `launch`, `checks`, `finalize`, or `cancel`. Launch/checks revalidate the fresh PR head; finalize requires an actual scoped playable recording and stores its immutable proof. Each phase uses its saved deterministic key. Unknown outcomes must be recovered with get; repeating or replacing an uncertain key is not a recovery strategy. A first explicit cancel may stop proven owned processes; checkout ownership is released only after native process death is proved. A cancellation that remains failed/unknown after manual process recovery permits an explicit new `cancellationKey` with `action:"cancel"`. The server saves that distinct cleanup intent before invoking native stop; it never automatically resends the uncertain cancellation. Reuse the same new key if its response is lost. Native bounded receipts and actual owned process-death checks still decide release. None of these tools writes to the hosting provider or creates a PR.

A generic native window cannot prove that its video depicts the declared service. The full verdict therefore stays **incomplete**, even when `buildAndChecksMatch` confirms clean pinned source, actual named successful checks, and matching declared served artifact/stamp/process at capture endpoints. Earlier PR revisions, failed checks, missing assets, changed source and missing build proof stay explicit. These facts do not assert application behavior or provider attachment acceptance.

## Before and after comparisons

`deckhand_verification_scenarios({reference})` lists the calling feature’s saved comparisons with immutable recording IDs and manifest hashes. `deckhand_verification_scenario_save({reference,scenarioID,title,baselineArtifactID,followupArtifactID})` links two distinct, chronological recordings already associated with that same feature. Exact retries preserve the original pair; a changed pair requires a new scenario identity. `deckhand_verification_scenario_remove({reference,scenarioID})` removes only the comparison association, preserving both recordings. Mutations require current provider ownership; none writes to the hosting provider. Comparison preserves failed, stale, dirty and unknown evidence rather than inferring that the depicted build matches a PR.
