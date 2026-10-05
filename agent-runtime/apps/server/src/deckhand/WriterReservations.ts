// @effect-diagnostics nodeBuiltinImport:off - UUIDs identify durable requests, never processes.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrations from "./Migrations.ts";

export class WriterReservationError extends Schema.TaggedError<WriterReservationError>()(
  "WriterReservationError",
  {
    reason: Schema.Literals(["invalid_scope", "duplicate_owner", "busy", "retired", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Cannot reserve this checkout: ${this.reason}.`;
  }
}
export interface WriterRequest {
  readonly id: string;
  readonly ownerId: string;
  readonly state: "queued" | "held" | "uncertain";
  readonly physicalIds: ReadonlyArray<string>;
}
const isReservationError = Schema.is(WriterReservationError);
export class WriterReservations extends Context.Service<
  WriterReservations,
  {
    readonly acquire: (input: {
      readonly ownerId: string;
      readonly physicalIds: ReadonlyArray<string>;
    }) => Effect.Effect<void, WriterReservationError, Scope.Scope>;
    readonly tryAcquire: (input: {
      readonly ownerId: string;
      readonly physicalIds: ReadonlyArray<string>;
    }) => Effect.Effect<void, WriterReservationError, Scope.Scope>;
    /** Add newly materialized standalone checkout identities to a held lifecycle. */
    readonly extend: (input: {
      readonly ownerId: string;
      readonly physicalIds: ReadonlyArray<string>;
    }) => Effect.Effect<void, WriterReservationError>;
    readonly inspect: Effect.Effect<ReadonlyArray<WriterRequest>, WriterReservationError>;
    readonly changes: Stream.Stream<ReadonlyArray<WriterRequest>, WriterReservationError>;
    readonly uncertain: (ownerId: string) => Effect.Effect<void, WriterReservationError>;
  }
>()("@cinderdeck/server/deckhand/WriterReservations") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Migrations.migrate;
  const epoch = NodeCrypto.randomUUID();
  // A new process cannot prove an old provider stopped. Preserve held ownership
  // as uncertain; waiting requests did not start a provider and can be retired.
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`UPDATE deckhand_writer_requests SET state = 'uncertain' WHERE state = 'held'`;
      yield* sql`UPDATE deckhand_writer_requests SET state = 'released' WHERE state = 'queued'`;
    }),
  );
  const changed = yield* Ref.make(yield* Deferred.make<void>());
  const wake = Effect.gen(function* () {
    const next = yield* Deferred.make<void>();
    const previous = yield* Ref.getAndSet(changed, next);
    yield* Deferred.succeed(previous, undefined);
  });
  const storage = (cause: unknown) =>
    isReservationError(cause) ? cause : new WriterReservationError({ reason: "storage", cause });
  const release = (id: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE deckhand_writer_requests SET state = 'released'
      WHERE id = ${id} AND runtime_epoch = ${epoch} AND state <> 'uncertain'`;
          yield* sql`DELETE FROM deckhand_writer_scope WHERE request_id = ${id}
      AND EXISTS (SELECT 1 FROM deckhand_writer_requests WHERE id = ${id} AND state = 'released')`;
        }),
      )
      .pipe(Effect.andThen(wake), Effect.orDie);
  const acquire = Effect.fn("deckhand.writerReservations.acquire")(function* (input: {
    readonly ownerId: string;
    readonly physicalIds: ReadonlyArray<string>;
  }) {
    const physicalIds = [...new Set(input.physicalIds)].sort();
    if (
      !input.ownerId ||
      input.ownerId.length > 160 ||
      physicalIds.length === 0 ||
      physicalIds.length > 64 ||
      physicalIds.some((id) => !id || id.length > 160)
    ) {
      return yield* new WriterReservationError({ reason: "invalid_scope" });
    }
    const id = yield* Effect.acquireRelease(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql`SELECT id FROM deckhand_writer_requests
          WHERE owner_id = ${input.ownerId} AND state <> 'released' LIMIT 1`;
            if (existing.length)
              return yield* new WriterReservationError({ reason: "duplicate_owner" });
            const requestId = NodeCrypto.randomUUID();
            yield* sql`INSERT INTO deckhand_writer_requests(id, runtime_epoch, owner_id, state)
          VALUES (${requestId}, ${epoch}, ${input.ownerId}, 'queued')`;
            for (const physicalId of physicalIds) {
              yield* sql`INSERT INTO deckhand_writer_scope(request_id, physical_id)
            VALUES (${requestId}, ${physicalId})`;
            }
            return requestId;
          }),
        )
        .pipe(
          Effect.mapError(storage),
          Effect.tap(() => wake),
        ),
      release,
    );
    while (true) {
      // Capture before checking the database so a release between check/wait
      // completes this very signal. No timer or elapsed lease grants ownership.
      const signal = yield* Ref.get(changed);
      const admitted = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const self = yield* sql<{
              state: string;
            }>`SELECT state FROM deckhand_writer_requests WHERE id = ${id}`;
            if (self[0]?.state !== "queued")
              return yield* new WriterReservationError({ reason: "retired" });
            const blockers = yield* sql`SELECT other.id FROM deckhand_writer_requests self
          JOIN deckhand_writer_scope wanted ON wanted.request_id = self.id
          JOIN deckhand_writer_scope occupied ON occupied.physical_id = wanted.physical_id
          JOIN deckhand_writer_requests other ON other.id = occupied.request_id
          WHERE self.id = ${id} AND other.id <> self.id
            AND (other.state IN ('held','uncertain') OR
              (other.state = 'queued' AND other.sequence < self.sequence)) LIMIT 1`;
            if (blockers.length) return false;
            const rows = yield* sql`UPDATE deckhand_writer_requests SET state = 'held'
          WHERE id = ${id} AND runtime_epoch = ${epoch} AND state = 'queued' RETURNING id`;
            return rows.length === 1;
          }),
        )
        .pipe(Effect.mapError(storage));
      if (admitted) {
        yield* wake;
        return;
      }
      yield* Deferred.await(signal);
    }
  });
  const tryAcquire = Effect.fn("deckhand.writerReservations.tryAcquire")(function* (input: {
    readonly ownerId: string;
    readonly physicalIds: ReadonlyArray<string>;
  }) {
    const physicalIds = [...new Set(input.physicalIds)].sort();
    if (
      !input.ownerId ||
      input.ownerId.length > 160 ||
      physicalIds.length === 0 ||
      physicalIds.length > 64 ||
      physicalIds.some((id) => !id || id.length > 160)
    )
      return yield* new WriterReservationError({ reason: "invalid_scope" });
    yield* Effect.acquireRelease(
      sql
        .withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql`SELECT id FROM deckhand_writer_requests
          WHERE owner_id = ${input.ownerId} AND state <> 'released' LIMIT 1`;
            if (existing.length)
              return yield* new WriterReservationError({ reason: "duplicate_owner" });
            // Short Git/file actions refuse rather than wait for their own resident
            // provider. Earlier queued writers retain admission priority.
            const blockers = yield* sql`SELECT r.id FROM deckhand_writer_requests r
          JOIN deckhand_writer_scope s ON s.request_id = r.id
          WHERE r.state IN ('queued','held','uncertain') AND ${sql.in("s.physical_id", physicalIds)} LIMIT 1`;
            if (blockers.length) return yield* new WriterReservationError({ reason: "busy" });
            const id = NodeCrypto.randomUUID();
            yield* sql`INSERT INTO deckhand_writer_requests(id,runtime_epoch,owner_id,state)
          VALUES (${id},${epoch},${input.ownerId},'held')`;
            for (const physicalId of physicalIds)
              yield* sql`INSERT INTO deckhand_writer_scope(request_id,physical_id) VALUES (${id},${physicalId})`;
            return id;
          }),
        )
        .pipe(
          Effect.mapError(storage),
          Effect.tap(() => wake),
        ),
      release,
    );
  });
  const extend: WriterReservations["Service"]["extend"] = (input) => {
    const physicalIds = [...new Set(input.physicalIds)].sort();
    if (
      !input.ownerId ||
      input.ownerId.length > 160 ||
      !physicalIds.length ||
      physicalIds.length > 64 ||
      physicalIds.some((id) => !id || id.length > 160)
    )
      return Effect.fail(new WriterReservationError({ reason: "invalid_scope" }));
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const self = yield* sql<{
            id: string;
            state: string;
          }>`SELECT id,state FROM deckhand_writer_requests
        WHERE owner_id=${input.ownerId} AND runtime_epoch=${epoch} AND state='held' LIMIT 1`;
          if (!self[0]) return yield* new WriterReservationError({ reason: "retired" });
          const id = self[0].id;
          const existing = yield* sql<{
            physical_id: string;
          }>`SELECT physical_id FROM deckhand_writer_scope WHERE request_id=${id}`;
          const scope = [...new Set([...existing.map((row) => row.physical_id), ...physicalIds])];
          if (scope.length > 64)
            return yield* new WriterReservationError({ reason: "invalid_scope" });
          const blockers =
            yield* sql`SELECT r.id FROM deckhand_writer_requests r JOIN deckhand_writer_scope s ON s.request_id=r.id
        WHERE r.id <> ${id} AND r.state IN ('queued','held','uncertain') AND ${sql.in("s.physical_id", physicalIds)} LIMIT 1`;
          if (blockers.length) return yield* new WriterReservationError({ reason: "busy" });
          for (const physicalId of physicalIds)
            yield* sql`INSERT OR IGNORE INTO deckhand_writer_scope(request_id,physical_id) VALUES (${id},${physicalId})`;
        }),
      )
      .pipe(Effect.andThen(wake), Effect.mapError(storage));
  };
  const inspect = Effect.gen(function* () {
    const rows = yield* sql<{
      id: string;
      owner_id: string;
      state: WriterRequest["state"];
      physical_id: string;
    }>`SELECT r.id, r.owner_id, r.state, s.physical_id FROM deckhand_writer_requests r
      JOIN deckhand_writer_scope s ON s.request_id = r.id
      WHERE r.state <> 'released' ORDER BY r.sequence, s.physical_id LIMIT 6400`;
    const result = new Map<string, WriterRequest>();
    for (const row of rows) {
      const previous = result.get(row.id);
      result.set(row.id, {
        id: row.id,
        ownerId: row.owner_id,
        state: row.state,
        physicalIds: [...(previous?.physicalIds ?? []), row.physical_id],
      });
    }
    return [...result.values()];
  }).pipe(Effect.mapError(storage));
  const changes = Stream.unfold<
    Deferred.Deferred<void> | null,
    ReadonlyArray<WriterRequest>,
    WriterReservationError,
    never
  >(null, (previous) =>
    Effect.gen(function* () {
      if (previous !== null) yield* Deferred.await(previous);
      const next = yield* Ref.get(changed);
      const snapshot = yield* inspect;
      return [snapshot, next] as const;
    }),
  );
  const uncertain = (ownerId: string) =>
    sql`UPDATE deckhand_writer_requests SET state = 'uncertain'
    WHERE owner_id = ${ownerId} AND runtime_epoch = ${epoch} AND state = 'held'`.pipe(
      Effect.asVoid,
      Effect.andThen(wake),
      Effect.mapError(storage),
    );
  return WriterReservations.of({ acquire, tryAcquire, extend, inspect, changes, uncertain });
});
export const layer = Layer.effect(WriterReservations, make);
