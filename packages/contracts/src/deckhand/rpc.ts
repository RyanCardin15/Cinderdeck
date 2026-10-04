import { OwnershipRpcGroup } from "./ownershipRpc.ts";
import { HistoryImportsRpcGroup } from "./historyImportRpc.ts";
import { OwnedPreviewRpcGroup } from "./ownedPreviewRpc.ts";
import { VerificationAttemptRpcGroup } from "./verificationAttemptsRpc.ts";
import { ExternalSessionRpcGroup, ExternalSessionSummary } from "./externalSessionsRpc.ts";
import { AttentionRpcGroup } from "./attentionRpc.ts";
import { VerificationRpcGroup } from "./verificationRpc.ts";
import {
  LINKED_WORK_METHODS,
  LinkedWorkPublishInput,
  LinkedWorkRecord,
  LinkedWorkTarget,
  LinkedWorkResolution,
  LinkedWorkError,
} from "./linkedWorkRpc.ts";
export * from "./linkedWorkRpc.ts";
import { RunsRpcGroup } from "./runsRpc.ts";
import {
  REVIEWER_METHODS,
  ReviewerLaunchContext,
  ReviewerLaunchPreview,
  ReviewerPreviewInput,
  ReviewerLaunchInput,
  ReviewerQueueRecord,
  ReviewerQueueLookup,
  ReviewerSourceStopInput,
  ReviewerSourceStopResult,
} from "./reviewerRpc.ts";
export {
  REVIEWER_METHODS,
  ReviewerLaunchContext,
  ReviewerLaunchPreview,
  ReviewerPreviewInput,
  ReviewerLaunchInput,
  ReviewerQueueRecord,
  ReviewerQueueLookup,
  ReviewerSourceStopInput,
  ReviewerSourceStopResult,
} from "./reviewerRpc.ts";
import {
  THREAD_CONTEXT_METHOD,
  ThreadContextInput,
  ThreadContextView,
} from "./threadContextRpc.ts";
export {
  THREAD_CONTEXT_METHOD,
  ThreadContextInput,
  ThreadContextView,
} from "./threadContextRpc.ts";
import { RecordingRpcGroup } from "./recordingsRpc.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { SessionBinding, FeatureId, WorkspaceBindingId, PhysicalCheckout } from "./index.ts";
import { ProviderInstanceId } from "../providerInstance.ts";
import { ModelSelection } from "../modelSelection.ts";
import { ThreadPullRequestLink } from "../threadPullRequest.ts";
import { RuntimeMode } from "../providerPolicy.ts";
import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  ThreadId,
  ProjectId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import {
  IntegrationHello,
  IntegrationSnapshot,
  IntegrationEvents,
  IntegrationOperationInput,
  IntegrationRepositoryStartRefs,
  IntegrationOperationReceipt,
} from "./integration.ts";

