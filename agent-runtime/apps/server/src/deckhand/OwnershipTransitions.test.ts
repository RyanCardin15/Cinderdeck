import { assert, describe, it } from "@effect/vitest";
import { OrchestrationV2ThreadShell, ThreadId } from "@cinderdeck/contracts";
import * as B from "@cinderdeck/contracts/deckhand";
import * as C from "@cinderdeck/contracts/deckhand/ownershipRpc";
import * as I from "@cinderdeck/contracts/deckhand/integration";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as ThreadContext from "./ThreadContext.ts";
import * as ManagedSessions from "./ManagedSessions.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Current from "./CurrentCheckout.ts";
import * as Ownership from "./OwnershipTransitions.ts";
import * as Relationships from "./Relationships.ts";
import * as Identity from "./CheckoutIdentity.ts";
import * as Hub from "./IntegrationHub.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
const threadId = ThreadId.make("thread");
const intent: C.OwnershipIntent = {
  operationKey: "adopt-1",
  threadId,
  direction: "adopt",
  installationID: "installation",
  workspaceID: "base",
  generation: 1,
  revision: "revision",
  laneName: "existing",
};
const physical: B.PhysicalCheckout = {
  physicalId: "physical",
  repositoryPhysicalId: "repo",
  root: "/fixture/lane",
  commonDirectory: "/fixture/.git",
  gitDirectory: "/fixture/.git/worktrees/lane",
  branch: "existing",
  commit: "abc",
  remotes: [],
};
const shell = Schema.decodeUnknownEffect(OrchestrationV2ThreadShell)({
  id: threadId,
  projectId: "project",
  title: "Existing conversation",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt", options: [] },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "existing",
  worktreePath: physical.root,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 7,
  visibleItemCount: 7,
  createdAt: DateTime.makeUnsafe("2026-10-04T00:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-04T00:00:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  createdBy: "user",
  creationSource: "web",
});
const hello: I.IntegrationHello = {
  protocolVersion: 1,
  installationID: "installation",
  executionHostID: "host",
  channel: "development",
  runtimeEpoch: "epoch",
  capabilities: ["projection.snapshot", "operations.lane.adopt"],
  maximumFrameBytes: 65536,
  maximumPageSize: 100,
  maximumWaitMs: 30000,
};
const resource = (lane: boolean): I.IntegrationSnapshot["resources"][number] => ({
  workspaceID: lane ? "lane" : "base",
  generation: lane ? 2 : 1,
  revision: "revision",
  available: true,
  workspace: {
    id: lane ? "lane" : "base",
    name: lane ? "Lane" : "Base",
    file: "fixture.toml",
    state: "idle",
    ...(lane
      ? {
          lane: {
            sourceStackID: "base",
            name: "existing",
            createdAt: "now",
            directory: "/fixture",
            ports: {},
            adopted: true,
          },
        }
      : {}),
    definitionChanged: false,
    issues: [],
    services: [],
    repos: [
      {
        id: "web",
        path: lane ? physical.root : "/fixture/main",
        branch: lane ? "existing" : "main",
        dirty: false,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      },
    ],
  },
});
const fixture = () => {
  const state = {
    native: false,
    phase: "running" as I.IntegrationOperationReceipt["state"],
    submits: 0,
    method: "lane.adopt" as I.IntegrationOperationInput["method"],
    replaced: false,
    keptPath: physical.root,
    keptRoot: physical.root,
    keptPathAvailable: true,
    multi: false,
    key: "",
    blocked: false,
    receiptError: null as Rpc.DeckhandRpcError["reason"] | null,
  };
  const receipt = (): I.IntegrationOperationReceipt => ({
    id: "native-receipt",
    operationKey: state.key,
    argumentHash: "a".repeat(64),
    workspaceID: state.method === "lane.adopt" ? "base" : "lane",
    generation: state.method === "lane.adopt" ? 1 : 2,
    method: state.method,
    state: state.phase,
    createdAt: "now",
    updatedAt: "now",
    ...(state.phase === "succeeded"
      ? {
          result:
            state.method === "lane.adopt"
              ? { createdWorkspaceID: "lane" }
              : {
                  released: "lane",
                  report: {
                    removedWorktrees: [],
                    keptWorktrees: [state.keptPath],
                    unpushed: {},
                    ignored: [],
                  },
                },
        }
      : {}),
  });
  const sql = NodeSqliteClient.layer({ filename: ":memory:" });
  const relationships = Relationships.layer.pipe(Layer.provideMerge(sql));
  const current = Current.layer.pipe(Layer.provideMerge(relationships));
  const shared = Layer.mergeAll(
    current,
    sql,
    FileSystem.layerNoop({
      realPath: (path) =>
        path === state.keptPath && path !== physical.root
          ? state.keptPathAvailable
            ? Effect.succeed(state.keptRoot)
            : Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "realPath",
                  pathOrDescriptor: path,
                }),
              )
          : Effect.succeed(path),
    }),
    Layer.mock(Identity.CheckoutIdentity)({
      resolve: (path) =>
        Effect.succeed({
          ...physical,
          physicalId: state.replaced
            ? "replacement"
            : path === physical.root
              ? "physical"
              : "primary",
          root: path,
          gitDirectory: path === physical.root ? physical.gitDirectory : "/fixture/.git",
        }),
    }),
    Layer.mock(Projections.ProjectionStoreV2)({
      getThreadShell: () =>
        Effect.map(shell.pipe(Effect.orDie), (value) =>
          state.blocked ? { ...value, status: "running", activeRunId: null } : value,
        ),
    }),
    Layer.mock(Hub.IntegrationHub)({
      overview: () =>
        Effect.sync(() => ({
          state: "connected" as const,
          hello,
          observedAt: "now",
          error: null,
          resources: [resource(false), ...(state.native ? [resource(true)] : [])],
          activity: [],
          total: state.native ? 2 : 1,
          nextOffset: null,
        })),
      subscribe: () =>
        Stream.make({
          state: "connected" as const,
          hello,
          observedAt: "now",
          error: null,
          resources: [resource(false), ...(state.native ? [resource(true)] : [])],
          selectedResources: state.native ? [resource(true)] : [],
          activity: [],
          total: state.native ? 2 : 1,
          nextOffset: null,
        }),
      resource: (id) =>
        Effect.sync(() => {
          const item = resource(id === "lane");
          return {
            hello,
            resource:
              state.multi && item.workspace
                ? {
                    ...item,
                    workspace: {
                      ...item.workspace,
                      repos: [
                        ...item.workspace.repos,
                        { ...item.workspace.repos[0]!, id: "second" },
                      ],
                    },
                  }
                : item,
          };
        }),
      checkoutContexts: () =>
        Effect.succeed({
          installationID: "installation",
          runtimeEpoch: "epoch",
          contexts: state.native
            ? [
                {
                  workspaceID: "lane",
                  generation: 2,
                  revision: "revision",
                  available: true,
                  repos: ["web"],
                  physicalIDs: [state.replaced ? "replacement" : "physical"],
                },
              ]
            : [],
        }),
      submit: (_actor, input) =>
        Effect.sync(() => {
          state.submits++;
          state.method = input.method;
          state.key = input.operationKey;
          return receipt();
        }),
      operation: () =>
        state.receiptError
          ? Effect.fail(new Rpc.DeckhandRpcError({ reason: state.receiptError }))
          : Effect.sync(receipt),
    }),
  );
  const owned = Ownership.layer.pipe(Layer.provideMerge(shared));
  const layer = ThreadContext.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        owned,
        Layer.mock(ManagedSessions.ManagedSessions)({
          subscribe: () => Stream.make([]),
          subscribeThread: () => Stream.make(null),
        }),
      ),
    ),
  );
  const seed = Effect.gen(function* () {
    yield* shell;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,payload_json TEXT)`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES('thread','{"worktreePath":"/fixture/lane","deletedAt":null}')`;
  });
  return { state, layer, seed };
};
describe("explicit ownership transitions", () => {
  it.effect(
    "durable pending adoption blocks actions, reconciles without resubmission, and release retains original conversation identity",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        const s = yield* Ownership.OwnershipTransitions,
          current = yield* Current.CurrentCheckout,
          r = yield* Relationships.Relationships;
        const view = yield* s.preview("actor", intent);
        assert.deepEqual(view.blockers, []);
        const pending = yield* s.submit("actor", { ...intent, preview: view });
        assert.equal(pending.state, "pending");
        assert.equal(f.state.submits, 1);
        const originalRows = yield* (yield* SqlClient.SqlClient)<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_sessions WHERE thread_id='thread'`;
        const blocked = yield* current.forThread(threadId).pipe(Effect.result);
        assert.equal(blocked._tag, "Failure");
        yield* s.submit("actor", { ...intent, preview: view });
        assert.equal(f.state.submits, 1);
        f.state.phase = "succeeded";
        f.state.native = true;
        const done = yield* s.get("actor", { id: pending.id });
        assert.equal(done.state, "completed");
        const live = yield* current.forThread(threadId);
        assert.equal(live?.checkout.backend, "cinderdeck");
        assert.equal(live?.session.threadId, threadId);
        assert.equal(live?.originCheckout.backend, "standalone");
        assert.isTrue(
          yield* Current.currentFeatureWorkspaceAuthorized(
            live!.session.featureId,
            live!.workspace.id,
          ),
        );
        assert.isFalse(
          yield* Current.currentFeatureWorkspaceAuthorized("unrelated", live!.workspace.id),
        );
        const releaseIntent: C.OwnershipIntent = {
          ...intent,
          operationKey: "release-1",
          direction: "release",
          workspaceID: "lane",
          generation: 2,
        };
        f.state.phase = "running";
        const releaseView = yield* s.preview("actor", releaseIntent);
        const releasing = yield* s.submit("actor", { ...releaseIntent, preview: releaseView });
        f.state.phase = "succeeded";
        f.state.native = false;
        f.state.keptPath = "/tmp/fixture/lane";
        f.state.keptRoot = physical.root;
        const released = yield* s.get("actor", { id: releasing.id });
        assert.equal(released.state, "completed");
        assert.equal((yield* current.forThread(threadId))?.checkout.backend, "standalone");
        const finalRows = yield* (yield* SqlClient.SqlClient)<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_sessions WHERE thread_id='thread'`;
        assert.deepEqual(finalRows, originalRows);
        assert.equal((yield* r.checkout(live!.session.checkoutId)).backend, "standalone");
        assert.equal(f.state.submits, 2);
        assert.equal((yield* s.list("actor", { threadId, offset: 0, limit: 20 })).total, 2);
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect(
    "a consumed conversation context follows adoption and release without resubscription",
    () => {
      const f = fixture();
      return Effect.scoped(
        Effect.gen(function* () {
          yield* f.seed;
          const initial = yield* Deferred.make<void>(),
            connected = yield* Deferred.make<void>(),
            released = yield* Deferred.make<void>();
          const contexts = yield* ThreadContext.ThreadContext;
          let hasConnected = false;
          yield* Effect.forkScoped(
            Stream.runForEach(contexts.subscribe({ threadId }), (view) =>
              Effect.gen(function* () {
                if (view?.native?.workspaceID === "lane") {
                  hasConnected = true;
                  yield* Deferred.succeed(connected, undefined);
                } else if (view === null && hasConnected)
                  yield* Deferred.succeed(released, undefined);
                else if (view === null) yield* Deferred.succeed(initial, undefined);
              }),
            ),
          );
          yield* Deferred.await(initial);
          const service = yield* Ownership.OwnershipTransitions;
          const view = yield* service.preview("actor", intent);
          const pending = yield* service.submit("actor", { ...intent, preview: view });
          f.state.phase = "succeeded";
          f.state.native = true;
          yield* service.get("actor", { id: pending.id });
          yield* Deferred.await(connected);
          const releaseIntent: C.OwnershipIntent = {
            ...intent,
            operationKey: "stream-release",
            direction: "release",
            workspaceID: "lane",
            generation: 2,
          };
          f.state.phase = "running";
          const before = yield* service.preview("actor", releaseIntent);
          const release = yield* service.submit("actor", { ...releaseIntent, preview: before });
          f.state.phase = "succeeded";
          f.state.native = false;
          yield* service.get("actor", { id: release.id });
          yield* Deferred.await(released);
          assert.equal(
            (yield* (yield* Current.CurrentCheckout).forThread(threadId))?.session.threadId,
            threadId,
          );
        }),
      ).pipe(Effect.provide(f.layer));
    },
  );
  it.effect(
    "keeps a succeeded release uncertain for missing or substitute roots, then recovers the same receipt without replay",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        const service = yield* Ownership.OwnershipTransitions;
        const preview = yield* service.preview("actor", intent);
        const adopted = yield* service.submit("actor", { ...intent, preview });
        f.state.phase = "succeeded";
        f.state.native = true;
        yield* service.get("actor", { id: adopted.id });
        const sql = yield* SqlClient.SqlClient;
        const original = yield* sql`SELECT * FROM deckhand_sessions`;
        const releaseIntent: C.OwnershipIntent = {
          ...intent,
          operationKey: "release-proof",
          direction: "release",
          workspaceID: "lane",
          generation: 2,
        };
        f.state.phase = "running";
        const view = yield* service.preview("actor", releaseIntent);
        const released = yield* service.submit("actor", { ...releaseIntent, preview: view });
        f.state.phase = "succeeded";
        f.state.native = false;
        f.state.keptPath = "/tmp/reported/lane";
        f.state.keptRoot = physical.root + "/child";
        assert.equal((yield* service.get("actor", { id: released.id })).state, "unknown_outcome");
        f.state.keptRoot = "/different/checkout";
        assert.equal((yield* service.get("actor", { id: released.id })).state, "unknown_outcome");
        f.state.keptPathAvailable = false;
        assert.equal((yield* service.get("actor", { id: released.id })).state, "unknown_outcome");
        f.state.keptRoot = physical.root;
        f.state.keptPathAvailable = true;
        f.state.replaced = true;
        assert.equal((yield* service.get("actor", { id: released.id })).state, "unknown_outcome");
        f.state.replaced = false;
        const recovered = yield* service.get("actor", { id: released.id });
        assert.equal(recovered.state, "completed");
        assert.equal(recovered.id, released.id);
        assert.equal(recovered.nativeOperationID, released.nativeOperationID);
        assert.deepEqual(recovered.original, released.original);
        assert.deepEqual(yield* sql`SELECT * FROM deckhand_sessions`, original);
        assert.equal(
          (yield* (yield* Current.CurrentCheckout).forThread(threadId))?.checkout.backend,
          "standalone",
        );
        assert.equal(f.state.submits, 2);
        assert.equal((yield* service.get("actor", { id: released.id })).state, "completed");
        assert.equal(f.state.submits, 2);
      }).pipe(Effect.provide(f.layer));
    },
  );

  it.effect("uncertain outcomes preserve a blocked checkout, actor and stable intent", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const s = yield* Ownership.OwnershipTransitions;
      const view = yield* s.preview("actor", intent);
      f.state.phase = "unknown_outcome";
      const record = yield* s.submit("actor", { ...intent, preview: view });
      assert.equal(record.state, "unknown_outcome");
      assert.equal((yield* s.get("other", { id: record.id }).pipe(Effect.result))._tag, "Failure");
      assert.equal(
        (yield* s
          .submit("actor", { ...intent, laneName: "different", preview: view })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* s.get("actor", { id: record.id });
      assert.equal(f.state.submits, 1);
      assert.equal(
        (yield* (yield* Current.CurrentCheckout).forThread(threadId).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("active work and multi-repository contexts refuse before native effects", () => {
    const f = fixture();
    return Effect.gen(function* () {
      yield* f.seed;
      const s = yield* Ownership.OwnershipTransitions;
      f.state.blocked = true;
      const view = yield* s.preview("actor", intent);
      assert.isNotEmpty(view.blockers);
      assert.equal(
        (yield* s.submit("actor", { ...intent, preview: view }).pipe(Effect.result))._tag,
        "Failure",
      );
      f.state.multi = true;
      assert.equal((yield* s.preview("actor", intent).pipe(Effect.result))._tag, "Failure");
      assert.equal(f.state.submits, 0);
      assert.equal(
        (yield* (yield* SqlClient.SqlClient)`SELECT id FROM deckhand_sessions`).length,
        0,
      );
    }).pipe(Effect.provide(f.layer));
  });
  it.effect(
    "native success with changed physical identity stays unknown and does not publish an alias",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        const s = yield* Ownership.OwnershipTransitions;
        const view = yield* s.preview("actor", intent);
        const record = yield* s.submit("actor", { ...intent, preview: view });
        f.state.phase = "succeeded";
        f.state.native = true;
        f.state.replaced = true;
        assert.equal((yield* s.get("actor", { id: record.id })).state, "unknown_outcome");
        assert.equal(
          (yield* (yield* SqlClient.SqlClient)`SELECT * FROM deckhand_checkout_ownership`).length,
          0,
        );
      }).pipe(Effect.provide(f.layer));
    },
  );
});

