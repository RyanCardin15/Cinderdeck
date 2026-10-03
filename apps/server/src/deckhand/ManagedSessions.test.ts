import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as Contracts from "@t3tools/contracts/deckhand";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Relationships from "./Relationships.ts";
import * as ManagedSessions from "./ManagedSessions.ts";

const threadId = ThreadId.make("thread");
const instanceId = ProviderInstanceId.make("codex-account");
const scope = { installationID: "installation", workspaceID: "lane", generation: 7, limit: 20 };
const baseLayer = Relationships.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const decodeWorkspace = Schema.decodeUnknownEffect(Contracts.WorkspaceBinding);
const decodeCheckout = Schema.decodeUnknownEffect(Contracts.CheckoutBinding);
const decodeFeature = Schema.decodeUnknownEffect(Contracts.Feature);
const decodeSession = Schema.decodeUnknownEffect(Contracts.SessionBinding);
const seed = Effect.gen(function* () {
  const store = yield* Relationships.Relationships;
  const workspace = yield* decodeWorkspace({
    id: "workspace",
    environmentId: "installation",
    backend: "cinderdeck",
    ownerId: "payment",
    generation: 2,
    revision: 1,
    name: "Payment",
    state: "active",
  });
  const checkout = yield* decodeCheckout({
    id: "checkout",
    workspaceId: "workspace",
    environmentId: "installation",
    backend: "cinderdeck",
    workspaceGeneration: 2,
    nativeGeneration: 7,
    revision: 1,
    kind: "lane",
    laneId: "lane",
    state: "ready",
    repositories: [
      {
        physicalId: "physical",
        repositoryPhysicalId: "repository",
        root: "/fixture/lane",
        commonDirectory: "/fixture/.git",
        gitDirectory: "/fixture/.git/worktrees/lane",
        branch: "lane",
        commit: null,
        remotes: [],
      },
    ],
  });
  const feature = yield* decodeFeature({
    id: "feature",
    workspaceId: "workspace",
    title: "Payment retry",
    objective: "Verify retry",
    status: "active",
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
  });
  const session = yield* decodeSession({
    id: "session",
    threadId,
    providerSessionId: null,
    providerInstanceId: instanceId,
    featureId: "feature",
    checkoutId: "checkout",
    repositoryScope: ["physical"],
    role: "writer",
    desiredAccess: "write",
    execution: "queued",
    connection: "connected",
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
  });
  yield* store.putWorkspace(workspace, null);
  yield* store.putCheckout(checkout, null);
  yield* store.putFeature(feature, null);
  yield* store.linkCheckout("feature", "checkout", true);
  yield* store.putSession(session, null);
});
const source = () => {
  const state = {
    sequence: 8,
    shell: {
      id: threadId,
      providerInstanceId: instanceId,
      status: "running",
      activityRunStatus: "running",
      activeProviderThreadId: ProviderThreadId.make("provider-thread"),
      pendingRuntimeRequest: null,
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell | null,
    session: {
      id: ProviderSessionId.make("provider-session"),
      status: "running",
      capabilities: CodexProviderCapabilitiesV2,
    },
    attachedSessionId: ProviderSessionId.make("provider-session") as ProviderSessionId | null,
  };
  const projectionLayer = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadShell: () => Effect.sync(() => state.shell),
    getThreadRecords: (() =>
      Effect.sync(() => ({
        thread: {},
        providerThreads: [
          {
            id: ProviderThreadId.make("provider-thread"),
            providerSessionId: state.attachedSessionId,
          },
        ],
        providerSessions: [state.session],
      }))) as ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"],
  });
  const eventLayer = (stream: EventSink.EventSinkV2Shape["stream"] = () => Stream.empty) =>
    Layer.mock(EventSink.EventSinkV2)({
      latestSequence: () => Effect.sync(() => state.sequence),
      stream,
    });
  const layer = (stream?: EventSink.EventSinkV2Shape["stream"]) =>
    ManagedSessions.layer.pipe(Layer.provide(projectionLayer), Layer.provide(eventLayer(stream)));
  return { state, layer };
};
describe("managed session provider projection", () => {
  it.effect(
    "projects actual work, approval, question, and completion states while retaining checkout scope",
    () =>
      Effect.gen(function* () {
        const f = source();
        yield* Effect.gen(function* () {
          yield* seed;
          const service = yield* ManagedSessions.ManagedSessions;
          const store = yield* Relationships.Relationships;
          const working = (yield* service.list(scope))[0]!;
          assert.equal(working.binding.execution, "working");
          assert.equal(working.binding.providerSessionId, "provider-session");
          assert.isTrue(working.binding.capabilities.interrupt);
          assert.isFalse(working.binding.capabilities.enforcedReadOnly);
          f.state.shell = {
            ...f.state.shell!,
            pendingRuntimeRequest: {
              kind: "command",
            } as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
          };
          f.state.sequence++;
          assert.equal((yield* service.list(scope))[0]!.binding.execution, "waiting_approval");
          f.state.shell = {
            ...f.state.shell!,
            pendingRuntimeRequest: {
              kind: "user_input",
            } as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
          };
          f.state.sequence++;
          assert.equal((yield* service.list(scope))[0]!.binding.execution, "waiting_input");
          f.state.shell = {
            ...f.state.shell!,
            pendingRuntimeRequest: {
              kind: "auth_refresh",
            } as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
          };
          f.state.sequence++;
          assert.equal((yield* service.list(scope))[0]!.binding.execution, "waiting_input");
          f.state.shell = {
            ...f.state.shell!,
            pendingRuntimeRequest: {
              kind: "dynamic_tool_call",
            } as OrchestrationV2ThreadShell["pendingRuntimeRequest"],
          };
          f.state.sequence++;
          assert.equal((yield* service.list(scope))[0]!.binding.execution, "working");
          f.state.shell = {
            ...f.state.shell!,
            pendingRuntimeRequest: null,
            status: "completed",
            activityRunStatus: null,
          };
          f.state.session.status = "ready";
          f.state.sequence++;
          const completed = (yield* service.list(scope))[0]!;
          assert.equal(completed.binding.execution, "finished_turn");
          assert.equal(completed.binding.connection, "connected");
          const durable = yield* store.session("session");
          assert.equal(durable.execution, "finished_turn");
          assert.equal(durable.lastSequence, 13);
          assert.equal(durable.checkoutId, "checkout");
          assert.deepEqual(durable.repositoryScope, ["physical"]);
        }).pipe(Effect.provide(f.layer()));
      }).pipe(Effect.provide(baseLayer)),
  );

  it.effect(
    "shows unavailable source truth without erasing saved history or rolling sequence backwards",
    () =>
      Effect.gen(function* () {
        const f = source();
        yield* Effect.gen(function* () {
          yield* seed;
          const service = yield* ManagedSessions.ManagedSessions;
          const store = yield* Relationships.Relationships;
          yield* service.list(scope);
          f.state.shell = null;
          const unavailable = (yield* service.list(scope))[0]!;
          assert.equal(unavailable.source, "unavailable");
          assert.equal(unavailable.binding.execution, "unknown");
          assert.equal(unavailable.binding.connection, "unavailable");
          assert.equal((yield* store.session("session")).execution, "working");
          f.state.shell = {
            id: threadId,
            providerInstanceId: instanceId,
            status: "completed",
            activityRunStatus: null,
            activeProviderThreadId: ProviderThreadId.make("provider-thread"),
            pendingRuntimeRequest: null,
            archivedAt: null,
            deletedAt: null,
          } as OrchestrationV2ThreadShell;
          f.state.sequence = 3;
          assert.equal((yield* service.list(scope))[0]!.source, "unavailable");
          assert.equal((yield* store.session("session")).lastSequence, 8);
        }).pipe(Effect.provide(f.layer()));
      }).pipe(Effect.provide(baseLayer)),
  );

  it.effect(
    "separates provider connection loss from terminal execution and checks the exact attachment",
    () =>
      Effect.gen(function* () {
        const f = source();
        yield* Effect.gen(function* () {
          yield* seed;
          const service = yield* ManagedSessions.ManagedSessions;
          f.state.shell = { ...f.state.shell!, status: "interrupted", activityRunStatus: null };
          f.state.session.status = "stopped";
          const stopped = (yield* service.list(scope))[0]!;
          assert.equal(stopped.binding.execution, "interrupted");
          assert.equal(stopped.binding.connection, "unavailable");
          f.state.session.status = "ready";
          f.state.attachedSessionId = ProviderSessionId.make("different-session");
          f.state.sequence++;
          const detached = (yield* service.list(scope))[0]!;
          assert.isNull(detached.binding.providerSessionId);
          assert.equal(detached.binding.connection, "unavailable");
          assert.equal(
            (yield* service.list({ ...scope, limit: 21 }).pipe(Effect.flip)).reason,
            "invalid_request",
          );
          assert.equal((yield* service.list({ ...scope, generation: 8 })).length, 0);
          assert.equal((yield* service.list({ ...scope, installationID: "different" })).length, 0);
        }).pipe(Effect.provide(f.layer()));
      }).pipe(Effect.provide(baseLayer)),
  );

  it.effect(
    "replays after the initial durable watermark and emits source state changes without timers",
    () =>
      Effect.gen(function* () {
        const f = source();
        let cursor: number | undefined;
        const layer = f.layer((request) =>
          Stream.unwrap(
            Effect.sync(() => {
              cursor = request?.afterSequence;
              f.state.sequence = 9;
              f.state.shell = { ...f.state.shell!, status: "completed", activityRunStatus: null };
              return Stream.make({
                sequence: 9,
                commandId: null,
                event: { type: "run.updated" },
              } as OrchestrationV2StoredEvent);
            }),
          ),
        );
        yield* Effect.gen(function* () {
          yield* seed;
          const service = yield* ManagedSessions.ManagedSessions;
          const updates = yield* service.subscribe(scope).pipe(Stream.take(2), Stream.runCollect);
          assert.equal(cursor, 8);
          assert.equal(updates[0]![0]!.binding.execution, "working");
          assert.equal(updates[1]![0]!.binding.execution, "finished_turn");
          assert.equal(updates[1]![0]!.binding.lastSequence, 9);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(baseLayer)),
  );
});
