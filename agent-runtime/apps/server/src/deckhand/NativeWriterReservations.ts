// @effect-diagnostics nodeBuiltinImport:off - Scoped control nonces are generated on the owning server.
import * as NodeCrypto from "node:crypto";
import * as Contracts from "@t3tools/contracts/deckhand/integration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as IntegrationHub from "./IntegrationHub.ts";
import type { ManagedContext } from "./ManagedCheckoutGuard.ts";
import * as Migrations from "./Migrations.ts";

export class NativeWriterError extends Schema.TaggedError<NativeWriterError>()(
  "NativeWriterError",
  {
    reason: Schema.Literals(["refused", "uncertain", "storage", "duplicate_owner"]),
  },
) {
  override get message() {
    return `Native checkout reservation ${this.reason}.`;
  }
}
export class NativeWriterReservations extends Context.Service<
  NativeWriterReservations,
  {
    readonly acquire: (
      ownerID: string,
      context: ManagedContext,
    ) => Effect.Effect<string | null, NativeWriterError>;
    /** The caller must first prove its actual provider process stopped. */
    readonly release: (id: string) => Effect.Effect<void, NativeWriterError>;
    readonly verify: (
      id: string,
      context: ManagedContext,
    ) => Effect.Effect<void, NativeWriterError>;
  }
>()("t3/deckhand/NativeWriterReservations") {}

const isNativeWriterError = Schema.is(NativeWriterError);
const encode = Schema.encodeEffect(
  Schema.fromJsonString(Contracts.IntegrationWriterReservationInput),
);
const decode = Schema.decodeEffect(
  Schema.fromJsonString(Contracts.IntegrationWriterReservationInput),
);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* IntegrationHub.IntegrationHub;
  yield* Migrations.migrate;
  // A fresh server cannot attest that the previous server's provider stopped.
  yield* sql`UPDATE deckhand_native_writer_intents SET state = 'uncertain' WHERE state IN ('pending','held')`;
  const update = (id: string, state: "held" | "uncertain" | "released") =>
    sql`UPDATE deckhand_native_writer_intents SET state = ${state},
      control_json = CASE WHEN ${state} = 'released' THEN '{}' ELSE control_json END WHERE id = ${id}`;
  const storage = (cause: unknown) =>
    isNativeWriterError(cause) ? cause : new NativeWriterError({ reason: "storage" });
  const acquire = (ownerID: string, context: ManagedContext) =>
    Effect.gen(function* () {
      if (!context.native) return null;
      const input: Contracts.IntegrationWriterReservationInput = {
        ...context.native,
        ownerID,
        id: NodeCrypto.randomUUID(),
        token: NodeCrypto.randomBytes(32).toString("hex"),
      };
      const control = yield* encode(input);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const old =
            yield* sql`SELECT id FROM deckhand_native_writer_intents WHERE owner_id = ${ownerID} AND state <> 'released' LIMIT 1`;
          if (old.length) return yield* new NativeWriterError({ reason: "duplicate_owner" });
          yield* sql`INSERT INTO deckhand_native_writer_intents(id,owner_id,installation_id,state,control_json)
        VALUES (${input.id},${ownerID},${input.installationID},'pending',${control})`;
        }),
      );
      const result = yield* hub.reserveWriter(ownerID, input).pipe(Effect.result);
      let record: Contracts.IntegrationCheckoutReservation;
      if (result._tag === "Success") record = result.success;
      else if (
        result.failure.reason === "peer_rejected" ||
        result.failure.reason === "unsupported_capability" ||
        result.failure.reason === "invalid_request"
      ) {
        // A decoded refusal confirms admission never happened; no provider was started.
        yield* update(input.id, "released");
        return yield* new NativeWriterError({ reason: "refused" });
      } else {
        // Reconcile the same durable intent exactly once. Never resubmit a mutation.
        const recovered = yield* hub.reservation(ownerID, input).pipe(Effect.result);
        if (recovered._tag === "Failure") {
          yield* update(input.id, "uncertain");
          return yield* new NativeWriterError({ reason: "uncertain" });
        }
        record = recovered.success;
      }
      if (
        record.id !== input.id ||
        record.ownerID !== ownerID ||
        record.workspaceID !== input.workspaceID ||
        record.generation !== input.generation ||
        record.kind !== "writer" ||
        record.state !== "held" ||
        record.physicalIDs.length !== context.writerScope.length ||
        record.physicalIDs.some((id) => !context.writerScope.includes(id))
      ) {
        yield* update(input.id, "uncertain");
        return yield* new NativeWriterError({ reason: "uncertain" });
      }
      yield* update(input.id, "held");
      return input.id;
    }).pipe(Effect.mapError(storage));
  const release = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        state: string;
        control_json: string;
      }>`SELECT state,control_json FROM deckhand_native_writer_intents WHERE id = ${id}`;
      if (!rows[0]) return yield* new NativeWriterError({ reason: "storage" });
      if (rows[0].state === "released") return;
      const input = yield* decode(rows[0].control_json);
      const result = yield* hub.releaseWriter(input.ownerID, input).pipe(Effect.result);
      if (
        result._tag === "Failure" ||
        result.success.state !== "released" ||
        result.success.ownerID !== input.ownerID ||
        result.success.workspaceID !== input.workspaceID ||
        result.success.generation !== input.generation
      ) {
        yield* update(id, "uncertain");
        return yield* new NativeWriterError({ reason: "uncertain" });
      }
      yield* update(id, "released");
    }).pipe(Effect.mapError(storage));
  const verify = (id: string, context: ManagedContext) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        state: string;
        control_json: string;
      }>`SELECT state,control_json FROM deckhand_native_writer_intents WHERE id = ${id}`;
      if (!rows[0] || rows[0].state !== "held" || !context.native)
        return yield* new NativeWriterError({ reason: "uncertain" });
      const input = yield* decode(rows[0].control_json);
      const result = yield* hub.reservation(input.ownerID, input).pipe(Effect.result);
      if (
        result._tag === "Failure" ||
        result.success.id !== id ||
        result.success.state !== "held" ||
        result.success.ownerID !== input.ownerID ||
        result.success.workspaceID !== context.native.workspaceID ||
        result.success.generation !== context.native.generation ||
        input.installationID !== context.native.installationID ||
        result.success.physicalIDs.length !== context.writerScope.length ||
        result.success.physicalIDs.some((physicalID) => !context.writerScope.includes(physicalID))
      ) {
        yield* update(id, "uncertain");
        return yield* new NativeWriterError({ reason: "uncertain" });
      }
    }).pipe(Effect.mapError(storage));
  return NativeWriterReservations.of({ acquire, release, verify });
});
export const layer = Layer.effect(NativeWriterReservations, make);
