import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Contracts from "@t3tools/contracts/deckhand";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
const decodeSession = Schema.decodeUnknownSync(Contracts.SessionBinding);
const session = (id = "session", threadId = "thread") =>
  decodeSession({
    id,
    threadId,
    providerSessionId: null,
    providerInstanceId: "codex-local",
    featureId: "feature",
    checkoutId: "checkout",
    repositoryScope: ["physical-checkout"],
    role: "writer",
    desiredAccess: "write",
    execution: "starting",
    connection: "connected",
    lastSequence: 0,
    capabilities: {
      nativeResume: true,
      interrupt: true,
      steering: true,
      approvals: true,
      questions: true,
      enforcedReadOnly: false,
      imageInput: true,
      videoInput: false,
      managed: true,
    },
  });
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
    nativeGeneration: generation,
    environmentId,
    backend: "cinderdeck",
    kind: "lane",
    laneId: id,
    state: "ready",
    repositories: [
      {
        physicalId: `physical-${id}`,
        repositoryPhysicalId: "shared-repository",
        root: `/fixture/${id}`,
        commonDirectory: "/fixture/.git",
        gitDirectory: `/fixture/.git/worktrees/${id}`,
        branch: id,
        commit: "abc",
        remotes: [],
      },
    ],
    revision: 1,
  });
