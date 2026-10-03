import { assert, describe, it } from "@effect/vitest";
import * as Contracts from "@t3tools/contracts/deckhand";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrations from "./Migrations.ts";
import * as Relationships from "./Relationships.ts";

const SqlLayer = NodeSqliteClient.layer({ filename: ":memory:" });
const TestLayer = Relationships.layer.pipe(Layer.provideMerge(SqlLayer));
const decodeWorkspace = Schema.decodeUnknownSync(Contracts.WorkspaceBinding);
const decodeFeature = Schema.decodeUnknownSync(Contracts.Feature);
const decodeCheckout = Schema.decodeUnknownSync(Contracts.CheckoutBinding);
const workspace = (id = "workspace", environmentId = "local", generation = 1) =>
  decodeWorkspace({
    id,
    environmentId,
    backend: "cinderdeck",
    ownerId: "demo.toml",
    generation,
    revision: 1,
    name: "Demo",
    state: "active",
  });
const feature = (id = "feature", workspaceId = "workspace") =>
  decodeFeature({
    id,
    workspaceId,
    title: "Payment retry",
    objective: "Verify a declined payment can be retried",
    status: "active",
    revision: 1,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  });
const checkout = (
  id = "checkout",
  workspaceId = "workspace",
  environmentId = "local",
  generation = 1,
) =>
  decodeCheckout({
    id,
    workspaceId,
    workspaceGeneration: generation,
    environmentId,
    backend: "cinderdeck",
    kind: "lane",
    laneId: id,
    state: "ready",
    repositories: [],
    revision: 1,
  });
describe("Deckhand relationship persistence", () => {
  it.effect(
    "renames persist, stale clients fail, and a workspace cannot be rebound to a new host or generation",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        const store = yield* Relationships.Relationships;
        const original = workspace();
        yield* store.putWorkspace(original, null);
        yield* store.putWorkspace({ ...original, name: "Renamed", revision: 2 }, 1);
        assert.equal((yield* store.workspace(original.id)).name, "Renamed");
        const stale = yield* store
          .putWorkspace({ ...original, name: "Stale edit", revision: 2 }, 1)
          .pipe(Effect.flip);
        assert.equal(stale.reason, "stale");
        const rebound = yield* store
          .putWorkspace({ ...workspace("workspace", "other-host", 2), revision: 3 }, 2)
          .pipe(Effect.flip);
        assert.equal(rebound.reason, "wrong_context");
        assert.equal((yield* store.workspace(original.id)).generation, 1);
      }).pipe(Effect.provide(TestLayer)),
  );
  it.effect(
    "recreated filenames acquire new bindings; old checkouts cannot attach to their replacement",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        const store = yield* Relationships.Relationships;
        const old = workspace("old");
        yield* store.putWorkspace(old, null);
        yield* store.putCheckout(checkout("old-checkout", "old"), null);
        yield* store.putWorkspace({ ...old, state: "missing", revision: 2 }, 1);
        yield* store.putWorkspace(workspace("new", "local", 2), null);
        const wrong = yield* store
          .putCheckout(checkout("reused", "new", "local", 1), null)
          .pipe(Effect.flip);
        assert.equal(wrong.reason, "wrong_context");
        assert.equal((yield* store.checkout("old-checkout")).workspaceId, "old");
        assert.equal((yield* store.workspace("new")).generation, 2);
      }).pipe(Effect.provide(TestLayer)),
  );
  it.effect(
    "explicit cross-workspace feature links retain one primary checkout and reject another host",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        const store = yield* Relationships.Relationships;
        const sql = yield* SqlClient.SqlClient;
        yield* store.putWorkspace(workspace(), null);
        yield* store.putWorkspace({ ...workspace("backend"), ownerId: "backend.toml" }, null);
        yield* store.putWorkspace(workspace("remote", "other-host"), null);
        yield* store.putFeature(feature(), null);
        yield* store.putCheckout(checkout(), null);
        yield* store.putCheckout(checkout("api", "backend"), null);
        yield* store.putCheckout(checkout("elsewhere", "remote", "other-host"), null);
        yield* store.linkCheckout("feature", "checkout", true);
        yield* store.linkCheckout("feature", "api", true);
        const links = yield* sql<{
          checkout_id: string;
          is_primary: number;
        }>`SELECT checkout_id, is_primary FROM deckhand_feature_checkouts ORDER BY checkout_id`;
        assert.deepEqual(
          [...links],
          [
            { checkout_id: "api", is_primary: 1 },
            { checkout_id: "checkout", is_primary: 0 },
          ],
        );
        const wrong = yield* store.linkCheckout("feature", "elsewhere", true).pipe(Effect.flip);
        assert.equal(wrong.reason, "wrong_context");
        const preserved = yield* sql<{
          checkout_id: string;
        }>`SELECT checkout_id FROM deckhand_feature_checkouts WHERE is_primary = 1`;
        assert.equal(preserved[0]?.checkout_id, "api");
      }).pipe(Effect.provide(TestLayer)),
  );
});
describe("Deckhand schema migration", () => {
  it.effect(
    "is replayable, preserves existing tables, protects captured provenance, and refuses a newer store",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE upstream_history(id TEXT PRIMARY KEY, transcript TEXT NOT NULL)`;
        yield* sql`INSERT INTO upstream_history VALUES ('thread', 'existing conversation')`;
        yield* Migrations.migrate;
        yield* sql`INSERT INTO deckhand_artifacts VALUES ('video', 'local', 'recording', 'recording-1', '{}')`;
        yield* sql`INSERT INTO deckhand_evidence_manifests VALUES ('manifest', 'video', '{"commit":"a"}', 'hash', 'captured')`;
        const immutable =
          yield* sql`UPDATE deckhand_evidence_manifests SET record_json = '{"commit":"b"}' WHERE id = 'manifest'`.pipe(
            Effect.exit,
          );
        assert.equal(immutable._tag, "Failure");
        yield* Migrations.migrate;
        const rows = yield* sql<{ transcript: string }>`SELECT transcript FROM upstream_history`;
        assert.equal(rows[0]?.transcript, "existing conversation");
        yield* sql`INSERT INTO deckhand_schema VALUES (2)`;
        const newer = yield* Migrations.migrate.pipe(Effect.flip);
        assert.equal(newer._tag, "DeckhandStoreVersionError");
        const provenance = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_evidence_manifests`;
        assert.equal(provenance[0]?.record_json, '{"commit":"a"}');
      }).pipe(Effect.provide(SqlLayer)),
  );
});
