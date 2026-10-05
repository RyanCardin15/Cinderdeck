// @effect-diagnostics nodeBuiltinImport:off - Environment-scoped owner identity has a bounded deterministic digest.
import * as NodeCrypto from "node:crypto";
import { AuthAdministrativeScopes, AuthEnvironmentScopes } from "@t3tools/contracts";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Internal selectors only: callers select a saved resource, never an actor or SQL table. */
export type ActorResource =
  | {
      readonly type:
        | "operation"
        | "launch"
        | "creation"
        | "reviewer"
        | "attempt"
        | "ownership-key"
        | "external-key"
        | "preview-import";
      readonly operationKey: string;
    }
  | { readonly type: "review"; readonly launchOperationKey: string }
  | { readonly type: "thread" | "ownership-thread"; readonly threadId: string }
  | { readonly type: "capture"; readonly captureKey: string }
  | { readonly type: "recording"; readonly recordingID: string }
  | { readonly type: "ownership-id" | "external"; readonly id: string }
  | { readonly type: "scenario"; readonly prKey: string; readonly scenarioID: string }
  | { readonly type: "attention"; readonly attentionID: string }
  | { readonly type: "build"; readonly receiptID: string };
export class ActorAccessError extends Schema.TaggedError<ActorAccessError>()("ActorAccessError", {
  reason: Schema.Literals(["storage", "ambiguous", "history_limit", "resource_limit"]),
}) {}
type Result<A> = Effect.Effect<A, ActorAccessError>;
export class ActorAccess extends Context.Service<
  ActorAccess,
  {
    readonly resolve: (
      session: AuthenticatedSession,
      resource?: ActorResource | readonly ActorResource[],
    ) => Result<string>;
    readonly aliases: (session: AuthenticatedSession) => Result<readonly string[]>;
  }
>()("t3/deckhand/ActorAccess") {}

const decodeScopes = Schema.decodeUnknownEffect(Schema.fromJsonString(AuthEnvironmentScopes));
const isAccessError = Schema.is(ActorAccessError);
const wrap = (cause: unknown) =>
  isAccessError(cause) ? cause : new ActorAccessError({ reason: "storage" });
const isAdministrative = (scopes: readonly string[]) =>
  AuthAdministrativeScopes.every((scope) => scopes.includes(scope));
const isOwnerClaims = (session: AuthenticatedSession) =>
  session.subject === "desktop-bootstrap" &&
  session.method === "bearer-access-token" &&
  isAdministrative(session.scopes);
type AuthRow = {
  session_id: string;
  subject: string;
  scopes: string;
  method: string;
  expires_at: string;
  revoked_at: string | null;
};
type ActorRow = { actor_id: string };
/** Never a credential or AuthSessionId. Domain/native histories keep their saved actor unchanged. */
export const desktopOwnerActor = (environmentID: string): string =>
  "dh-admin:" +
  NodeCrypto.createHash("sha256")
    .update(environmentID + "\0desktop-bootstrap")
    .digest("hex")
    .slice(0, 48);
export const ACTOR_HISTORY_LIMIT = 256;

