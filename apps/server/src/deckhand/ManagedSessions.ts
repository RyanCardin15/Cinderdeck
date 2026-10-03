import { type OrchestrationV2ThreadShell } from "@t3tools/contracts";
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
import * as Relationships from "./Relationships.ts";

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
export class ManagedSessions extends Context.Service<
  ManagedSessions,
  {
    readonly list: (
      input: Rpc.ManagedSessionsInput,
    ) => Effect.Effect<ReadonlyArray<Rpc.ManagedSessionView>, ManagedSessionsError>;
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
const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const sql = yield* SqlClient.SqlClient;
  const relationships = yield* Relationships.Relationships;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  const readCurrent = (binding: Contracts.SessionBinding, title: string) =>
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
          const sequence = yield* events.latestSequence();
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
            source: "unavailable" as const,
            archived: false,
          }),
        ),
      );
  const list = (input: Rpc.ManagedSessionsInput) =>
    Effect.gen(function* () {
      if (!isSessionsInput(input))
        return yield* new ManagedSessionsError({ reason: "invalid_request" });
      const rows = yield* sql<{ record_json: string; title: string }>`SELECT s.record_json,
      json_extract(f.record_json, '$.title') AS title FROM deckhand_sessions s
      JOIN deckhand_features f ON f.id = s.feature_id
      JOIN deckhand_checkouts c ON c.id = s.checkout_id
      JOIN deckhand_workspaces w ON w.id = c.workspace_id
      WHERE c.workspace_id = w.id AND w.environment_id = ${input.installationID} AND w.backend = 'cinderdeck'
        AND json_extract(c.record_json, '$.nativeGeneration') = ${input.generation}
        AND COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id) = ${input.workspaceID}
      ORDER BY s.rowid DESC LIMIT ${input.limit}`;
      return yield* Effect.forEach(rows, (row) =>
        decodeBinding(row.record_json).pipe(
          Effect.flatMap((binding) => readCurrent(binding, row.title)),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isManagedSessionsError(cause)
          ? cause
          : new ManagedSessionsError({ reason: "storage", cause }),
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
          events.stream({ afterSequence }).pipe(
            Stream.filter((stored) => stateEvent(stored.event.type)),
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
  return ManagedSessions.of({ list, subscribe });
});
export const layer = Layer.effect(ManagedSessions, make);
