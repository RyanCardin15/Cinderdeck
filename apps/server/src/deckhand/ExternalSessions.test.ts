import * as Stream from "effect/Stream";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Base from "@t3tools/contracts/deckhand";
import * as C from "@t3tools/contracts/deckhand/externalSessionsRpc";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Hub from "./IntegrationHub.ts";
import * as Relationships from "./Relationships.ts";
import * as Migrations from "./Migrations.ts";
import * as External from "./ExternalSessions.ts";
const input = Schema.decodeUnknownSync(C.ExternalSessionRegister)({
  installationID: "installation",
  workspaceID: "native-lane",
  generation: 3,
  featureId: "feature",
  checkoutId: "checkout",
  operationKey: "register-1",
  providerName: "Claude",
  providerSessionId: "reported-session",
  title: "External review",
  role: "reviewer",
  repositoryScope: ["physical"],
  reportedExecution: "working",
  reportedCapabilities: ["read_only", "resume"],
});
const state = () => ({ installationID: "installation", generation: 3, available: true });
const layer = (native: ReturnType<typeof state>, filename = ":memory:") => {
  const sql = NodeSqliteClient.layer({ filename });
  return External.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        sql,
        Relationships.layer.pipe(Layer.provide(sql)),
        Layer.mock(Hub.IntegrationHub)({
          subscribe: () => Stream.empty,
          currentResources: () =>
            Effect.succeed({
              state: "connected" as const,
              hello: {
                protocolVersion: 1,
                installationID: native.installationID,
                executionHostID: "host",
                channel: "development",
                runtimeEpoch: "epoch",
                capabilities: ["projection.snapshot"],
                maximumFrameBytes: 65536,
                maximumPageSize: 100,
                maximumWaitMs: 30000,
              },
              resources: [
                {
                  workspaceID: "native-lane",
                  generation: native.generation,
                  available: native.available,
                  revision: "revision",
                },
              ],
            }),
          resource: () =>
            Effect.succeed({
              hello: {
                protocolVersion: 1,
                installationID: native.installationID,
                executionHostID: "host",
                channel: "development",
                runtimeEpoch: "epoch",
                capabilities: ["projection.snapshot"],
                maximumFrameBytes: 65536,
                maximumPageSize: 100,
                maximumWaitMs: 30000,
              },
              resource: {
                workspaceID: "native-lane",
                generation: native.generation,
                available: native.available,
                revision: "revision",
              },
            }),
        }),
      ),
    ),
  );
};
const decodeWorkspace = Schema.decodeUnknownEffect(Base.WorkspaceBinding);
const decodeCheckout = Schema.decodeUnknownEffect(Base.CheckoutBinding);
const decodeFeature = Schema.decodeUnknownEffect(Base.Feature);
const seed = Effect.gen(function* () {
  const r = yield* Relationships.Relationships;
  yield* r.putWorkspace(
    yield* decodeWorkspace({
      id: "workspace",
      environmentId: "installation",
      backend: "cinderdeck",
      ownerId: "primary",
      generation: 1,
      revision: 1,
      name: "Workspace",
      state: "active",
    }),
    null,
  );
  yield* r.putCheckout(
    yield* decodeCheckout({
      id: "checkout",
      workspaceId: "workspace",
      workspaceGeneration: 1,
      nativeGeneration: 3,
      environmentId: "installation",
      backend: "cinderdeck",
      kind: "lane",
      laneId: "native-lane",
      state: "ready",
      repositories: [
        {
          physicalId: "physical",
          repositoryPhysicalId: "repo",
          root: "/fixture/lane",
          commonDirectory: "/fixture/.git",
          gitDirectory: "/fixture/.git/worktrees/lane",
          branch: "verify",
          commit: "abc",
          remotes: [],
        },
      ],
      revision: 1,
    }),
    null,
  );
  yield* r.putFeature(
    yield* decodeFeature({
      id: "feature",
      workspaceId: "workspace",
      title: "Feature",
      objective: "Review",
      status: "active",
      revision: 1,
      createdAt: "2026-10-03T00:00:00Z",
      updatedAt: "2026-10-03T00:00:00Z",
    }),
    null,
  );
  yield* r.linkCheckout("feature", "checkout", true);
});
const listInput: C.ExternalSessionList = {
  installationID: "installation",
  workspaceID: "native-lane",
  generation: 3,
  limit: 20,
};
const heartbeat = (
  id: C.ExternalSessionView["id"],
  expectedSequence = 0,
  sequence = 1,
): C.ExternalSessionHeartbeat => ({
  installationID: input.installationID,
  workspaceID: input.workspaceID,
  generation: input.generation,
  featureId: input.featureId,
  checkoutId: input.checkoutId,
  id,
  expectedSequence,
  sequence,
  reportedExecution: "idle",
});