export const layer = Layer.effect(
  ActorAccess,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const identity = yield* ServerEnvironmentIdentity;
    const canonical = desktopOwnerActor(yield* identity.getEnvironmentId);
    const administrativeRow = (row: AuthRow) =>
      Effect.gen(function* () {
        if (row.subject !== "desktop-bootstrap" || row.method !== "bearer-access-token")
          return false;
        return isAdministrative(yield* decodeScopes(row.scopes));
      });
    const owner = (session: AuthenticatedSession) =>
      Effect.gen(function* () {
        if (!isOwnerClaims(session)) return false;
        const rows =
          yield* sql<AuthRow>`SELECT session_id,subject,scopes,method,expires_at,revoked_at FROM auth_sessions WHERE session_id=${session.sessionId}`;
        const row = rows[0];
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        // Claims alone are insufficient. The presently authenticated session must have a live,
        // matching persisted grant. Revoked/expired history is used only after this check.
        return (
          !!row &&
          row.revoked_at === null &&
          Number.isFinite(Date.parse(row.expires_at)) &&
          Date.parse(row.expires_at) > now &&
          (yield* administrativeRow(row))
        );
      });
    const candidates = (resource: ActorResource): Effect.Effect<readonly ActorRow[], SqlError> => {
      switch (resource.type) {
        case "operation":
          return sql<ActorRow>`SELECT actor_id FROM deckhand_operations WHERE operation_key=${resource.operationKey} LIMIT 3`;
        case "launch":
          return sql<ActorRow>`SELECT DISTINCT actor_id FROM (SELECT actor_id FROM deckhand_managed_launches WHERE operation_key=${resource.operationKey} UNION ALL SELECT actor_id FROM deckhand_managed_creations WHERE json_extract(record_json,'$.launchOperationKey')=${resource.operationKey} UNION ALL SELECT actor_id FROM deckhand_launch_reviews WHERE launch_operation_key=${resource.operationKey}) LIMIT 3`;
        case "creation":
          return sql<ActorRow>`SELECT actor_id FROM deckhand_managed_creations WHERE operation_key=${resource.operationKey} LIMIT 3`;
        case "review":
          return sql<ActorRow>`SELECT actor_id FROM deckhand_launch_reviews WHERE launch_operation_key=${resource.launchOperationKey} LIMIT 3`;
        case "reviewer":
          return sql<ActorRow>`SELECT actor_id FROM deckhand_reviewer_queue WHERE operation_key=${resource.operationKey} LIMIT 3`;
        case "attempt":
          return sql<ActorRow>`SELECT actor_id FROM deckhand_verification_attempts WHERE operation_key=${resource.operationKey} LIMIT 3`;
        case "capture":
          return sql<ActorRow>`SELECT actor_id FROM deckhand_owned_preview_captures WHERE capture_key=${resource.captureKey} LIMIT 3`;
        case "ownership-id":
          return sql<ActorRow>`SELECT actor_id FROM deckhand_ownership_transitions WHERE id=${resource.id} LIMIT 3`;
        case "ownership-key":
          return sql<ActorRow>`SELECT DISTINCT actor_id FROM deckhand_ownership_transitions WHERE json_extract(record_json,'$.operationKey')=${resource.operationKey} LIMIT 3`;
        case "external":
          return sql<ActorRow>`SELECT actor_id FROM deckhand_external_sessions WHERE id=${resource.id} LIMIT 3`;
        case "external-key":
          return sql<ActorRow>`SELECT DISTINCT actor_id FROM deckhand_external_sessions WHERE operation_key=${resource.operationKey} LIMIT 3`;
        case "scenario":
          return sql<ActorRow>`SELECT actor_id FROM deckhand_verification_scenarios WHERE pr_key=${resource.prKey} AND id=${resource.scenarioID} LIMIT 3`;
        case "thread":
          return sql<ActorRow>`SELECT DISTINCT actor_id FROM deckhand_managed_launches WHERE json_extract(record_json,'$.threadId')=${resource.threadId} AND json_extract(record_json,'$.state')='accepted' LIMIT 3`;
        case "ownership-thread":
          return sql<ActorRow>`SELECT DISTINCT transition.actor_id FROM deckhand_sessions AS session JOIN deckhand_checkout_ownership AS ownership ON ownership.original_checkout_id=session.checkout_id JOIN deckhand_ownership_transitions AS transition ON transition.id=ownership.transition_id WHERE session.thread_id=${resource.threadId} LIMIT 3`;
        case "recording":
          return sql<ActorRow>`SELECT DISTINCT actor_id FROM (SELECT actor_id FROM deckhand_owned_preview_proofs WHERE recording_id=${resource.recordingID} UNION ALL SELECT actor_id FROM deckhand_owned_preview_captures WHERE json_extract(record_json,'$.status.receipt.recordingID')=${resource.recordingID} UNION ALL SELECT actor_id FROM deckhand_verification_attempts WHERE json_extract(record_json,'$.recordingID')=${resource.recordingID}) LIMIT 3`;
        case "build":
          return sql<ActorRow>`SELECT DISTINCT actor_id FROM deckhand_verification_attempts WHERE json_extract(record_json,'$.receipt.id')=${resource.receiptID} LIMIT 3`;
        case "preview-import":
          return sql<ActorRow>`SELECT DISTINCT actor_id FROM deckhand_owned_preview_captures WHERE json_extract(record_json,'$.status.receipt.operationKey')=${resource.operationKey} LIMIT 3`;
        case "attention":
          return sql<ActorRow>`SELECT DISTINCT actor_id FROM (SELECT entity_id AS actor_id FROM deckhand_attention WHERE id=${resource.attentionID} AND entity_id!='*' UNION ALL SELECT actor_id FROM deckhand_attention_dispositions WHERE attention_id=${resource.attentionID}) LIMIT 3`;
      }
    };
    const entitled = (actor: string) =>
      Effect.gen(function* () {
        if (actor === canonical) return true;
        const rows =
          yield* sql<AuthRow>`SELECT session_id,subject,scopes,method,expires_at,revoked_at FROM auth_sessions WHERE session_id=${actor}`;
        return !!rows[0] && (yield* administrativeRow(rows[0]));
      });
    return ActorAccess.of({
      resolve: (session, resource) =>
        Effect.gen(function* () {
          if (!(yield* owner(session))) return session.sessionId;
          if (resource === undefined) return canonical;
          const resources: readonly ActorResource[] = Array.isArray(resource)
            ? resource
            : [resource as ActorResource];
          if (resources.length > 8)
            return yield* new ActorAccessError({ reason: "resource_limit" });
          const found = new Set<string>();
          for (const key of resources)
            for (const row of yield* candidates(key)) found.add(row.actor_id);
          if (!found.size) return canonical;
          // An unrelated/inaccessible saved resource must not become accessible because another
          // supplied key belongs to the local owner. Domain checks still run using the exact UUID.
          for (const actor of found) if (!(yield* entitled(actor))) return session.sessionId;
          if (found.size !== 1) return yield* new ActorAccessError({ reason: "ambiguous" });
          return [...found][0]!;
        }).pipe(Effect.mapError(wrap)),
      aliases: (session) =>
        Effect.gen(function* () {
          if (!(yield* owner(session))) return [session.sessionId];
          const requiredScopes = sql.and(
            AuthAdministrativeScopes.map(
              (scope) =>
                sql`EXISTS (SELECT 1 FROM json_each(auth.scopes) AS scope WHERE scope.value=${scope})`,
            ),
          );
          // Bootstrap exchanges with no saved work need no recovery alias. Bound distinct
          // historical workflow owners, rather than penalizing normal credential rotation.
          const rows =
            yield* sql<AuthRow>`SELECT auth.session_id,auth.subject,auth.scopes,auth.method,auth.expires_at,auth.revoked_at FROM auth_sessions AS auth
            JOIN (
              SELECT actor_id FROM deckhand_operations
              UNION SELECT actor_id FROM deckhand_managed_launches
              UNION SELECT actor_id FROM deckhand_managed_creations
              UNION SELECT actor_id FROM deckhand_launch_reviews
              UNION SELECT actor_id FROM deckhand_reviewer_queue
              UNION SELECT actor_id FROM deckhand_verification_attempts
              UNION SELECT actor_id FROM deckhand_owned_preview_captures
              UNION SELECT actor_id FROM deckhand_owned_preview_proofs
              UNION SELECT actor_id FROM deckhand_ownership_transitions
              UNION SELECT actor_id FROM deckhand_external_sessions
              UNION SELECT actor_id FROM deckhand_verification_scenarios
              UNION SELECT actor_id FROM deckhand_attention_dispositions
              UNION SELECT entity_id AS actor_id FROM deckhand_attention WHERE entity_id!='*'
            ) AS saved ON saved.actor_id=auth.session_id
            WHERE auth.subject='desktop-bootstrap' AND auth.method='bearer-access-token' AND auth.session_id!=${session.sessionId} AND ${requiredScopes}
            ORDER BY auth.issued_at DESC,auth.session_id LIMIT ${ACTOR_HISTORY_LIMIT + 1}`;
          if (rows.length > ACTOR_HISTORY_LIMIT)
            return yield* new ActorAccessError({ reason: "history_limit" });
          const result = new Set<string>([canonical, session.sessionId]);
          for (const row of rows) if (yield* administrativeRow(row)) result.add(row.session_id);
          return [...result];
        }).pipe(Effect.mapError(wrap)),
    });
  }),
);
