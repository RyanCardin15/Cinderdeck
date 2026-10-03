import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type {
  IntegrationOperationInput,
  IntegrationOperationReceipt,
} from "@t3tools/contracts/deckhand/integration";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Migrations from "./Migrations.ts";
import * as OperationJournal from "./OperationJournal.ts";
const input = (operationKey: string): IntegrationOperationInput => ({
  operationKey,
  installationID: "installation",
  workspaceID: "workspace",
  generation: 1,
  revision: "revision",
  method: "services.start",
  arguments: { workspace: "workspace", services: ["api", "web"] },
});
const receipt = (key: string): IntegrationOperationReceipt => ({
  id: key,
  operationKey: key,
  argumentHash: "a".repeat(64),
  workspaceID: "workspace",
  generation: 1,
  method: "services.start",
  state: "succeeded",
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:01Z",
});
const TestLayer = OperationJournal.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
describe("Deckhand durable operation intents", () => {
  it.effect("reopens a file-backed intent and treats reordered arguments as the same claim", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "dh-intent-" });
      const storeLayer = () =>
        OperationJournal.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: `${root}/state.sqlite` })),
        );
      yield* Effect.gen(function* () {
        yield* Migrations.migrate;
        const journal = yield* OperationJournal.OperationJournal;
        assert.isTrue(yield* journal.claim("actor", input("key")));
      }).pipe(Effect.provide(storeLayer()), Effect.scoped);
      yield* Effect.gen(function* () {
        yield* Migrations.migrate;
        const journal = yield* OperationJournal.OperationJournal;
        assert.isFalse(
          yield* journal.claim("actor", {
            ...input("key"),
            arguments: { services: ["api", "web"], workspace: "workspace" },
          }),
        );
        assert.equal((yield* journal.read("actor", "key")).input.operationKey, "key");
        assert.equal(
          (yield* journal.claim("actor", { ...input("key"), generation: 2 }).pipe(Effect.flip))
            .reason,
          "operation_key_conflict",
        );
        assert.equal(
          (yield* journal.claim("other", input("key")).pipe(Effect.flip)).reason,
          "operation_key_conflict",
        );
        assert.equal(
          (yield* journal.read("other", "key").pipe(Effect.flip)).reason,
          "operation_missing",
        );
      }).pipe(Effect.provide(storeLayer()), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "retains an unresolved operation ahead of bounded successful history and rejects oversized intents",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        const journal = yield* OperationJournal.OperationJournal;
        yield* journal.claim("actor", input("unresolved"));
        for (let index = 0; index < 55; index++) {
          const key = `completed-${index}`;
          yield* journal.claim("actor", input(key));
          yield* journal.update("actor", key, receipt(key), null);
        }
        const records = yield* journal.list("actor", "installation");
        assert.equal(records.length, 50);
        assert.equal(records[0]?.input.operationKey, "unresolved");
        assert.deepEqual(yield* journal.list("actor", "other-installation"), []);
        assert.equal(
          (yield* journal
            .claim("actor", {
              ...input("oversized"),
              arguments: { workspace: "workspace", text: "x".repeat(65537) },
            })
            .pipe(Effect.flip)).code,
          "input_too_large",
        );
        assert.equal(
          (yield* journal.read("actor", "oversized").pipe(Effect.flip)).reason,
          "operation_missing",
        );
      }).pipe(Effect.provide(TestLayer)),
  );
  it.effect(
    "refuses a foreign receipt and keeps a terminal result when an earlier reply arrives late",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        const journal = yield* OperationJournal.OperationJournal;
        yield* journal.claim("actor", input("key"));
        assert.equal(
          (yield* journal
            .update("actor", "key", { ...receipt("key"), workspaceID: "other" }, null)
            .pipe(Effect.flip)).reason,
          "invalid_response",
        );
        yield* journal.update("actor", "key", receipt("key"), null);
        yield* journal.update("actor", "key", { ...receipt("key"), state: "pending" }, null);
        assert.equal((yield* journal.read("actor", "key")).receipt?.state, "succeeded");
        assert.equal(
          (yield* journal
            .update("actor", "key", { ...receipt("key"), state: "failed" }, null)
            .pipe(Effect.flip)).reason,
          "invalid_response",
        );
      }).pipe(Effect.provide(TestLayer)),
  );
});
