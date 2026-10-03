import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as WriterReservations from "./WriterReservations.ts";

const SqlLayer = NodeSqliteClient.layer({ filename: ":memory:" });
const TestLayer = WriterReservations.layer.pipe(Layer.provideMerge(SqlLayer));
const waitFor = (
  store: WriterReservations.WriterReservations["Service"],
  ownerId: string,
  state: WriterReservations.WriterRequest["state"],
) =>
  store.changes.pipe(
    Stream.filter((rows) => rows.some((row) => row.ownerId === ownerId && row.state === state)),
    Stream.take(1),
    Stream.runDrain,
  );

describe("physical checkout writer ownership", () => {
  it.effect("queues overlapping scopes in order while independent checkouts run", () =>
    Effect.gen(function* () {
      const store = yield* WriterReservations.WriterReservations;
      const firstScope = yield* Scope.make();
      yield* store
        .acquire({ ownerId: "first", physicalIds: ["git-worktree-a"] })
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      const secondDone = yield* Deferred.make<void>();
      const second = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* store.acquire({
            ownerId: "alias",
            physicalIds: ["git-worktree-a", "git-worktree-b"],
          });
          yield* Deferred.await(secondDone);
        }),
      ).pipe(Effect.forkChild);
      yield* waitFor(store, "alias", "queued");
      const thirdDone = yield* Deferred.make<void>();
      const third = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* store.acquire({ ownerId: "third", physicalIds: ["git-worktree-b"] });
          yield* Deferred.await(thirdDone);
        }),
      ).pipe(Effect.forkChild);
      yield* waitFor(store, "third", "queued");
      const independentScope = yield* Scope.make();
      yield* store
        .acquire({ ownerId: "independent", physicalIds: ["different-worktree"] })
        .pipe(Effect.provideService(Scope.Scope, independentScope));
      assert.deepEqual(
        (yield* store.inspect).map((row) => [row.ownerId, row.state]),
        [
          ["first", "held"],
          ["alias", "queued"],
          ["third", "queued"],
          ["independent", "held"],
        ],
      );
      yield* Scope.close(firstScope, Exit.void);
      yield* waitFor(store, "alias", "held");
      assert.equal((yield* store.inspect).find((row) => row.ownerId === "third")?.state, "queued");
      yield* Deferred.succeed(secondDone, undefined);
      yield* Fiber.join(second);
      yield* waitFor(store, "third", "held");
      yield* Deferred.succeed(thirdDone, undefined);
      yield* Fiber.join(third);
      yield* Scope.close(independentScope, Exit.void);
      assert.deepEqual(yield* store.inspect, []);
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("cancels queued admission and refuses duplicate owners or empty scopes", () =>
    Effect.gen(function* () {
      const store = yield* WriterReservations.WriterReservations;
      const ownerScope = yield* Scope.make();
      yield* store
        .acquire({ ownerId: "owner", physicalIds: ["physical"] })
        .pipe(Effect.provideService(Scope.Scope, ownerScope));
      const duplicate = yield* Effect.scoped(
        store.acquire({ ownerId: "owner", physicalIds: ["other"] }),
      ).pipe(Effect.flip);
      assert.equal(duplicate.reason, "duplicate_owner");
      const empty = yield* Effect.scoped(store.acquire({ ownerId: "empty", physicalIds: [] })).pipe(
        Effect.flip,
      );
      assert.equal(empty.reason, "invalid_scope");
      const queued = yield* Effect.scoped(
        store.acquire({ ownerId: "queued", physicalIds: ["physical"] }),
      ).pipe(Effect.forkChild);
      yield* waitFor(store, "queued", "queued");
      yield* Fiber.interrupt(queued);
      assert.deepEqual(
        (yield* store.inspect).map((row) => row.ownerId),
        ["owner"],
      );
      yield* Scope.close(ownerScope, Exit.void);
      assert.deepEqual(yield* store.inspect, []);
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("retains crashed ownership as uncertain instead of admitting a new writer", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* WriterReservations.WriterReservations;
      yield* sql`INSERT INTO deckhand_writer_requests(id,runtime_epoch,owner_id,state)
        VALUES ('crashed', 'previous-process', 'old-provider', 'held'),
          ('waiting', 'previous-process', 'old-waiter', 'queued')`;
      yield* sql`INSERT INTO deckhand_writer_scope(request_id, physical_id)
        VALUES ('crashed','physical'), ('waiting','physical')`;
      // Rebuild the actual service against the same persistent SQL connection.
      yield* Effect.gen(function* () {
        const reopened = yield* WriterReservations.WriterReservations;
        assert.deepEqual(
          (yield* reopened.inspect).map((row) => [row.ownerId, row.state]),
          [["old-provider", "uncertain"]],
        );
        const replacement = yield* Effect.scoped(
          reopened.acquire({ ownerId: "replacement", physicalIds: ["physical"] }),
        ).pipe(Effect.forkChild);
        yield* waitFor(reopened, "replacement", "queued");
        assert.equal(
          (yield* reopened.inspect).find((row) => row.ownerId === "old-provider")?.state,
          "uncertain",
        );
        yield* Fiber.interrupt(replacement);
      }).pipe(Effect.provide(Layer.fresh(WriterReservations.layer)), Effect.scoped);
      assert.equal((yield* store.inspect)[0]?.state, "uncertain");
    }).pipe(Effect.provide(TestLayer)),
  );
});
