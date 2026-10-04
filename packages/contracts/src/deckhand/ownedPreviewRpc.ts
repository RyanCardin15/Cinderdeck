import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { PositiveInt, NonNegativeInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { RecordingContext, PreviewImportReceipt } from "./recordingsRpc.ts";
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
export const OwnedPreviewIntentInput = Schema.Struct({ captureKey: id, attemptOperationKey: id });
export type OwnedPreviewIntentInput = typeof OwnedPreviewIntentInput.Type;
export const OwnedPreviewIntent = Schema.Struct({ ...OwnedPreviewIntentInput.fields, token: sha });
export type OwnedPreviewIntent = typeof OwnedPreviewIntent.Type;
export const OwnedPreviewBinding = Schema.Struct({
  serviceURL: Schema.String,
  artifactPath: Schema.String,
  artifactSHA256: sha,
});
export type OwnedPreviewBinding = typeof OwnedPreviewBinding.Type;
export const OwnedPreviewTarget = Schema.Struct({
  tabID: id,
  webContentsID: PositiveInt,
  targetID: id,
  frameID: id,
  documentID: id,
  url: Schema.String.check(Schema.isMaxLength(2048)),
  observedAt: Schema.String,
});
export type OwnedPreviewTarget = typeof OwnedPreviewTarget.Type;
export const OwnedPreviewLookup = Schema.Struct({ captureKey: id });
export type OwnedPreviewLookup = typeof OwnedPreviewLookup.Type;
export const OwnedPreviewPrivateIdentity = Schema.Struct({
  ...OwnedPreviewLookup.fields,
  token: sha,
});
export const OwnedPreviewBegin = Schema.Struct({
  ...OwnedPreviewPrivateIdentity.fields,
  target: OwnedPreviewTarget,
  consumedArtifactSHA256: sha,
  consumedArtifactURL: Schema.String,
  clientMonotonicMs: NonNegativeInt,
});
export const OwnedPreviewEvent = Schema.Struct({
  observedAt: Schema.String,
  ...OwnedPreviewPrivateIdentity.fields,
  event: Schema.Literals(["first_frame", "stop", "cancel"]),
  clientMonotonicMs: NonNegativeInt,
});
export const OwnedPreviewChunk = Schema.Struct({
  ...OwnedPreviewPrivateIdentity.fields,
  offset: NonNegativeInt,
  totalBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(268435456)),
  mimeType: Schema.Literals(["video/mp4", "video/webm"]),
  data: Schema.String.check(Schema.isMaxLength(349528)),
});
export const OwnedPreviewFinish = Schema.Struct({
  ...OwnedPreviewPrivateIdentity.fields,
  target: OwnedPreviewTarget,
  sourceVideoSHA256: sha,
  sourceVideoSizeBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(268435456)),
  frameCount: PositiveInt,
  uninterrupted: Schema.Boolean,
  invalidationReason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
});
export const OwnedPreviewProof = Schema.Struct({
  firstFrameAt: Schema.String,
  consumedArtifactSHA256: sha,
  consumedArtifactURL: Schema.String,
  captureKey: id,
  attemptOperationKey: id,
  ...RecordingContext.fields,
  featureID: id,
  checkoutID: id,
  buildReceiptID: id,
  recordingID: id,
  start: OwnedPreviewTarget,
  end: OwnedPreviewTarget,
  frameCount: PositiveInt,
  sourceVideoSHA256: sha,
  sourceVideoSizeBytes: PositiveInt,
  videoSHA256: sha,
  videoSizeBytes: PositiveInt,
  uninterrupted: Schema.Literal(true),
});
export type OwnedPreviewProof = typeof OwnedPreviewProof.Type;
export const OwnedPreviewStatus = Schema.Struct({
  captureKey: id,
  binding: Schema.optionalKey(OwnedPreviewBinding),
  state: Schema.Literals([
    "prepared",
    "starting",
    "capturing",
    "uploading",
    "finalizing",
    "ready",
    "failed",
    "unknown",
  ]),
  recordingID: Schema.NullOr(id),
  detail: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(PreviewImportReceipt),
});
export type OwnedPreviewStatus = typeof OwnedPreviewStatus.Type;
export class OwnedPreviewError extends Schema.TaggedError<OwnedPreviewError>()(
  "OwnedPreviewCaptureError",
  { reason: Schema.String },
) {
  override get message() {
    return `Owned preview capture ${this.reason}.`;
  }
}
export const OWNED_PREVIEW_METHODS = {
  intent: "deckhand.ownedPreview.intent",
  get: "deckhand.ownedPreview.get",
} as const;
export const OwnedPreviewRpcGroup = RpcGroup.make(
  Rpc.make(OWNED_PREVIEW_METHODS.intent, {
    payload: OwnedPreviewIntentInput,
    success: OwnedPreviewIntent,
    error: Schema.Union([OwnedPreviewError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(OWNED_PREVIEW_METHODS.get, {
    payload: OwnedPreviewLookup,
    success: OwnedPreviewStatus,
    error: Schema.Union([OwnedPreviewError, EnvironmentAuthorizationError]),
  }),
);
