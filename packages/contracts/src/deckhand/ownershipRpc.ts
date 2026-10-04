import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { PhysicalCheckout } from "./index.ts";
const key = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export const OWNERSHIP_METHODS = {
  preview: "deckhand.ownership.preview",
  submit: "deckhand.ownership.submit",
  get: "deckhand.ownership.get",
  list: "deckhand.ownership.list",
} as const;
export class OwnershipError extends Schema.TaggedError<OwnershipError>()("OwnershipError", {
  reason: Schema.Literals([
    "missing",
    "unsupported_multi_repo",
    "busy",
    "stale_context",
    "wrong_actor",
    "key_conflict",
    "pending",
    "unknown_outcome",
    "unavailable",
    "storage",
  ]),
}) {
  override get message() {
    return `Workspace ownership transition ${this.reason}.`;
  }
}
export const OwnershipIntent = Schema.Struct({
  operationKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  threadId: ThreadId,
  direction: Schema.Literals(["adopt", "release"]),
  installationID: key,
  workspaceID: key,
  generation: PositiveInt,
  revision: key,
  laneName: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type OwnershipIntent = typeof OwnershipIntent.Type;
export const OwnershipPreview = Schema.Struct({
  intent: OwnershipIntent,
  checkout: PhysicalCheckout,
  affectedThreads: Schema.Array(Schema.Struct({ threadId: ThreadId, title: Schema.String })).check(
    Schema.isMaxLength(100),
  ),
  sourceCheckoutIDs: Schema.Array(key).check(Schema.isMaxLength(100)),
  blockers: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
});
export type OwnershipPreview = typeof OwnershipPreview.Type;
export const OwnershipSubmit = Schema.Struct({
  ...OwnershipIntent.fields,
  preview: OwnershipPreview,
});
export type OwnershipSubmit = typeof OwnershipSubmit.Type;
export const OwnershipRecord = Schema.Struct({
  id: key,
  operationKey: OwnershipIntent.fields.operationKey,
  threadId: ThreadId,
  direction: OwnershipIntent.fields.direction,
  state: Schema.Literals(["pending", "unknown_outcome", "completed", "failed"]),
  original: OwnershipPreview,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  nativeOperationID: Schema.NullOr(Schema.String),
  targetCheckoutID: Schema.NullOr(key),
  detail: Schema.NullOr(Schema.String),
});
export type OwnershipRecord = typeof OwnershipRecord.Type;
export const OwnershipGet = Schema.Struct({ id: key });
export type OwnershipGet = typeof OwnershipGet.Type;
export const OwnershipList = Schema.Struct({
  threadId: ThreadId,
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(20)),
});
export const OwnershipPage = Schema.Struct({
  items: Schema.Array(OwnershipRecord),
  total: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export const OwnershipRpcGroup = RpcGroup.make(
  Rpc.make(OWNERSHIP_METHODS.preview, {
    payload: OwnershipIntent,
    success: OwnershipPreview,
    error: Schema.Union([OwnershipError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(OWNERSHIP_METHODS.submit, {
    payload: OwnershipSubmit,
    success: OwnershipRecord,
    error: Schema.Union([OwnershipError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(OWNERSHIP_METHODS.get, {
    payload: OwnershipGet,
    success: OwnershipRecord,
    error: Schema.Union([OwnershipError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(OWNERSHIP_METHODS.list, {
    payload: OwnershipList,
    success: OwnershipPage,
    error: Schema.Union([OwnershipError, EnvironmentAuthorizationError]),
  }),
);
