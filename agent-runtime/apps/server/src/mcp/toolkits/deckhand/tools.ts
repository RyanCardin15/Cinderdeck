import * as Comparison from "@t3tools/contracts/deckhand/verificationRpc";
import * as Verification from "../../../deckhand/Verification.ts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as R from "@t3tools/contracts/deckhand/recordingsRpc";
import * as V from "@t3tools/contracts/deckhand/verificationAttemptsRpc";
import * as Attempts from "../../../deckhand/VerificationAttempts.ts";
import * as U from "@t3tools/contracts/deckhand/runsRpc";
import * as X from "@t3tools/contracts/deckhand/externalSessionsRpc";
import * as External from "../../../deckhand/ExternalSessions.ts";
import * as I from "@t3tools/contracts/deckhand/integration";
import {
  ThreadContextView,
  ContextPullRequestsInput,
  ContextPullRequestsPage,
} from "@t3tools/contracts/deckhand/rpc";
import * as ManagedSessions from "../../../deckhand/ManagedSessions.ts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as Access from "../../DeckhandMcpAccess.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Runs from "../../../deckhand/Runs.ts";
import * as Recordings from "../../../deckhand/Recordings.ts";
import * as Hub from "../../../deckhand/IntegrationHub.ts";
const base = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [Access.DeckhandMcpAccess, Invocation.McpInvocationContext],
};

