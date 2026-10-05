// @effect-diagnostics nodeBuiltinImport:off - Stable source identity digests.
import * as NodeCrypto from "node:crypto";
import * as C from "@cinderdeck/contracts/deckhand/attentionRpc";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
const encodeJSON = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const digest = (value: unknown) =>
  NodeCrypto.createHash("sha256").update(encodeJSON(value)).digest("hex");
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(C.AttentionCause));
const encode = Schema.encodeEffect(Schema.fromJsonString(C.AttentionCause));
export type Observation = Omit<C.AttentionCause, "id" | "revision" | "state"> & {
  state?: C.AttentionCause["state"];
};
export const save = (observation: Observation, audience = "*") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const id = digest([audience, observation.scopeKey, observation.kind]);
        const rows = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_attention WHERE id=${id}`;
        const previous = rows[0] ? yield* decode(rows[0].record_json) : null;
        if (previous && previous.observedAt > observation.observedAt) return previous;
        const state = observation.state ?? "active";
        const revision = previous
          ? previous.revision +
            Number(previous.causeVersion !== observation.causeVersion || previous.state !== state)
          : 1;
        const next = { ...observation, id, state, revision };
        const json = yield* encode(next);
        yield* sql`INSERT INTO deckhand_attention(id,entity_id,cause_event_id,revision,record_json) VALUES(${id},${audience},${next.causeVersion},${revision},${json}) ON CONFLICT(id) DO UPDATE SET cause_event_id=excluded.cause_event_id,revision=excluded.revision,record_json=excluded.record_json`;
        return next;
      }),
    );
  });
// Only a successful read of the exact source may resolve its disappeared causes.
export const reconcile = (
  scopeKey: string,
  present: ReadonlyArray<string>,
  observedAt: string,
  state: "resolved" | "unknown" = "resolved",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_attention WHERE json_extract(record_json,'$.scopeKey')=${scopeKey}`;
        for (const row of rows) {
          const old = yield* decode(row.record_json);
          if (
            present.includes(old.id) ||
            (old.state === "resolved" && state === "unknown") ||
            old.observedAt > observedAt
          )
            continue;
          const next = {
            ...old,
            state,
            revision: old.revision + Number(old.state !== state),
            observedAt: state === "resolved" ? observedAt : old.observedAt,
          };
          const json = yield* encode(next);
          yield* sql`UPDATE deckhand_attention SET revision=${next.revision},record_json=${json} WHERE id=${old.id}`;
        }
      }),
    );
  });
export const decodeCause = decode;

export const unavailable = (scopeKey: string, observedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM deckhand_attention WHERE json_extract(record_json,'$.scopeKey')=${scopeKey} OR substr(json_extract(record_json,'$.scopeKey'),1,${scopeKey.length + 1})=${scopeKey + ":"}`;
    for (const row of rows) {
      const cause = yield* decode(row.record_json);
      yield* reconcile(cause.scopeKey, [], observedAt, "unknown");
    }
  });