export const DECKHAND_METHODS = {
  sessions: "deckhand.sessions.subscribe",
  contexts: "deckhand.contexts.subscribe",
  launch: "deckhand.session.launch",
  create: "deckhand.session.create",
  createGet: "deckhand.session.create.get",
  launchGet: "deckhand.session.launch.get",
  launchOptions: "deckhand.session.launch.options",
  reviewPreview: "deckhand.session.launch.review.preview",
  reviewConfirm: "deckhand.session.launch.review.confirm",
  overview: "deckhand.overview",
  subscribe: "deckhand.subscribe",
  refresh: "deckhand.refresh",
  submit: "deckhand.operation.submit",
  operation: "deckhand.operation.get",
  operations: "deckhand.operation.list",
} as const;
export class DeckhandRpcError extends Schema.TaggedError<DeckhandRpcError>()("DeckhandRpcError", {
  reason: Schema.String,
  code: Schema.optionalKey(Schema.String),
}) {
  override get message() {
    return `Deckhand integration ${this.reason}.`;
  }
}
export const OverviewPageInput = Schema.Struct({
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)),
  selectedWorkspaceID: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  selectedContextID: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  workspacePage: Schema.optionalKey(
    Schema.Struct({
      offset: NonNegativeInt,
      limit: PositiveInt.check(Schema.isLessThanOrEqualTo(50)),
    }),
  ),
});
export const IntegrationView = Schema.Struct({
  state: Schema.Literals([
    "connecting",
    "connected",
    "reconnecting",
    "unavailable",
    "incompatible",
    "identity_changed",
    "unauthorized",
    "unsupported",
  ]),
  hello: Schema.NullOr(IntegrationHello),
  observedAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(
    Schema.Struct({ reason: Schema.String, code: Schema.optionalKey(Schema.String) }),
  ),
  resources: IntegrationSnapshot.fields.resources,
  selectedResources: Schema.optionalKey(
    IntegrationSnapshot.fields.resources.check(Schema.isMaxLength(2)),
  ),
  workspaceContexts: Schema.optionalKey(
    Schema.Struct({
      workspaceID: TrimmedNonEmptyString,
      resources: IntegrationSnapshot.fields.resources.check(Schema.isMaxLength(50)),
      total: NonNegativeInt,
      laneCount: NonNegativeInt,
      offset: NonNegativeInt,
      nextOffset: Schema.NullOr(NonNegativeInt),
    }),
  ),
  activity: IntegrationEvents.fields.events,
  total: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type IntegrationView = typeof IntegrationView.Type;
export const OperationRecord = Schema.Struct({
  input: IntegrationOperationInput,
  receipt: Schema.NullOr(IntegrationOperationReceipt),
  createdAt: Schema.String,
  refused: Schema.Boolean,
  error: Schema.NullOr(
    Schema.Struct({ reason: Schema.String, code: Schema.optionalKey(Schema.String) }),
  ),
});
export type OperationRecord = typeof OperationRecord.Type;
const launchIdentifier = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const ManagedLaunchInput = Schema.Struct({
  operationKey: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  installationID: launchIdentifier,
  workspaceID: launchIdentifier,
  generation: PositiveInt,
  revision: launchIdentifier,
  repositoryID: launchIdentifier,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(16000)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  reviewerContext: Schema.optionalKey(ReviewerLaunchContext),
});
export type ManagedLaunchInput = typeof ManagedLaunchInput.Type;
export const ManagedLaunchRecord = Schema.Struct({
  operationKey: Schema.String,
  projectId: ProjectId,
  threadId: ThreadId,
  featureId: Schema.String,
  sessionId: Schema.String,
  checkoutId: Schema.String,
  state: Schema.Literals(["prepared", "accepted", "failed"]),
});
export type ManagedLaunchRecord = typeof ManagedLaunchRecord.Type;
export const ManagedCreateInput = Schema.Struct({
  ...ManagedLaunchInput.fields,
  branch: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(200)),
  repositoryRefs: IntegrationRepositoryStartRefs,
  setup: Schema.Boolean,
  start: Schema.Boolean,
});
export type ManagedCreateInput = typeof ManagedCreateInput.Type;
export const ManagedCreationContextIntent = Schema.Struct({
  featureId: FeatureId,
  workspaceBindingId: WorkspaceBindingId,
  repositoryIDs: Schema.Array(launchIdentifier).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(64),
  ),
});
export type ManagedCreationContextIntent = typeof ManagedCreationContextIntent.Type;
export const ManagedCreateRecord = Schema.Struct({
  operationKey: Schema.String,
  laneOperationKey: Schema.String,
  launchOperationKey: Schema.String,
  // Older saved receipts remain decodable; new creation commits this before native effects.
  contextIntent: Schema.optionalKey(ManagedCreationContextIntent),
  state: Schema.Literals([
    "prepared",
    "creating",
    "ready",
    "accepted",
    "failed",
    "unknown_outcome",
  ]),
  laneID: Schema.NullOr(Schema.String),
  receipt: Schema.NullOr(IntegrationOperationReceipt),
  launch: Schema.NullOr(ManagedLaunchRecord),
  error: Schema.NullOr(Schema.String),
});
export type ManagedCreateRecord = typeof ManagedCreateRecord.Type;
export const ManagedSessionsInput = Schema.Struct({
  installationID: launchIdentifier,
  workspaceID: launchIdentifier,
  generation: PositiveInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(20)),
});
export type ManagedSessionsInput = typeof ManagedSessionsInput.Type;
export const ManagedSessionView = Schema.Struct({
  binding: SessionBinding,
  title: Schema.String,
  objective: Schema.optionalKey(Schema.String),
  pullRequests: Schema.optionalKey(Schema.Array(ThreadPullRequestLink)),
  source: Schema.Literals(["current", "unavailable"]),
  archived: Schema.Boolean,
});
export type ManagedSessionView = typeof ManagedSessionView.Type;
export const ManagedContextsInput = Schema.Struct({
  installationID: launchIdentifier,
  contexts: Schema.Array(
    Schema.Struct({ workspaceID: launchIdentifier, generation: PositiveInt }),
  ).check(Schema.isMaxLength(100)),
});
export type ManagedContextsInput = typeof ManagedContextsInput.Type;
export const ManagedContextView = Schema.Struct({
  workspaceID: launchIdentifier,
  generation: PositiveInt,
  total: NonNegativeInt,
  sessions: Schema.Array(ManagedSessionView),
  externalSessions: Schema.optionalKey(ExternalSessionSummary),
});
export type ManagedContextView = typeof ManagedContextView.Type;
export const ManagedLaunchOption = Schema.Struct({
  instanceId: ProviderInstanceId,
  label: Schema.String,
  models: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
});
export const ManagedLaunchReviewInput = Schema.Struct({
  operationKey: launchIdentifier,
  kind: Schema.Literals(["launch", "creation"]),
});
export type ManagedLaunchReviewInput = typeof ManagedLaunchReviewInput.Type;
export const ManagedLaunchReview = Schema.Struct({
  ...ManagedLaunchReviewInput.fields,
  installationID: launchIdentifier,
  workspaceID: launchIdentifier,
  generation: PositiveInt,
  revision: launchIdentifier,
  repositories: Schema.Array(
    Schema.Struct({ repositoryID: launchIdentifier, checkout: PhysicalCheckout }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type ManagedLaunchReview = typeof ManagedLaunchReview.Type;
const ErrorSchema = Schema.Union([DeckhandRpcError, EnvironmentAuthorizationError]);
export const DeckhandRpcGroup = RpcGroup.make(
  Rpc.make(LINKED_WORK_METHODS.publish, {
    payload: LinkedWorkPublishInput,
    success: LinkedWorkRecord,
    error: Schema.Union([LinkedWorkError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(LINKED_WORK_METHODS.resolve, {
    payload: LinkedWorkTarget,
    success: LinkedWorkResolution,
    error: Schema.Union([LinkedWorkError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(REVIEWER_METHODS.preview, {
    payload: ReviewerPreviewInput,
    success: ReviewerLaunchPreview,
    error: ErrorSchema,
  }),
  Rpc.make(REVIEWER_METHODS.launch, {
    payload: ReviewerLaunchInput,
    success: ManagedCreateRecord,
    error: ErrorSchema,
  }),
  Rpc.make(REVIEWER_METHODS.stopSource, {
    payload: ReviewerSourceStopInput,
    success: ReviewerSourceStopResult,
    error: ErrorSchema,
  }),
  Rpc.make(REVIEWER_METHODS.schedule, {
    payload: ReviewerLaunchInput,
    success: ReviewerQueueRecord,
    error: ErrorSchema,
  }),
  Rpc.make(REVIEWER_METHODS.get, {
    payload: ReviewerQueueLookup,
    success: Schema.NullOr(ReviewerQueueRecord),
    error: ErrorSchema,
  }),
  Rpc.make(REVIEWER_METHODS.cancel, {
    payload: ReviewerQueueLookup,
    success: ReviewerQueueRecord,
    error: ErrorSchema,
  }),
  Rpc.make(THREAD_CONTEXT_METHOD, {
    payload: ThreadContextInput,
    success: Schema.NullOr(ThreadContextView),
    error: ErrorSchema,
    stream: true,
  }),
  Rpc.make(DECKHAND_METHODS.contexts, {
    payload: ManagedContextsInput,
    success: Schema.Array(ManagedContextView),
    error: ErrorSchema,
    stream: true,
  }),
  Rpc.make(DECKHAND_METHODS.sessions, {
    payload: ManagedSessionsInput,
    success: Schema.Array(ManagedSessionView),
    error: ErrorSchema,
    stream: true,
  }),
  Rpc.make(DECKHAND_METHODS.create, {
    payload: ManagedCreateInput,
    success: ManagedCreateRecord,
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.createGet, {
    payload: Schema.Struct({ operationKey: launchIdentifier }),
    success: ManagedCreateRecord,
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.launch, {
    payload: ManagedLaunchInput,
    success: ManagedLaunchRecord,
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.launchGet, {
    payload: Schema.Struct({ operationKey: launchIdentifier }),
    success: ManagedLaunchRecord,
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.reviewPreview, {
    payload: ManagedLaunchReviewInput,
    success: ManagedLaunchReview,
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.reviewConfirm, {
    payload: ManagedLaunchReview,
    success: ManagedLaunchReview,
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.launchOptions, {
    payload: Schema.Struct({}),
    success: Schema.Array(ManagedLaunchOption),
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.operations, {
    payload: Schema.Struct({}),
    success: Schema.Array(OperationRecord),
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.overview, {
    payload: OverviewPageInput,
    success: IntegrationView,
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.subscribe, {
    payload: OverviewPageInput,
    success: IntegrationView,
    error: ErrorSchema,
    stream: true,
  }),
  Rpc.make(DECKHAND_METHODS.refresh, {
    payload: Schema.Struct({}),
    success: Schema.Void,
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.submit, {
    payload: IntegrationOperationInput,
    success: IntegrationOperationReceipt,
    error: ErrorSchema,
  }),
  Rpc.make(DECKHAND_METHODS.operation, {
    payload: Schema.Struct({
      operationKey: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
      waitMs: Schema.optional(NonNegativeInt.check(Schema.isLessThanOrEqualTo(25000))),
    }),
    success: IntegrationOperationReceipt,
    error: ErrorSchema,
  }),
)
  .merge(RecordingRpcGroup)
  .merge(RunsRpcGroup)
  .merge(VerificationRpcGroup)
  .merge(AttentionRpcGroup)
  .merge(ExternalSessionRpcGroup)
  .merge(VerificationAttemptRpcGroup)
  .merge(OwnedPreviewRpcGroup)
  .merge(HistoryImportsRpcGroup)
  .merge(OwnershipRpcGroup);
