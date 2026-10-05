import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import {
  ThreadId,
  PositiveInt,
  NonNegativeInt,
  TrimmedNonEmptyString,
  IsoDateTime,
} from "../baseSchemas.ts";
import { PullRequestRef } from "../pullRequest.ts";
import { RunContext } from "./runsRpc.ts";
const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
export const ATTENTION_METHODS = {
  list: "deckhand.attention.list",
  change: "deckhand.attention.change",
} as const;
export const AttentionTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
  Schema.Struct({
    kind: Schema.Literal("runs"),
    context: RunContext,
    runID: identifier,
    resolvedByRunID: Schema.optionalKey(identifier),
  }),
  Schema.Struct({ kind: Schema.Literal("connection") }),
  Schema.Struct({
    kind: Schema.Literal("review"),
    operationKey: identifier,
    threadId: Schema.NullOr(ThreadId),
    context: RunContext,
    baseWorkspaceID: identifier,
  }),
  Schema.Struct({ kind: Schema.Literal("verification"), reference: PullRequestRef }),
]);
export const AttentionCause = Schema.Struct({
  id: identifier,
  scopeKey: identifier,
  causeVersion: identifier,
  kind: Schema.Literals([
    "approval",
    "input",
    "auth",
    "plan",
    "agent_failure",
    "run_failure",
    "connection",
    "review_ready",
    "review_blocked",
    "verification",
  ]),
  title: Schema.String.check(Schema.isMaxLength(200)),
  detail: Schema.String.check(Schema.isMaxLength(1200)),
  severity: Schema.Literals(["info", "warning", "error"]),
  target: AttentionTarget,
  observedAt: IsoDateTime,
  state: Schema.Literals(["active", "resolved", "unknown"]),
  revision: PositiveInt,
  canSnooze: Schema.Boolean,
});
export type AttentionCause = typeof AttentionCause.Type;
export const AttentionItem = Schema.Struct({
  ...AttentionCause.fields,
  freshness: Schema.Literals(["current", "last_observed"]),
  read: Schema.Boolean,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  dispositionRevision: NonNegativeInt,
});
export type AttentionItem = typeof AttentionItem.Type;
export const AttentionListInput = Schema.Struct({
  threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(100)),
  nativeContexts: Schema.Array(RunContext).check(Schema.isMaxLength(16)),
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)),
  view: Schema.Literals(["active", "snoozed", "history"]),
});
export type AttentionListInput = typeof AttentionListInput.Type;
export const AttentionPage = Schema.Struct({
  items: Schema.Array(AttentionItem).check(Schema.isMaxLength(100)),
  total: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
  warnings: Schema.Array(Schema.String).check(Schema.isMaxLength(32)),
  observedAt: IsoDateTime,
});
export type AttentionPage = typeof AttentionPage.Type;
export const AttentionChange = Schema.Struct({
  id: identifier,
  causeVersion: identifier,
  revision: PositiveInt,
  dispositionRevision: NonNegativeInt,
  action: Schema.Literals(["read", "unread", "snooze", "unsnooze"]),
  snoozedUntil: Schema.optionalKey(IsoDateTime),
});
export type AttentionChange = typeof AttentionChange.Type;
export class AttentionError extends Schema.TaggedError<AttentionError>()("AttentionError", {
  reason: Schema.Literals([
    "missing",
    "stale_cause",
    "conflict",
    "source_unavailable",
    "snooze_blocked",
    "invalid_time",
    "storage",
  ]),
}) {
  override get message() {
    return `Attention item ${this.reason.replaceAll("_", " ")}.`;
  }
}
export const AttentionRpcGroup = RpcGroup.make(
  Rpc.make(ATTENTION_METHODS.list, {
    payload: AttentionListInput,
    success: AttentionPage,
    error: Schema.Union([AttentionError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(ATTENTION_METHODS.change, {
    payload: AttentionChange,
    success: AttentionItem,
    error: Schema.Union([AttentionError, EnvironmentAuthorizationError]),
  }),
);
