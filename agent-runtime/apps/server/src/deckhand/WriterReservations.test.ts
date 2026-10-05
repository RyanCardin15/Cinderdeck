import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
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
  it.effect(
    "short mutation admission refuses resident and uncertain owners without bypassing queued writers",
    () =>
      Effect.gen(function* () {
        const store = yield* WriterReservations.WriterReservations;
        const firstScope = yield* Scope.make();
        yield* store
          .acquire({ ownerId: "resident", physicalIds: ["a"] })
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        const queued = yield* Effect.scoped(
          store.acquire({ ownerId: "waiting", physicalIds: ["a", "b"] }),
        ).pipe(Effect.forkChild);
        yield* waitFor(store, "waiting", "queued");
        for (const physicalIds of [["a"], ["b"]]) {
          const error = yield* Effect.scoped(
            store.tryAcquire({ ownerId: "git", physicalIds }),
          ).pipe(Effect.flip);
          assert.equal(error.reason, "busy");
        }
        assert.deepEqual(
          (yield* store.inspect).map((row) => row.ownerId),
          ["resident", "waiting"],
        );
        yield* Fiber.interrupt(queued);
        yield* store.uncertain("resident");
        assert.equal(
          (yield* Effect.scoped(store.tryAcquire({ ownerId: "git", physicalIds: ["a"] })).pipe(
            Effect.flip,
          )).reason,
          "busy",
        );
        const otherScope = yield* Scope.make();
        yield* store
          .tryAcquire({ ownerId: "independent", physicalIds: ["b", "b"] })
          .pipe(Effect.provideService(Scope.Scope, otherScope));
        assert.deepEqual(
          (yield* store.inspect).find((row) => row.ownerId === "independent")?.physicalIds,
          ["b"],
        );
        assert.equal(
          (yield* Effect.scoped(
            store.tryAcquire({ ownerId: "independent", physicalIds: ["c"] }),
          ).pipe(Effect.flip)).reason,
          "duplicate_owner",
        );
        yield* Scope.close(otherScope, Exit.void);
        yield* Scope.close(firstScope, Exit.void);
        assert.deepEqual(
          (yield* store.inspect).map((row) => [row.ownerId, row.state]),
          [["resident", "uncertain"]],
        );
        assert.equal(
          (yield* Effect.scoped(store.tryAcquire({ ownerId: "empty", physicalIds: [] })).pipe(
            Effect.flip,
          )).reason,
          "invalid_scope",
        );
      }).pipe(Effect.provide(TestLayer)),
  );
  it.effect(
    "extends a held lifecycle atomically, respects queued owners, and releases the expanded scope",
    () =>
      Effect.gen(function* () {
        const store = yield* WriterReservations.WriterReservations;
        const lifecycle = yield* Scope.make();
        const resident = yield* Scope.make();
        yield* store
          .tryAcquire({ ownerId: "create", physicalIds: ["source"] })
          .pipe(Effect.provideService(Scope.Scope, lifecycle));
        yield* store.extend({ ownerId: "create", physicalIds: ["new", "source", "new"] });
        assert.deepEqual(
          (yield* store.inspect).find((row) => row.ownerId === "create")?.physicalIds,
          ["new", "source"],
        );
        yield* store
          .tryAcquire({ ownerId: "provider", physicalIds: ["blocked"] })
          .pipe(Effect.provideService(Scope.Scope, resident));
        const queued = yield* Effect.scoped(
          store.acquire({ ownerId: "waiting", physicalIds: ["blocked", "next"] }),
        ).pipe(Effect.forkChild);
        yield* waitFor(store, "waiting", "queued");
        for (const physicalIds of [
          ["available", "blocked"],
          ["available", "next"],
        ]) {
          assert.equal(
            (yield* store.extend({ ownerId: "create", physicalIds }).pipe(Effect.flip)).reason,
            "busy",
          );
          assert.deepEqual(
            (yield* store.inspect).find((row) => row.ownerId === "create")?.physicalIds,
            ["new", "source"],
          );
        }
        assert.equal(
          (yield* store
            .extend({
              ownerId: "create",
              physicalIds: Array.from({ length: 64 }, (_, i) => `extra-${i}`),
            })
            .pipe(Effect.flip)).reason,
          "invalid_scope",
        );
        assert.equal(
          (yield* store
            .extend({ ownerId: "missing", physicalIds: ["available"] })
            .pipe(Effect.flip)).reason,
          "retired",
        );
        yield* Fiber.interrupt(queued);
        yield* Scope.close(resident, Exit.void);
        yield* Scope.close(lifecycle, Exit.void);
        assert.deepEqual(yield* store.inspect, []);
        yield* Effect.scoped(
          store.tryAcquire({ ownerId: "next-create", physicalIds: ["new", "source"] }),
        );
        assert.equal(
          (yield* store
            .extend({ ownerId: "next-create", physicalIds: ["another"] })
            .pipe(Effect.flip)).reason,
          "retired",
        );
      }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("uncertain and previous-runtime lifecycles cannot extend their authority", () =>
    Effect.gen(function* () {
      const store = yield* WriterReservations.WriterReservations;
      const sql = yield* SqlClient.SqlClient;
      const scope = yield* Scope.make();
      yield* store
        .tryAcquire({ ownerId: "uncertain", physicalIds: ["source"] })
        .pipe(Effect.provideService(Scope.Scope, scope));
      yield* store.uncertain("uncertain");
      assert.equal(
        (yield* store.extend({ ownerId: "uncertain", physicalIds: ["new"] }).pipe(Effect.flip))
          .reason,
        "retired",
      );
      yield* sql`INSERT INTO deckhand_writer_requests(id,runtime_epoch,owner_id,state) VALUES ('old','previous-runtime','old','held')`;
      assert.equal(
        (yield* store.extend({ ownerId: "old", physicalIds: ["new"] }).pipe(Effect.flip)).reason,
        "retired",
      );
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(
        (yield* store.inspect).find((row) => row.ownerId === "uncertain")?.physicalIds,
        ["source"],
      );
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
