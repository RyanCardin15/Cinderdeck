import * as Verification from "../../../deckhand/Verification.ts";
import * as Attempts from "../../../deckhand/VerificationAttempts.ts";
import * as External from "../../../deckhand/ExternalSessions.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ManagedSessions from "../../../deckhand/ManagedSessions.ts";
import * as Access from "../../DeckhandMcpAccess.ts";
import * as Runs from "../../../deckhand/Runs.ts";
import * as Recordings from "../../../deckhand/Recordings.ts";
import * as Hub from "../../../deckhand/IntegrationHub.ts";
import { DeckhandToolkit, ContextPullRequestsParameters } from "./tools.ts";
const isContextPullRequestsParameters = Schema.is(ContextPullRequestsParameters);
export const handlers = {
  deckhand_verification_scenarios: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      const overview = yield* (yield* Verification.Verification).list(c.actor, input);
      return (overview.scenarios ?? []).filter(
        (scenario) => scenario.featureID === c.view.feature.id,
      );
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_verification_scenario_save: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      const service = yield* Verification.Verification;
      const overview = yield* service.list(c.actor, { reference: input.reference });
      if (
        ![input.baselineArtifactID, input.followupArtifactID].every((id) =>
          overview.evidence.some(
            (evidence) => evidence.artifactID === id && evidence.featureID === c.view.feature.id,
          ),
        )
      )
        return yield* Access.deckhandFailure({ reason: "stale_binding" });
      const saved = yield* service.scenarioSave(c.actor, {
        ...input,
        featureID: c.view.feature.id,
      });
      return (saved.scenarios ?? []).filter((scenario) => scenario.featureID === c.view.feature.id);
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_verification_scenario_remove: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      const service = yield* Verification.Verification;
      const overview = yield* service.list(c.actor, { reference: input.reference });
      if (
        !(overview.scenarios ?? []).some(
          (scenario) =>
            scenario.id === input.scenarioID && scenario.featureID === c.view.feature.id,
        )
      )
        return yield* Access.deckhandFailure({ reason: "stale_binding" });
      const saved = yield* service.scenarioRemove(c.actor, input);
      return (saved.scenarios ?? []).filter((scenario) => scenario.featureID === c.view.feature.id);
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_external_session_register: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      if (!c.view.session.repositoryScope?.length)
        return yield* Access.deckhandFailure({ reason: "stale_binding" });
      return yield* (yield* External.ExternalSessions).register(c.actor, {
        ...input,
        ...c.input,
        featureId: c.view.feature.id,
        checkoutId: c.view.checkout.id,
        repositoryScope: c.view.session.repositoryScope,
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_external_session_heartbeat: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      return yield* (yield* External.ExternalSessions).heartbeat(c.actor, {
        ...input,
        ...c.input,
        featureId: c.view.feature.id,
        checkoutId: c.view.checkout.id,
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_external_session_visibility: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      return yield* (yield* External.ExternalSessions).changeVisibility(c.actor, {
        ...input,
        ...c.input,
        featureId: c.view.feature.id,
        checkoutId: c.view.checkout.id,
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_external_sessions: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* External.ExternalSessions).list({ ...input, ...c.input });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_recording_windows: () =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Recordings.Recordings).windows(c.actor, c.input);
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_recording_start: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      return yield* (yield* Recordings.Recordings).start(c.actor, {
        ...input,
        ...c.input,
        capturedWorkspaceIDs: [c.input.workspaceID],
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_recording_control: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      return yield* (yield* Recordings.Recordings).control(c.actor, { ...input, ...c.input });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_recording_mark: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      return yield* (yield* Recordings.Recordings).mark(c.actor, { ...input, ...c.input });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_evidence_read: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Recordings.Recordings).readEvidenceChunk(c.actor, {
        ...input,
        ...c.input,
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_context: () =>
    Effect.gen(function* () {
      return (yield* (yield* Access.DeckhandMcpAccess).resolve()).view;
    }),
  deckhand_context_pull_requests: (input) =>
    Effect.gen(function* () {
      if (!isContextPullRequestsParameters(input))
        return yield* Access.deckhandFailure({ reason: "invalid_request" });
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      const page = yield* (yield* ManagedSessions.ManagedSessions)
        .subscribePullRequests({
          ...c.input,
          offset: input.offset ?? 0,
          limit: input.limit ?? 20,
        })
        .pipe(Stream.runHead);
      if (Option.isNone(page))
        return yield* Access.deckhandFailure({ reason: "source_unavailable" });
      return page.value;
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_services_runs: () =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Runs.Runs).list(c.actor, c.input);
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_run_detail: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Runs.Runs).get(c.actor, {
        ...input,
        ...c.input,
        stepOffset: input.stepOffset ?? 0,
        stepLimit: input.stepLimit ?? 16,
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_run_failures: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Runs.Runs).failures(c.actor, { ...input, ...c.input });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_verification_attempt_preview: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Attempts.VerificationAttempts).preview(
        c.actor,
        { ...input, featureID: c.view.feature.id, checkoutID: c.view.checkout.id },
        { featureID: c.view.feature.id, checkoutID: c.view.checkout.id, context: c.input },
      );
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_verification_attempt_start: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      return yield* (yield* Attempts.VerificationAttempts).start(c.actor, input, {
        featureID: c.view.feature.id,
        checkoutID: c.view.checkout.id,
        context: c.input,
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_verification_attempt_get: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Attempts.VerificationAttempts).get(c.actor, input, {
        featureID: c.view.feature.id,
        checkoutID: c.view.checkout.id,
        context: c.input,
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_verification_attempt_list: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Attempts.VerificationAttempts).list(c.actor, input, {
        featureID: c.view.feature.id,
        checkoutID: c.view.checkout.id,
        context: c.input,
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_verification_attempt_advance: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      return yield* (yield* Attempts.VerificationAttempts).advance(c.actor, input, {
        featureID: c.view.feature.id,
        checkoutID: c.view.checkout.id,
        context: c.input,
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_run_logs: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Runs.Runs).logs(c.actor, { ...input, ...c.input });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_recordings: () =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Recordings.Recordings).list(c.actor, c.input);
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_recording: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Recordings.Recordings).get(c.actor, { ...input, ...c.input });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_recording_logs: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Recordings.Recordings).logs(c.actor, { ...input, ...c.input });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_evidence_prepare: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      return yield* (yield* Recordings.Recordings).prepareEvidence(c.actor, {
        ...input,
        ...c.input,
      });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_evidence_get: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Recordings.Recordings).getEvidence(c.actor, { ...input, ...c.input });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_operation_submit: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve(true);
      return yield* (yield* Hub.IntegrationHub).submit(c.actor, { ...input, ...c.input });
    }).pipe(Effect.mapError(Access.deckhandFailure)),
  deckhand_operation_get: (input) =>
    Effect.gen(function* () {
      const c = yield* (yield* Access.DeckhandMcpAccess).resolve();
      return yield* (yield* Hub.IntegrationHub).operation(c.actor, input.operationKey);
    }).pipe(Effect.mapError(Access.deckhandFailure)),
} satisfies Parameters<typeof DeckhandToolkit.toLayer>[0];
export const DeckhandToolkitHandlersLive = DeckhandToolkit.toLayer(handlers);