describe("ExternalSessions", () => {
  it.effect("keeps external registration separate and grants no managed thread or controls", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* External.ExternalSessions;
      const created = yield* service.register("mcp:actor", input);
      assert.match(created.id, /^external:/);
      assert.equal(created.source, "registrant_reported");
      assert.equal(created.reportedExecution, "working");
      assert.deepEqual(created.control, {
        transcript: false,
        interrupt: false,
        resume: false,
        approvals: false,
        writerReservation: false,
      });
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT id FROM deckhand_sessions`).length, 0);
      assert.equal((yield* sql`SELECT id FROM deckhand_writer_requests`).length, 0);
      assert.deepEqual(
        (yield* service.list(listInput)).map((row) => row.id),
        [created.id],
      );
      assert.equal((yield* service.register("mcp:actor", input)).id, created.id);
      assert.equal(
        (yield* service.register("mcp:actor", { ...input, title: "Retargeted" }).pipe(Effect.flip))
          .reason,
        "stale",
      );
    }).pipe(Effect.provide(layer(state()))),
  );

  it.effect(
    "requires actor ownership and compare-and-swap sequence, with exact replay but no lease renewal",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* External.ExternalSessions;
        const created = yield* service.register("owner", input);
        assert.equal(
          (yield* service.heartbeat("other", heartbeat(created.id)).pipe(Effect.flip)).reason,
          "unauthorized",
        );
        const updated = yield* service.heartbeat("owner", heartbeat(created.id));
        assert.equal(updated.lastSequence, 1);
        assert.equal(updated.reportedExecution, "idle");
        yield* TestClock.adjust("30 seconds");
        const replay = yield* service.heartbeat("owner", heartbeat(created.id));
        assert.equal(replay.lastSeenAt, updated.lastSeenAt);
        assert.equal(replay.expiresAt, updated.expiresAt);
        assert.equal(
          (yield* service
            .heartbeat("owner", { ...heartbeat(created.id), reportedExecution: "working" })
            .pipe(Effect.flip)).reason,
          "stale",
        );
        assert.equal(
          (yield* service.heartbeat("owner", heartbeat(created.id, 0, 2)).pipe(Effect.flip)).reason,
          "stale",
        );
      }).pipe(Effect.provide(layer(state()))),
  );

  it.effect(
    "heartbeat expiry changes connection while preserving the last reported execution and active feature",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* External.ExternalSessions;
        const created = yield* service.register("owner", input);
        yield* TestClock.adjust("121 seconds");
        const expired = (yield* service.list(listInput))[0]!;
        assert.equal(expired.connection, "stale");
        assert.equal(expired.reportedExecution, "working");
        assert.equal(
          (yield* (yield* Relationships.Relationships).feature(input.featureId)).status,
          "active",
        );
        const renewed = yield* service.heartbeat("owner", heartbeat(created.id));
        assert.equal(renewed.connection, "connected");
      }).pipe(Effect.provide(layer(state()))),
  );

  it.effect(
    "refuses wrong installation, generation, relation, repository scope and heartbeat retargeting",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* External.ExternalSessions;
        const created = yield* service.register("owner", input);
        for (const changed of [
          { ...input, installationID: "foreign" },
          { ...input, generation: 4 },
          { ...input, workspaceID: "other-context" },
          { ...input, featureId: Base.FeatureId.make("missing") },
          { ...input, repositoryScope: ["foreign-checkout"] },
          { ...input, repositoryScope: ["physical", "physical"] },
        ]) {
          const refused = yield* service.register("owner", changed).pipe(Effect.flip);
          assert.isTrue(["stale", "wrong_context"].includes(refused.reason));
        }
        assert.equal(
          (yield* service
            .heartbeat("owner", {
              ...heartbeat(created.id),
              checkoutId: Base.CheckoutBindingId.make("other"),
            })
            .pipe(Effect.flip)).reason,
          "wrong_context",
        );
        native.generation = 4;
        assert.equal(
          (yield* service.heartbeat("owner", heartbeat(created.id)).pipe(Effect.flip)).reason,
          "stale",
        );
      }).pipe(Effect.provide(layer(native))),
  );

  it.effect(
    "archives and restores owner visibility with CAS, preserving reported execution and heartbeat timestamps",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* External.ExternalSessions;
        const original = yield* service.register("owner", input);
        const visibility = { ...heartbeat(original.id), archived: true };
        const request = {
          installationID: visibility.installationID,
          workspaceID: visibility.workspaceID,
          generation: visibility.generation,
          featureId: visibility.featureId,
          checkoutId: visibility.checkoutId,
          id: visibility.id,
          expectedSequence: 0,
          archived: true,
        };
        assert.equal(
          (yield* service.changeVisibility("foreign", request).pipe(Effect.flip)).reason,
          "unauthorized",
        );
        yield* TestClock.adjust("121 seconds");
        const archived = yield* service.changeVisibility("owner", request);
        assert.equal(archived.reportedExecution, "working");
        assert.equal(archived.lastSeenAt, original.lastSeenAt);
        assert.equal(archived.expiresAt, original.expiresAt);
        assert.equal(archived.connection, "stale");
        assert.equal(
          (yield* service.changeVisibility("owner", request)).archivedAt,
          archived.archivedAt,
        );
        assert.equal((yield* service.list(listInput)).length, 0);
        assert.equal((yield* service.list({ ...listInput, includeArchived: true })).length, 1);
        assert.equal(
          (yield* service.heartbeat("owner", heartbeat(original.id, 1, 2)).pipe(Effect.flip))
            .reason,
          "stale",
        );
        assert.equal(
          (yield* service
            .changeVisibility("owner", { ...request, archived: false })
            .pipe(Effect.flip)).reason,
          "stale",
        );
        const restored = yield* service.changeVisibility("owner", {
          ...request,
          expectedSequence: 1,
          archived: false,
        });
        assert.equal(restored.lastSequence, 2);
        assert.equal(restored.archivedAt, null);
        assert.equal(restored.lastSeenAt, original.lastSeenAt);
        assert.equal((yield* service.list(listInput)).length, 1);
      }).pipe(Effect.provide(layer(state()))),
  );
  it.effect(
    "aggregates exact context counts once without treating expired or archived registrations as completed",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const service = yield* External.ExternalSessions;
        const original = yield* service.register("owner", input);
        const request = {
          installationID: input.installationID,
          contexts: [
            { workspaceID: input.workspaceID, generation: 3 },
            { workspaceID: "other", generation: 4 },
          ],
        };
        const first = yield* service.summaries(request);
        assert.equal(first[0]?.activeCount, 1);
        assert.equal(first[0]?.staleCount, 0);
        assert.equal(first[1]?.activeCount, 0);
        assert.isTrue(first[1]!.unavailable);
        yield* TestClock.adjust("121 seconds");
        assert.equal((yield* service.summaries(request))[0]?.staleCount, 1);
        const h = heartbeat(original.id);
        yield* service.changeVisibility("owner", {
          installationID: h.installationID,
          workspaceID: h.workspaceID,
          generation: h.generation,
          featureId: h.featureId,
          checkoutId: h.checkoutId,
          id: h.id,
          expectedSequence: 0,
          archived: true,
        });
        assert.equal((yield* service.summaries(request))[0]?.activeCount, 0);
        assert.equal(
          (yield* service.summaries({ ...request, installationID: "foreign" }))[0]?.activeCount,
          0,
        );
      }).pipe(Effect.provide(layer(state()))),
  );

  it.effect("reopens reported sessions from disk without a managed transcript", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-external-" });
      const filename = `${dir}/state.sqlite`;
      const created = yield* Effect.gen(function* () {
        yield* seed;
        return yield* (yield* External.ExternalSessions).register("owner", input);
      }).pipe(Effect.provide(layer(state(), filename)), Effect.scoped);
      const restored = yield* Effect.gen(function* () {
        const service = yield* External.ExternalSessions;
        return yield* service.list(listInput);
      }).pipe(Effect.provide(layer(state(), filename)), Effect.scoped);
      assert.equal(restored[0]?.id, created.id);
      assert.equal(restored[0]?.reportedExecution, "working");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("migrates a v11 store without replacing attention or managed-session state", () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE deckhand_external_sessions`;
      yield* sql`DROP TABLE IF EXISTS deckhand_verification_attempts`;
      yield* sql`DELETE FROM deckhand_schema`;
      yield* sql`INSERT INTO deckhand_schema(version) VALUES(11)`;
      yield* Migrations.migrate;
      assert.equal(
        (yield* sql<{
          version: number;
        }>`SELECT version FROM deckhand_schema ORDER BY version DESC LIMIT 1`)[0]?.version,
        Migrations.VERSION,
      );
      assert.equal((yield* sql`SELECT id FROM deckhand_features WHERE id='feature'`).length, 1);
      assert.equal(
        (yield* sql`SELECT name FROM sqlite_master WHERE name='deckhand_attention_dispositions'`)
          .length,
        1,
      );
      assert.equal((yield* sql`SELECT id FROM deckhand_external_sessions`).length, 0);
    }).pipe(Effect.provide(layer(state()))),
  );
});
const native = state();
