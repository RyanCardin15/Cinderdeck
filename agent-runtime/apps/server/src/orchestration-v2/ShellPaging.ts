import {
  ThreadId,
  ProjectId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ShellPageInput,
} from "@cinderdeck/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
interface ActiveShellIndexEntry extends Pick<
  OrchestrationV2ThreadShell,
  "id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "pinnedAt" | "snoozedUntil"
> {
  readonly mayBeLive: boolean;
}
const makeIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listActiveShellIndex = Effect.fn("ProjectionStore.listActiveShellIndex")(function* () {
    const rows = yield* sql<{
      readonly thread_id: string;
      readonly project_id: string;
      readonly relationship_to_parent: string | null;
      readonly parent_thread_id: string | null;
      readonly root_thread_id: string;
      readonly side_chat: number | null;
      readonly settled_override: string | null;
      readonly settled_at: string | null;
      readonly pinned_at: string | null;
      readonly snoozed_until: string | null;
      readonly may_be_live: number;
    }>`
        SELECT
          t.thread_id,
          t.project_id,
          json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship_to_parent,
          json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
          json_extract(t.payload_json, '$.lineage.rootThreadId') AS root_thread_id,
          json_extract(t.payload_json, '$.lineage.sideChat') AS side_chat,
          json_extract(t.payload_json, '$.settledOverride') AS settled_override,
          json_extract(t.payload_json, '$.settledAt') AS settled_at,
          json_extract(t.payload_json, '$.pinnedAt') AS pinned_at,
          json_extract(t.payload_json, '$.snoozedUntil') AS snoozed_until,
          -- A superset of isLiveSubagentShell: the sources of its run status, pending request,
          -- and pending background work.
          (
            EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs r
              WHERE r.thread_id = t.thread_id
                AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
            )
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runtime_requests request
              WHERE request.thread_id = t.thread_id AND request.status = 'pending'
            )
            -- Same predicates as the shell's pending item and link reads, for their partial indexes.
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items item
              WHERE item.thread_id = t.thread_id
                AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                AND item.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
            )
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items link_request
              WHERE link_request.thread_id = t.thread_id
                AND link_request.type = 'link_request' AND link_request.status = 'waiting'
            )
            OR EXISTS (
              SELECT 1 FROM orchestration_v2_projection_provider_threads provider_thread
              WHERE provider_thread.thread_id = t.thread_id
                AND json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
            )
            OR EXISTS (
              SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') link
              WHERE json_type(link.value, '$.watch') IS NOT NULL
            )
          ) AS may_be_live
        FROM orchestration_v2_projection_threads t
        WHERE t.deleted_at IS NULL
          AND json_extract(t.payload_json, '$.archivedAt') IS NULL
        ORDER BY t.updated_at ASC, t.thread_id ASC
      `;
    return rows.map((row): ActiveShellIndexEntry => ({
      id: ThreadId.make(row.thread_id),
      projectId: ProjectId.make(row.project_id),
      lineage: {
        parentThreadId: row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
        relationshipToParent:
          row.relationship_to_parent === "fork" || row.relationship_to_parent === "subagent"
            ? row.relationship_to_parent
            : null,
        rootThreadId: ThreadId.make(row.root_thread_id),
        ...(row.side_chat === null ? {} : { sideChat: row.side_chat === 1 }),
      },
      settledOverride:
        row.settled_override === "settled" || row.settled_override === "active"
          ? row.settled_override
          : null,
      settledAt: row.settled_at === null ? null : DateTime.makeUnsafe(row.settled_at),
      pinnedAt: row.pinned_at === null ? null : DateTime.makeUnsafe(row.pinned_at),
      snoozedUntil: row.snoozed_until === null ? null : DateTime.makeUnsafe(row.snoozed_until),
      mayBeLive: row.may_be_live === 1,
    }));
  });
  return listActiveShellIndex;
});

