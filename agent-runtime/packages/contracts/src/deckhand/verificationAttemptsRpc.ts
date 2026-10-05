import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { PullRequestRef } from "../pullRequest.ts";
import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { Recording } from "./recordingsRpc.ts";
import { RunContext } from "./runsRpc.ts";
import { BuildDescriptor, BuildExpectedRepository, BuildReceipt } from "./builds.ts";
const id = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const AttemptPreviewInput = Schema.Struct({
  reference: PullRequestRef,
  featureID: id,
  checkoutID: id,
  serviceID: id,
});
export type AttemptPreviewInput = typeof AttemptPreviewInput.Type;
export const AttemptPreview = Schema.Struct({
  ...AttemptPreviewInput.fields,
  context: RunContext,
  head: Schema.String,
  repositoryKeys: Schema.Array(Schema.String),
  observedAt: Schema.String,
  descriptor: BuildDescriptor,
  repositories: Schema.Array(BuildExpectedRepository).check(Schema.isMaxLength(16)),
});
export type AttemptPreview = typeof AttemptPreview.Type;
export const AttemptStart = Schema.Struct({ operationKey: id, preview: AttemptPreview });
export type AttemptStart = typeof AttemptStart.Type;
export const AttemptLookup = Schema.Struct({ operationKey: id });
export type AttemptLookup = typeof AttemptLookup.Type;
export const AttemptAdvance = Schema.Struct({
  ...AttemptLookup.fields,
  action: Schema.Literals(["launch", "checks", "finalize", "cancel"]),
  recordingID: Schema.optionalKey(id),
  cancellationKey: Schema.optionalKey(id),
});
export type AttemptAdvance = typeof AttemptAdvance.Type;
export const VerificationAttempt = Schema.Struct({
  operationKey: id,
  preview: AttemptPreview,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  phase: Schema.Literals([
    "preparing",
    "ready",
    "launching",
    "checking",
    "finalizing",
    "completed",
    "cancelled",
    "failed",
    "unknown",
  ]),
  pendingAction: Schema.NullOr(
    Schema.Literals(["prepare", "launch", "checks", "finalize", "cancel"]),
  ),
  pendingNativeOperationKey: Schema.optionalKey(id),
  receipt: Schema.NullOr(BuildReceipt),
  recordingID: Schema.NullOr(id),
  recordingProof: Schema.NullOr(Recording),
  proofHash: Schema.NullOr(Schema.String),
  buildAndChecksMatch: Schema.optionalKey(Schema.Boolean),
  verdict: Schema.Literals(["incomplete", "checks_failed", "earlier_revision", "matches"]),
  detail: Schema.String,
  currentHead: Schema.NullOr(Schema.String),
});
export type VerificationAttempt = typeof VerificationAttempt.Type;
export const AttemptSummary = Schema.Struct({
  operationKey: id,
  preview: Schema.Struct({
    reference: PullRequestRef,
    featureID: id,
    checkoutID: id,
    serviceID: id,
    context: RunContext,
    head: Schema.String,
  }),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  phase: VerificationAttempt.fields.phase,
  verdict: VerificationAttempt.fields.verdict,
  buildAndChecksMatch: Schema.optionalKey(Schema.Boolean),
  detail: Schema.String,
  currentHead: Schema.NullOr(Schema.String),
  recordingID: Schema.NullOr(id),
  buildRunID: Schema.NullOr(id),
  checkRunIDs: Schema.Array(id).check(Schema.isMaxLength(32)),
});
export type AttemptSummary = typeof AttemptSummary.Type;
export const toAttemptSummary = (value: VerificationAttempt): AttemptSummary => ({
  operationKey: value.operationKey,
  preview: {
    reference: value.preview.reference,
    featureID: value.preview.featureID,
    checkoutID: value.preview.checkoutID,
    serviceID: value.preview.serviceID,
    context: value.preview.context,
    head: value.preview.head,
  },
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
  phase: value.phase,
  verdict: value.verdict,
  ...(value.buildAndChecksMatch !== undefined
    ? { buildAndChecksMatch: value.buildAndChecksMatch }
    : {}),
  detail: value.detail,
  currentHead: value.currentHead,
  recordingID: value.recordingID,
  buildRunID: value.receipt?.buildRunID ?? null,
  checkRunIDs: value.receipt?.checks.map((check) => check.runID) ?? [],
});
export class AttemptError extends Schema.TaggedError<AttemptError>()("VerificationAttemptError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Verification attempt ${this.reason}.`;
  }
}
export const ATTEMPT_METHODS = {
  preview: "deckhand.verificationAttempt.preview",
  start: "deckhand.verificationAttempt.start",
  get: "deckhand.verificationAttempt.get",
  list: "deckhand.verificationAttempt.list",
  advance: "deckhand.verificationAttempt.advance",
} as const;
const errors = Schema.Union([AttemptError, EnvironmentAuthorizationError]);
export const VerificationAttemptRpcGroup = RpcGroup.make(
  Rpc.make(ATTEMPT_METHODS.preview, {
    payload: AttemptPreviewInput,
    success: AttemptPreview,
    error: errors,
  }),
  Rpc.make(ATTEMPT_METHODS.start, {
    payload: AttemptStart,
    success: VerificationAttempt,
    error: errors,
  }),
  Rpc.make(ATTEMPT_METHODS.get, {
    payload: AttemptLookup,
    success: VerificationAttempt,
    error: errors,
  }),
  Rpc.make(ATTEMPT_METHODS.list, {
    payload: Schema.Struct({ reference: PullRequestRef }),
    success: Schema.Array(AttemptSummary).check(Schema.isMaxLength(30)),
    error: errors,
  }),
  Rpc.make(ATTEMPT_METHODS.advance, {
    payload: AttemptAdvance,
    success: VerificationAttempt,
    error: errors,
  }),
);