describe("definite ownership dispatch recovery", () => {
  it.effect(
    "fails a legacy absent journal intent only with fresh unchanged identity proof, preserving original intent and conversation",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        const s = yield* Ownership.OwnershipTransitions;
        const preview = yield* s.preview("actor", intent);
        f.state.receiptError = "operation_missing";
        const record = yield* s.submit("actor", { ...intent, preview });
        // The stub submit produces an ID, so an absent receipt remains uncertain.
        assert.equal(record.state, "unknown_outcome");
        const sql = yield* SqlClient.SqlClient;
        const legacy = { ...record, nativeOperationID: null };
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(C.OwnershipRecord))(
          legacy,
        );
        yield* sql`UPDATE deckhand_ownership_transitions SET record_json=${encoded} WHERE id=${record.id}`;
        f.state.receiptError = "timeout";
        assert.equal((yield* s.get("actor", { id: record.id })).state, "unknown_outcome");
        f.state.receiptError = "operation_missing";
        f.state.replaced = true;
        assert.equal((yield* s.get("actor", { id: record.id })).state, "unknown_outcome");
        f.state.replaced = false;
        const recovered = yield* s.get("actor", { id: record.id });
        assert.equal(recovered.state, "failed");
        assert.equal(recovered.operationKey, intent.operationKey);
        assert.equal(recovered.targetCheckoutID, null);
        assert.equal(
          (yield* (yield* Current.CurrentCheckout).forThread(threadId))?.session.threadId,
          threadId,
        );
        assert.equal((yield* s.get("actor", { id: record.id })).state, "failed");
        assert.equal(f.state.submits, 1);
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect(
    "a durable definite operation refusal unblocks the original checkout without resubmission",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        yield* f.seed;
        const s = yield* Ownership.OwnershipTransitions;
        const preview = yield* s.preview("actor", intent);
        f.state.receiptError = "operation_refused";
        const record = yield* s.submit("actor", { ...intent, preview });
        assert.equal(record.state, "failed");
        assert.equal(
          (yield* (yield* Current.CurrentCheckout).forThread(threadId))?.checkout.backend,
          "standalone",
        );
        yield* s.submit("actor", { ...intent, preview });
        assert.equal(f.state.submits, 1);
      }).pipe(Effect.provide(f.layer));
    },
  );
});
