import { assert, describe, it } from "@effect/vitest";
import * as Contracts from "@cinderdeck/contracts/deckhand/integration";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as NativeWriterReservations from "./NativeWriterReservations.ts";
import type { ManagedContext } from "./ManagedCheckoutGuard.ts";

const physical = "a".repeat(64);
const context: ManagedContext = {
  cwd: "/fixture",
  physicalId: physical,
  writerScope: [physical],
  native: {
    installationID: "native",
    workspaceID: "lane",
    generation: 7,
    revision: "revision",
    repos: ["app"],
  },
};
const record = (
  input: Contracts.IntegrationWriterReservationInput,
): Contracts.IntegrationCheckoutReservation => ({
  id: input.id,
  ownerID: input.ownerID,
  workspaceID: input.workspaceID,
  generation: input.generation,
  kind: "writer",
  state: "held",
  physicalIDs: [physical],
  createdAt: "2026-10-03T00:00:00Z",
});
const withHub = (hub: Partial<IntegrationHub.IntegrationHub["Service"]>) =>
  NativeWriterReservations.layer.pipe(
    Layer.provide(Layer.mock(IntegrationHub.IntegrationHub)(hub)),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
describe("native writer intent reconciliation", () => {
  it.effect(
    "persists intent before admission, reconciles a lost reply without resubmitting, and releases with the same authority",
    () => {
      let acquired: Contracts.IntegrationWriterReservationInput | undefined;
      let mutations = 0;
      let reads = 0;
      let releases = 0;
      let inspectBeforeAdmission: (id: string) => Effect.Effect<void, Rpc.DeckhandRpcError> = () =>
        Effect.die("Intent inspection was not installed");
      const hub = {
        reserveWriter: (_: string, input: Contracts.IntegrationWriterReservationInput) =>
          Effect.gen(function* () {
            yield* inspectBeforeAdmission(input.id);
            acquired = input;
            mutations++;
            return yield* new Rpc.DeckhandRpcError({ reason: "timeout" });
          }),
        reservation: (_: string, input: Contracts.IntegrationReservationControl) =>
          Effect.sync(() => {
            reads++;
            assert.equal(input.token, acquired?.token);
            return record(acquired!);
          }),
        releaseWriter: (_: string, input: Contracts.IntegrationReservationControl) =>
          Effect.sync(() => {
            releases++;
            assert.equal(input.token, acquired?.token);
            return { ...record(acquired!), state: "released" as const };
          }),
      };
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        inspectBeforeAdmission = (id) =>
          sql<{
            state: string;
          }>`SELECT state FROM deckhand_native_writer_intents WHERE id = ${id}`.pipe(
            Effect.tap((rows) => Effect.sync(() => assert.equal(rows[0]?.state, "pending"))),
            Effect.asVoid,
            Effect.mapError(() => new Rpc.DeckhandRpcError({ reason: "storage" })),
          );
        const service = yield* NativeWriterReservations.NativeWriterReservations;
        const id = yield* service.acquire("thread", context);
        assert.isNotNull(id);
        assert.equal(mutations, 1);
        assert.equal(reads, 1);
        yield* service.verify(id!, context);
        assert.equal(
          (yield* service
            .verify(id!, { ...context, writerScope: ["b".repeat(64)] })
            .pipe(Effect.flip)).reason,
          "uncertain",
        );
        assert.equal(
          (yield* service.acquire("thread", context).pipe(Effect.flip)).reason,
          "duplicate_owner",
        );
        yield* service.release(id!);
        yield* service.release(id!);
        assert.equal((yield* service.verify(id!, context).pipe(Effect.flip)).reason, "uncertain");
        assert.equal(releases, 1);
        assert.equal(
          (yield* sql<{ state: string }>`SELECT state FROM deckhand_native_writer_intents`)[0]
            ?.state,
          "released",
        );
        assert.isNull(
          yield* service.acquire("standalone", {
            cwd: "/fixture",
            physicalId: physical,
            writerScope: [physical],
          }),
        );
      }).pipe(Effect.provide(withHub(hub)));
    },
  );
  it.effect(
    "holds unknown outcomes and changed physical scopes, but retires an explicit preflight refusal",
    () => {
      const hub = {
        reserveWriter: (_: string, input: Contracts.IntegrationWriterReservationInput) =>
          input.ownerID === "older"
            ? Effect.fail(new Rpc.DeckhandRpcError({ reason: "unsupported_capability" }))
            : input.ownerID === "refused"
              ? Effect.fail(
                  new Rpc.DeckhandRpcError({ reason: "peer_rejected", code: "checkout_reserved" }),
                )
              : input.ownerID === "wrong"
                ? Effect.succeed({ ...record(input), physicalIDs: ["b".repeat(64)] })
                : Effect.fail(new Rpc.DeckhandRpcError({ reason: "timeout" })),
        reservation: () => Effect.fail(new Rpc.DeckhandRpcError({ reason: "unavailable" })),
      };
      return Effect.gen(function* () {
        const service = yield* NativeWriterReservations.NativeWriterReservations;
        assert.equal(
          (yield* service.acquire("refused", context).pipe(Effect.flip)).reason,
          "refused",
        );
        assert.equal(
          (yield* service.acquire("older", context).pipe(Effect.flip)).reason,
          "refused",
        );
        for (const owner of ["lost", "wrong"]) {
          assert.equal(
            (yield* service.acquire(owner, context).pipe(Effect.flip)).reason,
            "uncertain",
          );
          assert.equal(
            (yield* service.acquire(owner, context).pipe(Effect.flip)).reason,
            "duplicate_owner",
          );
        }
        const sql = yield* SqlClient.SqlClient;
        assert.deepEqual(
          (yield* sql<{
            owner_id: string;
            state: string;
          }>`SELECT owner_id,state FROM deckhand_native_writer_intents ORDER BY owner_id`).map(
            (row) => [row.owner_id, row.state],
          ),
          [
            ["lost", "uncertain"],
            ["older", "released"],
            ["refused", "released"],
            ["wrong", "uncertain"],
          ],
        );
      }).pipe(Effect.provide(withHub(hub)));
    },
  );
  it.effect("keeps ownership uncertain when native release cannot confirm success", () => {
    const hub = {
      reserveWriter: (_: string, input: Contracts.IntegrationWriterReservationInput) =>
        Effect.succeed(record(input)),
      releaseWriter: () => Effect.fail(new Rpc.DeckhandRpcError({ reason: "unavailable" })),
    };
    return Effect.gen(function* () {
      const service = yield* NativeWriterReservations.NativeWriterReservations;
      const id = yield* service.acquire("thread", context);
      assert.equal((yield* service.release(id!).pipe(Effect.flip)).reason, "uncertain");
      assert.equal(
        (yield* service.acquire("thread", context).pipe(Effect.flip)).reason,
        "duplicate_owner",
      );
    }).pipe(Effect.provide(withHub(hub)));
  });
});
