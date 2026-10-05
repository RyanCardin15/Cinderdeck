import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { CheckoutBindingId, ExecutionState, FeatureId } from "./index.ts";
import { RunContext } from "./runsRpc.ts";
const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const ExternalSessionId = identifier
  .check(Schema.isPattern(/^external:[a-f0-9-]{36}$/))
  .pipe(Schema.brand("deckhand/ExternalSessionId"));
export const ReportedExternalCapabilities = Schema.Array(
  Schema.Literals([
    "transcript",
    "interrupt",
    "resume",
    "approvals",
    "questions",
    "image_input",
    "video_input",
    "read_only",
  ]),
).check(Schema.isMaxLength(8));
export const ExternalSessionContext = Schema.Struct({
  ...RunContext.fields,
  featureId: FeatureId,
  checkoutId: CheckoutBindingId,
});
export const ExternalSessionRegister = Schema.Struct({
  ...ExternalSessionContext.fields,
  operationKey: identifier,
  providerName: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  providerSessionId: identifier,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  role: Schema.Literals(["writer", "reviewer", "observer"]),
  repositoryScope: Schema.Array(identifier).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  reportedExecution: ExecutionState,
  reportedCapabilities: ReportedExternalCapabilities,
});
export type ExternalSessionRegister = typeof ExternalSessionRegister.Type;
export const ExternalSessionHeartbeat = Schema.Struct({
  ...ExternalSessionContext.fields,
  id: ExternalSessionId,
  expectedSequence: NonNegativeInt,
  sequence: PositiveInt,
  reportedExecution: ExecutionState,
});
export type ExternalSessionHeartbeat = typeof ExternalSessionHeartbeat.Type;
export const ExternalSessionList = Schema.Struct({
  ...RunContext.fields,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(50)),
  includeArchived: Schema.optionalKey(Schema.Boolean),
});
export type ExternalSessionList = typeof ExternalSessionList.Type;
export const ExternalSessionRecord = Schema.Struct({
  ...ExternalSessionContext.fields,
  id: ExternalSessionId,
  providerName: ExternalSessionRegister.fields.providerName,
  providerSessionId: identifier,
  title: ExternalSessionRegister.fields.title,
  role: ExternalSessionRegister.fields.role,
  repositoryScope: ExternalSessionRegister.fields.repositoryScope,
  reportedExecution: ExecutionState,
  reportedCapabilities: ReportedExternalCapabilities,
  source: Schema.Literal("registrant_reported"),
  lastSequence: NonNegativeInt,
  registeredAt: Schema.String,
  lastSeenAt: Schema.String,
  expiresAt: Schema.String,
  archivedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ExternalSessionRecord = typeof ExternalSessionRecord.Type;
export const ExternalSessionView = Schema.Struct({
  ...ExternalSessionRecord.fields,
  connection: Schema.Literals(["connected", "stale"]),
  leaseSeconds: Schema.Literal(120),
  control: Schema.Struct({
    transcript: Schema.Literal(false),
    interrupt: Schema.Literal(false),
    resume: Schema.Literal(false),
    approvals: Schema.Literal(false),
    writerReservation: Schema.Literal(false),
  }),
});
export type ExternalSessionView = typeof ExternalSessionView.Type;
export class ExternalSessionError extends Schema.TaggedError<ExternalSessionError>()(
  "ExternalSessionError",
  {
    reason: Schema.Literals([
      "invalid_request",
      "unauthorized",
      "stale",
      "wrong_context",
      "source_unavailable",
      "missing",
      "capacity",
      "storage",
    ]),
  },
) {
  override get message() {
    return `External session ${this.reason}. Registration provides reported visibility only.`;
  }
}
export const ExternalSessionVisibility = Schema.Struct({
  ...ExternalSessionContext.fields,
  id: ExternalSessionId,
  expectedSequence: NonNegativeInt,
  archived: Schema.Boolean,
});
export type ExternalSessionVisibility = typeof ExternalSessionVisibility.Type;
export const ExternalSessionSummaryInput = Schema.Struct({
  installationID: identifier,
  contexts: Schema.Array(Schema.Struct({ workspaceID: identifier, generation: PositiveInt })).check(
    Schema.isMaxLength(100),
  ),
});
export type ExternalSessionSummaryInput = typeof ExternalSessionSummaryInput.Type;
export const ExternalSessionSummary = Schema.Struct({
  workspaceID: identifier,
  generation: PositiveInt,
  activeCount: NonNegativeInt,
  staleCount: NonNegativeInt,
  lastSeenAt: Schema.NullOr(Schema.String),
  unavailable: Schema.Boolean,
});
export type ExternalSessionSummary = typeof ExternalSessionSummary.Type;
export const EXTERNAL_SESSION_METHODS = {
  register: "deckhand.external-session.register",
  heartbeat: "deckhand.external-session.heartbeat",
  list: "deckhand.external-session.list",
  visibility: "deckhand.external-session.visibility",
} as const;
export const ExternalSessionRpcGroup = RpcGroup.make(
  Rpc.make(EXTERNAL_SESSION_METHODS.visibility, {
    payload: ExternalSessionVisibility,
    success: ExternalSessionView,
    error: Schema.Union([ExternalSessionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(EXTERNAL_SESSION_METHODS.register, {
    payload: ExternalSessionRegister,
    success: ExternalSessionView,
    error: Schema.Union([ExternalSessionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(EXTERNAL_SESSION_METHODS.heartbeat, {
    payload: ExternalSessionHeartbeat,
    success: ExternalSessionView,
    error: Schema.Union([ExternalSessionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(EXTERNAL_SESSION_METHODS.list, {
    payload: ExternalSessionList,
    success: Schema.Array(ExternalSessionView),
    error: Schema.Union([ExternalSessionError, EnvironmentAuthorizationError]),
  }),
);
