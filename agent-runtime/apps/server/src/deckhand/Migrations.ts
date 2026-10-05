import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class DeckhandStoreVersionError extends Schema.TaggedError<DeckhandStoreVersionError>()(
  "DeckhandStoreVersionError",
  { found: Schema.Int, supported: Schema.Int },
) {
  override get message() {
    return "This Cinderdeck store requires a newer application. Restore a compatible binary or store backup.";
  }
}
export const VERSION = 17;
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
      if (found === VERSION) {
        // Compatible indexes can be restored after an interrupted deployment or manual repair.
        yield* sql`CREATE INDEX IF NOT EXISTS deckhand_attention_source ON deckhand_attention(json_extract(record_json,'$.scopeKey'))`;
        yield* sql`CREATE INDEX IF NOT EXISTS deckhand_attention_page ON deckhand_attention(entity_id,json_extract(record_json,'$.observedAt') DESC,id)`;
        return;
      }
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
      if (found < 4) {
        yield* sql`CREATE TABLE deckhand_writer_requests (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
          runtime_epoch TEXT NOT NULL, owner_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('queued','held','uncertain','released'))
        )`;
        yield* sql`CREATE TABLE deckhand_writer_scope (
          request_id TEXT NOT NULL REFERENCES deckhand_writer_requests(id),
          physical_id TEXT NOT NULL, PRIMARY KEY(request_id, physical_id)
        )`;
        yield* sql`CREATE INDEX deckhand_writer_scope_physical ON deckhand_writer_scope(physical_id, request_id)`;
        yield* sql`CREATE INDEX deckhand_writer_requests_owner ON deckhand_writer_requests(owner_id, state)`;
      }
      if (found < 5) {
        // Scoped control secrets stay in the private server store, never projections.
        yield* sql`CREATE TABLE deckhand_native_writer_intents (
          id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, installation_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('pending','held','uncertain','released')),
          control_json TEXT NOT NULL CHECK(json_valid(control_json))
        )`;
        yield* sql`CREATE INDEX deckhand_native_writer_owner ON deckhand_native_writer_intents(owner_id, state)`;
      }
      if (found < 6) {
        yield* sql`CREATE TABLE deckhand_managed_launches (
          operation_key TEXT PRIMARY KEY, actor_id TEXT NOT NULL, input_json TEXT NOT NULL CHECK(json_valid(input_json)),
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        )`;
      }
      if (found < 7) {
        yield* sql`CREATE TABLE deckhand_managed_creations (
          operation_key TEXT PRIMARY KEY, actor_id TEXT NOT NULL,
          input_json TEXT NOT NULL CHECK(json_valid(input_json)),
          launch_input_json TEXT CHECK(launch_input_json IS NULL OR json_valid(launch_input_json)),
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        )`;
      }
      if (found < 8) {
        yield* sql`CREATE UNIQUE INDEX deckhand_creations_launch_key
          ON deckhand_managed_creations(json_extract(record_json, '$.launchOperationKey'))`;
      }
      if (found < 9) {
        yield* sql`CREATE TABLE deckhand_launch_reviews (
          launch_operation_key TEXT PRIMARY KEY,
          actor_id TEXT NOT NULL,
          original_input_json TEXT NOT NULL CHECK(json_valid(original_input_json)),
          review_json TEXT NOT NULL CHECK(json_valid(review_json))
        )`;
      }
      if (found < 10) {
        yield* sql`CREATE TABLE deckhand_reviewer_queue (
          operation_key TEXT PRIMARY KEY,
          actor_id TEXT NOT NULL,
          original_input_json TEXT NOT NULL CHECK(json_valid(original_input_json)),
          state TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        )`;
        yield* sql`CREATE INDEX deckhand_reviewer_queue_pending ON deckhand_reviewer_queue(state,updated_at)`;
        yield* sql`CREATE INDEX deckhand_reviewer_queue_actor ON deckhand_reviewer_queue(actor_id,operation_key)`;
        yield* sql`CREATE TRIGGER deckhand_reviewer_request_immutable BEFORE UPDATE OF original_input_json,actor_id ON deckhand_reviewer_queue
          BEGIN SELECT RAISE(ABORT, 'reviewer requests are immutable'); END`;
      }
      if (found < 11) {
        yield* sql`CREATE INDEX deckhand_attention_source ON deckhand_attention(json_extract(record_json,'$.scopeKey'))`;
        yield* sql`CREATE INDEX deckhand_attention_page ON deckhand_attention(entity_id,json_extract(record_json,'$.observedAt') DESC,id)`;
        yield* sql`CREATE TABLE deckhand_attention_dispositions (
          actor_id TEXT NOT NULL, attention_id TEXT NOT NULL REFERENCES deckhand_attention(id),
          cause_version TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0),
          record_json TEXT NOT NULL CHECK(json_valid(record_json)),
          PRIMARY KEY(actor_id,attention_id)
        )`;
      }
      if (found < 12) {
        yield* sql`CREATE TABLE deckhand_external_sessions (
          id TEXT PRIMARY KEY CHECK(id LIKE 'external:%'), actor_id TEXT NOT NULL,
          operation_key TEXT NOT NULL, argument_hash TEXT NOT NULL, report_hash TEXT,
          feature_id TEXT NOT NULL REFERENCES deckhand_features(id), checkout_id TEXT NOT NULL REFERENCES deckhand_checkouts(id),
          provider_name TEXT NOT NULL, provider_session_id TEXT NOT NULL,
          last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0), expires_at INTEGER NOT NULL,
          record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(actor_id,operation_key),
          UNIQUE(actor_id,checkout_id,provider_name,provider_session_id)
        )`;
        yield* sql`CREATE INDEX deckhand_external_sessions_context ON deckhand_external_sessions(checkout_id,id)`;
        yield* sql`CREATE TRIGGER deckhand_external_session_identity_immutable BEFORE UPDATE OF id,actor_id,operation_key,argument_hash,feature_id,checkout_id,provider_name,provider_session_id ON deckhand_external_sessions
          BEGIN SELECT RAISE(ABORT, 'external registration identity is immutable'); END`;
      }
      if (found < 13) {
        yield* sql`CREATE TABLE deckhand_verification_attempts (
          operation_key TEXT PRIMARY KEY, actor_id TEXT NOT NULL, pr_key TEXT NOT NULL,
          original_json TEXT NOT NULL CHECK(json_valid(original_json)),
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        )`;
        yield* sql`CREATE INDEX deckhand_verification_attempt_actor ON deckhand_verification_attempts(actor_id,pr_key)`;
        yield* sql`CREATE TRIGGER deckhand_verification_attempt_identity BEFORE UPDATE OF operation_key,actor_id,pr_key,original_json ON deckhand_verification_attempts
          BEGIN SELECT RAISE(ABORT, 'verification attempt identity is immutable'); END`;
        yield* sql`CREATE TRIGGER deckhand_verification_proof_immutable BEFORE UPDATE OF record_json ON deckhand_verification_attempts
          WHEN json_type(OLD.record_json,'$.recordingProof') != 'null' AND (json_extract(OLD.record_json,'$.recordingProof') IS NOT json_extract(NEW.record_json,'$.recordingProof') OR json_extract(OLD.record_json,'$.proofHash') IS NOT json_extract(NEW.record_json,'$.proofHash'))
          BEGIN SELECT RAISE(ABORT, 'verification proof is immutable'); END`;
      }
      if (found < 14) {
        yield* sql`CREATE TABLE deckhand_verification_scenarios (
          pr_key TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL,
          request_json TEXT NOT NULL CHECK(json_valid(request_json)),
          record_json TEXT NOT NULL CHECK(json_valid(record_json)), PRIMARY KEY(pr_key,id)
        )`;
        yield* sql`CREATE TRIGGER deckhand_scenario_immutable BEFORE UPDATE ON deckhand_verification_scenarios
          BEGIN SELECT RAISE(ABORT, 'scenario evidence is immutable'); END`;
      }
      if (found < 15) {
        yield* sql`CREATE TABLE deckhand_owned_preview_captures (
          capture_key TEXT PRIMARY KEY, actor_id TEXT NOT NULL, original_json TEXT NOT NULL CHECK(json_valid(original_json)),
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        )`;
        yield* sql`CREATE TRIGGER deckhand_owned_capture_identity BEFORE UPDATE OF capture_key,actor_id,original_json ON deckhand_owned_preview_captures
          BEGIN SELECT RAISE(ABORT, 'owned capture identity is immutable'); END`;
        yield* sql`CREATE TABLE deckhand_owned_preview_proofs (
          recording_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, capture_key TEXT UNIQUE NOT NULL REFERENCES deckhand_owned_preview_captures(capture_key),
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        )`;
        yield* sql`CREATE TRIGGER deckhand_owned_proof_immutable BEFORE UPDATE ON deckhand_owned_preview_proofs
          BEGIN SELECT RAISE(ABORT, 'owned preview proof is immutable'); END`;
      }
      if (found < 16) {
        yield* sql`CREATE TABLE deckhand_ownership_transitions (
          id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, physical_id TEXT NOT NULL,
          original_json TEXT NOT NULL CHECK(json_valid(original_json)),
          record_json TEXT NOT NULL CHECK(json_valid(record_json))
        )`;
        yield* sql`CREATE UNIQUE INDEX deckhand_ownership_pending ON deckhand_ownership_transitions(physical_id)
          WHERE json_extract(record_json,'$.state') IN ('pending','unknown_outcome')`;
        yield* sql`CREATE TRIGGER deckhand_ownership_intent_immutable BEFORE UPDATE OF id,actor_id,physical_id,original_json ON deckhand_ownership_transitions
          BEGIN SELECT RAISE(ABORT, 'ownership intent is immutable'); END`;
        yield* sql`CREATE TABLE deckhand_checkout_ownership (
          original_checkout_id TEXT PRIMARY KEY REFERENCES deckhand_checkouts(id),
          target_checkout_id TEXT NOT NULL REFERENCES deckhand_checkouts(id),
          transition_id TEXT NOT NULL REFERENCES deckhand_ownership_transitions(id), revision INTEGER NOT NULL CHECK(revision>0)
        )`;
        yield* sql`CREATE VIEW deckhand_current_checkouts AS
          SELECT c.id AS origin_id,e.id,e.workspace_id,e.revision,e.record_json
          FROM deckhand_checkouts c LEFT JOIN deckhand_checkout_ownership a ON a.original_checkout_id=c.id
          JOIN deckhand_checkouts e ON e.id=COALESCE(a.target_checkout_id,c.id)`;
      }
      if (found < 17) {
        yield* sql`UPDATE deckhand_reviewer_queue SET state='queued',
          record_json=json_set(record_json,'$.state','queued','$.detail',NULL) WHERE state='waiting_writer'`;
        yield* sql`DROP TABLE IF EXISTS deckhand_writer_scope`;
        yield* sql`DROP TABLE IF EXISTS deckhand_writer_requests`;
        yield* sql`DROP TABLE IF EXISTS deckhand_native_writer_intents`;
      }
      yield* sql`INSERT INTO deckhand_schema(version) VALUES (${VERSION})`;
    }),
  );
});
