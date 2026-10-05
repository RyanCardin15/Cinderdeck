import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2StoredEvent,
} from "@cinderdeck/contracts";
import * as Contracts from "@cinderdeck/contracts/deckhand";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Relationships from "./Relationships.ts";
import * as ManagedSessions from "./ManagedSessions.ts";
import * as External from "./ExternalSessions.ts";

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
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY, deleted_at TEXT
  )`;
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
  const layer = (
    stream?: EventSink.EventSinkV2Shape["stream"],
    externalLayer?: Layer.Layer<External.ExternalSessions>,
  ) =>
    ManagedSessions.layer.pipe(
      Layer.provide(projectionLayer),
      Layer.provide(eventLayer(stream)),
      Layer.provide(
        externalLayer ??
          Layer.mock(External.ExternalSessions)({
            changes: Stream.never,
            summaries: (input) =>
              Effect.succeed(
                input.contexts.map((target) => ({
                  ...target,
                  activeCount: 2,
                  staleCount: 1,
                  lastSeenAt: "2026-10-03T00:00:00Z",
                  unavailable: false,
                })),
              ),
          }),
      ),
    );
  return { state, layer };
};
describe("managed session provider projection", () => {
  it.effect(
    "removes deleted sessions before pagination and overview counts while keeping archives restorable",
    () =>
      Effect.gen(function* () {
        const f = source();
        yield* Effect.gen(function* () {
          yield* seed;
          const sql = yield* SqlClient.SqlClient;
          const store = yield* Relationships.Relationships;
          const original = yield* store.session("session");
          for (let index = 1; index <= 20; index++) {
            yield* store.putSession(
              {
                ...original,
                id: Contracts.SessionBindingId.make(`deleted-${index}`),
                threadId: ThreadId.make(`deleted-thread-${index}`),
              },
              null,
            );
            yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${`deleted-thread-${index}`}, '2026-10-05')`;
          }
          f.state.shell = {
            ...f.state.shell!,
            archivedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z"),
          };
          const service = yield* ManagedSessions.ManagedSessions;
          const rows = yield* service.list({ ...scope, limit: 1 });
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.binding.id, original.id);
          assert.isTrue(rows[0]!.archived);
          const overview = yield* service.contexts({
            installationID: scope.installationID,
            contexts: [{ workspaceID: scope.workspaceID, generation: scope.generation }],
          });
          assert.equal(overview[0]!.total, 1);
          assert.equal(overview[0]!.sessions[0]!.binding.id, original.id);
          yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${threadId}, '2026-10-05')`;
          assert.deepEqual(yield* service.list(scope), []);
          const [selected] = yield* service
            .subscribeThread({
              ...scope,
              sessionID: original.id,
              threadID: original.threadId,
              checkoutID: original.checkoutId,
            })
            .pipe(Stream.take(1), Stream.runCollect);
          assert.isNull(selected);
          const empty = yield* service.contexts({
            installationID: scope.installationID,
            contexts: [{ workspaceID: scope.workspaceID, generation: scope.generation }],
          });
          assert.equal(empty[0]!.total, 0);
        }).pipe(Effect.provide(f.layer()));
      }).pipe(Effect.provide(baseLayer)),
  );
  it.effect(
    "projects the 21st saved agent exactly while retaining a bounded sibling list and refusing mismatched bindings",
    () =>
      Effect.gen(function* () {
        const f = source();
        yield* Effect.gen(function* () {
          yield* seed;
          const relationships = yield* Relationships.Relationships;
          const original = yield* relationships.session("session");
          for (let index = 1; index <= 20; index++)
            yield* relationships.putSession(
              {
                ...original,
                id: Contracts.SessionBindingId.make(`newer-${index}`),
                threadId: ThreadId.make(`newer-thread-${index}`),
              },
              null,
            );
          const service = yield* ManagedSessions.ManagedSessions;
          const siblings = yield* service.list(scope);
          assert.equal(siblings.length, 20);
          assert.isFalse(siblings.some((item) => item.binding.id === original.id));
          assert.deepEqual(yield* service.list({ ...scope, offset: 0 }), siblings);
          const older = yield* service.list({ ...scope, offset: 20 });
          assert.equal(older.length, 1);
          assert.equal(older[0]?.binding.id, original.id);
          const [liveOlderPage] = yield* service
            .subscribe({ ...scope, offset: 20 })
            .pipe(Stream.take(1), Stream.runCollect);
          assert.equal(liveOlderPage?.[0]?.binding.threadId, original.threadId);
          for (const wrong of [
            { ...scope, offset: 20, installationID: "different-installation" },
            { ...scope, offset: 20, workspaceID: "different-lane" },
            { ...scope, offset: 20, generation: 8 },
          ])
            assert.deepEqual(yield* service.list(wrong), []);
          for (const invalid of [
            { ...scope, offset: -1 },
            { ...scope, offset: 10001 },
            { ...scope, limit: 21 },
          ]) {
            assert.equal(
              (yield* service.list(invalid).pipe(Effect.flip)).reason,
              "invalid_request",
            );
          }
          const input = {
            ...scope,
            sessionID: original.id,
            threadID: original.threadId,
            checkoutID: original.checkoutId,
          };
          const [selected] = yield* service
            .subscribeThread(input)
            .pipe(Stream.take(1), Stream.runCollect);
          assert.equal(selected?.binding.execution, "working");
          assert.equal(selected?.binding.connection, "connected");
          assert.equal(selected?.binding.threadId, original.threadId);
          for (const wrong of [
            { ...input, installationID: "another-installation" },
            { ...input, workspaceID: "another-lane" },
            { ...input, generation: 8 },
            { ...input, threadID: ThreadId.make("another-thread") },
            { ...input, sessionID: Contracts.SessionBindingId.make("newer-1") },
            { ...input, checkoutID: Contracts.CheckoutBindingId.make("another-checkout") },
          ]) {
            const [rejected] = yield* service
              .subscribeThread(wrong)
              .pipe(Stream.take(1), Stream.runCollect);
            assert.isNull(rejected);
          }
        }).pipe(Effect.provide(f.layer()));
      }).pipe(Effect.provide(baseLayer)),
  );

  it.effect(
    "summarizes a bounded page with exact saved counts, PR identity and generation isolation",
    () =>
      Effect.gen(function* () {
        const f = source();
        yield* Effect.gen(function* () {
          yield* seed;
          const store = yield* Relationships.Relationships;
          const original = yield* store.session("session");
          for (let index = 2; index <= 6; index++)
            yield* store.putSession(
              {
                ...original,
                id: Contracts.SessionBindingId.make(`session${index}`),
                threadId: ThreadId.make(`thread${index}`),
              },
              null,
            );
          f.state.shell = {
            ...f.state.shell!,
            pullRequests: [
              {
                host: "github.com",
                repository: "fixture/shop",
                number: 14,
                url: "https://github.com/fixture/shop/pull/14",
                source: "manual",
                linkedAt: "2026-10-03T00:00:00Z",
                snapshot: null,
                stack: null,
              },
            ],
          };
          const service = yield* ManagedSessions.ManagedSessions;
          const input = {
            installationID: "installation",
            contexts: [
              { workspaceID: "lane", generation: 7 },
              { workspaceID: "lane-replaced", generation: 8 },
            ],
          };
          const page = yield* service.contexts(input);
          assert.equal(page[0]!.total, 6);
          assert.equal(page[0]!.externalSessions?.activeCount, 2);
          assert.equal(page[0]!.externalSessions?.staleCount, 1);
          assert.equal(page[0]!.sessions.length, 4);
          assert.equal(page[0]!.sessions[0]!.objective, "Verify retry");
          assert.equal(page[0]!.sessions[0]!.pullRequests![0]!.host, "github.com");
          assert.equal(page[1]!.total, 0);
          assert.equal(
            (yield* service.contexts({ ...input, installationID: "other" }))[0]!.total,
            0,
          );
          assert.equal(
            (yield* service.contexts({
              ...input,
              contexts: [{ workspaceID: "lane", generation: 8 }],
            }))[0]!.total,
            0,
          );
          assert.equal(
            (yield* service
              .contexts({ ...input, contexts: [input.contexts[0]!, input.contexts[0]!] })
              .pipe(Effect.flip)).reason,
            "invalid_request",
          );
          f.state.shell = null;
          const unavailable = yield* service.contexts(input);
          assert.equal(unavailable[0]!.total, 6);
          assert.equal(unavailable[0]!.sessions[0]!.source, "unavailable");
          assert.equal(unavailable[0]!.sessions[0]!.binding.execution, "unknown");
        }).pipe(Effect.provide(f.layer()));
      }).pipe(Effect.provide(baseLayer)),
  );

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
    "consumes context summaries and shared external visibility changes without a stream defect",
    () =>
      Effect.gen(function* () {
        const f = source();
        let externalCount = 0;
        const externalLayer = Layer.mock(External.ExternalSessions)({
          summaries: (input) =>
            Effect.succeed(
              input.contexts.map((target) => ({
                ...target,
                activeCount: externalCount,
                staleCount: 0,
                lastSeenAt: null,
                unavailable: false,
              })),
            ),
          changes: Stream.unwrap(
            Effect.sync(() => {
              externalCount = 1;
              return Stream.make(undefined);
            }),
          ),
        });
        yield* Effect.gen(function* () {
          yield* seed;
          const service = yield* ManagedSessions.ManagedSessions;
          const updates = yield* service
            .subscribeContexts({
              installationID: "installation",
              contexts: [{ workspaceID: "lane", generation: 7 }],
            })
            .pipe(Stream.take(2), Stream.runCollect);
          assert.equal(updates.length, 2);
          assert.equal(updates[0]?.[0]?.externalSessions?.activeCount, 0);
          assert.equal(updates[1]?.[0]?.externalSessions?.activeCount, 1);
          assert.equal(updates[1]?.[0]?.sessions[0]?.binding.execution, "working");
        }).pipe(Effect.provide(f.layer(undefined, externalLayer)));
      }).pipe(Effect.provide(baseLayer)),
  );

  it.effect(
    "replays the exact opened thread after its initial watermark without widening scope",
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
          const binding = yield* (yield* Relationships.Relationships).session("session");
          const updates = yield* service
            .subscribeThread({
              ...scope,
              sessionID: binding.id,
              threadID: binding.threadId,
              checkoutID: binding.checkoutId,
            })
            .pipe(Stream.take(2), Stream.runCollect);
          assert.equal(cursor, 8);
          assert.equal(updates[0]?.binding.execution, "working");
          assert.equal(updates[1]?.binding.execution, "finished_turn");
          assert.equal(updates[1]?.binding.threadId, binding.threadId);
          assert.equal(updates[1]?.binding.lastSequence, 9);
        }).pipe(Effect.provide(layer));
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
