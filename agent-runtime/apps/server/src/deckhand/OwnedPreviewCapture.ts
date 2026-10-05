// @effect-diagnostics nodeBuiltinImport:off - opaque local capture capabilities.
import * as NodeCrypto from "node:crypto";
import * as C from "@t3tools/contracts/deckhand/ownedPreviewRpc";
import * as R from "@t3tools/contracts/deckhand/recordingsRpc";
import * as A from "@t3tools/contracts/deckhand/verificationAttemptsRpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Relationships from "./Relationships.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as Builds from "./Builds.ts";
import * as Recordings from "./Recordings.ts";
import * as RecordingTransport from "./RecordingTransport.ts";
import * as VerificationAttempts from "./VerificationAttempts.ts";
import * as Attestations from "./OwnedPreviewAttestations.ts";
import * as Migrations from "./Migrations.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
const Stored = Schema.Struct({
  sessionID: Schema.String,
  effectiveCheckoutID: Schema.optionalKey(Schema.String),
  actor: Schema.String,
  intent: C.OwnedPreviewIntent,
  attempt: A.VerificationAttempt,
  status: C.OwnedPreviewStatus,
  start: Schema.NullOr(C.OwnedPreviewTarget),
  finish: Schema.NullOr(C.OwnedPreviewFinish),
  firstFrameAt: Schema.NullOr(Schema.String),
  consumedArtifact: Schema.optionalKey(
    Schema.Struct({ sha256: Schema.String, url: Schema.String }),
  ),
});
type Stored = typeof Stored.Type;
const encode = Schema.encodeEffect(Schema.fromJsonString(Stored));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Stored));
const encodeOriginal = Schema.encodeEffect(Schema.fromJsonString(C.OwnedPreviewIntentInput));
const decodeReceipt = Schema.decodeUnknownEffect(R.PreviewImportReceipt);
const isCaptureError = Schema.is(C.OwnedPreviewError);
const fail = (reason: string) => new C.OwnedPreviewError({ reason });
const wrap = (cause: unknown) => (isCaptureError(cause) ? cause : fail("unavailable"));
export function targetMatchesOwnedService(
  target: C.OwnedPreviewTarget,
  serviceURL: string | undefined,
): boolean {
  if (!serviceURL) return false;
  try {
    const actual = new URL(target.url),
      owned = new URL(serviceURL);
    return (
      actual.protocol === "http:" &&
      owned.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(actual.hostname) &&
      actual.origin === owned.origin &&
      !actual.username &&
      !actual.password &&
      !owned.username &&
      !owned.password
    );
  } catch {
    return false;
  }
}
export class OwnedPreviewCapture extends Context.Service<
  OwnedPreviewCapture,
  {
    readonly intent: (
      actor: string,
      input: C.OwnedPreviewIntentInput,
    ) => Effect.Effect<C.OwnedPreviewIntent, C.OwnedPreviewError>;
    readonly get: (
      actor: string,
      input: C.OwnedPreviewLookup,
    ) => Effect.Effect<C.OwnedPreviewStatus, C.OwnedPreviewError>;
    readonly begin: (
      input: typeof C.OwnedPreviewBegin.Type,
    ) => Effect.Effect<C.OwnedPreviewStatus, C.OwnedPreviewError>;
    readonly event: (
      input: typeof C.OwnedPreviewEvent.Type,
    ) => Effect.Effect<C.OwnedPreviewStatus, C.OwnedPreviewError>;
    readonly chunk: (
      input: typeof C.OwnedPreviewChunk.Type,
    ) => Effect.Effect<C.OwnedPreviewStatus, C.OwnedPreviewError>;
    readonly finish: (
      input: typeof C.OwnedPreviewFinish.Type,
    ) => Effect.Effect<C.OwnedPreviewStatus, C.OwnedPreviewError>;
    readonly recover: (
      input: typeof C.OwnedPreviewPrivateIdentity.Type,
    ) => Effect.Effect<C.OwnedPreviewStatus, C.OwnedPreviewError>;
  }