export const ContextPullRequestsParameters = Schema.Struct({
  offset: Schema.optionalKey(
    ContextPullRequestsInput.fields.offset.check(Schema.isLessThanOrEqualTo(10000)),
  ),
  limit: Schema.optionalKey(ContextPullRequestsInput.fields.limit),
});
export const DeckhandToolkit = Toolkit.make(
  Tool.make("deckhand_verification_scenarios", {
    ...base,
    dependencies: [...base.dependencies, Verification.Verification],
    description:
      "Read saved before/after scenarios for this calling feature and exact PR reference. Immutable recording IDs and manifest hashes retain the original source evidence; comparison does not establish an exact running build.",
    parameters: Comparison.VerificationInput,
    success: Schema.Array(Comparison.VerificationScenario),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_verification_scenario_save", {
    ...base,
    dependencies: [...base.dependencies, Verification.Verification],
    description:
      "Explicitly link two already-associated recordings in the calling feature as an immutable before/after scenario. Baseline and follow-up IDs must be distinct and chronological. Reusing the exact scenario identity is safe; changed evidence is refused. No hosting writes.",
    parameters: Schema.Struct({
      reference: Comparison.VerificationScenarioSave.fields.reference,
      scenarioID: Comparison.VerificationScenarioSave.fields.scenarioID,
      title: Comparison.VerificationScenarioSave.fields.title,
      baselineArtifactID: Comparison.VerificationScenarioSave.fields.baselineArtifactID,
      followupArtifactID: Comparison.VerificationScenarioSave.fields.followupArtifactID,
    }),
    success: Schema.Array(Comparison.VerificationScenario),
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("deckhand_verification_scenario_remove", {
    ...base,
    dependencies: [...base.dependencies, Verification.Verification],
    description:
      "Explicitly remove a saved comparison association belonging to the calling feature. Preserves both original recordings and immutable source evidence. No hosting writes.",
    parameters: Comparison.VerificationScenarioRemove,
    success: Schema.Array(Comparison.VerificationScenario),
  }).annotate(Tool.Readonly, false),
  Tool.make("deckhand_external_session_register", {
    ...base,
    dependencies: [...base.dependencies, External.ExternalSessions],
    description:
      "Register a reported external session in this calling thread's exact feature/checkout/repository scope. Requires active provider ownership, immutable provider/session identity, and durable operationKey. Visibility only: never grants Stop, transcript, resume, approvals, or a writer reservation. Heartbeat every60seconds; lease 120 seconds.",
    parameters: Schema.Struct({
      operationKey: X.ExternalSessionRegister.fields.operationKey,
      providerName: X.ExternalSessionRegister.fields.providerName,
      providerSessionId: X.ExternalSessionRegister.fields.providerSessionId,
      title: X.ExternalSessionRegister.fields.title,
      role: X.ExternalSessionRegister.fields.role,
      reportedExecution: X.ExternalSessionRegister.fields.reportedExecution,
      reportedCapabilities: X.ExternalSessionRegister.fields.reportedCapabilities,
    }),
    success: X.ExternalSessionView,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("deckhand_external_session_heartbeat", {
    ...base,
    dependencies: [...base.dependencies, External.ExternalSessions],
    description:
      "Report the next external-session execution state using this same provider-session actor and exact context. expectedSequence must match lastSequence; sequence must advance. Exact replay is safe but does not extend lease. Expiry means last-seen connection, never completion. Registration grants no process controls.",
    parameters: Schema.Struct({
      id: X.ExternalSessionHeartbeat.fields.id,
      expectedSequence: X.ExternalSessionHeartbeat.fields.expectedSequence,
      sequence: X.ExternalSessionHeartbeat.fields.sequence,
      reportedExecution: X.ExternalSessionHeartbeat.fields.reportedExecution,
    }),
    success: X.ExternalSessionView,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("deckhand_external_session_visibility", {
    ...base,
    dependencies: [...base.dependencies, External.ExternalSessions],
    description:
      "Archive or restore your reported registration using its exact sequence and current calling context. Changes saved visibility only, never execution, connection lease or process controls.",
    parameters: Schema.Struct({
      id: X.ExternalSessionVisibility.fields.id,
      expectedSequence: X.ExternalSessionVisibility.fields.expectedSequence,
      archived: X.ExternalSessionVisibility.fields.archived,
    }),
    success: X.ExternalSessionView,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("deckhand_external_sessions", {
    ...base,
    dependencies: [...base.dependencies, External.ExternalSessions],
    description:
      "List up to 50 reported external sessions for this exact calling lane. Reported capabilities and execution are registrant claims, not provider-authenticated provenance. A stale lease means last seen, never finished.",
    parameters: Schema.Struct({
      limit: X.ExternalSessionList.fields.limit,
      includeArchived: X.ExternalSessionList.fields.includeArchived,
    }),
    success: Schema.Array(X.ExternalSessionView),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_recording_windows", {
    ...base,
    dependencies: [...base.dependencies, Recordings.Recordings],
    description:
      "List available native capture windows for explicit target selection in this lane. Listing does not start capture.",
    success: Schema.Array(R.RecordingWindow),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_recording_start", {
    ...base,
    dependencies: [...base.dependencies, Recordings.Recordings],
    description:
      "Explicitly start recording the selected native window, with logs scoped to this calling lane. Requires active provider ownership and an original durable operationKey. Get user agreement for browser/computer capture when applicable.",
    parameters: Schema.Struct({
      windowID: R.RecordingStart.fields.windowID,
      title: R.RecordingStart.fields.title,
      operationKey: R.RecordingStart.fields.operationKey,
    }),
    success: R.Recording,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("deckhand_recording_control", {
    ...base,
    dependencies: [...base.dependencies, Recordings.Recordings],
    description:
      "Explicitly pause/resume/stop a recording owned by this provider session. Stop preserves available video and evidence; it does not mark checks passed.",
    parameters: Schema.Struct({
      recordingID: R.RecordingControl.fields.recordingID,
      action: R.RecordingControl.fields.action,
    }),
    success: R.Recording,
  }).annotate(Tool.Readonly, false),
  Tool.make("deckhand_recording_mark", {
    ...base,
    dependencies: [...base.dependencies, Recordings.Recordings],
    description:
      "Add an action/check marker to a recording owned by this provider session. Mark failures honestly; a claimed pass is not exact build verification.",
    parameters: Schema.Struct({
      recordingID: R.RecordingMark.fields.recordingID,
      label: R.RecordingMark.fields.label,
      outcome: R.RecordingMark.fields.outcome,
    }),
    success: R.Recording,
  }).annotate(Tool.Readonly, false),
  Tool.make("deckhand_evidence_read", {
    ...base,
    dependencies: [...base.dependencies, Recordings.Recordings],
    description:
      "Read up to 64 KiB of one ready evidence asset owned by this provider session, as base64. Use metadata size and SHA256 to reconstruct and verify actual bytes. Keep video by default when a receiver supports attachments; chunk read does not itself prove provider attachment acceptance.",
    parameters: Schema.Struct({
      recordingID: R.EvidenceChunkInput.fields.recordingID,
      preparationID: R.EvidenceChunkInput.fields.preparationID,
      resourceID: R.EvidenceChunkInput.fields.resourceID,
      offset: R.EvidenceChunkInput.fields.offset,
      length: R.EvidenceChunkInput.fields.length,
    }),
    success: R.EvidenceChunk,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_context", {
    ...base,
    description:
      "Read this calling agent's managed lane and current native service context. No cross-workspace selection.",
    success: ThreadContextView,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_context_pull_requests", {
    ...base,
    dependencies: [...base.dependencies, ManagedSessions.ManagedSessions, Hub.IntegrationHub],
    description:
      "Read one page of real PR associations from this calling agent's exact current managed workspace/lane, including historical contributors. Defaults offset 0, limit 20; offset is bounded to 10000 and limit to 50. No caller-selected workspace, project or native identity. Returns total/nextOffset; does not refresh hosting status or write to a PR.",
    parameters: ContextPullRequestsParameters,
    success: ContextPullRequestsPage,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_services_runs", {
    ...base,
    dependencies: [...base.dependencies, Runs.Runs],
    description:
      "Read actual services, readiness, task/workflow definitions and recent runs for this agent's lane.",
    success: U.RunsOverview,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_run_detail", {
    ...base,
    dependencies: [...base.dependencies, Runs.Runs],
    description:
      "Read one exact retained run in the calling lane: named steps, actual results and immutable source provenance. Missing runs stay unavailable; they never imply success.",
    parameters: Schema.Struct({
      runID: U.RunGetInput.fields.runID,
      stepOffset: Schema.optionalKey(U.RunGetInput.fields.stepOffset),
      stepLimit: Schema.optionalKey(U.RunGetInput.fields.stepLimit),
    }),
    success: U.RunDetail,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_run_failures", {
    ...base,
    dependencies: [...base.dependencies, Runs.Runs],
    description:
      "Read compact bounded failed/interrupted run inventory and positive matching-rerun resolutions in this calling lane. Optional exact runIDs revalidate up to 100 retained causes. Absence or truncated inventory never means resolved.",
    parameters: Schema.Struct({ runIDs: U.RunFailuresInput.fields.runIDs }),
    success: U.RunFailures,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_verification_attempt_preview", {
    ...base,
    dependencies: [...base.dependencies, Attempts.VerificationAttempts],
    description:
      "Pin a freshly read PR head against this calling thread's clean feature checkout and declared service/build/check definitions. Read only. Canonical repo, physical checkout, installation and generation must match; no caller-selected lane or feature.",
    parameters: Schema.Struct({
      reference: V.AttemptPreviewInput.fields.reference,
      serviceID: V.AttemptPreviewInput.fields.serviceID,
    }),
    success: V.AttemptPreview,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_verification_attempt_start", {
    ...base,
    dependencies: [...base.dependencies, Attempts.VerificationAttempts],
    description:
      "Explicitly persist and start a pinned declared build using the original operationKey and preview. Only the caller's exact bound feature/checkout is accepted. Active provider writer ownership may correctly refuse the native reservation; no writer token is borrowed. Inspect receipt.phase/detail/reservationState honestly. Never replace an uncertain key. No hosting writes.",
    parameters: V.AttemptStart,
    success: V.VerificationAttempt,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("deckhand_verification_attempt_get", {
    ...base,
    dependencies: [...base.dependencies, Attempts.VerificationAttempts],
    description:
      "Recover one saved attempt belonging to this provider session and its exact current lane. Native read reconciliation never replays build/launch/check effects. Full verification remains incomplete without trusted capture target attestation.",
    parameters: V.AttemptLookup,
    success: V.VerificationAttempt,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_verification_attempt_list", {
    ...base,
    dependencies: [...base.dependencies, Attempts.VerificationAttempts],
    description:
      "List up to 30 compact saved attempt summaries for the requested PR and this exact calling feature/checkout. Includes actual run IDs; use get for one full proof. Saved native phase is last observed, not live process status.",
    parameters: Schema.Struct({ reference: V.AttemptPreviewInput.fields.reference }),
    success: Schema.Array(V.AttemptSummary).check(Schema.isMaxLength(30)),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_verification_attempt_advance", {
    ...base,
    dependencies: [...base.dependencies, Attempts.VerificationAttempts],
    description:
      "Explicitly launch the saved artifact, run required named checks, finalize with an actual scoped recording, or cancel owned processes and release. Caller context cannot be retargeted. Each phase has a saved deterministic key; uncertain actions must be recovered, never replayed. After failed/unknown cancellation and manual process recovery, an explicit new cancellationKey permits bounded cleanup retry. A generic window only proves simultaneous source/check/artifact facts; video target remains unverified. No PR/hosting writes.",
    parameters: V.AttemptAdvance,
    success: V.VerificationAttempt,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true),
  Tool.make("deckhand_run_logs", {
    ...base,
    dependencies: [...base.dependencies, Runs.Runs],
    description: "Read bounded actual output from a run in this lane.",
    parameters: Schema.Struct({
      runID: U.RunLogInput.fields.runID,
      stepID: U.RunLogInput.fields.stepID,
    }),
    success: U.RunLogs,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_recordings", {
    ...base,
    dependencies: [...base.dependencies, Recordings.Recordings],
    description:
      "List real recordings in this agent's lane, including immutable capture provenance.",
    success: Schema.Array(R.Recording),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_recording", {
    ...base,
    dependencies: [...base.dependencies, Recordings.Recordings],
    description:
      "Read a recording, action markers and source provenance. Source identity never proves served build freshness.",
    parameters: Schema.Struct({ recordingID: R.RecordingIdentity.fields.recordingID }),
    success: R.Recording,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_recording_logs", {
    ...base,
    dependencies: [...base.dependencies, Recordings.Recordings],
    description: "Read bounded synchronized recording logs in the current lane.",
    parameters: Schema.Struct({
      recordingID: R.RecordingIdentity.fields.recordingID,
      around: R.RecordingLogInput.fields.around,
      level: R.RecordingLogInput.fields.level,
      source: R.RecordingLogInput.fields.source,
    }),
    success: R.RecordingLogs,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_evidence_prepare", {
    ...base,
    dependencies: [...base.dependencies, Recordings.Recordings],
    description:
      "Explicitly prepare a local evidence bundle including video. Reuse the original operationKey after interruption; inspect until ready. This does not send files to any agent or hosted service.",
    parameters: Schema.Struct({
      recordingID: R.EvidencePrepare.fields.recordingID,
      operationKey: R.EvidencePrepare.fields.operationKey,
    }),
    success: R.EvidencePreparation,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("deckhand_evidence_get", {
    ...base,
    dependencies: [...base.dependencies, Recordings.Recordings],
    description:
      "Inspect the calling provider session's evidence preparation and actual hashed assets. HTTP media grants require a UI auth session; use the bounded evidence-read tool for provider transport.",
    parameters: Schema.Struct({
      recordingID: R.EvidenceIdentity.fields.recordingID,
      preparationID: R.EvidenceIdentity.fields.preparationID,
    }),
    success: R.EvidencePreparation,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("deckhand_operation_submit", {
    ...base,
    dependencies: [...base.dependencies, Hub.IntegrationHub],
    description:
      "Explicitly start/stop/restart local services or start/cancel/rerun a task/workflow in this lane. Supply the current revision from deckhand_services_runs and a durable operationKey. Reuse the original key and arguments after uncertainty, then inspect. Native validation enforces argument shape and dependencies. No hosted writes or lane deletion.",
    parameters: Schema.Struct({
      operationKey: I.IntegrationOperationInput.fields.operationKey,
      revision: I.IntegrationOperationInput.fields.revision,
      method: Schema.Literals([
        "services.start",
        "services.stop",
        "services.restart",
        "runs.start",
        "runs.cancel",
        "runs.rerun",
      ]),
      arguments: I.IntegrationOperationInput.fields.arguments,
    }),
    success: I.IntegrationOperationReceipt,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, true)
    .annotate(Tool.Idempotent, true),
  Tool.make("deckhand_operation_get", {
    ...base,
    dependencies: [...base.dependencies, Hub.IntegrationHub],
    description:
      "Reconcile a durable operation belonging to this provider session without resubmitting it.",
    parameters: Schema.Struct({ operationKey: I.IntegrationOperationInput.fields.operationKey }),
    success: I.IntegrationOperationReceipt,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
);
