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
              old.laneId !== record.laneId ||
              old.kind !== record.kind
            ) {
              return yield* error(record.id, "wrong_context");
            }
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
  });
});
export const layer = Layer.effect(Relationships, make);