>()("t3/deckhand/OwnedPreviewCapture") {}
export const layer = Layer.effect(
  OwnedPreviewCapture,
  Effect.gen(function* () {
    yield* Migrations.migrate;
    const sql = yield* SqlClient.SqlClient;
    const relationships = yield* Relationships.Relationships;
    const currentCheckouts = yield* CurrentCheckout.CurrentCheckout;
    const attempts = yield* VerificationAttempts.VerificationAttempts;
    const transport = yield* RecordingTransport.RecordingTransport;
    const builds = yield* Builds.Builds;
    const recordings = yield* Recordings.Recordings;
    const attestations = yield* Attestations.OwnedPreviewAttestations;
    const locks = yield* makeKeyedSerialExecutor<string>();
    const read = (key: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_owned_preview_captures WHERE capture_key=${key}`;
        if (!rows[0]) return yield* fail("missing");
        return yield* decode(rows[0].record_json);
      });
    const save = (value: Stored) =>
      Effect.gen(function* () {
        const json = yield* encode(value);
        yield* sql`UPDATE deckhand_owned_preview_captures SET record_json=${json} WHERE capture_key=${value.intent.captureKey}`;
        return value;
      });
    const privateRead = (input: typeof C.OwnedPreviewPrivateIdentity.Type) =>
      Effect.gen(function* () {
        const value = yield* read(input.captureKey);
        if (!Attestations.privateCredentialMatches(value.intent.token, input.token))
          return yield* fail("invalid_capability");
        return value;
      });
    const context = (v: Stored) => ({
      ...v.attempt.preview.context,
      operationKey: `owned-preview:${v.intent.captureKey}`,
    });
    const call = (value: Stored, method: string, input: Record<string, unknown>) =>
      transport
        .request(value.actor, `integration.recording.import.${method}`, {
          ...context(value),
          ...input,
        })
        .pipe(Effect.flatMap(decodeReceipt));
    const recoverValue = (value: Stored) =>
      Effect.gen(function* () {
        if (!value.status.receipt && value.status.state === "prepared") return value.status;
        if (value.status.state === "ready" || value.status.state === "failed") return value.status;
        const receipt = yield* call(value, "get", {});
        let status: C.OwnedPreviewStatus = {
          ...value.status,
          receipt,
          recordingID: receipt.recordingID,
          detail: receipt.detail,
        };
        if (receipt.state === "ready") {
          const finish = value.finish,
            start = value.start;
          const recording = yield* recordings.get(value.actor, {
            ...value.attempt.preview.context,
            recordingID: receipt.recordingID,
          });
          const valid =
            value.firstFrameAt &&
            finish &&
            start &&
            value.attempt.receipt &&
            finish.uninterrupted &&
            !finish.invalidationReason &&
            Attestations.exactTarget(start, finish.target) &&
            recording.sourceVideoSHA256 === finish.sourceVideoSHA256 &&
            recording.sourceVideoSizeBytes === finish.sourceVideoSizeBytes &&
            recording.videoIntegrity === "matched" &&
            value.consumedArtifact?.sha256 === value.attempt.receipt.artifact?.sha256 &&
            recording.videoSHA256 &&
            recording.videoSizeBytes &&
            recording.buildProof?.receiptID === value.attempt.receipt.id &&
            recording.buildProof.start.state === "matched" &&
            recording.buildProof.end?.state === "matched";
          if (
            valid &&
            finish &&
            start &&
            value.attempt.receipt &&
            recording.videoSHA256 &&
            recording.videoSizeBytes
          ) {
            yield* attestations.put(value.actor, {
              captureKey: value.intent.captureKey,
              attemptOperationKey: value.intent.attemptOperationKey,
              ...value.attempt.preview.context,
              featureID: value.attempt.preview.featureID,
              checkoutID: value.attempt.preview.checkoutID,
              buildReceiptID: value.attempt.receipt.id,
              recordingID: recording.id,
              start,
              end: finish.target,
              firstFrameAt: value.firstFrameAt!,
              consumedArtifactSHA256: value.consumedArtifact!.sha256,
              consumedArtifactURL: value.consumedArtifact!.url,
              frameCount: finish.frameCount,
              sourceVideoSHA256: finish.sourceVideoSHA256,
              sourceVideoSizeBytes: finish.sourceVideoSizeBytes,
              videoSHA256: recording.videoSHA256,
              videoSizeBytes: recording.videoSizeBytes,
              uninterrupted: true,
            });
            status = {
              ...status,
              state: "ready",
              detail: "Owned browser target and recorded bytes are bound to this build receipt.",
            };
          } else
            status = {
              ...status,
              state: "failed",
              detail:
                "Saved video has no matching uninterrupted owned-target proof. It remains available without an exact-preview claim.",
            };
        } else if (["failed", "interrupted"].includes(receipt.state))
          status = { ...status, state: "failed" };
        else
          status = {
            ...status,
            state: value.finish
              ? "finalizing"
              : receipt.state === "uploading"
                ? "uploading"
                : "capturing",
          };
        yield* save({ ...value, status });
        return status;
      });
    const locked = <T, E>(key: string, effect: Effect.Effect<T, E>) =>
      locks.withLock(key, effect).pipe(Effect.mapError(wrap));
    const intent: OwnedPreviewCapture["Service"]["intent"] = (actor, input) =>
      locked(
        input.captureKey,
        Effect.gen(function* () {
          const original = yield* encodeOriginal(input);
          const rows = yield* sql<{
            actor_id: string;
            original_json: string;
            record_json: string;
          }>`SELECT actor_id,original_json,record_json FROM deckhand_owned_preview_captures WHERE capture_key=${input.captureKey}`;
          if (rows[0]) {
            if (rows[0].actor_id !== actor || rows[0].original_json !== original)
              return yield* fail("identity_conflict");
            return (yield* decode(rows[0].record_json)).intent;
          }
          const attempt = yield* attempts.get(actor, { operationKey: input.attemptOperationKey });
          if (
            !attempt.receipt?.launch ||
            attempt.receipt.state !== "running" ||
            attempt.receipt.reservationState !== "held" ||
            attempt.currentHead !== attempt.preview.head
          )
            return yield* fail("launched_current_build_required");
          const sessions = yield* relationships.sessions({
            featureId: attempt.preview.featureID,
            limit: 100,
          });
          const session = sessions.find((item) => item.checkoutId === attempt.preview.checkoutID);
          if (!session) return yield* fail("connected_conversation_required");
          const checkout = yield* currentCheckouts.current(session.checkoutId);
          const workspace = yield* relationships.workspace(checkout.workspaceId);
          if (
            checkout.backend !== "cinderdeck" ||
            checkout.state !== "ready" ||
            workspace.state !== "active" ||
            checkout.workspaceGeneration !== workspace.generation ||
            checkout.nativeGeneration !== attempt.preview.context.generation ||
            checkout.environmentId !== attempt.preview.context.installationID ||
            (checkout.laneId ?? workspace.ownerId) !== attempt.preview.context.workspaceID
          )
            return yield* fail("stale_connected_conversation");
          const observed = yield* builds.observe(actor, {
            ...attempt.preview.context,
            receiptID: attempt.receipt.id,
            phase: "check",
          });
          if (observed.state !== "matched" || !observed.serviceURL || !attempt.receipt.artifact)
            return yield* fail("owned_build_binding_unavailable");
          const binding: C.OwnedPreviewBinding = {
            serviceURL: observed.serviceURL,
            artifactPath: attempt.receipt.adapter.servedArtifactPath,
            artifactSHA256: attempt.receipt.artifact.sha256,
          };
          const intent: C.OwnedPreviewIntent = {
            ...input,
            token: NodeCrypto.randomBytes(32).toString("hex"),
          };
          const value: Stored = {
            actor,
            sessionID: session.id,
            effectiveCheckoutID: checkout.id,
            intent,
            attempt,
            start: null,
            finish: null,
            firstFrameAt: null,
            status: {
              captureKey: input.captureKey,
              state: "prepared",
              binding,
              recordingID: null,
              detail: null,
              receipt: null,
            },
          };
          const json = yield* encode(value);
          yield* sql`INSERT INTO deckhand_owned_preview_captures(capture_key,actor_id,original_json,record_json) VALUES(${input.captureKey},${actor},${original},${json})`;
          return intent;
        }),
      );
    const begin: OwnedPreviewCapture["Service"]["begin"] = (input) =>
      locked(
        input.captureKey,
        Effect.gen(function* () {
          let value = yield* privateRead(input);
          if (value.status.state !== "prepared")
            return yield* fail("capture_already_started_recover");
          const binding = value.status.binding;
          if (
            !binding ||
            input.consumedArtifactSHA256 !== binding.artifactSHA256 ||
            input.consumedArtifactURL !== new URL(binding.artifactPath, binding.serviceURL).href
          )
            return yield* fail("loaded_artifact_mismatch");
          const current = yield* attempts.get(value.actor, {
            operationKey: value.intent.attemptOperationKey,
          });
          if (
            current.currentHead !== value.attempt.preview.head ||
            current.receipt?.id !== value.attempt.receipt?.id ||
            current.receipt?.reservationState !== "held"
          )
            return yield* fail("stale_attempt");
          const boundSession = yield* relationships.session(value.sessionID);
          const boundCheckout = yield* currentCheckouts.current(boundSession.checkoutId);
          const boundWorkspace = yield* relationships.workspace(boundCheckout.workspaceId);
          if (
            boundSession.featureId !== value.attempt.preview.featureID ||
            boundSession.checkoutId !== value.attempt.preview.checkoutID ||
            boundCheckout.id !== (value.effectiveCheckoutID ?? value.attempt.preview.checkoutID) ||
            boundCheckout.environmentId !== value.attempt.preview.context.installationID ||
            (boundCheckout.laneId ?? boundWorkspace.ownerId) !==
              value.attempt.preview.context.workspaceID ||
            boundWorkspace.state !== "active" ||
            boundCheckout.workspaceGeneration !== boundWorkspace.generation ||
            boundCheckout.state !== "ready" ||
            boundCheckout.nativeGeneration !== value.attempt.preview.context.generation
          )
            return yield* fail("stale_connected_conversation");
          const receipt = value.attempt.receipt;
          if (!receipt) return yield* fail("build_missing");
          const observed = yield* builds.observe(value.actor, {
            ...value.attempt.preview.context,
            receiptID: receipt.id,
            phase: "start",
          });
          if (
            observed.state !== "matched" ||
            !targetMatchesOwnedService(input.target, observed.serviceURL)
          )
            return yield* fail("target_not_owned_build");
          value = yield* save({
            ...value,
            start: input.target,
            consumedArtifact: {
              sha256: input.consumedArtifactSHA256,
              url: input.consumedArtifactURL,
            },
            status: { ...value.status, state: "starting" },
          });
          const imported = yield* call(value, "begin", {
            sessionID: value.sessionID,
            title: "Owned preview verification",
            tabID: input.target.tabID,
            targetURL: input.target.url,
            clientMonotonicMs: input.clientMonotonicMs,
            capturedWorkspaceIDs: [value.attempt.preview.context.workspaceID],
            featureID: value.attempt.preview.featureID,
            checkoutID: value.attempt.preview.checkoutID,
            attemptOperationKey: value.attempt.operationKey,
            buildReceiptID: receipt.id,
          });
          value = yield* save({
            ...value,
            status: {
              ...value.status,
              state: "capturing",
              receipt: imported,
              recordingID: imported.recordingID,
            },
          });
          return value.status;
        }),
      );
    const event: OwnedPreviewCapture["Service"]["event"] = (input) =>
      locked(
        input.captureKey,
        Effect.gen(function* () {
          const value = yield* privateRead(input),
            native = value.status.receipt;
          if (!native) return yield* fail("not_started");
          const receipt = yield* call(value, "event", {
            token: native.token,
            event: input.event,
            clientMonotonicMs: input.clientMonotonicMs,
          });
          return (yield* save({
            ...value,
            firstFrameAt:
              input.event === "first_frame"
                ? (value.firstFrameAt ?? input.observedAt)
                : value.firstFrameAt,
            status: { ...value.status, receipt },
          })).status;
        }),
      );
    const chunk: OwnedPreviewCapture["Service"]["chunk"] = (input) =>
      locked(
        input.captureKey,
        Effect.gen(function* () {
          const value = yield* privateRead(input),
            native = value.status.receipt;
          if (!native || value.finish || !["capturing", "uploading"].includes(value.status.state))
            return yield* fail("not_capturing");
          const receipt = yield* call(value, "chunk", {
            token: native.token,
            offset: input.offset,
            totalBytes: input.totalBytes,
            mimeType: input.mimeType,
            data: input.data,
          });
          return (yield* save({
            ...value,
            status: { ...value.status, state: "uploading", receipt },
          })).status;
        }),
      );
    const finish: OwnedPreviewCapture["Service"]["finish"] = (input) =>
      locked(
        input.captureKey,
        Effect.gen(function* () {
          let value = yield* privateRead(input);
          if (value.finish) return yield* recoverValue(value);
          const native = value.status.receipt;
          if (!native || !value.start) return yield* fail("not_started");
          value = yield* save({
            ...value,
            finish: input,
            status: { ...value.status, state: "finalizing" },
          });
          const receipt = yield* call(value, "finish", { token: native.token });
          value = yield* save({ ...value, status: { ...value.status, receipt } });
          return yield* recoverValue(value);
        }),
      );
    return OwnedPreviewCapture.of({
      intent,
      begin,
      event,
      chunk,
      finish,
      get: (actor, input) =>
        locked(
          input.captureKey,
          Effect.gen(function* () {
            const value = yield* read(input.captureKey);
            if (value.actor !== actor) return yield* fail("wrong_actor");
            const status = yield* recoverValue(value);
            return {
              ...status,
              receipt: status.receipt ? { ...status.receipt, token: "private-main-only" } : null,
            };
          }),
        ),
      recover: (input) =>
        locked(input.captureKey, privateRead(input).pipe(Effect.flatMap(recoverValue))),
    });
  }),
);
