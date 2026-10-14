import {
  NodeId,
  MessageId,
  isProviderNativeSubagentThread,
  canMessageProviderNativeSubagentThread,
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RawEventId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@cinderdeck/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as IdAllocator from "./IdAllocator.ts";
import { ProviderAdapterV2Event } from "./ProviderAdapter.ts";
import { makeProviderFailureTurnItem } from "./ProviderFailure.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

export class ProviderEventNormalizeError extends Schema.TaggedError<ProviderEventNormalizeError>()(
  "ProviderEventNormalizeError",
  {
    providerSessionId: ProviderSessionId,
    threadId: ThreadId,
    providerEvent: ProviderAdapterV2Event,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to normalize provider event ${this.providerEvent.type} for thread ${this.threadId}.`;
  }
}

export class ProviderEventPublishError extends Schema.TaggedError<ProviderEventPublishError>()(
  "ProviderEventPublishError",
  {
    providerSessionId: ProviderSessionId,
    eventCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to publish ${this.eventCount} normalized provider event(s).`;
  }
}

export const ProviderEventIngestorV2Error = Schema.Union([
  ProviderEventNormalizeError,
  ProviderEventPublishError,
]);
export type ProviderEventIngestorV2Error = typeof ProviderEventIngestorV2Error.Type;

type TodoListPlan = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

function withPlanStepDurations(
  plan: TodoListPlan,
  previous: TodoListPlan | undefined,
  occurredAt: DateTime.Utc,
): TodoListPlan {
  const occurredAtIso = DateTime.formatIso(occurredAt);
  const occurredAtMs = DateTime.toEpochMillis(occurredAt);
  const previousById = new Map(previous?.steps.map((step) => [step.id, step]));
  // Provider step IDs may be positional. Changed text must not inherit another task's timing.
  const previousStep = (step: TodoListPlan["steps"][number]) => {
    const prior = previousById.get(step.id);
    return prior?.text === step.text ? prior : undefined;
  };
  const hasNewCompletion = plan.steps.some((step) => {
    const prior = previousStep(step);
    return step.status === "completed" && prior?.status !== "completed";
  });
  let fallbackCompletionConsumed = false;

  return {
    ...plan,
    steps: plan.steps.map((step) => {
      const prior = previousStep(step);
      const baseStep = { id: step.id, text: step.text, status: step.status };
      if (step.status === "completed") {
        if (prior?.status === "completed") {
          return {
            ...baseStep,
            ...(prior.durationMs === undefined ? {} : { durationMs: prior.durationMs }),
          };
        }
        const durationAnchorAt =
          prior?.status === "running" || !fallbackCompletionConsumed
            ? prior?.durationAnchorAt
            : occurredAtIso;
        fallbackCompletionConsumed = true;
        const anchorMs =
          durationAnchorAt === undefined ? occurredAtMs : Date.parse(durationAnchorAt);
        const durationMs = Number.isFinite(anchorMs) ? Math.max(0, occurredAtMs - anchorMs) : 0;
        return {
          ...baseStep,
          ...(durationMs > 0 ? { durationMs } : {}),
        };
      }
      if (step.status === "running") {
        return {
          ...baseStep,
          durationAnchorAt:
            prior?.status === "running" ? (prior.durationAnchorAt ?? occurredAtIso) : occurredAtIso,
        };
      }
      return {
        ...baseStep,
        durationAnchorAt:
          hasNewCompletion || prior?.status !== "pending"
            ? occurredAtIso
            : (prior.durationAnchorAt ?? occurredAtIso),
      };
    }),
  };
}

export interface ProviderEventIngestInput {
  readonly providerSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly commandId?: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly nodeId?: NodeId;
  readonly rawEventId?: RawEventId;
  readonly event: ProviderAdapterV2Event;
}

export interface ProviderEventIngestorV2Shape {
  readonly normalize: (
    input: ProviderEventIngestInput,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, ProviderEventIngestorV2Error>;
  readonly ingestNormalized: (
    input: ProviderEventIngestInput & {
      /**
       * Atomically reject mutable provider state emitted by an attempt that
       * lost ownership while the adapter event was in flight.
       */
      readonly writeIfRunCurrent?: {
        readonly runId: RunId;
        readonly activeAttemptId: RunAttemptId;
        readonly expectedStatus: OrchestrationV2Run["status"];
      };
      /**
       * Atomically reject provider-thread snapshots from an attempt that no
       * longer owns the run or from a run that no longer owns the thread.
       */
      readonly writeIfProviderThreadOwner?: {
        readonly providerThreadId: ProviderThreadId;
        readonly runId: RunId;
        readonly activeAttemptId: RunAttemptId;
        readonly expectedLastRunOrdinal: number;
      };
    },
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, ProviderEventIngestorV2Error>;
}

export class ProviderEventIngestorV2 extends Context.Service<
  ProviderEventIngestorV2,
  ProviderEventIngestorV2Shape
>()("@cinderdeck/server/orchestration-v2/ProviderEventIngestor/ProviderEventIngestorV2") {}

function compactUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);

export const layer: Layer.Layer<
  ProviderEventIngestorV2,
  never,
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectionStore.ProjectionStoreV2
  | ThreadCommandExecutor.ThreadCommandExecutor
> = Layer.effect(
  ProviderEventIngestorV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const threadCommands = yield* ThreadCommandExecutor.ThreadCommandExecutor;

    const makeDomainEvent = (
      input: ProviderEventIngestInput,
      payloadInput: {
        readonly type: OrchestrationV2DomainEvent["type"];
        readonly payload: OrchestrationV2DomainEvent["payload"];
        readonly threadId?: ThreadId;
        readonly runId?: RunId | null;
        readonly nodeId?: NodeId | null;
        readonly occurredAt?: DateTime.Utc;
      },
    ) =>
      Effect.gen(function* () {
        const threadId = payloadInput.threadId ?? input.threadId;
        const eventId = yield* idAllocator.allocate.event({
          threadId,
          providerSessionId: input.providerSessionId,
        });
        const occurredAt = payloadInput.occurredAt ?? (yield* DateTime.now);
        return yield* decodeDomainEvent(
          compactUndefined({
            id: eventId,
            type: payloadInput.type,
            threadId,
            runId: payloadInput.runId ?? input.runId,
            nodeId: payloadInput.nodeId ?? input.nodeId,
            driver: input.event.driver,
            providerInstanceId: input.providerInstanceId,
            rawEventId: input.rawEventId,
            occurredAt,
            payload: payloadInput.payload,
          }),
        );
      });

    const dismissNativeUserInputs = Effect.fn("ProviderEventIngestor.dismissNativeUserInputs")(
      function* (
        input: ProviderEventIngestInput,
        providerTurnId: ProviderTurnId,
        threadId = input.threadId,
      ) {
        const pending = yield* projections.getPendingNativeUserInputs(threadId, providerTurnId);
        const now = yield* DateTime.now;
        const events: Array<OrchestrationV2DomainEvent> = [];
        for (const request of pending.runtimeRequests) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "runtime-request.updated",
              threadId,
              nodeId: request.nodeId,
              payload: { ...request, status: "cancelled", resolvedAt: now },
            }),
          );
        }
        for (const node of pending.nodes) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "node.updated",
              threadId,
              nodeId: node.id,
              runId: node.runId,
              payload: { ...node, status: "cancelled", completedAt: now },
            }),
          );
        }
        for (const item of pending.turnItems) {
          events.push(
            yield* makeDomainEvent(input, {
              type: "turn-item.updated",
              threadId,
              nodeId: item.nodeId,
              runId: item.runId,
              payload: { ...item, status: "cancelled", completedAt: now, updatedAt: now },
            }),
          );
        }
        return events;
      },
    );

    /**
     * A native subagent's thread starts on the parent's model when the
     * provider names the real one later (a Claude agent file's model arrives
     * with the subagent's first reply). Clients read the thread's model, so
     * move the thread to the reported one. Thread commands rewrite the whole
     * thread row under the thread's lock, so this read and write take it too.
     */
    const syncSubagentThreadModel = Effect.fn("ProviderEventIngestor.syncSubagentThreadModel")(
      function* (input: ProviderEventIngestInput, subagent: OrchestrationV2Subagent) {
        const { childThreadId, model } = subagent;
        if (subagent.origin !== "provider_native" || childThreadId === null || model === null) {
          return [];
        }
        const staleThread = projections.getThread(childThreadId).pipe(
          Effect.map((thread) => (thread.modelSelection.model === model ? null : thread)),
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
        );
        // Nearly every update already matches; only a mismatch takes the lock.
        if ((yield* staleThread) === null) return [];
        return yield* threadCommands.withLock(
          childThreadId,
          Effect.gen(function* () {
            const thread = yield* staleThread;
            if (thread === null) return [];
            const now = yield* DateTime.now;
            const event = yield* makeDomainEvent(input, {
              type: "thread.model-selection-updated",
              threadId: thread.id,
              // The parent's options belong to the parent's model.
              payload: {
                ...thread,
                modelSelection: { instanceId: thread.modelSelection.instanceId, model },
                updatedAt: now,
              },
              occurredAt: now,
            });
            return yield* eventSink.write({ events: [event] });
          }),
        );
      },
    );

    // Native Codex turns are already running in the parent's provider session.
    // Adopt their durable turn identity instead of starting a second turn. This
    // makes the ordinary steer/interrupt effects and terminal queue promotion
    // work for the child, while the adapter keeps reporting results to its parent.
    const projectNativeChildEvents = Effect.fn("ProviderEventIngestor.projectNativeChildEvents")(
      function* (
        input: ProviderEventIngestInput,
        events: ReadonlyArray<OrchestrationV2DomainEvent>,
      ) {
        const target = events[0];
        if (target === undefined || input.event.driver !== "codex") return events;
        const thread = yield* projections.getThread(target.threadId);
        if (!isProviderNativeSubagentThread(thread)) return events;
        const result: Array<OrchestrationV2DomainEvent> = [];
        const append = (
          type: OrchestrationV2DomainEvent["type"],
          payload: OrchestrationV2DomainEvent["payload"],
          runId: RunId,
        ) => makeDomainEvent(input, { type, payload, threadId: thread.id, runId });
        for (const event of events) {
          if (event.type === "provider-turn.updated" && event.payload.runAttemptId === null) {
            const turn = event.payload;
            const records = yield* projections.getThreadRecords(
              thread.id,
              ["runs", "attempts", "providerThreads", "messages"],
              { messageRoles: ["user"] },
            );
            if (!canMessageProviderNativeSubagentThread(thread, records.providerThreads)) {
              result.push(event);
              continue;
            }
            let run = records.runs.find((candidate) => candidate.nativeSubagentTurnId === turn.id);
            let attempt = records.attempts.find(
              (candidate) => candidate.id === run?.activeAttemptId,
            );
            const providerThread = records.providerThreads.find(
              (candidate) => candidate.id === turn.providerThreadId,
            );
            if (run === undefined && turn.status === "running" && providerThread !== undefined) {
              const ordinal =
                records.runs.reduce((max, candidate) => Math.max(max, candidate.ordinal), 0) + 1;
              const runId = idAllocator.derive.run({ threadId: thread.id, ordinal });
              const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
              run = {
                id: runId,
                threadId: thread.id,
                ordinal,
                providerInstanceId: thread.providerInstanceId,
                modelSelection: thread.modelSelection,
                providerThreadId: turn.providerThreadId,
                userMessageId:
                  records.messages.at(-1)?.id ??
                  MessageId.make(`message:native-subagent:${turn.id}`),
                rootNodeId: turn.nodeId,
                activeAttemptId: attemptId,
                status: "running",
                nativeSubagentTurnId: turn.id,
                requestedAt: turn.startedAt ?? event.occurredAt,
                startedAt: turn.startedAt ?? event.occurredAt,
                completedAt: null,
                checkpointId: null,
                contextHandoffId: null,
              };
              attempt = {
                id: attemptId,
                runId,
                attemptOrdinal: 1,
                rootNodeId: turn.nodeId,
                providerInstanceId: thread.providerInstanceId,
                providerThreadId: turn.providerThreadId,
                providerTurnId: turn.id,
                nativeThreadId: providerThread.nativeThreadRef?.nativeId ?? undefined,
                reason: "initial" as const,
                status: "running" as const,
                startedAt: run.startedAt,
                completedAt: null,
              };
              result.push(yield* append("run.created", run, runId));
              result.push(yield* append("run-attempt.updated", attempt, runId));
              result.push(
                yield* append(
                  "provider-thread.updated",
                  {
                    ...providerThread,
                    firstRunOrdinal: providerThread.firstRunOrdinal ?? ordinal,
                    lastRunOrdinal: ordinal,
                  },
                  runId,
                ),
              );
            }
            if (run === undefined || attempt === undefined) {
              result.push(event);
              continue;
            }
            result.push({
              ...event,
              runId: run.id,
              payload: { ...turn, runAttemptId: attempt.id },
            });
            if (
              ["completed", "interrupted", "failed", "cancelled"].includes(turn.status) &&
              (run.status === "running" || run.status === "waiting")
            ) {
              const status = turn.status as "completed" | "interrupted" | "failed" | "cancelled";
              const completedAt = turn.completedAt ?? event.occurredAt;
              result.push(
                yield* append("run-attempt.updated", { ...attempt, status, completedAt }, run.id),
              );
              result.push(yield* append("run.updated", { ...run, status, completedAt }, run.id));
            }
            continue;
          }
          if (event.type === "provider-thread.updated") {
            // Late native snapshots cannot erase ownership of a queued/direct turn.
            const context = yield* projections.getThreadProviderContext(
              thread.id,
              thread.providerInstanceId,
            );
            const current = context.providerThreads.find(
              (candidate) => candidate.id === event.payload.id,
            );
            result.push(
              current === undefined
                ? event
                : {
                    ...event,
                    payload: {
                      ...event.payload,
                      providerSessionId: current.providerSessionId,
                      ownerNodeId: current.ownerNodeId,
                      firstRunOrdinal: current.firstRunOrdinal,
                      lastRunOrdinal: current.lastRunOrdinal,
                    },
                  },
            );
            continue;
          }
          if (event.type === "node.updated" || event.type === "turn-item.updated") {
            const payload = event.payload;
            const providerTurnId = payload.providerTurnId;
            const providerThreadId = payload.providerThreadId;
            if (payload.runId === null && providerThreadId != null && providerTurnId != null) {
              const context = yield* projections.getProviderControlContext(thread.id, {
                providerThreadId,
                providerTurnId,
                includeRun: true,
              });
              if (
                context.run !== undefined &&
                context.run.nativeSubagentTurnId === providerTurnId
              ) {
                result.push({
                  ...event,
                  runId: context.run.id,
                  payload: {
                    ...payload,
                    runId: context.run.id,
                    ...(event.type === "node.updated"
                      ? { countsForRun: event.payload.kind === "root_turn" }
                      : {}),
                  },
                } as OrchestrationV2DomainEvent);
                continue;
              }
            }
          }
          result.push(event);
        }
        return result;
      },
    );

    const normalize: ProviderEventIngestorV2Shape["normalize"] = (input) =>
      Effect.gen(function* () {
        switch (input.event.type) {
          case "app_thread.created": {
            const child = input.event.appThread;
            const created = yield* makeDomainEvent(input, {
              type: "thread.created",
              threadId: child.id,
              payload: child,
            });
            if (input.event.driver !== "codex" || !isProviderNativeSubagentThread(child))
              return [created];
            // The child shares the parent's live process. Persist that binding
            // with its creation so all clients see the real queue/steer capabilities.
            const parent = yield* projections.getThreadRecords(input.threadId, [
              "providerSessions",
            ]);
            const session = parent.providerSessions.find(
              (candidate) => candidate.id === input.providerSessionId,
            );
            return session === undefined
              ? [created]
              : [
                  created,
                  yield* makeDomainEvent(input, {
                    type: "provider-session.attached",
                    threadId: child.id,
                    payload: session,
                  }),
                ];
          }
          case "provider_session.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "provider-session.updated",
                payload: input.event.providerSession,
              }),
            ];
          case "provider_thread.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "provider-thread.updated",
                threadId: input.event.providerThread.appThreadId ?? input.threadId,
                payload: input.event.providerThread,
              }),
            ];
          case "provider_turn.updated":
            return [
              ...(["completed", "interrupted", "failed", "cancelled"].includes(
                input.event.providerTurn.status,
              )
                ? yield* dismissNativeUserInputs(
                    input,
                    input.event.providerTurn.id,
                    input.event.threadId,
                  )
                : []),
              yield* makeDomainEvent(input, {
                type: "provider-turn.updated",
                ...(input.event.threadId === undefined ? {} : { threadId: input.event.threadId }),
                payload: input.event.providerTurn,
                nodeId: input.event.providerTurn.nodeId,
              }),
            ];
          case "node.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "node.updated",
                threadId: input.event.node.threadId,
                payload: input.event.node,
                runId: input.event.node.runId,
                nodeId: input.event.node.id,
              }),
            ];
          case "subagent.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "subagent.updated",
                threadId: input.event.subagent.threadId,
                payload: input.event.subagent,
                runId: input.event.subagent.runId,
                nodeId: input.event.subagent.id,
              }),
            ];
          case "message.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "message.updated",
                threadId: input.event.message.threadId,
                payload: input.event.message,
                runId: input.event.message.runId,
                nodeId: input.event.message.nodeId,
              }),
            ];
          case "turn_item.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "turn-item.updated",
                threadId: input.event.turnItem.threadId,
                payload: input.event.turnItem,
                runId: input.event.turnItem.runId,
                nodeId: input.event.turnItem.nodeId,
              }),
            ];
          case "runtime_request.updated":
            return [
              yield* makeDomainEvent(input, {
                type: "runtime-request.updated",
                ...(input.event.threadId === undefined ? {} : { threadId: input.event.threadId }),
                payload: input.event.runtimeRequest,
                nodeId: input.event.runtimeRequest.nodeId,
              }),
            ];
          case "plan.updated": {
            const occurredAt = yield* DateTime.now;
            const plan = input.event.plan;
            const previous =
              plan.kind === "todo_list"
                ? yield* projections.getPlan(plan.threadId, plan.id)
                : undefined;
            const payload =
              plan.kind === "todo_list"
                ? withPlanStepDurations(
                    plan,
                    previous?.kind === "todo_list" ? previous : undefined,
                    occurredAt,
                  )
                : plan;
            return [
              yield* makeDomainEvent(input, {
                type: "plan.updated",
                threadId: plan.threadId,
                payload,
                runId: plan.runId,
                nodeId: plan.nodeId,
                occurredAt,
              }),
            ];
          }
          case "turn.terminal":
            const dismissed = yield* dismissNativeUserInputs(input, input.event.providerTurnId);
            if (input.event.status !== "failed") {
              return dismissed;
            }
            const occurredAt = yield* DateTime.now;
            return [
              ...dismissed,
              yield* makeDomainEvent(input, {
                type: "turn-item.updated",
                payload: makeProviderFailureTurnItem({
                  idAllocator,
                  driver: input.event.driver,
                  threadId: input.threadId,
                  runId: input.runId ?? null,
                  nodeId: input.nodeId ?? null,
                  providerThreadId: input.event.providerThreadId,
                  providerTurnId: input.event.providerTurnId,
                  itemOrdinal: input.event.failureItemOrdinal,
                  failure: input.event.failure,
                  ...(input.event.retry === undefined ? {} : { retry: input.event.retry }),
                  ...(input.event.retryStartedAt === undefined
                    ? {}
                    : { retryStartedAt: input.event.retryStartedAt }),
                  occurredAt,
                }),
              }),
            ];
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderEventNormalizeError({
              providerSessionId: input.providerSessionId,
              threadId: input.threadId,
              providerEvent: input.event,
              cause,
            }),
        ),
      );

    return ProviderEventIngestorV2.of({
      normalize,
      ingestNormalized: (input) => {
        const nativeTarget =
          input.event.driver === "codex"
            ? (() => {
                switch (input.event.type) {
                  case "provider_turn.updated":
                    return input.event.providerTurn.runAttemptId === null
                      ? (input.event.threadId ?? input.threadId)
                      : null;
                  case "provider_thread.updated":
                    return input.event.providerThread.appThreadId !== input.threadId
                      ? input.event.providerThread.appThreadId
                      : null;
                  case "node.updated":
                    return input.event.node.runId === null ? input.event.node.threadId : null;
                  case "message.updated":
                    return input.event.message.runId === null ? input.event.message.threadId : null;
                  case "turn_item.updated":
                    return input.event.turnItem.runId === null
                      ? input.event.turnItem.threadId
                      : null;
                  default:
                    return null;
                }
              })()
            : null;
        const publish = Effect.gen(function* () {
          const normalized = yield* normalize(input);
          const events =
            nativeTarget === null ? normalized : yield* projectNativeChildEvents(input, normalized);
          if (events.length === 0) {
            return [];
          }
          const mapWriteError = (cause: unknown) =>
            new ProviderEventPublishError({
              providerSessionId: input.providerSessionId,
              eventCount: events.length,
              cause,
            });
          if (input.writeIfProviderThreadOwner !== undefined) {
            const ownerResult = yield* eventSink
              .writeIfProviderThreadOwner({
                guardPendingUserInputCancellations: true,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                ...input.writeIfProviderThreadOwner,
                events,
              })
              .pipe(Effect.mapError(mapWriteError));
            return ownerResult.storedEvents;
          }
          if (input.writeIfRunCurrent === undefined) {
            return yield* eventSink
              .write({
                guardPendingUserInputCancellations: true,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                events,
              })
              .pipe(Effect.mapError(mapWriteError));
          }
          const result = yield* eventSink
            .writeIfRunCurrent({
              guardPendingUserInputCancellations: true,
              ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
              threadId: input.threadId,
              ...input.writeIfRunCurrent,
              events,
            })
            .pipe(Effect.mapError(mapWriteError));
          return result.storedEvents;
        });
        return (
          nativeTarget === null ? publish : threadCommands.withLock(nativeTarget, publish)
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderEventPublishError({
                providerSessionId: input.providerSessionId,
                eventCount: 1,
                cause,
              }),
          ),
          Effect.flatMap((storedEvents) =>
            storedEvents.length === 0 || input.event.type !== "subagent.updated"
              ? Effect.succeed(storedEvents)
              : syncSubagentThreadModel(input, input.event.subagent).pipe(
                  Effect.map((synced) => [...storedEvents, ...synced]),
                  Effect.mapError(
                    (cause) =>
                      new ProviderEventPublishError({
                        providerSessionId: input.providerSessionId,
                        eventCount: 1,
                        cause,
                      }),
                  ),
                ),
          ),
        );
      },
    });
  }),
);
