import { isProviderNativeSubagentThread, type ThreadId } from "@cinderdeck/contracts";
import * as Contracts from "@cinderdeck/contracts/deckhand";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as ManagedSessions from "./ManagedSessions.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as Relationships from "./Relationships.ts";
import * as Migrations from "./Migrations.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export class ThreadContextError extends Schema.TaggedError<ThreadContextError>()(
  "ThreadContextError",
  {
    reason: Schema.Literals(["storage", "invalid_context"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return "The saved lane context could not be loaded.";
  }
}
export class ThreadContext extends Context.Service<
  ThreadContext,
  {
    readonly subscribe: (
      input: Rpc.ThreadContextInput,
    ) => Stream.Stream<Rpc.ThreadContextView | null, ThreadContextError>;
  }
>()("@cinderdeck/server/deckhand/ThreadContext") {}
const isThreadContextError = Schema.is(ThreadContextError);
const isCurrentError = Schema.is(CurrentCheckout.CurrentCheckoutError);
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.SessionBinding));
const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const sql = yield* SqlClient.SqlClient;
  const relationships = yield* Relationships.Relationships;
  const ownershipDependencies = yield* Effect.context<
    SqlClient.SqlClient | Relationships.Relationships
  >();
  const currentCheckout = (id: string) =>
    CurrentCheckout.resolveCurrentCheckout(id).pipe(Effect.provide(ownershipDependencies));

  const hub = yield* IntegrationHub.IntegrationHub;
  const sessions = yield* ManagedSessions.ManagedSessions;
  const projectionStore = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  const load = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_sessions WHERE thread_id = ${threadId}`;
      if (!rows[0]) return null;
      const session = yield* decodeSession(rows[0].record_json);
      const checkout = yield* currentCheckout(session.checkoutId);
      const workspace = yield* relationships.workspace(checkout.workspaceId);
      const feature = yield* relationships.feature(session.featureId);
      if (workspace.backend !== "cinderdeck") return null;
      if (!checkout.nativeGeneration || checkout.environmentId !== workspace.environmentId)
        return yield* new ThreadContextError({ reason: "invalid_context" });
      return { session, checkout, workspace, feature };
    });
  // Provider-owned helpers have no independent managed binding. Follow only their
  // saved display lineage; launch and MCP retain exact lookups.
  const loadDisplayContext = (requestedThreadId: ThreadId) =>
    Effect.gen(function* () {
      const direct = yield* load(requestedThreadId);
      if (direct) return { ...direct, requestedThreadId };
      if (Option.isNone(projectionStore)) return null;
      const visited = new Set<ThreadId>([requestedThreadId]);
      let child = yield* projectionStore.value.getThreadShell(requestedThreadId);
      let parentThreadId: ThreadId | undefined;
      for (let depth = 0; depth < 16; depth += 1) {
        if (!child || child.deletedAt !== null || !isProviderNativeSubagentThread(child))
          return null;
        const nextId = child.lineage.parentThreadId;
        if (!nextId || visited.has(nextId)) return null;
        visited.add(nextId);
        parentThreadId ??= nextId;
        const parent = yield* projectionStore.value.getThreadShell(nextId);
        if (!parent || parent.deletedAt !== null || parent.projectId !== child.projectId)
          return null;
        const managed = yield* load(nextId);
        if (managed) return { ...managed, requestedThreadId, parentThreadId };
        child = parent;
      }
      return null;
    });
  const ownership = yield* Effect.serviceOption(CurrentCheckout.CurrentCheckout);
  const build = (input: Rpc.ThreadContextInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const savedResult = yield* loadDisplayContext(input.threadId).pipe(Effect.result);
        if (
          savedResult._tag === "Failure" &&
          isCurrentError(savedResult.failure) &&
          ["pending", "unknown_outcome"].includes(savedResult.failure.reason)
        )
          return Stream.make(null);
        if (savedResult._tag === "Failure") return yield* savedResult.failure;
        const saved = savedResult.success;
        if (!saved) return Stream.make(null);
        const workspaceID = saved.checkout.laneId ?? saved.workspace.ownerId;
        // A failed refresh preserves history, never turns remembered service URLs into live ones.
        yield* hub.resource(workspaceID).pipe(Effect.ignore);
        const states = sessions.subscribe({
          installationID: saved.workspace.environmentId,
          workspaceID,
          generation: saved.checkout.nativeGeneration!,
          limit: 20,
        });
        const exact = sessions.subscribeThread({
          installationID: saved.workspace.environmentId,
          workspaceID,
          generation: saved.checkout.nativeGeneration!,
          sessionID: saved.session.id,
          threadID: saved.session.threadId,
          checkoutID: saved.session.checkoutId,
        });
        const current = states.pipe(
          Stream.zipLatestWith(exact, (siblings, selected) => ({ siblings, selected })),
        );
        return hub.subscribe({ offset: 0, limit: 1, selectedContextID: workspaceID }).pipe(
          Stream.zipLatestWith(current, (view, currentSessions) => {
            const resource = view.selectedResources?.find(
              (item) =>
                item.workspaceID === workspaceID &&
                item.generation === saved.checkout.nativeGeneration,
            );
            const sameHost = view.hello?.installationID === saved.workspace.environmentId;
            return {
              ...saved,
              session: currentSessions.selected?.binding ?? {
                ...saved.session,
                execution: "unknown",
                connection: "unavailable",
              },
              native:
                sameHost && view.state === "connected" && resource?.available ? resource : null,
              nativeConnection: sameHost ? view.state : "identity_changed",
              ...(sameHost && view.hello ? { nativeChannel: view.hello.channel } : {}),
              sessions: currentSessions.siblings,
            } satisfies Rpc.ThreadContextView;
          }),
        );
      }),
    ).pipe(
      Stream.mapError((cause) =>
        isThreadContextError(cause) ? cause : new ThreadContextError({ reason: "storage", cause }),
      ),
    );
  const subscribe = (input: Rpc.ThreadContextInput) =>
    Option.isSome(ownership)
      ? ownership.value.changes.pipe(Stream.switchMap(() => build(input)))
      : build(input);
  return ThreadContext.of({ subscribe });
});
export const layer = Layer.effect(ThreadContext, make);
