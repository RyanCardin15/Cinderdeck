import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
// @effect-diagnostics nodeBuiltinImport:off - deterministic private lane names preserve retry identity.
import * as NodeCrypto from "node:crypto";
import * as Queue from "@t3tools/contracts/deckhand/reviewerRpc";
import * as Scope from "effect/Scope";
import * as DateTime from "effect/DateTime";
import * as Migrations from "./Migrations.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import * as Rpc from "@t3tools/contracts/deckhand/rpc";
import * as Contracts from "@t3tools/contracts/deckhand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ManagedSessionLaunch from "./ManagedSessionLaunch.ts";
import { resolveReviewerSource, ReviewerSourceError } from "./ReviewerSource.ts";
import * as Relationships from "./Relationships.ts";
import * as WorkspaceBackend from "./WorkspaceBackend.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as ProcessRunner from "../processRunner.ts";

export class ReviewerLaunch extends Context.Service<
  ReviewerLaunch,
  {
    readonly stopSource: (
      actorID: string,
      input: Queue.ReviewerSourceStopInput,
    ) => Effect.Effect<Queue.ReviewerSourceStopResult, ManagedSessionLaunch.ManagedLaunchError>;
    readonly schedule: (
      actorID: string,
      input: Queue.ReviewerLaunchInput,
    ) => Effect.Effect<Queue.ReviewerQueueRecord, ManagedSessionLaunch.ManagedLaunchError>;
    readonly getScheduled: (
      actorID: string,
      input: Queue.ReviewerQueueLookup,
    ) => Effect.Effect<Queue.ReviewerQueueRecord, ManagedSessionLaunch.ManagedLaunchError>;
    readonly cancelScheduled: (
      actorID: string,
      input: Queue.ReviewerQueueLookup,
    ) => Effect.Effect<Queue.ReviewerQueueRecord, ManagedSessionLaunch.ManagedLaunchError>;
    readonly preview: (
      input: typeof Rpc.ReviewerPreviewInput.Type,
    ) => Effect.Effect<Rpc.ReviewerLaunchPreview, ReviewerSourceError>;
    readonly launch: (
      actorID: string,
      input: Rpc.ReviewerLaunchInput,
    ) => Effect.Effect<Rpc.ManagedCreateRecord, ManagedSessionLaunch.ManagedLaunchError>;
  }
