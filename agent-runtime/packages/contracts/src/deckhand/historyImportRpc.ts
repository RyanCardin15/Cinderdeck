import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "../auth.ts";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export const HISTORY_IMPORT_METHODS = {
  import: "deckhand.history.import",
  get: "deckhand.history.get",
  list: "deckhand.history.list",
  threads: "deckhand.history.threads",
  messages: "deckhand.history.messages",
  messageText: "deckhand.history.messageText",
  remove: "deckhand.history.remove",
} as const;
export const HistoryImportInput = Schema.Struct({
  operationKey: identifier,
  sourceDatabasePath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type HistoryImportInput = typeof HistoryImportInput.Type;
export const HistoryIdentity = Schema.Struct({ importID: identifier });
export type HistoryIdentity = typeof HistoryIdentity.Type;
export const HistoryImportReport = Schema.Struct({
  importID: identifier,
  state: Schema.Literals(["preparing", "ready", "failed", "interrupted", "removed"]),
  sourceLabel: Schema.String,
  sourceSha256: Schema.NullOr(Schema.String),
  sourceSchemaVersion: Schema.NullOr(NonNegativeInt),
  archiveSchemaVersion: PositiveInt,
  createdAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  threads: NonNegativeInt,
  messages: NonNegativeInt,
  attachmentsNotCopied: NonNegativeInt,
  historyOnly: Schema.Literal(true),
  providerContinuation: Schema.Literal("unsupported"),
  detail: Schema.NullOr(Schema.String),
  exclusions: Schema.Array(Schema.String).check(Schema.isMaxLength(16)),
});
export type HistoryImportReport = typeof HistoryImportReport.Type;
export const HistoryListInput = Schema.Struct({
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(20)),
});
export type HistoryListInput = typeof HistoryListInput.Type;
export const HistoryImportList = Schema.Struct({
  items: Schema.Array(HistoryImportReport).check(Schema.isMaxLength(20)),
  total: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type HistoryImportList = typeof HistoryImportList.Type;
export const HistoryThreadInput = Schema.Struct({
  ...HistoryIdentity.fields,
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(50)),
});
export type HistoryThreadInput = typeof HistoryThreadInput.Type;
export const HistoryThread = Schema.Struct({
  threadID: identifier,
  projectID: identifier,
  title: Schema.String.check(Schema.isMaxLength(4096)),
  provider: Schema.String.check(Schema.isMaxLength(512)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archived: Schema.Boolean,
  deleted: Schema.Boolean,
  messageCount: NonNegativeInt,
});
export type HistoryThread = typeof HistoryThread.Type;
export const HistoryThreadPage = Schema.Struct({
  items: Schema.Array(HistoryThread).check(Schema.isMaxLength(50)),
  total: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type HistoryThreadPage = typeof HistoryThreadPage.Type;
export const HistoryMessageInput = Schema.Struct({
  ...HistoryIdentity.fields,
  threadID: identifier,
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(20)),
});
export type HistoryMessageInput = typeof HistoryMessageInput.Type;
export const HistoryMessage = Schema.Struct({
  messageID: identifier,
  threadID: identifier,
  role: Schema.String.check(Schema.isMaxLength(160)),
  createdAt: Schema.String,
  text: Schema.String.check(Schema.isMaxLength(4096)),
  totalCharacters: NonNegativeInt,
  nextTextOffset: Schema.NullOr(NonNegativeInt),
  attachmentsNotCopied: NonNegativeInt,
});
export type HistoryMessage = typeof HistoryMessage.Type;
export const HistoryMessagePage = Schema.Struct({
  items: Schema.Array(HistoryMessage).check(Schema.isMaxLength(20)),
  total: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type HistoryMessagePage = typeof HistoryMessagePage.Type;
export const HistoryMessageTextInput = Schema.Struct({
  ...HistoryIdentity.fields,
  messageID: identifier,
  offset: NonNegativeInt,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(32768)),
});
export type HistoryMessageTextInput = typeof HistoryMessageTextInput.Type;
export const HistoryMessageText = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(32768)),
  totalCharacters: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type HistoryMessageText = typeof HistoryMessageText.Type;
export class HistoryImportError extends Schema.TaggedError<HistoryImportError>()(
  "HistoryImportError",
  { code: Schema.String, reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}
const errors = Schema.Union([HistoryImportError, EnvironmentAuthorizationError]);
export const HistoryImportsRpcGroup = RpcGroup.make(
  Rpc.make(HISTORY_IMPORT_METHODS.import, {
    payload: HistoryImportInput,
    success: HistoryImportReport,
    error: errors,
  }),
  Rpc.make(HISTORY_IMPORT_METHODS.get, {
    payload: HistoryIdentity,
    success: HistoryImportReport,
    error: errors,
  }),
  Rpc.make(HISTORY_IMPORT_METHODS.list, {
    payload: HistoryListInput,
    success: HistoryImportList,
    error: errors,
  }),
  Rpc.make(HISTORY_IMPORT_METHODS.threads, {
    payload: HistoryThreadInput,
    success: HistoryThreadPage,
    error: errors,
  }),
  Rpc.make(HISTORY_IMPORT_METHODS.messages, {
    payload: HistoryMessageInput,
    success: HistoryMessagePage,
    error: errors,
  }),
  Rpc.make(HISTORY_IMPORT_METHODS.messageText, {
    payload: HistoryMessageTextInput,
    success: HistoryMessageText,
    error: errors,
  }),
  Rpc.make(HISTORY_IMPORT_METHODS.remove, {
    payload: HistoryIdentity,
    success: HistoryImportReport,
    error: errors,
  }),
);