describe("Deckhand relationship persistence", () => {
  it.effect("reopens durable session bindings without copying upstream transcripts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-sessions-" });
      const storeLayer = () =>
        Relationships.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: `${root}/state.sqlite` })),
        );
      yield* Effect.gen(function* () {
        yield* Migrations.migrate;
        const store = yield* Relationships.Relationships;
        yield* store.putWorkspace(workspace(), null);
        yield* store.putFeature(feature(), null);
        yield* store.putCheckout(checkout(), null);
        yield* store.linkCheckout("feature", "checkout", true);
        yield* store.putSession(session(), null);
        yield* store.putSession({ ...session(), execution: "finished_turn", lastSequence: 12 }, 0);
      }).pipe(Effect.provide(storeLayer()), Effect.scoped);
      yield* Effect.gen(function* () {
        const store = yield* Relationships.Relationships;
        yield* Migrations.migrate;
        const restored = yield* store.session("session");
        assert.equal(restored.threadId, session().threadId);
        assert.equal(restored.execution, "finished_turn");
        assert.equal(restored.lastSequence, 12);
        assert.equal((yield* store.feature("feature")).status, "active");
        assert.deepEqual(
          (yield* store.sessions({ featureId: "feature", limit: 10 })).map((item) => item.id),
          ["session"],
        );
      }).pipe(Effect.provide(storeLayer()), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "preserves thread identity and sequence across multiple sessions and missing lanes",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        const store = yield* Relationships.Relationships;
        yield* store.putWorkspace(workspace(), null);
        yield* store.putFeature(feature(), null);
        yield* store.putCheckout(checkout(), null);
        yield* store.linkCheckout("feature", "checkout", true);
        const first = session("a", "thread-a");
        const second = session("b", "thread-b");
        yield* store.putSession(first, null);
        yield* store.putSession(second, null);
        yield* store.putSession({ ...first, execution: "working", lastSequence: 7 }, 0);
        const stale = yield* store
          .putSession({ ...first, execution: "idle", lastSequence: 4 }, 0)
          .pipe(Effect.flip);
        assert.equal(stale.reason, "stale");
        const replay = yield* store
          .putSession({ ...first, execution: "idle", lastSequence: 7 }, 7)
          .pipe(Effect.flip);
        assert.equal(replay.reason, "stale");
        yield* store.putCheckout({ ...checkout(), state: "unavailable", revision: 2 }, 1);
        yield* store.putSession(
          { ...first, execution: "unknown", connection: "unavailable", lastSequence: 8 },
          7,
        );
        assert.equal((yield* store.session("a")).threadId, first.threadId);
        assert.equal((yield* store.session("a")).execution, "unknown");
        assert.equal((yield* store.session("b")).execution, "starting");
        const page = yield* store.sessions({ featureId: "feature", limit: 1 });
        assert.deepEqual(
          page.map((item) => item.id),
          ["a"],
        );
        if (!page[0]) return yield* Effect.die("Expected a session page");
        const next = yield* store.sessions({
          featureId: "feature",
          afterId: page[0].id,
          limit: 1,
        });
        assert.deepEqual(
          next.map((item) => item.id),
          ["b"],
        );
        const invalid = yield* store
          .sessions({ featureId: "feature", limit: 101 })
          .pipe(Effect.flip);
        assert.equal(invalid.reason, "wrong_context");
        const launch = yield* store.putSession(session("c", "thread-c"), null).pipe(Effect.flip);
        assert.equal(launch.reason, "wrong_context");
      }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("rejects duplicate native threads, retargeting and external managed claims", () =>
    Effect.gen(function* () {
      yield* Migrations.migrate;
      const store = yield* Relationships.Relationships;
      yield* store.putWorkspace(workspace(), null);
      yield* store.putFeature(feature(), null);
      yield* store.putCheckout(checkout(), null);
      const unlinked = yield* store.putSession(session(), null).pipe(Effect.flip);
      assert.equal(unlinked.reason, "wrong_context");
      yield* store.linkCheckout("feature", "checkout", true);
      const original = session();
      yield* store.putSession(original, null);
      const duplicate = yield* store.putSession(session("other"), null).pipe(Effect.flip);
      assert.equal(duplicate.reason, "stale");
      const retarget = yield* store
        .putSession(
          { ...original, threadId: session("x", "different").threadId, lastSequence: 1 },
          0,
        )
        .pipe(Effect.flip);
      assert.equal(retarget.reason, "wrong_context");
      const external = yield* store
        .putSession(
          {
            ...session("external", "external-thread"),
            capabilities: { ...original.capabilities, managed: false },
          },
          null,
        )
        .pipe(Effect.flip);
      assert.equal(external.reason, "wrong_context");
      assert.equal((yield* store.session(original.id)).threadId, original.threadId);
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect("requires enforced read-only mode or isolation for managed reviewers", () =>
    Effect.gen(function* () {
      yield* Migrations.migrate;
      const store = yield* Relationships.Relationships;
      yield* store.putWorkspace(workspace(), null);
      yield* store.putFeature(feature(), null);
      yield* store.putCheckout(checkout(), null);
      yield* store.linkCheckout("feature", "checkout", true);
      const reviewer = { ...session(), role: "reviewer" as const };
      const writer = yield* store.putSession(reviewer, null).pipe(Effect.flip);
      assert.equal(writer.reason, "wrong_context");
      const advisory = yield* store
        .putSession({ ...reviewer, desiredAccess: "read_only" }, null)
        .pipe(Effect.flip);
      assert.equal(advisory.reason, "wrong_context");
      const sameCheckout = yield* store
        .putSession({ ...reviewer, desiredAccess: "isolated" }, null)
        .pipe(Effect.flip);
      assert.equal(sameCheckout.reason, "wrong_context");
      const alias = { ...checkout("review-alias"), repositories: checkout().repositories };
      yield* store.putCheckout(alias, null);
      yield* store.linkCheckout("feature", "review-alias", false);
      const samePhysical = yield* store
        .putSession({ ...reviewer, checkoutId: alias.id, desiredAccess: "isolated" }, null)
        .pipe(Effect.flip);
      assert.equal(samePhysical.reason, "wrong_context");
      const isolated = checkout("review-isolated");
      yield* store.putCheckout(isolated, null);
      yield* store.linkCheckout("feature", "review-isolated", false);
      yield* store.putSession(
        {
          ...session("isolated-review", "isolated-thread"),
          role: "reviewer",
          checkoutId: isolated.id,
          repositoryScope: isolated.repositories.map((repo) => repo.physicalId),
          desiredAccess: "isolated",
        },
        null,
      );
      yield* store.putSession(
        {
          ...reviewer,
          desiredAccess: "read_only",
          capabilities: { ...reviewer.capabilities, enforcedReadOnly: true },
        },
        null,
      );
      const downgrade = yield* store
        .putSession({ ...reviewer, desiredAccess: "read_only", lastSequence: 1 }, 0)
        .pipe(Effect.flip);
      assert.equal(downgrade.reason, "wrong_context");
      assert.equal((yield* store.session("session")).lastSequence, 0);
    }).pipe(Effect.provide(TestLayer)),
  );
  it.effect(
    "allows moved roots and revision changes but refuses physical checkout substitution",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        const store = yield* Relationships.Relationships;
        yield* store.putWorkspace(workspace(), null);
        const original = checkout();
        yield* store.putCheckout(original, null);
        const moved = {
          ...original,
          revision: 2,
          repositories: original.repositories.map((repo) => ({
            ...repo,
            root: "/fixture/moved",
            branch: "renamed",
            commit: "def",
          })),
        };
        yield* store.putCheckout(moved, 1);
        const substituted = yield* store
          .putCheckout(
            { ...moved, revision: 3, repositories: checkout("replacement").repositories },
            2,
          )
          .pipe(Effect.flip);
        assert.equal(substituted.reason, "wrong_context");
        assert.equal((yield* store.checkout("checkout")).repositories[0]?.root, "/fixture/moved");
        const erased = yield* store
          .putCheckout({ ...moved, revision: 3, state: "unavailable", repositories: [] }, 2)
          .pipe(Effect.flip);
        assert.equal(erased.reason, "wrong_context");
        const empty = yield* store
          .putCheckout({ ...checkout("empty"), repositories: [] }, null)
          .pipe(Effect.flip);
        assert.equal(empty.reason, "wrong_context");
      }).pipe(Effect.provide(TestLayer)),
  );
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
        // A v1 store has the same relationship tables but no feature paging index.
        yield* sql`DROP INDEX deckhand_sessions_feature_page`;
        yield* sql`DROP TABLE deckhand_integrations`;
        yield* sql`DROP TABLE deckhand_writer_scope`;
        yield* sql`DROP TABLE deckhand_writer_requests`;
        yield* sql`DROP TABLE deckhand_native_writer_intents`;
        yield* sql`DROP TABLE deckhand_managed_launches`;
        yield* sql`DROP TABLE deckhand_managed_creations`;
        yield* sql`DELETE FROM deckhand_schema WHERE version >= 2`;
        yield* sql`INSERT INTO deckhand_schema VALUES (1)`;
        yield* Migrations.migrate;
        const indexes = yield* sql<{ name: string }>`PRAGMA index_list(deckhand_sessions)`;
        assert.isTrue(indexes.some((row) => row.name === "deckhand_sessions_feature_page"));
        assert.equal(
          (yield* sql<{ transcript: string }>`SELECT transcript FROM upstream_history`)[0]
            ?.transcript,
          "existing conversation",
        );
        yield* sql`INSERT INTO deckhand_schema VALUES (8)`;
        const newer = yield* Migrations.migrate.pipe(Effect.flip);
        assert.equal(newer._tag, "DeckhandStoreVersionError");
        const provenance = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_evidence_manifests`;
        assert.equal(provenance[0]?.record_json, '{"commit":"a"}');
      }).pipe(Effect.provide(SqlLayer)),
  );
});
