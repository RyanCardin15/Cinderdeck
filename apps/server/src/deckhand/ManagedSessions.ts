import { type ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Contracts from "@t3tools/contracts/deckhand";
import * as Rpc from "@t3tools/contracts/deckhand/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Migrations from "./Migrations.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as Option from "effect/Option";
import * as Relationships from "./Relationships.ts";
import * as External from "./ExternalSessions.ts";

export class ManagedSessionsError extends Schema.TaggedError<ManagedSessionsError>()(
  "ManagedSessionsError",
  {
    reason: Schema.Literals(["storage", "source_unavailable", "invalid_request"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Managed session projection ${this.reason}.`;
  }
}
export interface ManagedThreadProjectionInput {
  readonly installationID: string;
  readonly workspaceID: string;
  readonly generation: number;
  readonly sessionID: Contracts.SessionBinding["id"];
  readonly threadID: ThreadId;
  readonly checkoutID: Contracts.SessionBinding["checkoutId"];
}

export class ManagedSessions extends Context.Service<
  ManagedSessions,
  {
    readonly list: (
      input: Rpc.ManagedSessionsInput,
    ) => Effect.Effect<ReadonlyArray<Rpc.ManagedSessionView>, ManagedSessionsError>;
    readonly subscribeThread: (
      input: ManagedThreadProjectionInput,
    ) => Stream.Stream<Rpc.ManagedSessionView | null, ManagedSessionsError>;
    readonly contexts: (
      input: Rpc.ManagedContextsInput,
    ) => Effect.Effect<ReadonlyArray<Rpc.ManagedContextView>, ManagedSessionsError>;
    readonly subscribeContexts: (
      input: Rpc.ManagedContextsInput,
    ) => Stream.Stream<ReadonlyArray<Rpc.ManagedContextView>, ManagedSessionsError>;
    readonly subscribe: (
      input: Rpc.ManagedSessionsInput,
    ) => Stream.Stream<ReadonlyArray<Rpc.ManagedSessionView>, ManagedSessionsError>;
  }
>()("t3/deckhand/ManagedSessions") {}

const isManagedSessionsError = Schema.is(ManagedSessionsError);
const isSessionsInput = Schema.is(Rpc.ManagedSessionsInput);
const decodeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.SessionBinding));
const execution = (shell: OrchestrationV2ThreadShell): Contracts.SessionBinding["execution"] => {
  if (shell.pendingRuntimeRequest) {
    switch (shell.pendingRuntimeRequest.kind) {
      case "user_input":
      case "auth_refresh":
        return "waiting_input";
      case "dynamic_tool_call":
        return "working";
      default:
        return "waiting_approval";
    }
  }
  switch (shell.activityRunStatus ?? shell.status) {
    case "queued":
      return "queued";
    case "preparing":
    case "starting":
      return "starting";
    case "running":
      return "working";
    case "waiting":
      return "waiting_input";
    case "completed":
      return "finished_turn";
    case "cancelled":
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "idle":
    case "rolled_back":
      return "idle";
  }
};
const stateEvent = (type: string) =>
  type.startsWith("run.") ||
  type.startsWith("provider-session.") ||
  type.startsWith("provider-thread.") ||
  type.startsWith("runtime-request.") ||
  type.startsWith("thread.");
const isManagedContextsInput = Schema.is(Rpc.ManagedContextsInput);
const encodeContextTargets = Schema.encodeEffect(
  Schema.fromJsonString(Rpc.ManagedContextsInput.fields.contexts),
);
const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const sql = yield* SqlClient.SqlClient;
  const relationships = yield* Relationships.Relationships;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  const external = yield* External.ExternalSessions;
  const ownership = yield* Effect.serviceOption(CurrentCheckout.CurrentCheckout);
  const ownershipChanges = Option.isSome(ownership)
    ? ownership.value.changes.pipe(Stream.map(() => undefined))
    : Stream.empty;
  const readCurrent = (
    binding: Contracts.SessionBinding,
    title: string,
    sequence: number,
    objective?: string,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Canonical control reads and their durable event watermark share one SQLite
          // transaction. No transcript is copied and a timer never advances session state.
          const shell = yield* projections.getThreadShell(binding.threadId);
          if (!shell) return yield* new ManagedSessionsError({ reason: "source_unavailable" });
          const records = yield* projections.getThreadRecords(binding.threadId, [
            "providerThreads",
            "providerSessions",
          ]);
          const thread = records.providerThreads.find(
            (item) => item.id === shell.activeProviderThreadId,
          );
          const session = records.providerSessions.find(
            (item) => item.id === thread?.providerSessionId,
          );
          const live = session && ["ready", "running", "waiting"].includes(session.status);
          const old = yield* relationships.session(binding.id);

          if (sequence < old.lastSequence)
            return yield* new ManagedSessionsError({ reason: "source_unavailable" });
          const next: Contracts.SessionBinding = {
            ...old,
            providerSessionId: session?.id ?? null,
            providerInstanceId: shell.providerInstanceId,
            execution: execution(shell),
            connection: live
              ? "connected"
              : session?.status === "starting"
                ? "reconnecting"
                : "unavailable",
            capabilities: session
              ? {
                  ...old.capabilities,
                  interrupt: session.capabilities.turns.supportsInterrupt,
                  steering: session.capabilities.turns.supportsActiveSteering,
                  approvals:
                    session.capabilities.approvals.supportsCommandApproval ||
                    session.capabilities.approvals.supportsFileChangeApproval,
                  questions: session.capabilities.planning.supportsStructuredQuestions,
                }
              : old.capabilities,
            lastSequence: Math.max(sequence, old.lastSequence),
          };
          if (sequence > old.lastSequence) yield* relationships.putSession(next, old.lastSequence);
          return {
            binding: next,
            title,
            ...(objective !== undefined ? { objective } : {}),
            pullRequests: shell.pullRequests ?? [],
            source: "current" as const,
            archived: shell.archivedAt !== null || shell.deletedAt !== null,
          };
        }),
      )
      .pipe(
        Effect.catch(() =>
          Effect.succeed({
            binding: {
              ...binding,
              execution: "unknown" as const,
              connection: "unavailable" as const,
            },
            title,
            ...(objective !== undefined ? { objective } : {}),
            source: "unavailable" as const,
            archived: false,
          }),
        ),
      );
  const list = (input: Rpc.ManagedSessionsInput) =>
    Effect.gen(function* () {
      if (!isSessionsInput(input))
        return yield* new ManagedSessionsError({ reason: "invalid_request" });
      const sequence = yield* events.latestSequence();
      const rows = yield* sql<{ record_json: string; title: string }>`SELECT s.record_json,
      json_extract(f.record_json, '$.title') AS title FROM deckhand_sessions s
      JOIN deckhand_features f ON f.id = s.feature_id
      JOIN deckhand_current_checkouts c ON c.origin_id = s.checkout_id
      JOIN deckhand_workspaces w ON w.id = c.workspace_id
      WHERE c.workspace_id = w.id AND w.environment_id = ${input.installationID} AND w.backend = 'cinderdeck'
        AND json_extract(c.record_json, '$.nativeGeneration') = ${input.generation}
        AND COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id) = ${input.workspaceID}
      ORDER BY s.rowid DESC LIMIT ${input.limit} OFFSET ${input.offset ?? 0}`;
      return yield* Effect.forEach(rows, (row) =>
        decodeBinding(row.record_json).pipe(
          Effect.flatMap((binding) => readCurrent(binding, row.title, sequence)),
        ),
      );
    }).pipe(
      sql.withTransaction,
      Effect.mapError((cause) =>
        isManagedSessionsError(cause)
          ? cause
          : new ManagedSessionsError({ reason: "storage", cause }),
      ),
    );
  // Internal only: ThreadContext supplies the exact saved binding it already loaded.
  // Lane summaries stay bounded independently of the opened conversation's age.
  const exactThread = (input: ManagedThreadProjectionInput) =>
    Effect.gen(function* () {
      if (!isSessionsInput({ ...input, limit: 1 }))
        return yield* new ManagedSessionsError({ reason: "invalid_request" });
      const sequence = yield* events.latestSequence();
      const rows = yield* sql<{ record_json: string; title: string }>`SELECT s.record_json,
        json_extract(f.record_json, '$.title') AS title FROM deckhand_sessions s
        JOIN deckhand_features f ON f.id = s.feature_id
        JOIN deckhand_current_checkouts c ON c.origin_id = s.checkout_id
        JOIN deckhand_workspaces w ON w.id = c.workspace_id
        WHERE s.id = ${input.sessionID} AND s.thread_id = ${input.threadID}
          AND s.checkout_id = ${input.checkoutID}
          AND w.environment_id = ${input.installationID} AND w.backend = 'cinderdeck'
          AND json_extract(c.record_json, '$.nativeGeneration') = ${input.generation}
          AND COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id) = ${input.workspaceID}
        LIMIT 1`;
      return rows[0]
        ? yield* decodeBinding(rows[0].record_json).pipe(
            Effect.flatMap((binding) => readCurrent(binding, rows[0]!.title, sequence)),
          )
        : null;
    }).pipe(
      sql.withTransaction,
      Effect.mapError((cause) =>
        isManagedSessionsError(cause)
          ? cause
          : new ManagedSessionsError({ reason: "storage", cause }),
      ),
    );
  const subscribeThread = (input: ManagedThreadProjectionInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const afterSequence = yield* events.latestSequence();
        const initial = yield* exactThread(input);
        return Stream.concat(
          Stream.make(initial),
          Stream.merge(
            events.stream({ afterSequence }).pipe(
              Stream.filter((stored) => stateEvent(stored.event.type)),
              Stream.map(() => undefined),
            ),
            ownershipChanges,
          ).pipe(
            Stream.buffer({ capacity: 1, strategy: "sliding" }),
            Stream.mapEffect(() => exactThread(input)),
          ),
        );
      }),
    ).pipe(
      Stream.mapError((cause) =>
        isManagedSessionsError(cause)
          ? cause
          : new ManagedSessionsError({ reason: "source_unavailable", cause }),
      ),
    );

  const contexts = (input: Rpc.ManagedContextsInput) =>
    Effect.gen(function* () {
      if (
        !isManagedContextsInput(input) ||
        new Set(input.contexts.map((item) => item.workspaceID)).size !== input.contexts.length
      )
        return yield* new ManagedSessionsError({ reason: "invalid_request" });
      // One page-scoped query, not an independent subscription per lane. Window counts
      // include saved sessions beyond the four visible summaries; no transcript is read.
      const targets = yield* encodeContextTargets(input.contexts);
      // One durable watermark per SQL snapshot, shared by every bounded session summary.
      const sequence = yield* events.latestSequence();
      const rows = yield* sql<{
        workspace_id: string;
        generation: number;
        total: number;
        record_json: string;
        title: string;
        objective: string;
      }>`
      WITH scoped AS (
        SELECT COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id) AS workspace_id,
          json_extract(c.record_json, '$.nativeGeneration') AS generation,
          s.record_json, json_extract(f.record_json, '$.title') AS title,
          json_extract(f.record_json, '$.objective') AS objective,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id), json_extract(c.record_json, '$.nativeGeneration') ORDER BY s.rowid DESC) AS rank,
          COUNT(*) OVER (PARTITION BY COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id), json_extract(c.record_json, '$.nativeGeneration')) AS total
        FROM deckhand_sessions s JOIN deckhand_features f ON f.id = s.feature_id
        JOIN deckhand_current_checkouts c ON c.origin_id = s.checkout_id JOIN deckhand_workspaces w ON w.id = c.workspace_id
        WHERE w.environment_id = ${input.installationID} AND w.backend = 'cinderdeck'
          AND EXISTS (SELECT 1 FROM json_each(${targets}) t
            WHERE json_extract(t.value, '$.workspaceID') = COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id)
              AND json_extract(t.value, '$.generation') = json_extract(c.record_json, '$.nativeGeneration'))
      ) SELECT workspace_id, generation, total, record_json, title, objective FROM scoped WHERE rank <= 4 ORDER BY workspace_id, rank`;
      const externalSummaries = yield* external.summaries(input).pipe(
        Effect.catch(() =>
          Effect.succeed(
            input.contexts.map((target) => ({
              ...target,
              activeCount: 0,
              staleCount: 0,
              lastSeenAt: null,
              unavailable: true,
            })),
          ),
        ),
      );
      return yield* Effect.forEach(input.contexts, (target) =>
        Effect.gen(function* () {
          const group = rows.filter(
            (row) =>
              row.workspace_id === target.workspaceID && row.generation === target.generation,
          );
          const sessions = yield* Effect.forEach(group, (row) =>
            decodeBinding(row.record_json).pipe(
              Effect.flatMap((binding) => readCurrent(binding, row.title, sequence, row.objective)),
            ),
          );
          return {
            ...target,
            total: group[0]?.total ?? 0,
            sessions,
            externalSessions: externalSummaries.find(
              (item) =>
                item.workspaceID === target.workspaceID && item.generation === target.generation,
            ) ?? { ...target, activeCount: 0, staleCount: 0, lastSeenAt: null, unavailable: true },
          };
        }),
      );
    }).pipe(
      sql.withTransaction,
      Effect.mapError((cause) =>
        isManagedSessionsError(cause)
          ? cause
          : new ManagedSessionsError({ reason: "storage", cause }),
      ),
    );
  const subscribeContexts = (input: Rpc.ManagedContextsInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const afterSequence = yield* events.latestSequence();
        const initial = yield* contexts(input);
        return Stream.concat(
          Stream.make(initial),
          Stream.mergeAll(
            [
              events.stream({ afterSequence }).pipe(
                Stream.filter((stored) => stateEvent(stored.event.type)),
                Stream.map(() => undefined),
              ),
              external.changes,
              ownershipChanges,
              // Expiry changes only reported connection freshness, never process execution.
              Stream.tick("30 seconds"),
            ],
            { concurrency: 4 },
          ).pipe(
            // Each refresh reads the latest canonical image; keep only one
            // pending invalidation while a bounded page is being projected.
            Stream.buffer({ capacity: 1, strategy: "sliding" }),
            Stream.mapEffect(() => contexts(input)),
          ),
        );
      }),
    ).pipe(
      Stream.mapError((cause) =>
        isManagedSessionsError(cause)
          ? cause
          : new ManagedSessionsError({ reason: "source_unavailable", cause }),
      ),
    );
  const subscribe = (input: Rpc.ManagedSessionsInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const afterSequence = yield* events.latestSequence();
        const initial = yield* list(input);
        // Replay after the captured watermark closes the gap between initial read and
        // live subscription. Only lifecycle/control events trigger another bounded read.
        return Stream.concat(
          Stream.make(initial),
          Stream.merge(
            events.stream({ afterSequence }).pipe(
              Stream.filter((stored) => stateEvent(stored.event.type)),
              Stream.map(() => undefined),
            ),
            ownershipChanges,
          ).pipe(
            Stream.buffer({ capacity: 1, strategy: "sliding" }),
            Stream.mapEffect(() => list(input)),
          ),
        );
      }),
    ).pipe(
      Stream.mapError((cause) =>
        isManagedSessionsError(cause)
          ? cause
          : new ManagedSessionsError({ reason: "source_unavailable", cause }),
      ),
    );
  return ManagedSessions.of({ list, subscribe, subscribeThread, contexts, subscribeContexts });
});
export const layer = Layer.effect(ManagedSessions, make);
