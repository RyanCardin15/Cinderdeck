import * as Schema from "effect/Schema";
import { ThreadId, ProviderSessionId, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { ModelSelection } from "../modelSelection.ts";
import { RuntimeMode } from "../providerPolicy.ts";
import { FeatureId, CheckoutBindingId } from "./index.ts";
const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const REVIEWER_METHODS = {
  preview: "deckhand.reviewer.preview",
  launch: "deckhand.reviewer.launch",
  schedule: "deckhand.reviewer.schedule",
  get: "deckhand.reviewer.get",
  cancel: "deckhand.reviewer.cancel",
  stopSource: "deckhand.reviewer.source.stop",
} as const;
export const ReviewerLaunchContext = Schema.Struct({
  featureId: FeatureId,
  sourceCheckoutId: CheckoutBindingId,
  sourceWorkspaceID: identifier,
  sourceGeneration: PositiveInt,
  sourceRevision: identifier,
  repositories: Schema.Array(
    Schema.Struct({
      repositoryID: identifier,
      sourcePhysicalId: identifier,
      repositoryPhysicalId: identifier,
      commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type ReviewerLaunchContext = typeof ReviewerLaunchContext.Type;
export const ReviewerLaunchPreview = Schema.Struct({
  installationID: identifier,
  workspaceID: identifier,
  generation: PositiveInt,
  revision: identifier,
  repositoryID: identifier,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  reviewerContext: ReviewerLaunchContext,
});
export type ReviewerLaunchPreview = typeof ReviewerLaunchPreview.Type;
export const ReviewerPreviewInput = Schema.Struct({ threadId: ThreadId });
export const ReviewerLaunchInput = Schema.Struct({
  operationKey: identifier,
  preview: ReviewerLaunchPreview,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
});
export type ReviewerLaunchInput = typeof ReviewerLaunchInput.Type;

export const ReviewerQueueLookup = Schema.Struct({ operationKey: identifier });
export type ReviewerQueueLookup = typeof ReviewerQueueLookup.Type;
export const ReviewerQueueRecord = Schema.Struct({
  operationKey: identifier,
  state: Schema.Literals([
    "queued",
    "waiting_writer",
    "starting",
    "accepted",
    "needs_refresh",
    "failed",
    "unknown_outcome",
    "cancelled",
  ]),
  attempts: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  attemptKey: Schema.NullOr(identifier),
  preview: ReviewerLaunchPreview,
  creation: Schema.NullOr(
    Schema.Struct({
      operationKey: identifier,
      state: Schema.String,
      laneID: Schema.NullOr(identifier),
      threadID: Schema.NullOr(ThreadId),
      error: Schema.NullOr(Schema.String),
    }),
  ),
  detail: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ReviewerQueueRecord = typeof ReviewerQueueRecord.Type;

export const ReviewerSourceStopInput = Schema.Struct({
  threadId: ThreadId,
  providerSessionId: ProviderSessionId,
});
export type ReviewerSourceStopInput = typeof ReviewerSourceStopInput.Type;
export const ReviewerSourceStopResult = Schema.Struct({
  threadId: ThreadId,
  state: Schema.Literals(["released", "shared_session", "unknown_outcome"]),
  detail: Schema.String,
});
export type ReviewerSourceStopResult = typeof ReviewerSourceStopResult.Type;