>()("t3/deckhand/ReviewerLaunch") {}
const isSourceError = Schema.is(ReviewerSourceError);
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.SessionBinding));
const encodeQueueInput = Schema.encodeEffect(Schema.fromJsonString(Queue.ReviewerLaunchInput));
const decodeQueueInput = Schema.decodeEffect(Schema.fromJsonString(Queue.ReviewerLaunchInput));
const encodeQueueRecord = Schema.encodeEffect(Schema.fromJsonString(Queue.ReviewerQueueRecord));
const decodeQueueRecord = Schema.decodeEffect(Schema.fromJsonString(Queue.ReviewerQueueRecord));
const encodePreview = Schema.encodeEffect(Schema.fromJsonString(Queue.ReviewerLaunchPreview));
const encodeRepositoryKeys = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const isManagedError = Schema.is(ManagedSessionLaunch.ManagedLaunchError);
const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const scope = yield* Scope.Scope;
  const queueLocks = yield* makeKeyedSerialExecutor<string>();
  const reviewerDependencies = yield* Effect.context<
    | Relationships.Relationships
    | WorkspaceBackend.WorkspaceBackend
    | CheckoutIdentity.CheckoutIdentity
    | ProcessRunner.ProcessRunner
    | SqlClient.SqlClient
  >();
  const sql = yield* SqlClient.SqlClient;
  const managed = yield* ManagedSessionLaunch.ManagedSessionLaunch;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const preview = (input: typeof Rpc.ReviewerPreviewInput.Type) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_sessions WHERE thread_id=${input.threadId}`;
      if (!rows[0]) return yield* new ReviewerSourceError({ reason: "invalid_feature" });
      const binding = yield* decodeSession(rows[0].record_json);
      return yield* resolveReviewerSource({
        featureId: binding.featureId,
        sourceCheckoutId: binding.checkoutId,
        ...(binding.repositoryScope?.[0]
          ? { repositoryPhysicalId: binding.repositoryScope[0] }
          : {}),
      }).pipe(Effect.provideContext(reviewerDependencies));
    }).pipe(
      Effect.mapError((cause) =>
        isSourceError(cause) ? cause : new ReviewerSourceError({ reason: "stale_context", cause }),
      ),
    );
  const launch = (actorID: string, input: Rpc.ReviewerLaunchInput) => {
    const preview = input.preview;
    const heads = preview.reviewerContext.repositories.map((repo) => `${repo.commit}`).join("\n");
    return managed.create(actorID, {
      operationKey: input.operationKey,
      ...preview,
      branch: `review/${NodeCrypto.createHash("sha256").update(input.operationKey).digest("hex").slice(0, 24)}`,
      repositoryRefs: Object.fromEntries(
        preview.reviewerContext.repositories.map((repo) => [repo.repositoryID, repo.commit]),
      ),
      setup: true,
      start: false,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      objective: `Review the following committed revision set in this isolated checkout. Source checkout changes are excluded. Do not modify the source lane or submit a hosting-provider review.\n${heads}\n\n${input.objective}`,
    });
  };
  const queueError = (key: string, reason: ManagedSessionLaunch.ManagedLaunchError["reason"]) =>
    new ManagedSessionLaunch.ManagedLaunchError({ operationKey: key, reason });
  const normalize = (key: string) => (cause: unknown) =>
    isManagedError(cause) ? cause : queueError(key, "storage");
  const readQueue = (actorID: string, key: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        actor_id: string;
        original_input_json: string;
        record_json: string;
      }>`SELECT actor_id,original_input_json,record_json FROM deckhand_reviewer_queue WHERE operation_key=${key}`;
      if (!rows[0]) return yield* queueError(key, "missing");
      if (rows[0].actor_id !== actorID) return yield* queueError(key, "wrong_actor");
      return {
        input: yield* decodeQueueInput(rows[0].original_input_json),
        record: yield* decodeQueueRecord(rows[0].record_json),
        original: rows[0].original_input_json,
      };
    }).pipe(Effect.mapError(normalize(key)));
  const saveQueue = (record: Queue.ReviewerQueueRecord) =>
    Effect.gen(function* () {
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const next = { ...record, updatedAt };
      const encoded = yield* encodeQueueRecord(next);
      yield* sql`UPDATE deckhand_reviewer_queue SET state=${next.state},updated_at=${updatedAt},record_json=${encoded} WHERE operation_key=${record.operationKey}`;
      return next;
    });
  const waitingForWriter = (input: Queue.ReviewerLaunchInput) =>
    Effect.gen(function* () {
      const keys = yield* encodeRepositoryKeys(
        input.preview.reviewerContext.repositories.map((repo) => repo.repositoryPhysicalId),
      );
      // Shared Git refs follow canonical repository identity across workspace aliases.
      const held = yield* sql`SELECT n.id FROM deckhand_native_writer_intents n
      JOIN deckhand_sessions s ON s.thread_id=n.owner_id
      JOIN deckhand_checkouts c ON c.id=s.checkout_id
      JOIN json_each(c.record_json,'$.repositories') repo
      JOIN json_each(${keys}) pin ON pin.value=json_extract(repo.value,'$.repositoryPhysicalId')
      WHERE n.installation_id=${input.preview.installationID} AND n.state IN ('pending','held','uncertain') LIMIT 1`;
      return held.length > 0;
    });
  const validateQueuedSource = (input: Queue.ReviewerLaunchInput) =>
    Effect.gen(function* () {
      const selected = input.preview.reviewerContext.repositories.find(
        (repo) => repo.repositoryID === input.preview.repositoryID,
      );
      if (!selected) return yield* queueError(input.operationKey, "stale_context");
      const current = yield* resolveReviewerSource({
        featureId: input.preview.reviewerContext.featureId,
        sourceCheckoutId: input.preview.reviewerContext.sourceCheckoutId,
        repositoryPhysicalId: selected.sourcePhysicalId,
      }).pipe(
        Effect.provideContext(reviewerDependencies),
        Effect.mapError((cause) =>
          queueError(
            input.operationKey,
            cause.reason === "dirty_source" ? "dirty_source" : "stale_context",
          ),
        ),
      );
      const currentJSON = yield* encodePreview(current);
      const expected = yield* encodePreview(input.preview);
      if (currentJSON !== expected) return yield* queueError(input.operationKey, "stale_context");
    });
  const briefCreation = (record: Rpc.ManagedCreateRecord) => ({
    operationKey: record.operationKey,
    state: record.state,
    laneID: record.laneID,
    threadID: record.launch?.threadId ?? null,
    error: record.error,
  });
  const advance = (actorID: string, key: string) =>
    queueLocks
      .withLock(
        key,
        Effect.gen(function* () {
          const saved = yield* readQueue(actorID, key);
          let record = saved.record;
          if (["accepted", "needs_refresh", "failed", "cancelled"].includes(record.state))
            return record;
          const wasUncertain = record.state === "unknown_outcome";
          if (
            !wasUncertain &&
            record.state !== "starting" &&
            (yield* waitingForWriter(saved.input))
          ) {
            return yield* saveQueue({
              ...record,
              state: "waiting_writer",
              detail:
                "Waiting for an agent process to release shared repository metadata. No reviewer lane has been created.",
            });
          }
          if (!record.attemptKey || record.state === "waiting_writer") {
            const validation = yield* validateQueuedSource(saved.input).pipe(Effect.result);
            if (validation._tag === "Failure")
              return yield* saveQueue({
                ...record,
                state: "needs_refresh",
                detail:
                  "The reviewed source changed or is unavailable. Inspect its current committed revision before scheduling a new review.",
              });
            if (record.attempts >= 8)
              return yield* saveQueue({
                ...record,
                state: "needs_refresh",
                detail:
                  "Scheduling admission changed repeatedly. Inspect the source and create a new request.",
              });
            const attempts = record.attempts + 1;
            const attemptKey = `review-queue:${NodeCrypto.createHash("sha256").update(key).digest("hex")}:${attempts}`;
            // The exact derived key is durable before any checkout or provider effect.
            record = yield* saveQueue({
              ...record,
              state: "starting",
              attempts,
              attemptKey,
              detail: "Creating the pinned reviewer lane.",
            });
          }
          const attempt = { ...saved.input, operationKey: record.attemptKey! };
          const result = yield* launch(actorID, attempt).pipe(Effect.result);
          if (result._tag === "Failure") {
            const existing = yield* managed
              .getCreation(actorID, attempt.operationKey)
              .pipe(Effect.result);
            if (existing._tag === "Failure" && existing.failure.reason === "missing") {
              return yield* saveQueue({
                ...record,
                state: "needs_refresh",
                detail:
                  "The request was refused before creation. Inspect the source and provider before scheduling again.",
              });
            }
            return yield* saveQueue({
              ...record,
              state: "unknown_outcome",
              creation:
                existing._tag === "Success" ? briefCreation(existing.success) : record.creation,
              detail:
                "Creation could not be confirmed. Continue only this exact saved request; a new lane will not be submitted.",
            });
          }
          const creation = result.success;
          const refused =
            creation.state === "failed" &&
            creation.laneID === null &&
            creation.launch === null &&
            creation.receipt?.state === "failed" &&
            creation.receipt.result == null &&
            creation.receipt.error?.code === "checkout_reserved";
          if (refused)
            return yield* saveQueue({
              ...record,
              state: "waiting_writer",
              creation: briefCreation(creation),
              detail:
                "Repository admission is still held by an agent process. This attempt was definitively refused before creation; scheduling will retry after release.",
            });
          const state: Queue.ReviewerQueueRecord["state"] =
            creation.state === "accepted"
              ? "accepted"
              : creation.state === "unknown_outcome"
                ? "unknown_outcome"
                : creation.state === "failed"
                  ? "failed"
                  : "starting";
          return yield* saveQueue({
            ...record,
            state,
            creation: briefCreation(creation),
            detail:
              state === "accepted"
                ? "The isolated reviewer conversation is ready."
                : state === "failed"
                  ? "The saved creation failed. Inspect its existing lane before taking another action."
                  : state === "unknown_outcome"
                    ? "The native outcome is uncertain. Keep this exact request for reconciliation."
                    : "Creating the pinned reviewer lane and conversation.",
          });
        }),
      )
      .pipe(Effect.mapError(normalize(key)));
  const schedule = (actorID: string, input: Queue.ReviewerLaunchInput) =>
    Effect.gen(function* () {
      const encoded = yield* encodeQueueInput(input);
      const reserved = yield* queueLocks.withLock(
        input.operationKey,
        Effect.gen(function* () {
          const old = yield* readQueue(actorID, input.operationKey).pipe(Effect.result);
          if (old._tag === "Success") {
            if (old.success.original !== encoded)
              return yield* queueError(input.operationKey, "key_conflict");
            return old.success.record;
          }
          if (old.failure.reason !== "missing") return yield* old.failure;
          // A legacy direct request owns its key permanently; scheduling it under
          // a derived attempt key would otherwise create a second reviewer.
          const legacy = yield* managed
            .getCreation(actorID, input.operationKey)
            .pipe(Effect.result);
          if (legacy._tag === "Success")
            return yield* queueError(input.operationKey, "key_conflict");
          if (legacy.failure.reason !== "missing") return yield* legacy.failure;
          yield* validateQueuedSource(input);
          const now = DateTime.formatIso(yield* DateTime.now);
          const record: Queue.ReviewerQueueRecord = {
            operationKey: input.operationKey,
            state: "queued",
            attempts: 0,
            attemptKey: null,
            preview: input.preview,
            creation: null,
            detail: "Waiting to schedule an isolated reviewer.",
            createdAt: now,
            updatedAt: now,
          };
          const json = yield* encodeQueueRecord(record);
          yield* sql`INSERT INTO deckhand_reviewer_queue(operation_key,actor_id,original_input_json,state,updated_at,record_json) VALUES(${input.operationKey},${actorID},${encoded},'queued',${now},${json})`;
          return record;
        }),
      );
      if (["accepted", "needs_refresh", "failed", "cancelled"].includes(reserved.state))
        return reserved;
      return yield* advance(actorID, input.operationKey);
    }).pipe(Effect.mapError(normalize(input.operationKey)));
  const getScheduled = (actorID: string, input: Queue.ReviewerQueueLookup) =>
    readQueue(actorID, input.operationKey).pipe(
      Effect.map((saved) => saved.record),
      Effect.mapError(normalize(input.operationKey)),
    );
  const cancelScheduled = (actorID: string, input: Queue.ReviewerQueueLookup) =>
    queueLocks
      .withLock(
        input.operationKey,
        Effect.gen(function* () {
          const saved = yield* readQueue(actorID, input.operationKey);
          if (saved.record.state === "cancelled") return saved.record;
          if (!["queued", "waiting_writer", "needs_refresh"].includes(saved.record.state))
            return yield* queueError(input.operationKey, "not_retryable");
          return yield* saveQueue({
            ...saved.record,
            state: "cancelled",
            detail: "Scheduling was cancelled before a reviewer lane was created.",
          });
        }),
      )
      .pipe(Effect.mapError(normalize(input.operationKey)));
  const stopSource = (actorID: string, input: Queue.ReviewerSourceStopInput) =>
    Effect.gen(function* () {
      const owned = yield* sql<{
        actor_id: string;
      }>`SELECT actor_id FROM deckhand_managed_launches WHERE json_extract(record_json,'$.threadId')=${input.threadId} AND json_extract(record_json,'$.state')='accepted' LIMIT 1`;
      if (!owned[0] || owned[0].actor_id !== actorID)
        return yield* queueError(input.threadId, "wrong_actor");
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_sessions WHERE thread_id=${input.threadId}`;
      if (!rows[0]) return yield* queueError(input.threadId, "missing");
      const binding = yield* decodeSession(rows[0].record_json);
      if (binding.role !== "writer") return yield* queueError(input.threadId, "stale_context");
      const shell = yield* projections.getThreadShell(input.threadId);
      const records = yield* projections.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerSessions",
      ]);
      const active = records.providerThreads.find(
        (thread) => thread.id === shell?.activeProviderThreadId,
      );
      if (active?.providerSessionId !== input.providerSessionId)
        return yield* queueError(input.threadId, "stale_context");
      const closed = providerSessions.closeForThread
        ? yield* providerSessions.closeForThread(input).pipe(Effect.result)
        : null;
      if (closed?._tag === "Success" && closed.success === "shared")
        return {
          threadId: input.threadId,
          state: "shared_session" as const,
          detail:
            "This provider process is shared with other conversations. It was not stopped; release the shared process from its owning conversations first.",
        };
      const held =
        yield* sql`SELECT id FROM deckhand_native_writer_intents WHERE owner_id=${input.threadId} AND state IN ('pending','held','uncertain') LIMIT 1`;
      if (closed?._tag === "Failure" || !closed || held.length)
        return {
          threadId: input.threadId,
          state: "unknown_outcome" as const,
          detail:
            "The process or reservation release could not be confirmed. The queue remains blocked; no reviewer checkout was admitted.",
        };
      return {
        threadId: input.threadId,
        state: "released" as const,
        detail:
          "The writer process stopped and its repository reservation was released. The lane and transcript are preserved; queued review will continue automatically once all repository reservations are clear.",
      };
    }).pipe(Effect.mapError(normalize(input.threadId)));
  const worker = Effect.gen(function* () {
    while (true) {
      yield* Effect.gen(function* () {
        const rows = yield* sql<{
          operation_key: string;
          actor_id: string;
        }>`SELECT operation_key,actor_id FROM deckhand_reviewer_queue WHERE state IN ('queued','waiting_writer','starting') ORDER BY updated_at LIMIT 8`;
        yield* Effect.forEach(
          rows,
          (row) =>
            advance(row.actor_id, row.operation_key).pipe(
              Effect.catch(() =>
                Effect.logDebug("Reviewer scheduling could not confirm its saved request"),
              ),
            ),
          { concurrency: 2 },
        );
      }).pipe(Effect.catch(() => Effect.logDebug("Reviewer queue could not be read")));
      yield* Effect.sleep("10 seconds");
    }
  });
  yield* worker.pipe(Effect.forkIn(scope));
  return ReviewerLaunch.of({
    preview,
    launch,
    schedule,
    getScheduled,
    cancelScheduled,
    stopSource,
  });
});
export const layer = Layer.effect(ReviewerLaunch, make);