/** Retain live work, pins, snoozes, the newest 25 settled roots and every ancestor. */
export function initialShellIds(
  index: ReadonlyArray<ActiveShellIndexEntry>,
): ReadonlyArray<ThreadId> {
  const parents = new Set(
    index.flatMap((entry) => (entry.lineage.parentThreadId ? [entry.lineage.parentThreadId] : [])),
  );
  const settled = index
    .filter(
      (row) =>
        row.lineage.relationshipToParent !== "subagent" &&
        row.settledOverride === "settled" &&
        row.settledAt !== null,
    )
    .map((row) => DateTime.toEpochMillis(row.settledAt!))
    .sort((a, b) => b - a);
  const cut = settled[24] ?? settled.at(-1) ?? -Infinity;
  const retained = new Set(
    index
      .filter(
        (row) =>
          row.mayBeLive ||
          row.pinnedAt != null ||
          row.snoozedUntil != null ||
          parents.has(row.id) ||
          (row.lineage.relationshipToParent !== "subagent" &&
            !(
              row.settledOverride === "settled" &&
              row.settledAt !== null &&
              DateTime.toEpochMillis(row.settledAt) < cut
            )),
      )
      .map((row) => row.id),
  );
  const byId = new Map(index.map((row) => [row.id, row]));
  for (const id of retained) {
    const parent = byId.get(id)?.lineage.parentThreadId;
    if (parent) retained.add(parent);
  }
  return [...retained];
}

export const loadDeferredShell = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  const readIndex = yield* makeIndex;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const index = yield* readIndex();
      const ids = initialShellIds(index);
      const snapshot = yield* store.getShellSnapshot({ location: "active", threadIds: ids });
      return {
        ...snapshot,
        snapshotSequence: yield* events.latestApplicationSequence,
        projects: yield* projects.listShells(),
        deferredThreads: true as const,
        deferredThreadRefs: index.map(({ id, projectId, lineage }) => ({
          id,
          projectId,
          rootThreadId: lineage.rootThreadId,
        })),
      };
    }),
  );
});

/** Scope pages to a workspace's projects or an exact conversation's complete family. */
export const readShellPage = (input: typeof OrchestrationV2ShellPageInput.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* ThreadManagement.ThreadManagementService;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const wanted = input.threadIds ?? [];
        const parentRows = wanted.length
          ? yield* sql<{
              root_id: string;
            }>`SELECT COALESCE(json_extract(payload_json, '$.lineage.rootThreadId'), thread_id) AS root_id FROM orchestration_v2_projection_threads WHERE thread_id IN ${sql.in(wanted)}`
          : [];
        const roots = [
          ...new Set([...wanted, ...parentRows.map((row) => ThreadId.make(row.root_id))]),
        ];
        const scoped =
          input.threadIds === undefined
            ? input.projectIds === undefined
              ? sql``
              : sql` AND t.project_id IN ${sql.in(input.projectIds)}`
            : !input.projectIds?.length
              ? sql` AND (t.thread_id IN ${sql.in(wanted)} OR json_extract(t.payload_json, '$.lineage.rootThreadId') IN ${sql.in(roots)})`
              : sql` AND (t.project_id IN ${sql.in(input.projectIds)} OR t.thread_id IN ${sql.in(wanted)} OR json_extract(t.payload_json, '$.lineage.rootThreadId') IN ${sql.in(roots)})`;
        const rows = yield* sql<{
          id: ThreadId;
        }>`SELECT t.thread_id AS id FROM orchestration_v2_projection_threads t WHERE t.deleted_at IS NULL AND json_extract(t.payload_json, '$.archivedAt') IS NULL ${scoped} ${input.afterId === undefined ? sql`` : sql` AND t.thread_id > ${input.afterId}`} ORDER BY t.thread_id ASC LIMIT 101`;
        const ids = rows.slice(0, 100).map((row) => row.id);
        const snapshot = yield* store.getShellSnapshot({ location: "active", threadIds: ids });
        const byId = new Map(snapshot.threads.map((row) => [row.id, row]));
        return {
          snapshotSequence: yield* events.latestApplicationSequence,
          threads: ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])),
          nextId: rows.length > 100 ? ids.at(-1)! : null,
        };
      }),
    );
  });
