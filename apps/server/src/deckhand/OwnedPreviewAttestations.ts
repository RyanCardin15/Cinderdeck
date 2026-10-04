// @effect-diagnostics nodeBuiltinImport:off - constant-time credential and immutable recording digest comparisons.
import * as NodeCrypto from "node:crypto";
import * as C from "@t3tools/contracts/deckhand/ownedPreviewRpc";
import type * as R from "@t3tools/contracts/deckhand/recordingsRpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrations from "./Migrations.ts";
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(C.OwnedPreviewProof));
const encode = Schema.encodeEffect(Schema.fromJsonString(C.OwnedPreviewProof));
export const exactTarget = (start: C.OwnedPreviewTarget, end: C.OwnedPreviewTarget) =>
  start.webContentsID === end.webContentsID &&
  start.targetID === end.targetID &&
  start.frameID === end.frameID &&
  start.documentID === end.documentID &&
  start.tabID === end.tabID &&
  start.url === end.url;
export function ownedPreviewMatches(
  proof: C.OwnedPreviewProof,
  expected: {
    operationKey: string;
    preview: {
      featureID: string;
      checkoutID: string;
      context: { installationID: string; workspaceID: string; generation: number };
    };
  },
  receiptID: string,
  recording: R.Recording,
): boolean {
  return (
    proof.attemptOperationKey === expected.operationKey &&
    proof.buildReceiptID === receiptID &&
    proof.featureID === expected.preview.featureID &&
    proof.checkoutID === expected.preview.checkoutID &&
    proof.installationID === expected.preview.context.installationID &&
    proof.workspaceID === expected.preview.context.workspaceID &&
    proof.generation === expected.preview.context.generation &&
    Math.abs(
      Date.parse(proof.firstFrameAt) - Date.parse(recording.buildProof?.start.observedAt ?? ""),
    ) <= 10000 &&
    proof.recordingID === recording.id &&
    recording.videoIntegrity === "matched" &&
    proof.consumedArtifactSHA256 === recording.buildProof?.artifactSHA256 &&
    proof.uninterrupted &&
    proof.frameCount > 0 &&
    exactTarget(proof.start, proof.end) &&
    proof.sourceVideoSHA256 === recording.sourceVideoSHA256 &&
    proof.sourceVideoSizeBytes === recording.sourceVideoSizeBytes &&
    proof.videoSHA256 === recording.videoSHA256 &&
    proof.videoSizeBytes === recording.videoSizeBytes
  );
}
export function privateCredentialMatches(
  expected: string | undefined,
  supplied: string | undefined,
): boolean {
  if (
    !expected ||
    !supplied ||
    !/^[a-f0-9]{64}$/.test(expected) ||
    !/^[a-f0-9]{64}$/.test(supplied)
  )
    return false;
  return NodeCrypto.timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}
export class OwnedPreviewAttestations extends Context.Service<
  OwnedPreviewAttestations,
  {
    readonly put: (
      actor: string,
      proof: C.OwnedPreviewProof,
    ) => Effect.Effect<void, C.OwnedPreviewError>;
    readonly get: (
      actor: string,
      recordingID: string,
    ) => Effect.Effect<C.OwnedPreviewProof | null, C.OwnedPreviewError>;
  }
>()("t3/deckhand/OwnedPreviewAttestations") {}
export const layer = Layer.effect(
  OwnedPreviewAttestations,
  Effect.gen(function* () {
    yield* Migrations.migrate;
    const sql = yield* SqlClient.SqlClient;
    return OwnedPreviewAttestations.of({
      put: (actor, proof) =>
        Effect.gen(function* () {
          const json = yield* encode(proof);
          const rows = yield* sql<{
            record_json: string;
            actor_id: string;
          }>`SELECT record_json,actor_id FROM deckhand_owned_preview_proofs WHERE recording_id=${proof.recordingID}`;
          if (rows[0]) {
            if (rows[0].actor_id !== actor || rows[0].record_json !== json)
              return yield* new C.OwnedPreviewError({ reason: "immutable_proof_conflict" });
            return;
          }
          yield* sql`INSERT INTO deckhand_owned_preview_proofs(recording_id,actor_id,capture_key,record_json) VALUES(${proof.recordingID},${actor},${proof.captureKey},${json})`;
        }).pipe(Effect.mapError(() => new C.OwnedPreviewError({ reason: "proof_storage_failed" }))),
      get: (actor, recordingID) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM deckhand_owned_preview_proofs WHERE recording_id=${recordingID} AND actor_id=${actor}`;
          return rows[0] ? yield* decode(rows[0].record_json) : null;
        }).pipe(Effect.mapError(() => new C.OwnedPreviewError({ reason: "proof_unavailable" }))),
    });
  }),
);
