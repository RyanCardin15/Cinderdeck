import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class DeckhandStoreVersionError extends Schema.TaggedError<DeckhandStoreVersionError>()(
  "DeckhandStoreVersionError",
  { found: Schema.Int, supported: Schema.Int },
) {
  override get message() {
    return "This Deckhand store requires a newer application. Restore a compatible binary or store backup.";
  }
}
const VERSION = 3;
/** Separate migration ledger prevents a new upstream migration number from colliding with fork state. */
export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS deckhand_schema (version INTEGER NOT NULL PRIMARY KEY)`;
      const rows = yield* sql<{
        version: number;
      }>`SELECT version FROM deckhand_schema ORDER BY version DESC LIMIT 1`;
      const found = rows[0]?.version ?? 0;
      if (found > VERSION)
        return yield* new DeckhandStoreVersionError({ found, supported: VERSION });
      if (found === VERSION) return;
      if (found < 1) {
        yield* sql`CREATE TABLE deckhand_workspaces (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, backend TEXT NOT NULL CHECK(backend IN ('standalone','cinderdeck')),
      owner_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation > 0), revision INTEGER NOT NULL CHECK(revision > 0),
      record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(environment_id, backend, owner_id, generation)
    )`;
        yield* sql`CREATE TABLE deckhand_checkouts (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES deckhand_workspaces(id), revision INTEGER NOT NULL CHECK(revision > 0),
      record_json TEXT NOT NULL CHECK(json_valid(record_json))
    )`;
        yield* sql`CREATE INDEX deckhand_checkouts_workspace ON deckhand_checkouts(workspace_id)`;
        yield* sql`CREATE TABLE deckhand_features (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES deckhand_workspaces(id), revision INTEGER NOT NULL CHECK(revision > 0),
      record_json TEXT NOT NULL CHECK(json_valid(record_json))
    )`;
        yield* sql`CREATE INDEX deckhand_features_workspace ON deckhand_features(workspace_id)`;
        yield* sql`CREATE TABLE deckhand_feature_checkouts (
      feature_id TEXT NOT NULL REFERENCES deckhand_features(id), checkout_id TEXT NOT NULL REFERENCES deckhand_checkouts(id),
      is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1)), PRIMARY KEY(feature_id, checkout_id)
    )`;
        yield* sql`CREATE UNIQUE INDEX deckhand_feature_primary ON deckhand_feature_checkouts(feature_id) WHERE is_primary = 1`;
        yield* sql`CREATE TABLE deckhand_sessions (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL UNIQUE, feature_id TEXT NOT NULL REFERENCES deckhand_features(id),
      checkout_id TEXT NOT NULL REFERENCES deckhand_checkouts(id), record_json TEXT NOT NULL CHECK(json_valid(record_json))
    )`;
        yield* sql`CREATE INDEX deckhand_sessions_checkout ON deckhand_sessions(checkout_id)`;
        yield* sql`CREATE TABLE deckhand_artifacts (
      id TEXT PRIMARY KEY, environment_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('pull_request','recording','run')),
      owner_key TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(environment_id, kind, owner_key)
    )`;
        yield* sql`CREATE TABLE deckhand_artifact_links (
      artifact_id TEXT NOT NULL REFERENCES deckhand_artifacts(id), feature_id TEXT NOT NULL REFERENCES deckhand_features(id),
      checkout_id TEXT NOT NULL REFERENCES deckhand_checkouts(id), session_id TEXT REFERENCES deckhand_sessions(id),
      basis TEXT NOT NULL CHECK(basis IN ('explicit','suggested')), PRIMARY KEY(artifact_id, feature_id, checkout_id)
    )`;
        yield* sql`CREATE TABLE deckhand_evidence_manifests (
      id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES deckhand_artifacts(id),
      record_json TEXT NOT NULL CHECK(json_valid(record_json)), sha256 TEXT NOT NULL, captured_at TEXT NOT NULL
    )`;
        yield* sql`CREATE TRIGGER deckhand_evidence_immutable BEFORE UPDATE ON deckhand_evidence_manifests
      BEGIN SELECT RAISE(ABORT, 'captured provenance is immutable'); END`;
        yield* sql`CREATE TABLE deckhand_operations (
      operation_key TEXT PRIMARY KEY, environment_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      argument_hash TEXT NOT NULL, resource_generation INTEGER NOT NULL, state TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json))
    )`;
        yield* sql`CREATE TABLE deckhand_activity (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, environment_id TEXT NOT NULL, source TEXT NOT NULL,
      source_event_id TEXT NOT NULL, entity_id TEXT NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      UNIQUE(environment_id, source, source_event_id)
    )`;
        yield* sql`CREATE INDEX deckhand_activity_entity ON deckhand_activity(entity_id, sequence)`;
        yield* sql`CREATE TABLE deckhand_attention (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, cause_event_id TEXT NOT NULL,
      revision INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json))
    )`;
      }
      if (found < 2) {
        yield* sql`CREATE INDEX deckhand_sessions_feature_page ON deckhand_sessions(feature_id, id)`;
      }
      if (found < 3) {
        yield* sql`CREATE INDEX IF NOT EXISTS deckhand_operations_actor ON deckhand_operations(actor_id, environment_id)`;
        yield* sql`CREATE TABLE deckhand_integrations (
          channel TEXT PRIMARY KEY, installation_id TEXT NOT NULL, host_id TEXT NOT NULL,
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        )`;
      }
      yield* sql`INSERT INTO deckhand_schema(version) VALUES (${VERSION})`;
    }),
  );
});
