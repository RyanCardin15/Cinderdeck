import { BuildCaptureProof } from "./buildEvidence.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
export const RECORDING_METHODS = {
  thumbnail: "deckhand.recording.thumbnail",
  prepareEvidence: "deckhand.recording.evidence.prepare",
  evidenceGet: "deckhand.recording.evidence.get",
  evidenceResource: "deckhand.recording.evidence.resource",
  importBegin: "deckhand.recording.import.begin",
  importGet: "deckhand.recording.import.get",
  importEvent: "deckhand.recording.import.event",
  importChunk: "deckhand.recording.import.chunk",
  importFinish: "deckhand.recording.import.finish",
  overview: "deckhand.recording.overview",
  list: "deckhand.recording.list",
  get: "deckhand.recording.get",
  windows: "deckhand.recording.windows",
  start: "deckhand.recording.start",
  control: "deckhand.recording.control",
  logs: "deckhand.recording.logs",
  mark: "deckhand.recording.mark",
  media: "deckhand.recording.media",
} as const;
const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const RecordingContext = Schema.Struct({
  installationID: identifier,
  workspaceID: identifier,
  generation: PositiveInt,
});
export type RecordingContext = typeof RecordingContext.Type;
export const RecordingIdentity = Schema.Struct({
  ...RecordingContext.fields,
  recordingID: identifier,
});
export type RecordingIdentity = typeof RecordingIdentity.Type;
export { SourceFingerprint } from "./sourceFingerprint.ts";
import { SourceFingerprint } from "./sourceFingerprint.ts";
export { BuildCaptureProof } from "./buildEvidence.ts";
export const Recording = Schema.Struct({
  sourceVideoSHA256: Schema.optionalKey(Schema.String),
  sourceVideoSizeBytes: Schema.optionalKey(NonNegativeInt),
  videoIntegrity: Schema.optionalKey(Schema.Literals(["matched", "changed", "unknown"])),
  videoSHA256: Schema.optionalKey(Schema.String),
  videoSizeBytes: Schema.optionalKey(NonNegativeInt),
  buildProof: Schema.optionalKey(BuildCaptureProof),
  id: identifier,
  title: Schema.String,
  state: Schema.Literals(["recording", "finalizing", "ready", "failed", "cancelled"]),
  createdAt: Schema.String,
  clockQuality: Schema.optionalKey(Schema.Literals(["estimated", "unknown"])),
  duration: Schema.Number,
  actor: Schema.String,
  capture: Schema.NullOr(Schema.String),
  primaryWorkspaceID: Schema.NullOr(Schema.String),
  capturedWorkspaceIDs: Schema.Array(Schema.String),
  capturedWorkspaceNames: Schema.Array(Schema.String),
  lineCount: NonNegativeInt,
  errorCount: NonNegativeInt,
  warningCount: NonNegativeInt,
  playable: Schema.Boolean,
  paused: Schema.Boolean,
  controlAllowed: Schema.Boolean,
  detail: Schema.NullOr(Schema.String),
  checkOutcome: Schema.Literals(["passed", "failed", "unverified"]),
  markers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      t: Schema.Number,
      label: Schema.String,
      outcome: Schema.NullOr(Schema.Literals(["pass", "fail", "info"])),
    }),
  ),
  repositories: Schema.Array(
    Schema.Struct({
      workspaceID: Schema.String,
      repositoryID: Schema.String,
      branch: Schema.String,
      head: Schema.NullOr(Schema.String),
      changedFiles: NonNegativeInt,
      canonicalRepositoryKeys: Schema.optionalKey(Schema.Array(Schema.String)),
      repositoryPhysicalId: Schema.optionalKey(Schema.String),
      snapshotComplete: Schema.optionalKey(Schema.Boolean),
      capturedAt: Schema.optionalKey(Schema.String),
      diffHash: Schema.optionalKey(Schema.String),
      sourceFingerprint: Schema.optionalKey(SourceFingerprint),
      endSourceFingerprint: Schema.optionalKey(SourceFingerprint),
      endHead: Schema.optionalKey(Schema.String),
      diffTruncated: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type Recording = typeof Recording.Type;
export const RecordingWindow = Schema.Struct({
  id: PositiveInt,
  app: Schema.String,
  title: Schema.String,
});
export type RecordingWindow = typeof RecordingWindow.Type;
export const RecordingStart = Schema.Struct({
  ...RecordingContext.fields,
  buildReceiptID: Schema.optionalKey(identifier),
  operationKey: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  windowID: PositiveInt,
  capturedWorkspaceIDs: Schema.Array(identifier).check(Schema.isMaxLength(16)),
});
export type RecordingStart = typeof RecordingStart.Type;
export const RecordingControl = Schema.Struct({
  ...RecordingIdentity.fields,
  action: Schema.Literals(["stop", "pause", "resume"]),
});
export type RecordingControl = typeof RecordingControl.Type;
export const RecordingLogInput = Schema.Struct({
  ...RecordingIdentity.fields,
  around: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
  level: Schema.optionalKey(Schema.Literals(["debug", "info", "warning", "error"])),
  source: Schema.optionalKey(identifier),
});
export type RecordingLogInput = typeof RecordingLogInput.Type;
export const RecordingLogs = Schema.Struct({
  repro: Schema.String,
  duration: Schema.Number,
  total: NonNegativeInt,
  returned: NonNegativeInt,
  lines: Schema.Array(
    Schema.Struct({
      id: Schema.optionalKey(NonNegativeInt),
      t: Schema.Number,
      time: Schema.String,
      source: Schema.String,
      level: Schema.String,
      text: Schema.String,
      offscreen: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export type RecordingLogs = typeof RecordingLogs.Type;
export const RecordingMark = Schema.Struct({
  ...RecordingIdentity.fields,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  outcome: Schema.Literals(["pass", "fail", "info"]),
});
export type RecordingMark = typeof RecordingMark.Type;
export const RecordingMedia = Schema.Struct({
  path: Schema.String,
  expiresAt: Schema.String,
  mimeType: Schema.String,
  size: NonNegativeInt,
});
export type RecordingMedia = typeof RecordingMedia.Type;
export const RecordingThumbnail = Schema.Struct({
  ...RecordingMedia.fields,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  width: PositiveInt.check(Schema.isLessThanOrEqualTo(480)),
  height: PositiveInt.check(Schema.isLessThanOrEqualTo(480)),
});
export type RecordingThumbnail = typeof RecordingThumbnail.Type;
export class RecordingError extends Schema.TaggedError<RecordingError>()("RecordingError", {
  reason: Schema.String,
  code: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    return `Recording ${this.reason}${this.code ? ` (${this.code})` : ""}.`;
  }
}
const errors = Schema.Union([RecordingError, EnvironmentAuthorizationError]);
export const RecordingOverviewInput = Schema.Struct({
  installationID: identifier,
  contexts: Schema.Array(Schema.Struct({ workspaceID: identifier, generation: PositiveInt })).check(
    Schema.isMaxLength(100),
  ),
});
export type RecordingOverviewInput = typeof RecordingOverviewInput.Type;
export const RecordingContextOverview = Schema.Struct({
  workspaceID: identifier,
  generation: PositiveInt,
  count: NonNegativeInt,
  playableCount: NonNegativeInt,
  active: Schema.NullOr(
    Schema.Struct({
      id: identifier,
      state: Schema.Literals(["recording", "finalizing"]),
      title: Schema.String,
    }),
  ),
  latest: Schema.NullOr(
    Schema.Struct({
      id: identifier,
      title: Schema.String,
      duration: Schema.Number,
      playable: Schema.Boolean,
      checkOutcome: Schema.Literals(["passed", "failed", "unverified"]),
    }),
  ),
});
export type RecordingContextOverview = typeof RecordingContextOverview.Type;
export const PreviewImportLookup = Schema.Struct({
  ...RecordingContext.fields,
  operationKey: identifier,
});
export type PreviewImportLookup = typeof PreviewImportLookup.Type;
export const PreviewImportControl = Schema.Struct({
  ...PreviewImportLookup.fields,
  token: identifier,
});
export type PreviewImportControl = typeof PreviewImportControl.Type;
export const PreviewImportBegin = Schema.Struct({
  buildReceiptID: Schema.optionalKey(identifier),
  attemptOperationKey: Schema.optionalKey(identifier),
  ...PreviewImportLookup.fields,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  sessionID: identifier,
  tabID: identifier,
  targetURL: Schema.String.check(Schema.isMaxLength(2048)),
  clientMonotonicMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  capturedWorkspaceIDs: Schema.Array(identifier).check(Schema.isMaxLength(16)),
});
export type PreviewImportBegin = typeof PreviewImportBegin.Type;
export const PreviewImportEvent = Schema.Struct({
  ...PreviewImportControl.fields,
  event: Schema.Literals(["first_frame", "stop", "cancel"]),
  clientMonotonicMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type PreviewImportEvent = typeof PreviewImportEvent.Type;
export const PreviewImportChunk = Schema.Struct({
  ...PreviewImportControl.fields,
  offset: NonNegativeInt,
  totalBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(268435456)),
  mimeType: Schema.Literals(["video/mp4", "video/webm"]),
  data: Schema.String.check(Schema.isMaxLength(349528)),
});
export type PreviewImportChunk = typeof PreviewImportChunk.Type;
export const PreviewImportReceipt = Schema.Struct({
  sourceVideoSHA256: Schema.optionalKey(Schema.NullOr(Schema.String)),
  sourceVideoSizeBytes: Schema.optionalKey(NonNegativeInt),
  videoSHA256: Schema.optionalKey(Schema.NullOr(Schema.String)),
  videoSizeBytes: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  buildProof: Schema.optionalKey(Schema.NullOr(BuildCaptureProof)),
  operationKey: identifier,
  recordingID: identifier,
  token: identifier,
  state: Schema.Literals([
    "prepared",
    "capturing",
    "uploading",
    "validating",
    "ready",
    "failed",
    "interrupted",
  ]),
  receivedBytes: NonNegativeInt,
  hostStartedAt: Schema.String,
  clockQuality: Schema.Literals(["estimated", "unknown"]),
  detail: Schema.NullOr(Schema.String),
  sha256: Schema.NullOr(Schema.String),
  duration: Schema.NullOr(Schema.Number),
});
export type PreviewImportReceipt = typeof PreviewImportReceipt.Type;
export const EvidencePrepare = Schema.Struct({
  ...RecordingIdentity.fields,
  operationKey: identifier,
});
export type EvidencePrepare = typeof EvidencePrepare.Type;
export const EvidenceIdentity = Schema.Struct({
  ...RecordingIdentity.fields,
  preparationID: identifier,
});
export type EvidenceIdentity = typeof EvidenceIdentity.Type;
export const EvidenceResourceInput = Schema.Struct({
  ...EvidenceIdentity.fields,
  resourceID: identifier,
});
export type EvidenceResourceInput = typeof EvidenceResourceInput.Type;
export const EvidenceAsset = Schema.Struct({
  id: identifier,
  name: Schema.String.check(Schema.isMaxLength(512)),
  kind: Schema.Literals(["video", "frame", "logs", "diff", "manifest", "report"]),
  mimeType: Schema.String.check(Schema.isMaxLength(100)),
  size: NonNegativeInt,
  sha256: Schema.NullOr(Schema.String),
  state: Schema.Literals(["ready", "missing", "failed"]),
  detail: Schema.NullOr(Schema.String),
});
export type EvidenceAsset = typeof EvidenceAsset.Type;
export const EvidencePreparation = Schema.Struct({
  preparationID: identifier,
  recordingID: identifier,
  state: Schema.Literals(["preparing", "ready", "failed", "interrupted"]),
  assets: Schema.Array(EvidenceAsset).check(Schema.isMaxLength(200)),
  detail: Schema.NullOr(Schema.String),
});
export type EvidencePreparation = typeof EvidencePreparation.Type;
export const EvidenceChunkInput = Schema.Struct({
  ...EvidenceResourceInput.fields,
  offset: NonNegativeInt,
  length: PositiveInt.check(Schema.isLessThanOrEqualTo(65536)),
});
export type EvidenceChunkInput = typeof EvidenceChunkInput.Type;
export const EvidenceChunk = Schema.Struct({
  offset: NonNegativeInt,
  size: NonNegativeInt,
  mimeType: Schema.String.check(Schema.isMaxLength(100)),
  version: Schema.String.check(Schema.isMaxLength(160)),
  data: Schema.String.check(Schema.isMaxLength(87384)),
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type EvidenceChunk = typeof EvidenceChunk.Type;
export const RecordingRpcGroup = RpcGroup.make(
  Rpc.make(RECORDING_METHODS.thumbnail, {
    payload: RecordingIdentity,
    success: RecordingThumbnail,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.prepareEvidence, {
    payload: EvidencePrepare,
    success: EvidencePreparation,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.evidenceGet, {
    payload: EvidenceIdentity,
    success: EvidencePreparation,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.evidenceResource, {
    payload: EvidenceResourceInput,
    success: RecordingMedia,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.importBegin, {
    payload: PreviewImportBegin,
    success: PreviewImportReceipt,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.importGet, {
    payload: PreviewImportLookup,
    success: PreviewImportReceipt,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.importEvent, {
    payload: PreviewImportEvent,
    success: PreviewImportReceipt,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.importChunk, {
    payload: PreviewImportChunk,
    success: PreviewImportReceipt,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.importFinish, {
    payload: PreviewImportControl,
    success: PreviewImportReceipt,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.overview, {
    payload: RecordingOverviewInput,
    success: Schema.Array(RecordingContextOverview),
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.list, {
    payload: RecordingContext,
    success: Schema.Array(Recording),
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.get, {
    payload: RecordingIdentity,
    success: Recording,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.windows, {
    payload: RecordingContext,
    success: Schema.Array(RecordingWindow),
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.start, { payload: RecordingStart, success: Recording, error: errors }),
  Rpc.make(RECORDING_METHODS.control, {
    payload: RecordingControl,
    success: Recording,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.logs, {
    payload: RecordingLogInput,
    success: RecordingLogs,
    error: errors,
  }),
  Rpc.make(RECORDING_METHODS.mark, { payload: RecordingMark, success: Recording, error: errors }),
  Rpc.make(RECORDING_METHODS.media, {
    payload: RecordingIdentity,
    success: RecordingMedia,
    error: errors,
  }),
);
