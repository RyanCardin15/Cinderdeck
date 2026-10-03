import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import {
  IntegrationHello,
  IntegrationSnapshot,
  IntegrationEvents,
  IntegrationOperationInput,
  IntegrationOperationReceipt,
} from "./integration.ts";

export const DECKHAND_METHODS = {
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
const ErrorSchema = Schema.Union([DeckhandRpcError, EnvironmentAuthorizationError]);
export const DeckhandRpcGroup = RpcGroup.make(
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
    payload: Schema.Struct({ operationKey: TrimmedNonEmptyString.check(Schema.isMaxLength(160)) }),
    success: IntegrationOperationReceipt,
    error: ErrorSchema,
  }),
);
