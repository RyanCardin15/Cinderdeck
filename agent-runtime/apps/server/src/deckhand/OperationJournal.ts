// @effect-diagnostics nodeBuiltinImport:off - A deterministic digest binds a durable operation key to its original input.
import * as NodeCrypto from "node:crypto";
import * as Contracts from "@t3tools/contracts/deckhand/integration";
import * as Rpc from "@t3tools/contracts/deckhand/rpc";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type Result<A> = Effect.Effect<A, Rpc.DeckhandRpcError>;
export class OperationJournal extends Context.Service<
  OperationJournal,
  {
    readonly claim: (
      actorID: string,
      input: Contracts.IntegrationOperationInput,
    ) => Result<boolean>;
    readonly read: (actorID: string, key: string) => Result<Rpc.OperationRecord>;
    readonly update: (
      actorID: string,
      key: string,
      receipt: Contracts.IntegrationOperationReceipt | null,
      error: Rpc.DeckhandRpcError | null,
      refused?: boolean,
    ) => Result<void>;
    readonly list: (
      actorID: string,
      installationID: string,
    ) => Result<ReadonlyArray<Rpc.OperationRecord>>;
  }
>()("t3/deckhand/OperationJournal") {}
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(Rpc.OperationRecord));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Rpc.OperationRecord));
const encodeInput = Schema.encodeEffect(Schema.fromJsonString(Contracts.IntegrationOperationInput));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const isRpcError = Schema.is(Rpc.DeckhandRpcError);
const storeError = (cause: unknown) =>
  isRpcError(cause) ? cause : new Rpc.DeckhandRpcError({ reason: "storage" });
// Normalizing JSON object keys makes retries independent of their transport's field order.
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
export const layer = Layer.effect(
  OperationJournal,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const read = (actorID: string, key: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_operations WHERE operation_key = ${key} AND actor_id = ${actorID}`;
        if (!rows[0]) return yield* new Rpc.DeckhandRpcError({ reason: "operation_missing" });
        return yield* decodeRecord(rows[0].record_json);
      }).pipe(Effect.mapError(storeError));
    return OperationJournal.of({
      read,
      claim: (actorID, input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const encodedInput = yield* encodeInput(input);
              if (new TextEncoder().encode(encodedInput).byteLength > 65536)
                return yield* new Rpc.DeckhandRpcError({
                  reason: "invalid_request",
                  code: "input_too_large",
                });
              const normalizedInput = yield* decodeJson(encodedInput);
              const canonicalInput = yield* encodeJson(canonical(normalizedInput));
              const argumentHash = NodeCrypto.createHash("sha256")
                .update(canonicalInput)
                .digest("hex");
              const record = yield* encodeRecord({
                input,
                receipt: null,
                error: null,
                refused: false,
                createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
              });
              const inserted = yield* sql<{
                operation_key: string;
              }>`INSERT INTO deckhand_operations(operation_key, environment_id, actor_id, argument_hash, resource_generation, state, record_json)
        VALUES(${input.operationKey}, ${input.installationID}, ${actorID}, ${argumentHash}, ${input.generation}, 'intent', ${record}) ON CONFLICT(operation_key) DO NOTHING RETURNING operation_key`;
              if (inserted.length) return true;
              const rows = yield* sql<{
                actor_id: string;
                argument_hash: string;
              }>`SELECT actor_id, argument_hash FROM deckhand_operations WHERE operation_key = ${input.operationKey}`;
              if (rows[0]?.actor_id !== actorID || rows[0].argument_hash !== argumentHash)
                return yield* new Rpc.DeckhandRpcError({ reason: "operation_key_conflict" });
              return false;
            }),
          )
          .pipe(Effect.mapError(storeError)),
      update: (actorID, key, receipt, error, refused = false) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const old = yield* read(actorID, key);
              if (
                receipt &&
                (receipt.operationKey !== key ||
                  receipt.workspaceID !== old.input.workspaceID ||
                  receipt.generation !== old.input.generation ||
                  receipt.method !== old.input.method)
              )
                return yield* new Rpc.DeckhandRpcError({ reason: "invalid_response" });
              if (receipt && old.receipt) {
                const ranks = {
                  pending: 0,
                  running: 1,
                  unknown_outcome: 2,
                  failed: 3,
                  succeeded: 3,
                };
                if (ranks[receipt.state] < ranks[old.receipt.state]) return;
                if (
                  ["failed", "succeeded"].includes(old.receipt.state) &&
                  receipt.state !== old.receipt.state
                )
                  return yield* new Rpc.DeckhandRpcError({ reason: "invalid_response" });
              }
              const encoded = yield* encodeRecord({
                ...old,
                receipt: receipt ?? old.receipt,
                refused: refused || old.refused,
                error: error
                  ? { reason: error.reason, ...(error.code ? { code: error.code } : {}) }
                  : null,
              });
              yield* sql`UPDATE deckhand_operations SET state = ${refused || old.refused ? "refused" : (receipt?.state ?? old.receipt?.state ?? "unknown_outcome")}, record_json = ${encoded} WHERE operation_key = ${key} AND actor_id = ${actorID}`;
            }),
          )
          .pipe(Effect.mapError(storeError)),
      list: (actorID, installationID) =>
        Effect.gen(function* () {
          const rows = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM deckhand_operations WHERE actor_id = ${actorID} AND environment_id = ${installationID} ORDER BY CASE WHEN state IN ('intent', 'pending', 'running', 'unknown_outcome') THEN 0 ELSE 1 END, rowid DESC LIMIT 50`;
          return yield* Effect.forEach(rows, (row) => decodeRecord(row.record_json));
        }).pipe(Effect.mapError(storeError)),
    });
  }),
);
