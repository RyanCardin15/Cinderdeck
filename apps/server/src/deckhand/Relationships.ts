import * as Contracts from "@t3tools/contracts/deckhand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class RelationshipError extends Schema.TaggedError<RelationshipError>()(
  "RelationshipError",
  {
    entityId: Schema.String,
    reason: Schema.Literals(["stale", "missing", "wrong_context", "storage"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Relationship ${this.reason}. Refresh this context before retrying.`;
  }
}
const isRelationshipError = Schema.is(RelationshipError);
const decodeWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Contracts.WorkspaceBinding),
);
const decodeCheckout = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.CheckoutBinding));
const decodeFeature = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.Feature));
const encodeWorkspace = Schema.encodeEffect(Schema.fromJsonString(Contracts.WorkspaceBinding));
const encodeCheckout = Schema.encodeEffect(Schema.fromJsonString(Contracts.CheckoutBinding));
const encodeFeature = Schema.encodeEffect(Schema.fromJsonString(Contracts.Feature));
const decodeSession = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.SessionBinding));
const encodeSession = Schema.encodeEffect(Schema.fromJsonString(Contracts.SessionBinding));
type Result<A> = Effect.Effect<A, RelationshipError>;
export class Relationships extends Context.Service<
  Relationships,
  {
    readonly putWorkspace: (
      record: Contracts.WorkspaceBinding,
      expectedRevision: number | null,
    ) => Result<void>;
    readonly putCheckout: (
      record: Contracts.CheckoutBinding,
      expectedRevision: number | null,
    ) => Result<void>;
    readonly putFeature: (
      record: Contracts.Feature,
      expectedRevision: number | null,
    ) => Result<void>;
    readonly linkCheckout: (
      featureId: string,
      checkoutId: string,
      primary: boolean,
    ) => Result<void>;
    readonly workspace: (id: string) => Result<Contracts.WorkspaceBinding>;
    readonly feature: (id: string) => Result<Contracts.Feature>;
    readonly checkout: (id: string) => Result<Contracts.CheckoutBinding>;
    readonly putSession: (
      record: Contracts.SessionBinding,
      expectedSequence: number | null,
    ) => Result<void>;
    readonly session: (id: string) => Result<Contracts.SessionBinding>;
    readonly sessions: (input: {
      readonly featureId: string;
      readonly afterId?: string;
      readonly limit: number;
    }) => Result<ReadonlyArray<Contracts.SessionBinding>>;
  }
>()("t3/deckhand/Relationships") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const error = (entityId: string, reason: RelationshipError["reason"]) =>
    new RelationshipError({ entityId, reason });
  const storage = (entityId: string) => (cause: unknown) =>
    isRelationshipError(cause)
      ? cause
      : new RelationshipError({ entityId, reason: "storage", cause });
  const workspace = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_workspaces WHERE id = ${id}`;
      if (!rows[0]) return yield* error(id, "missing");
      return yield* decodeWorkspace(rows[0].record_json);
    }).pipe(Effect.mapError(storage(id)));
  const feature = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_features WHERE id = ${id}`;
      if (!rows[0]) return yield* error(id, "missing");
      return yield* decodeFeature(rows[0].record_json);
    }).pipe(Effect.mapError(storage(id)));
  const checkout = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_checkouts WHERE id = ${id}`;
      if (!rows[0]) return yield* error(id, "missing");
      return yield* decodeCheckout(rows[0].record_json);
    }).pipe(Effect.mapError(storage(id)));
  const session = (id: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_sessions WHERE id = ${id}`;
      if (!rows[0]) return yield* error(id, "missing");
      return yield* decodeSession(rows[0].record_json);
    }).pipe(Effect.mapError(storage(id)));
  // Only the environment's managed orchestration service may supply these projections.
  // External registration has a separate authority and cannot claim a managed thread.
  const putSession = (record: Contracts.SessionBinding, expectedSequence: number | null) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const encoded = yield* encodeSession(record);
          if (!record.capabilities.managed) return yield* error(record.id, "wrong_context");
          if (expectedSequence === null) {
            if (record.lastSequence !== 0) return yield* error(record.id, "stale");
            const existing =
              yield* sql`SELECT id FROM deckhand_sessions WHERE id = ${record.id} OR thread_id = ${record.threadId}`;
            if (existing.length) return yield* error(record.id, "stale");
            const item = yield* feature(record.featureId);
            const target = yield* checkout(record.checkoutId);
            const parent = yield* workspace(target.workspaceId);
            const source = yield* workspace(item.workspaceId);
            const links =
              yield* sql`SELECT checkout_id FROM deckhand_feature_checkouts WHERE feature_id = ${record.featureId} AND checkout_id = ${record.checkoutId}`;
            if (
              !links.length ||
              item.status !== "active" ||
              target.state !== "ready" ||
              parent.state !== "active" ||
              source.state !== "active" ||
              parent.environmentId !== source.environmentId ||
              parent.generation !== target.workspaceGeneration ||
              !record.repositoryScope?.length ||
              new Set(record.repositoryScope).size !== record.repositoryScope.length ||
              record.repositoryScope.some(
                (id) => !target.repositories.some((repo) => repo.physicalId === id),
              ) ||
              (record.role === "reviewer" && record.desiredAccess === "write") ||
              (record.desiredAccess === "read_only" && !record.capabilities.enforcedReadOnly)
            ) {
              return yield* error(record.id, "wrong_context");
            }
            if (record.role === "reviewer" && record.desiredAccess === "isolated") {
              const primary = yield* sql<{
                checkout_id: string;
              }>`SELECT checkout_id FROM deckhand_feature_checkouts
            WHERE feature_id = ${record.featureId} AND is_primary = 1`;
              if (
                !primary[0] ||
                primary[0].checkout_id === target.id ||
                target.kind !== "lane" ||
                !target.repositories.length
              )
                return yield* error(record.id, "wrong_context");
              const original = yield* checkout(primary[0].checkout_id);
              const sourceIds = new Set(original.repositories.map((repo) => repo.physicalId));
              if (
                !sourceIds.size ||
                target.repositories.some((repo) => sourceIds.has(repo.physicalId))
              )
                return yield* error(record.id, "wrong_context");
            }
            yield* sql`INSERT INTO deckhand_sessions(id, thread_id, feature_id, checkout_id, record_json)
          VALUES(${record.id}, ${record.threadId}, ${record.featureId}, ${record.checkoutId}, ${encoded})`;
          } else {
            const old = yield* session(record.id);
            if (old.lastSequence !== expectedSequence || record.lastSequence <= expectedSequence)
              return yield* error(record.id, "stale");
            if (
              old.threadId !== record.threadId ||
              old.featureId !== record.featureId ||
              old.checkoutId !== record.checkoutId ||
              old.role !== record.role ||
              old.desiredAccess !== record.desiredAccess ||
              (old.repositoryScope ?? []).length !== (record.repositoryScope ?? []).length ||
              (old.repositoryScope ?? []).some((id) => !record.repositoryScope?.includes(id)) ||
              (record.desiredAccess === "read_only" && !record.capabilities.enforcedReadOnly)
            ) {
              return yield* error(record.id, "wrong_context");
            }
            // Missing/released checkouts retain their history and can still receive a disconnect/exit.
            const updated = yield* sql`UPDATE deckhand_sessions SET record_json = ${encoded}
          WHERE id = ${record.id} AND json_extract(record_json, '$.lastSequence') = ${expectedSequence} RETURNING id`;
            if (!updated.length) return yield* error(record.id, "stale");
          }
        }),
      )
      .pipe(Effect.mapError(storage(record.id)));
  const sessions = (input: {
    readonly featureId: string;
    readonly afterId?: string;
    readonly limit: number;
  }) =>
    Effect.gen(function* () {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
        return yield* error(input.featureId, "wrong_context");
      yield* feature(input.featureId);
      const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM deckhand_sessions
        WHERE feature_id = ${input.featureId} AND id > ${input.afterId ?? ""} ORDER BY id LIMIT ${input.limit}`;
      return yield* Effect.forEach(rows, (row) => decodeSession(row.record_json));
    }).pipe(Effect.mapError(storage(input.featureId)));
  const putWorkspace = (record: Contracts.WorkspaceBinding, expectedRevision: number | null) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const encoded = yield* encodeWorkspace(record);
          if (record.revision !== (expectedRevision ?? 0) + 1)
            return yield* error(record.id, "stale");
          if (expectedRevision === null) {
            const existing = yield* sql`SELECT id FROM deckhand_workspaces WHERE id = ${record.id}`;
            if (existing.length) return yield* error(record.id, "stale");
            yield* sql`INSERT INTO deckhand_workspaces(id, environment_id, backend, owner_id, generation, revision, record_json)
        VALUES(${record.id}, ${record.environmentId}, ${record.backend}, ${record.ownerId}, ${record.generation}, ${record.revision}, ${encoded})`;
          } else {
            const old = yield* workspace(record.id);
            // A rename is mutable metadata. Rebinding an ID to a new host/owner/generation is forbidden.
            if (
              old.environmentId !== record.environmentId ||
              old.backend !== record.backend ||
              old.ownerId !== record.ownerId ||
              old.generation !== record.generation
            ) {
              return yield* error(record.id, "wrong_context");
            }
            const changed =
              yield* sql`UPDATE deckhand_workspaces SET revision = ${record.revision}, record_json = ${encoded}
        WHERE id = ${record.id} AND revision = ${expectedRevision} RETURNING id`;
            if (!changed.length) return yield* error(record.id, "stale");
          }
        }),
      )
      .pipe(Effect.mapError(storage(record.id)));
  const putCheckout = (record: Contracts.CheckoutBinding, expectedRevision: number | null) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const parent = yield* workspace(record.workspaceId);
          if (
            parent.environmentId !== record.environmentId ||
            parent.backend !== record.backend ||
            parent.generation !== record.workspaceGeneration ||
            parent.state !== "active"
          ) {
            return yield* error(record.id, "wrong_context");
          }
          const identities = new Set(record.repositories.map((repo) => repo.physicalId));
          if (
            (record.state === "ready" && !identities.size) ||
            (record.state === "ready" &&
              record.backend === "cinderdeck" &&
              record.nativeGeneration === undefined) ||
            identities.size !== record.repositories.length ||
            (record.kind === "primary" ? record.laneId !== null : record.laneId === null)
          )
            return yield* error(record.id, "wrong_context");
          if (record.revision !== (expectedRevision ?? 0) + 1)
            return yield* error(record.id, "stale");
          const encoded = yield* encodeCheckout(record);
          if (expectedRevision === null) {
            const existing = yield* sql`SELECT id FROM deckhand_checkouts WHERE id = ${record.id}`;
            if (existing.length) return yield* error(record.id, "stale");
            yield* sql`INSERT INTO deckhand_checkouts(id, workspace_id, revision, record_json) VALUES(${record.id}, ${record.workspaceId}, ${record.revision}, ${encoded})`;
          } else {
            const old = yield* checkout(record.id);
            if (
              old.workspaceId !== record.workspaceId ||
              old.environmentId !== record.environmentId ||
              old.backend !== record.backend ||
              old.workspaceGeneration !== record.workspaceGeneration ||
              old.nativeGeneration !== record.nativeGeneration ||
              old.laneId !== record.laneId ||
              old.kind !== record.kind
            ) {
              return yield* error(record.id, "wrong_context");
            }
            // Roots, branches and commits can change. A physical checkout replacement needs a new binding.
            if (
              old.repositories.length &&
              (old.repositories.length !== record.repositories.length ||
                old.repositories.some(
                  (repo) =>
                    !record.repositories.some(
                      (next) =>
                        next.physicalId === repo.physicalId &&
                        next.repositoryPhysicalId === repo.repositoryPhysicalId,
                    ),
                ))
            )
              return yield* error(record.id, "wrong_context");
            const changed =
              yield* sql`UPDATE deckhand_checkouts SET revision = ${record.revision}, record_json = ${encoded}
        WHERE id = ${record.id} AND revision = ${expectedRevision} RETURNING id`;
            if (!changed.length) return yield* error(record.id, "stale");
          }
        }),
      )
      .pipe(Effect.mapError(storage(record.id)));
  const putFeature = (record: Contracts.Feature, expectedRevision: number | null) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const parent = yield* workspace(record.workspaceId);
          if (parent.state !== "active") return yield* error(record.id, "wrong_context");
          if (record.revision !== (expectedRevision ?? 0) + 1)
            return yield* error(record.id, "stale");
          const encoded = yield* encodeFeature(record);
          if (expectedRevision === null) {
            const existing = yield* sql`SELECT id FROM deckhand_features WHERE id = ${record.id}`;
            if (existing.length) return yield* error(record.id, "stale");
            yield* sql`INSERT INTO deckhand_features(id, workspace_id, revision, record_json) VALUES(${record.id}, ${record.workspaceId}, ${record.revision}, ${encoded})`;
          } else {
            const old = yield* feature(record.id);
            if (old.workspaceId !== record.workspaceId || old.createdAt !== record.createdAt)
              return yield* error(record.id, "wrong_context");
            const changed =
              yield* sql`UPDATE deckhand_features SET revision = ${record.revision}, record_json = ${encoded}
        WHERE id = ${record.id} AND revision = ${expectedRevision} RETURNING id`;
            if (!changed.length) return yield* error(record.id, "stale");
          }
        }),
      )
      .pipe(Effect.mapError(storage(record.id)));
  const linkCheckout = (featureId: string, checkoutId: string, primary: boolean) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const item = yield* feature(featureId);
          const target = yield* checkout(checkoutId);
          const parent = yield* workspace(target.workspaceId);
          const source = yield* workspace(item.workspaceId);
          if (
            target.state !== "ready" ||
            parent.state !== "active" ||
            source.state !== "active" ||
            parent.environmentId !== source.environmentId ||
            parent.generation !== target.workspaceGeneration
          ) {
            return yield* error(checkoutId, "wrong_context");
          }
          if (primary)
            yield* sql`UPDATE deckhand_feature_checkouts SET is_primary = 0 WHERE feature_id = ${featureId}`;
          yield* sql`INSERT INTO deckhand_feature_checkouts(feature_id, checkout_id, is_primary) VALUES(${featureId}, ${checkoutId}, ${primary ? 1 : 0})
      ON CONFLICT(feature_id, checkout_id) DO UPDATE SET is_primary = excluded.is_primary`;
        }),
      )
      .pipe(Effect.mapError(storage(checkoutId)));
  return Relationships.of({
    putWorkspace,
    putCheckout,
    putFeature,
    linkCheckout,
    workspace,
    feature,
    checkout,
    putSession,
    session,
    sessions,
  });
});
export const layer = Layer.effect(Relationships, make);
