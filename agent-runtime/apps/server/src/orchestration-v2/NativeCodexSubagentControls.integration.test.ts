import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@cinderdeck/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
  ProviderAdapterV2SteerInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

// A non-default instance id proves support is chosen by driver and native
// destination rather than by the provider's display name.
const instanceId = ProviderInstanceId.make("codex-custom-account");
const driver = ProviderDriverKind.make("codex");
const parentId = ThreadId.make("thread:controls-parent");
const childId = ThreadId.make("thread:controls-child");
const childProviderId = ProviderThreadId.make("provider-thread:controls-child");
const childTurnId = ProviderTurnId.make("provider-turn:controls-child");
const childNodeId = NodeId.make("node:controls-child");
const modelSelection = { instanceId, model: "test-model" };
const capabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

it.effect(
  "steers, queues, continues and stops the native Codex child without targeting its parent",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("native-codex-child-controls");
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const started: ProviderAdapterV2TurnInput[] = [];
        const steered: ProviderAdapterV2SteerInput[] = [];
        const interrupted: Array<{
          providerThreadId: ProviderThreadId;
          providerTurnId: ProviderTurnId;
        }> = [];
        let nativeChild: OrchestrationV2ProviderThread;
        const adapter: ProviderAdapterV2Shape = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(capabilities),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              const sessionEvents =
                started.length === 0 ? events : yield* Queue.unbounded<ProviderAdapterV2Event>();
              const providerThread = (threadId: ThreadId): OrchestrationV2ProviderThread => ({
                id:
                  threadId === childId
                    ? childProviderId
                    : ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: threadId === childId ? "native-child" : "native-parent",
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              });
              nativeChild = providerThread(childId);
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: modelSelection.model,
                  capabilities,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(sessionEvents),
                ensureThread: ({ threadId }) => Effect.succeed(providerThread(threadId)),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    started.push(turn);
                    yield* Queue.offer(sessionEvents, {
                      type: "provider_turn.updated",
                      driver,
                      threadId: turn.threadId,
                      providerTurn: {
                        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `native:${turn.attemptId}`,
                          strength: "strong",
                        },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                    if (turn.threadId !== parentId) return;
                    yield* Queue.offer(sessionEvents, {
                      type: "app_thread.created",
                      driver,
                      appThread: {
                        ...turn.appThread,
                        id: childId,
                        title: "Child",
                        createdBy: "agent",
                        creationSource: "provider",
                        activeProviderThreadId: childProviderId,
                        lineage: {
                          parentThreadId: parentId,
                          rootThreadId: parentId,
                          relationshipToParent: "subagent",
                        },
                      },
                    });
                    yield* Queue.offer(sessionEvents, {
                      type: "provider_thread.updated",
                      driver,
                      providerThread: nativeChild,
                    });
                    yield* Queue.offer(sessionEvents, {
                      type: "message.updated",
                      driver,
                      message: {
                        id: MessageId.make("message:child-task"),
                        threadId: childId,
                        runId: null,
                        nodeId: childNodeId,
                        role: "user",
                        text: "Inspect the fixture",
                        attachments: [],
                        streaming: false,
                        createdBy: "agent",
                        creationSource: "provider",
                        createdAt: now,
                        updatedAt: now,
                      },
                    });
                    yield* Queue.offer(sessionEvents, {
                      type: "provider_turn.updated",
                      driver,
                      threadId: childId,
                      providerTurn: {
                        id: childTurnId,
                        providerThreadId: childProviderId,
                        nodeId: childNodeId,
                        runAttemptId: null,
                        nativeTurnRef: {
                          driver,
                          nativeId: "native-child-turn",
                          strength: "strong",
                        },
                        ordinal: 1,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                    yield* Queue.offer(sessionEvents, {
                      type: "node.updated",
                      driver,
                      node: {
                        id: childNodeId,
                        threadId: childId,
                        runId: null,
                        parentNodeId: null,
                        rootNodeId: childNodeId,
                        kind: "root_turn",
                        status: "running",
                        countsForRun: false,
                        providerThreadId: childProviderId,
                        providerTurnId: childTurnId,
                        nativeItemRef: null,
                        runtimeRequestId: null,
                        checkpointScopeId: null,
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                  }),
                steerTurn: (turn) =>
                  Effect.sync(() => {
                    steered.push(turn);
                  }),
                interruptTurn: (turn) =>
                  Effect.sync(() => {
                    interrupted.push({
                      providerThreadId: turn.providerThread.id,
                      providerTurnId: turn.providerTurnId,
                    });
                  }),
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-parent"),
            threadId: parentId,
            projectId: ProjectId.make("project:child-controls"),
            title: "Parent",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const childReady = yield* watch(
            (event) =>
              event.type === "node.updated" &&
              event.threadId === childId &&
              event.payload.runId !== null,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("parent-message"),
            threadId: parentId,
            messageId: MessageId.make("message:parent"),
            text: "Delegate",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(childReady);
          const child = yield* orchestrator.getThreadProjection(childId);
          assert.lengthOf(child.runs, 1);
          assert.isTrue(child.providerSessions[0]?.capabilities.turns.supportsActiveSteering);
          assert.isTrue(child.providerSessions[0]?.capabilities.turns.supportsQueuedMessages);
          assert.equal(child.runs[0]?.nativeSubagentTurnId, childTurnId);
          assert.equal(child.runs[0]?.status, "running");
          assert.equal(child.providerTurns[0]?.runAttemptId, child.runs[0]?.activeAttemptId);
          const send = (
            name: string,
            dispatchMode:
              | { type: "queue_after_active" }
              | { type: "steer_active"; targetRunId: (typeof child.runs)[number]["id"] },
          ) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(name),
              threadId: childId,
              messageId: MessageId.make(`message:${name}`),
              text: name,
              attachments: [],
              dispatchMode,
              createdBy: "user",
              creationSource: "web",
            });
          yield* send("steer-child", { type: "steer_active", targetRunId: child.runs[0]!.id });
          yield* worker.drain();
          assert.lengthOf(steered, 1);
          assert.equal(steered[0]?.threadId, childId);
          assert.equal(steered[0]?.providerThread.nativeThreadRef?.nativeId, "native-child");
          assert.equal(steered[0]?.providerTurnId, childTurnId);
          yield* send("queued-child", { type: "queue_after_active" });
          yield* worker.drain();
          assert.lengthOf(started, 1, "queued message must not start while the native child works");
          assert.equal(
            (yield* orchestrator.getThreadProjection(childId)).runs[1]?.status,
            "queued",
          );
          const queuedForSteer = (yield* orchestrator.getThreadProjection(childId)).runs[1]!;
          yield* orchestrator.dispatch({
            type: "queued-message.promote-to-steer",
            commandId: CommandId.make("promote-child-queue"),
            threadId: childId,
            queuedRunId: queuedForSteer.id,
            targetRunId: child.runs[0]!.id,
          });
          yield* worker.drain();
          assert.lengthOf(steered, 2);
          assert.equal(steered[1]?.providerTurnId, childTurnId);
          assert.equal(steered[1]?.message.text, "queued-child");
          yield* send("final-queued-child", { type: "queue_after_active" });
          yield* worker.drain();
          assert.lengthOf(started, 1);
          const continued = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.threadId === childId &&
              event.payload.runAttemptId !== null &&
              event.payload.id !== childTurnId,
          );
          const now = yield* DateTime.now;
          yield* Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            threadId: childId,
            providerTurn: {
              ...child.providerTurns[0]!,
              runAttemptId: null,
              status: "completed",
              completedAt: now,
            },
          });
          yield* Fiber.join(continued);
          assert.lengthOf(started, 2);
          assert.equal(started[1]?.threadId, childId);
          assert.equal(started[1]?.providerThread.id, childProviderId);
          assert.equal(started[1]?.providerThread.nativeThreadRef?.nativeId, "native-child");
          assert.notEqual(
            started[1]?.providerThread.providerSessionId,
            started[0]?.providerThread.providerSessionId,
            "native-host follow-ups require a child-owned process while retaining native history",
          );
          assert.equal(started[1]?.message.text, "final-queued-child");
          assert.equal(
            (yield* orchestrator.getThreadProjection(parentId)).runs[0]?.status,
            "running",
          );
          const activeChild = yield* orchestrator.getThreadProjection(childId);
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-child"),
            threadId: childId,
            runId: activeChild.runs.find((run) => run.status === "running")!.id,
          });
          yield* worker.drain();
          assert.equal(interrupted.at(-1)?.providerThreadId, childProviderId);
          assert.notEqual(interrupted.at(-1)?.providerTurnId, childTurnId);
          assert.equal(
            (yield* orchestrator.getThreadProjection(parentId)).runs[0]?.status,
            "running",
          );
          assert.equal(activeChild.thread.lineage.parentThreadId, parentId);
          assert.isTrue(
            activeChild.messages.some((message) => message.text === "Inspect the fixture"),
          );
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name: "native-codex-child-controls" },
              ProviderAdapterRegistry.makeLayer([adapter]),
            ),
          ),
        );
      }),
    ),
);
