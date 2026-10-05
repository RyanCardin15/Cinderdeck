import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Base from "@t3tools/contracts/deckhand";
import * as ExternalContracts from "@t3tools/contracts/deckhand/externalSessionsRpc";
import {
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Relationships from "./Relationships.ts";
import * as Hub from "./IntegrationHub.ts";
import * as External from "./ExternalSessions.ts";
import * as Managed from "./ManagedSessions.ts";
const laneID = (index: number) => `lane-${String(index).padStart(4, "0")}`;
const decodeWorkspaces = Schema.decodeUnknownEffect(Schema.Array(Base.WorkspaceBinding));
const decodeCheckouts = Schema.decodeUnknownEffect(Schema.Array(Base.CheckoutBinding));
const decodeFeatures = Schema.decodeUnknownEffect(Schema.Array(Base.Feature));
const decodeSessions = Schema.decodeUnknownEffect(Schema.Array(Base.SessionBinding));
const decodeExternal = Schema.decodeUnknownEffect(
  Schema.Array(ExternalContracts.ExternalSessionRecord),
);
const encodeWorkspaces = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Base.WorkspaceBinding)),
);
const encodeCheckouts = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Base.CheckoutBinding)),
);
const encodeFeatures = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Base.Feature)));
const encodeSessions = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Base.SessionBinding)),
);
const encodeExternal = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(ExternalContracts.ExternalSessionRecord)),
);
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY, deleted_at TEXT
  )`;
  const workspaces = yield* decodeWorkspaces(
    Array.from({ length: 100 }, (_, index) => ({
      id: `workspace-${index}`,
      environmentId: "scale-installation",
      backend: "cinderdeck",
      ownerId: `primary-${index}`,
      generation: 1,
      revision: 1,
      name: `Workspace ${index}`,
      state: "active",
    })),
  );
  const checkouts = yield* decodeCheckouts(
    Array.from({ length: 500 }, (_, index) => ({
      id: `checkout-${index}`,
      workspaceId: `workspace-${Math.floor(index / 5)}`,
      workspaceGeneration: 1,
      nativeGeneration: 7,
      environmentId: "scale-installation",
      backend: "cinderdeck",
      kind: "lane",
      laneId: laneID(index),
      state: "ready",
      repositories: [
        {
          physicalId: `physical-${index}`,
          repositoryPhysicalId: `repo-${index}`,
          root: `/fixture/${index}`,
          commonDirectory: `/fixture/git-${index}`,
          gitDirectory: `/fixture/git-${index}`,
          branch: `branch-${index}`,
          commit: null,
          remotes: [],
        },
      ],
      revision: 1,
    })),
  );
  const features = yield* decodeFeatures(
    Array.from({ length: 500 }, (_, index) => ({
      id: `feature-${index}`,
      workspaceId: `workspace-${Math.floor(index / 5)}`,
      title: `Feature ${index}`,
      objective: `Objective ${index}`,
      status: "active",
      revision: 1,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    })),
  );
  const sessions = yield* decodeSessions(
    Array.from({ length: 3000 }, (_, index) => {
      const lane = Math.floor(index / 6);
      return {
        id: `session-${index}`,
        threadId: `thread-${index}`,
        providerSessionId: null,
        providerInstanceId: "scale-codex",
        featureId: `feature-${lane}`,
        checkoutId: `checkout-${lane}`,
        repositoryScope: [`physical-${lane}`],
        role: "writer",
        desiredAccess: "write",
        execution: "queued",
        connection: "unavailable",
        lastSequence: 0,
        capabilities: {
          nativeResume: true,
          interrupt: false,
          steering: false,
          approvals: false,
          questions: false,
          enforcedReadOnly: false,
          imageInput: false,
          videoInput: false,
          managed: true,
        },
      };
    }),
  );
  const external = yield* decodeExternal(
    Array.from({ length: 500 }, (_, index) => ({
      id: `external:${index.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`,
      installationID: "scale-installation",
      workspaceID: laneID(index),
      generation: 7,
      featureId: `feature-${index}`,
      checkoutId: `checkout-${index}`,
      providerName: "Reported provider",
      providerSessionId: `reported-${index}`,
      title: `External ${index}`,
      role: "observer",
      repositoryScope: [`physical-${index}`],
      reportedExecution: "working",
      reportedCapabilities: [],
      source: "registrant_reported",
      lastSequence: 0,
      registeredAt: "1970-01-01T00:00:00.000Z",
      lastSeenAt: "1970-01-01T00:00:00.000Z",
      expiresAt: "1970-01-01T00:02:00.000Z",
      archivedAt: index % 2 ? "1970-01-01T00:00:00.000Z" : null,
    })),
  );
  const w = yield* encodeWorkspaces(workspaces),
    c = yield* encodeCheckouts(checkouts),
    f = yield* encodeFeatures(features),
    s = yield* encodeSessions(sessions),
    e = yield* encodeExternal(external);
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO deckhand_workspaces(id,environment_id,backend,owner_id,generation,revision,record_json) SELECT json_extract(value,'$.id'),json_extract(value,'$.environmentId'),json_extract(value,'$.backend'),json_extract(value,'$.ownerId'),1,1,value FROM json_each(${w})`;
      yield* sql`INSERT INTO deckhand_checkouts(id,workspace_id,revision,record_json) SELECT json_extract(value,'$.id'),json_extract(value,'$.workspaceId'),1,value FROM json_each(${c})`;
      yield* sql`INSERT INTO deckhand_features(id,workspace_id,revision,record_json) SELECT json_extract(value,'$.id'),json_extract(value,'$.workspaceId'),1,value FROM json_each(${f})`;
      yield* sql`INSERT INTO deckhand_feature_checkouts(feature_id,checkout_id,is_primary) SELECT json_extract(value,'$.featureId'),json_extract(value,'$.checkoutId'),1 FROM json_each(${e})`;
      yield* sql`INSERT INTO deckhand_sessions(id,thread_id,feature_id,checkout_id,record_json) SELECT json_extract(value,'$.id'),json_extract(value,'$.threadId'),json_extract(value,'$.featureId'),json_extract(value,'$.checkoutId'),value FROM json_each(${s})`;
      yield* sql`INSERT INTO deckhand_external_sessions(id,actor_id,operation_key,argument_hash,feature_id,checkout_id,provider_name,provider_session_id,last_sequence,expires_at,record_json) SELECT json_extract(value,'$.id'),'actor-' || json_extract(value,'$.featureId'),'register-' || json_extract(value,'$.id'),'fixture',json_extract(value,'$.featureId'),json_extract(value,'$.checkoutId'),json_extract(value,'$.providerName'),json_extract(value,'$.providerSessionId'),0,120000,value FROM json_each(${e})`;
    }),
  );
});
const page = (offset: number, length = 100) => ({
  installationID: "scale-installation",
  contexts: Array.from({ length }, (_, index) => ({
    workspaceID: laneID(offset + index),
    generation: 7,
  })),
});
const harness = (options: { startsConnecting?: boolean } = {}) => {
  const count = { watermarks: 0, shells: 0, records: 0, nativeResources: 0, eventStreams: 0 };
  let sequence = 0;
  let nativeState: "connecting" | "connected" = options.startsConnecting
    ? "connecting"
    : "connected";
  const sql = NodeSqliteClient.layer({ filename: ":memory:" });
  const base = Relationships.layer.pipe(Layer.provideMerge(sql));
  const native = Layer.mock(Hub.IntegrationHub)({
    subscribe: () =>
      options.startsConnecting
        ? Stream.fromIterable(["connecting", "connected"] as const).pipe(
            Stream.tap((state) =>
              Effect.sync(() => {
                nativeState = state;
              }),
            ),
            Stream.map((state) => ({
              state,
              hello: null,
              observedAt: null,
              error: null,
              resources: [],
              activity: [],
              total: 500,
              nextOffset: 1,
            })),
          )
        : Stream.empty,
    currentResources: (workspaceIDs) =>
      Effect.sync(() => {
        count.nativeResources++;
        assert.isAtMost(workspaceIDs.length, 100);
        return {
          state: nativeState,
          hello: {
            protocolVersion: 1,
            installationID: "scale-installation",
            executionHostID: "fixture",
            channel: "development",
            runtimeEpoch: "fixture",
            capabilities: ["projection.snapshot"],
            maximumFrameBytes: 65536,
            maximumPageSize: 100,
            maximumWaitMs: 30000,
          },
          resources: workspaceIDs.map((workspaceID) => ({
            workspaceID,
            generation: 7,
            available: true,
            revision: "fixture",
          })),
        };
      }),
  });
  const external = External.layer.pipe(Layer.provide(native), Layer.provideMerge(base));
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadShell: (threadId) =>
      Effect.sync(() => {
        count.shells++;
        return {
          id: threadId,
          providerInstanceId: ProviderInstanceId.make("scale-codex"),
          status: sequence ? "completed" : "running",
          activityRunStatus: null,
          activeProviderThreadId: null,
          pendingRuntimeRequest: null,
          archivedAt: null,
          deletedAt: null,
        } as OrchestrationV2ThreadShell;
      }),
    getThreadRecords: ((
      threadId: ThreadId,
      fields: ReadonlyArray<ProjectionStore.ProjectionRecordField>,
    ) =>
      Effect.sync(() => {
        count.records++;
        assert.deepEqual(fields, ["providerThreads", "providerSessions"]);
        assert.match(threadId, /^thread-/);
        return { thread: {}, providerThreads: [], providerSessions: [] };
      })) as ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"],
  });
  const events = Layer.mock(EventSink.EventSinkV2)({
    latestSequence: () =>
      Effect.sync(() => {
        count.watermarks++;
        return sequence;
      }),
    stream: (request) => {
      count.eventStreams++;
      if (options.startsConnecting) return Stream.empty;
      assert.equal(request?.afterSequence, 0);
      return Stream.fromIterable(["unrelated.output", "run.updated"]).pipe(
        Stream.map(
          (type) =>
            ({ sequence: 1, commandId: null, event: { type } }) as OrchestrationV2StoredEvent,
        ),
        Stream.tap((stored) =>
          Effect.sync(() => {
            if (stored.event.type === "run.updated") sequence = 1;
          }),
        ),
      );
    },
  });
  return {
    count,
    layer: Managed.layer.pipe(
      Layer.provide(projections),
      Layer.provide(events),
      Layer.provideMerge(external),
    ),
  };
};
describe("bounded context scalability", () => {
  it.effect(
    "recovers initial cached native unavailability through the consumed shared catalog stream",
    () => {
      const fixture = harness({ startsConnecting: true });
      return Effect.gen(function* () {
        yield* seed;
        const service = yield* Managed.ManagedSessions;
        const updates = yield* service.subscribeContexts(page(0)).pipe(
          Stream.takeUntil((rows) =>
            rows.every((row) => row.externalSessions?.unavailable === false),
          ),
          Stream.runCollect,
        );
        assert.isAtLeast(updates.length, 2);
        assert.isTrue(updates[0]![0]!.externalSessions!.unavailable);
        const connected = updates.at(-1)!;
        assert.equal(connected.length, 100);
        assert.isFalse(connected[0]!.externalSessions!.unavailable);
        assert.equal(connected[0]!.externalSessions!.activeCount, 1);
        assert.equal(connected[0]!.total, 6);
        assert.equal(connected[0]!.sessions.length, 4);
        assert.equal(fixture.count.nativeResources, updates.length);
        assert.equal(fixture.count.shells, updates.length * 400);
        assert.equal(fixture.count.records, updates.length * 400);
      }).pipe(Effect.provide(fixture.layer));
    },
  );
  it.effect(
    "pages 100 workspaces / 500 lanes / 3000 managed sessions with exact counts and at most 4 canonical summaries per context",
    () => {
      const fixture = harness();
      return Effect.gen(function* () {
        yield* seed;
        const service = yield* Managed.ManagedSessions;
        const seen = new Set<string>();
        for (let offset = 0; offset < 500; offset += 100) {
          const before = { ...fixture.count };
          const rows = yield* service.contexts(page(offset));
          assert.equal(rows.length, 100);
          assert.equal(fixture.count.watermarks - before.watermarks, 1);
          assert.equal(fixture.count.shells - before.shells, 400);
          assert.equal(fixture.count.records - before.records, 400);
          assert.equal(fixture.count.nativeResources - before.nativeResources, 1);
          for (const row of rows) {
            seen.add(row.workspaceID);
            assert.equal(row.total, 6);
            assert.equal(row.sessions.length, 4);
            assert.equal(row.sessions[0]?.binding.execution, "working");
            assert.equal(row.sessions[0]?.source, "current");
            const lane = Number(row.workspaceID.slice(5));
            assert.equal(row.externalSessions?.activeCount, lane % 2 ? 0 : 1);
            assert.isFalse(row.externalSessions!.unavailable);
            assert.equal(row.sessions[0]?.binding.id, `session-${lane * 6 + 5}`);
          }
        }
        assert.equal(seen.size, 500);
        assert.equal(fixture.count.eventStreams, 0);
        const reads = fixture.count.watermarks;
        assert.deepEqual(yield* service.contexts(page(0, 0)), []);
        assert.equal(
          (yield* service.contexts(page(0, 101)).pipe(Effect.flip)).reason,
          "invalid_request",
        );
        assert.equal(fixture.count.watermarks, reads + 1);
        const replaced = yield* service.contexts({
          installationID: "scale-installation",
          contexts: [{ workspaceID: laneID(0), generation: 8 }],
        });
        assert.equal(replaced[0]?.total, 0);
        assert.isTrue(replaced[0]!.externalSessions!.unavailable);
      }).pipe(Effect.provide(fixture.layer));
    },
  );
  it.effect("keeps context stream updates page-bounded and filters unrelated events", () => {
    const fixture = harness();
    return Effect.gen(function* () {
      yield* seed;
      const service = yield* Managed.ManagedSessions;
      const updates = yield* service
        .subscribeContexts(page(0))
        .pipe(Stream.take(2), Stream.runCollect);
      assert.equal(updates.length, 2);
      assert.equal(fixture.count.watermarks, 3);
      assert.equal(fixture.count.shells, 800);
      assert.equal(fixture.count.records, 800);
      assert.equal(fixture.count.nativeResources, 2);
      assert.equal(fixture.count.eventStreams, 1);
      assert.equal(updates[0]?.length, 100);
      assert.equal(updates[1]?.length, 100);
      assert.equal(updates[0]?.[0]?.sessions[0]?.binding.execution, "working");
      assert.equal(updates[1]?.[0]?.sessions[0]?.binding.execution, "finished_turn");
    }).pipe(Effect.provide(fixture.layer));
  });
});
