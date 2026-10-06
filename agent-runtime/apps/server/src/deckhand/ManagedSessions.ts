import { type ThreadId, type OrchestrationV2ThreadShell } from "@cinderdeck/contracts";
import * as Contracts from "@cinderdeck/contracts/deckhand";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
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
import * as IntegrationHub from "./IntegrationHub.ts";

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
    readonly subscribePullRequests: (
      input: Rpc.ContextPullRequestsInput,
    ) => Stream.Stream<
      Rpc.ContextPullRequestsPage,
      ManagedSessionsError,
      IntegrationHub.IntegrationHub
    >;
    readonly subscribeContexts: (
      input: Rpc.ManagedContextsInput,
    ) => Stream.Stream<ReadonlyArray<Rpc.ManagedContextView>, ManagedSessionsError>;
    readonly subscribe: (
      input: Rpc.ManagedSessionsInput,
    ) => Stream.Stream<ReadonlyArray<Rpc.ManagedSessionView>, ManagedSessionsError>;
  }
>()("@cinderdeck/server/deckhand/ManagedSessions") {}

const isManagedSessionsError = Schema.is(ManagedSessionsError);
const isSessionsInput = Schema.is(Rpc.ManagedSessionsInput);
const isContextPullRequestsInput = Schema.is(Rpc.ContextPullRequestsInput);
const decodeContextPullRequest = Schema.decodeUnknownEffect(Rpc.ContextPullRequest);
const decodeContextPullRequestLink = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Rpc.ContextPullRequest.fields.link),
);
const decodeCheckout = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.CheckoutBinding));
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
  type.startsWith("thread.") ||
  type.startsWith("plan.");
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
  const hub = yield* Effect.serviceOption(IntegrationHub.IntegrationHub);
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
            title: shell.title || title,
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
      const rows = yield* sql<{
        record_json: string;
        title: string;
        workspace_id: string;
        checkout_json: string;
        generation: number | null;
        lane_id: string | null;
        label: string | null;
      }>`SELECT s.record_json, c.record_json AS checkout_json,
      COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id) AS workspace_id,
      json_extract(c.record_json, '$.nativeGeneration') AS generation,
      json_extract(c.record_json, '$.laneId') AS lane_id,
      COALESCE(json_extract(c.record_json, '$.laneName'),
        json_extract(c.record_json, '$.repositories[0].branch')) AS label,
      json_extract(f.record_json, '$.title') AS title FROM deckhand_sessions s
      JOIN deckhand_features f ON f.id = s.feature_id
      JOIN deckhand_current_checkouts c ON c.origin_id = s.checkout_id
      JOIN deckhand_workspaces w ON w.id = c.workspace_id
      WHERE c.workspace_id = w.id AND w.environment_id = ${input.installationID} AND w.backend = 'cinderdeck'
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads t
          WHERE t.thread_id = s.thread_id AND t.deleted_at IS NOT NULL)
        AND ((${input.scope === "workspace" ? 1 : 0} AND w.owner_id = ${input.workspaceID})
          OR (${input.scope !== "workspace" ? 1 : 0}
            AND json_extract(c.record_json, '$.nativeGeneration') = ${input.generation}
            AND COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id) = ${input.workspaceID}))
      ORDER BY s.rowid DESC LIMIT ${input.limit} OFFSET ${input.offset ?? 0}`;
      // History belongs to durable workspace/checkouts, not the live lane catalog.
      // Native availability annotates rows; it never decides whether history is readable.
      const catalog =
        input.scope === "workspace" && Option.isSome(hub)
          ? yield* hub.value
              .currentResources([...new Set(rows.map((row) => row.workspace_id))])
              .pipe(Effect.catch(() => Effect.succeed(null)))
          : null;
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const binding = yield* decodeBinding(row.record_json);
          const session = yield* readCurrent(binding, row.title, sequence);
          if (input.scope !== "workspace") return session;
          const resource = catalog?.resources.find((item) => item.workspaceID === row.workspace_id);
          const current =
            catalog?.state === "connected" &&
            catalog.hello?.installationID === input.installationID;
          const checkout = yield* decodeCheckout(row.checkout_json);
          const samePhysicalCheckout =
            checkout.repositories.length > 0 &&
            checkout.repositories.length === resource?.workspace?.repos.length &&
            checkout.repositories.every((repo) =>
              resource?.workspace?.repos.some(
                (live) =>
                  live.physicalID === repo.physicalId &&
                  live.repositoryPhysicalID === repo.repositoryPhysicalId,
              ),
            );
          const available =
            resource?.available && (resource.generation === row.generation || samePhysicalCheckout);
          return {
            ...session,
            context: {
              workspaceID: row.workspace_id,
              generation: row.generation,
              label: row.lane_id
                ? ((available ? resource.workspace?.lane?.name : undefined) ??
                  row.label ??
                  row.lane_id)
                : "Primary checkout",
              lane: row.lane_id !== null,
              availability: !current
                ? ("unknown" as const)
                : available
                  ? ("available" as const)
                  : ("removed" as const),
            },
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
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads t
            WHERE t.thread_id = s.thread_id AND t.deleted_at IS NOT NULL)
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
        owner_id: string;
        owner_generation: number;
        generation: number;
        total: number;
        record_json: string;
        title: string;
        objective: string;
      }>`
      WITH scoped AS (
        SELECT COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id) AS workspace_id,
          w.owner_id, json_extract(c.record_json, '$.workspaceGeneration') AS owner_generation,
          json_extract(c.record_json, '$.nativeGeneration') AS generation,
          s.record_json, json_extract(f.record_json, '$.title') AS title,
          json_extract(f.record_json, '$.objective') AS objective,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id), json_extract(c.record_json, '$.nativeGeneration') ORDER BY s.rowid DESC) AS rank,
          COUNT(*) OVER (PARTITION BY COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id), json_extract(c.record_json, '$.nativeGeneration')) AS total
        FROM deckhand_sessions s JOIN deckhand_features f ON f.id = s.feature_id
        JOIN deckhand_current_checkouts c ON c.origin_id = s.checkout_id JOIN deckhand_workspaces w ON w.id = c.workspace_id
        WHERE w.environment_id = ${input.installationID} AND w.backend = 'cinderdeck'
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads t
            WHERE t.thread_id = s.thread_id AND t.deleted_at IS NOT NULL)
          AND EXISTS (SELECT 1 FROM json_each(${targets}) t
            WHERE json_extract(t.value, '$.workspaceID') = COALESCE(json_extract(c.record_json, '$.laneId'), w.owner_id)
              AND json_extract(t.value, '$.generation') = json_extract(c.record_json, '$.nativeGeneration')
              OR json_extract(t.value, '$.workspaceID') = w.owner_id
                AND json_extract(t.value, '$.generation') = json_extract(c.record_json, '$.workspaceGeneration'))
      ) SELECT workspace_id, owner_id, owner_generation, generation, total, record_json, title, objective FROM scoped ORDER BY workspace_id, rank`;
      // Count every matching saved agent, including older sessions and collapsed lanes.
      // Read canonical shells only; keep the returned sibling summaries bounded to four.
      const shells = new Map<ThreadId, OrchestrationV2ThreadShell | null>();
      const observed = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const binding = yield* decodeBinding(row.record_json);
          if (!shells.has(binding.threadId)) {
            const shell = yield* projections
              .getThreadShell(binding.threadId)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            shells.set(binding.threadId, shell);
          }
          return { row, threadId: binding.threadId, shell: shells.get(binding.threadId) ?? null };
        }),
      );
      const activityFor = (matches: typeof observed): Rpc.AgentActivityCounts => {
        const counts = { running: 0, review: 0, unavailable: false };
        const seen = new Set<ThreadId>();
        for (const { threadId, shell } of matches) {
          if (seen.has(threadId)) continue;
          seen.add(threadId);
          if (!shell) {
            counts.unavailable = true;
            continue;
          }
          if (shell.archivedAt || shell.deletedAt) continue;
          const state = execution(shell);
          if (
            shell.hasActionableProposedPlan ||
            shell.lastError ||
            ["waiting_input", "waiting_approval", "failed"].includes(state)
          )
            counts.review++;
          else if (["queued", "starting", "working"].includes(state)) counts.running++;
        }
        return counts;
      };
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
          const sessions = yield* Effect.forEach(group.slice(0, 4), (row) =>
            decodeBinding(row.record_json).pipe(
              Effect.flatMap((binding) => readCurrent(binding, row.title, sequence, row.objective)),
            ),
          );
          return {
            ...target,
            total: group[0]?.total ?? 0,
            sessions,
            agentActivity: activityFor(
              observed.filter(
                ({ row }) =>
                  row.workspace_id === target.workspaceID && row.generation === target.generation,
              ),
            ),
            workspaceAgentActivity: activityFor(
              observed.filter(
                ({ row }) =>
                  row.owner_id === target.workspaceID && row.owner_generation === target.generation,
              ),
            ),
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
  const subscribePullRequests = (input: Rpc.ContextPullRequestsInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (!isContextPullRequestsInput(input))
          return yield* new ManagedSessionsError({ reason: "invalid_request" });
        const hub = yield* IntegrationHub.IntegrationHub;
        // Refresh before SQL ownership: native I/O must never wait inside the transaction.
        const fresh = yield* hub
          .freshResource(input.workspaceID)
          .pipe(Effect.mapError(() => new ManagedSessionsError({ reason: "source_unavailable" })));
        if (
          fresh.hello.installationID !== input.installationID ||
          fresh.resource.workspaceID !== input.workspaceID ||
          fresh.resource.generation !== input.generation ||
          !fresh.resource.available ||
          !fresh.resource.workspace ||
          fresh.resource.workspace.definitionChanged ||
          fresh.resource.workspace.issues.length
        )
          return yield* new ManagedSessionsError({ reason: "source_unavailable" });
        const read = Effect.gen(function* () {
          const current = yield* hub.currentResources([input.workspaceID]);
          const resource = current.resources.find((item) => item.workspaceID === input.workspaceID);
          if (
            current.state !== "connected" ||
            current.hello?.installationID !== input.installationID ||
            current.hello.runtimeEpoch !== fresh.hello.runtimeEpoch ||
            !resource?.available ||
            resource.generation !== input.generation ||
            !resource.workspace ||
            resource.workspace.definitionChanged ||
            resource.workspace.issues.length
          )
            return yield* new ManagedSessionsError({ reason: "source_unavailable" });
          // Read PR metadata directly, never transcripts. Canonical deduplication precedes
          // pagination, so old/archived contributors and every repository remain reachable.
          const rows = yield* sql<{
            project_id: string;
            thread_id: string;
            link_json: string;
            total: number;
          }>`
          WITH linked AS (
            SELECT json_extract(t.payload_json,'$.projectId') AS project_id, s.thread_id,
              p.value AS link_json,
              ROW_NUMBER() OVER (PARTITION BY lower(json_extract(p.value,'$.host')),
                lower(json_extract(p.value,'$.repository')), json_extract(p.value,'$.number')
                ORDER BY s.rowid DESC, p.key DESC) AS rank
            FROM deckhand_sessions s
            JOIN deckhand_current_checkouts c ON c.origin_id=s.checkout_id
            JOIN deckhand_workspaces w ON w.id=c.workspace_id
            JOIN orchestration_v2_projection_threads t ON t.thread_id=s.thread_id
            JOIN json_each(t.payload_json,'$.pullRequests') p
            WHERE w.environment_id=${input.installationID} AND w.backend='cinderdeck'
              AND json_extract(c.record_json,'$.backend')='cinderdeck'
              AND json_extract(c.record_json,'$.environmentId')=${input.installationID}
              AND json_extract(c.record_json,'$.nativeGeneration')=${input.generation}
              AND COALESCE(json_extract(c.record_json,'$.laneId'),w.owner_id)=${input.workspaceID}
              AND t.deleted_at IS NULL AND json_extract(p.value,'$.source')!='stack-dismissed'
          ), canonical AS (SELECT * FROM linked WHERE rank=1),
          page AS (SELECT *,COUNT(*) OVER () AS total FROM canonical
            ORDER BY lower(json_extract(link_json,'$.host')),lower(json_extract(link_json,'$.repository')),
              json_extract(link_json,'$.number') LIMIT ${input.limit} OFFSET ${input.offset})
          SELECT project_id,thread_id,link_json,total FROM page
          UNION ALL SELECT NULL,NULL,NULL,(SELECT COUNT(*) FROM canonical) WHERE NOT EXISTS(SELECT 1 FROM page)`;
          const items = yield* Effect.forEach(
            rows.filter((row) => row.link_json !== null),
            (row) =>
              decodeContextPullRequestLink(row.link_json).pipe(
                Effect.flatMap((link) =>
                  decodeContextPullRequest({
                    projectId: row.project_id,
                    threadId: row.thread_id,
                    link,
                  }),
                ),
              ),
          );
          const total = rows[0]?.total ?? 0;
          return {
            ...input,
            items,
            total,
            nextOffset: input.offset + items.length < total ? input.offset + items.length : null,
          };
        }).pipe(sql.withTransaction);
        const afterSequence = yield* events.latestSequence();
        const initial = yield* read;
        const changes = Stream.mergeAll({ concurrency: 3 })([
          events.stream({ afterSequence }).pipe(
            Stream.filter((stored) =>
              [
                "thread.created",
                "thread.metadata-updated",
                "thread.pull-request-synced",
                "thread.deleted",
                "thread.archived",
                "thread.unarchived",
              ].includes(stored.event.type),
            ),
            Stream.map(() => undefined),
            Stream.mapError(
              (cause) => new ManagedSessionsError({ reason: "source_unavailable", cause }),
            ),
          ),
          ownershipChanges,
          hub.subscribe({ offset: 0, limit: 1, selectedContextID: input.workspaceID }).pipe(
            // The first subscription image may already differ from the initial read.
            Stream.map(() => undefined),
            Stream.mapError(
              (cause) => new ManagedSessionsError({ reason: "source_unavailable", cause }),
            ),
          ),
        ]).pipe(
          Stream.buffer({ capacity: 1, strategy: "sliding" }),
          Stream.mapEffect(() => read),
        );
        return Stream.concat(Stream.make(initial), changes);
      }),
    ).pipe(
      Stream.mapError((cause) =>
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
            Stream.merge(
              ownershipChanges,
              input.scope === "workspace" && Option.isSome(hub)
                ? hub.value.subscribe({ offset: 0, limit: 1 }).pipe(
                    Stream.map(() => undefined),
                    Stream.catch(() => Stream.make(undefined)),
                  )
                : Stream.empty,
            ),
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
  return ManagedSessions.of({
    list,
    subscribe,
    subscribeThread,
    contexts,
    subscribeContexts,
    subscribePullRequests,
  });
});
export const layer = Layer.effect(ManagedSessions, make);
