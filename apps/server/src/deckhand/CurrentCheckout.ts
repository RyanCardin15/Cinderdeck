import type { ThreadId } from "@t3tools/contracts";
import * as C from "@t3tools/contracts/deckhand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Relationships from "./Relationships.ts";
import * as Migrations from "./Migrations.ts";
export class CurrentCheckoutError extends Schema.TaggedError<CurrentCheckoutError>()(
  "CurrentCheckoutError",
  { reason: Schema.Literals(["pending", "unknown_outcome", "storage", "missing"]) },
) {}
export interface CurrentThreadContext {
  readonly session: C.SessionBinding;
  readonly originCheckout: C.CheckoutBinding;
  readonly checkout: C.CheckoutBinding;
  readonly workspace: C.WorkspaceBinding;
}
export class CurrentCheckout extends Context.Service<
  CurrentCheckout,
  {
    readonly current: (id: string) => Effect.Effect<C.CheckoutBinding, CurrentCheckoutError>;
    readonly forThread: (
      id: ThreadId,
    ) => Effect.Effect<CurrentThreadContext | null, CurrentCheckoutError>;
    readonly assertPhysicalAvailable: (id: string) => Effect.Effect<void, CurrentCheckoutError>;
    readonly changes: Stream.Stream<number>;
    readonly invalidate: Effect.Effect<void>;
  }
>()("t3/deckhand/CurrentCheckout") {}
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(C.SessionBinding));
const isError = Schema.is(CurrentCheckoutError);
const normalize = (cause: unknown) =>
  isError(cause) ? cause : new CurrentCheckoutError({ reason: "storage" });
export const assertPhysicalAvailable = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      state: "pending" | "unknown_outcome";
    }>`SELECT json_extract(record_json,'$.state') AS state FROM deckhand_ownership_transitions WHERE physical_id=${id} AND json_extract(record_json,'$.state') IN ('pending','unknown_outcome') LIMIT 1`;
    if (rows[0]) return yield* new CurrentCheckoutError({ reason: rows[0].state });
  }).pipe(Effect.mapError(normalize));
export const resolveCurrentCheckout = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const relationships = yield* Relationships.Relationships;
    const rows = yield* sql<{
      id: string;
    }>`SELECT id FROM deckhand_current_checkouts WHERE origin_id=${id}`;
    if (!rows[0]) return yield* new CurrentCheckoutError({ reason: "missing" });
    const checkout = yield* relationships.checkout(rows[0].id);
    for (const repo of checkout.repositories) yield* assertPhysicalAvailable(repo.physicalId);
    return checkout;
  }).pipe(Effect.mapError(normalize));
export const resolveCurrentThread = (id: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const relationships = yield* Relationships.Relationships;
    const rows = yield* sql<{
      record_json: string;
    }>`SELECT record_json FROM deckhand_sessions WHERE thread_id=${id}`;
    if (!rows[0]) return null;
    const session = yield* decode(rows[0].record_json);
    const originCheckout = yield* relationships.checkout(session.checkoutId);
    const checkout = yield* resolveCurrentCheckout(session.checkoutId);
    const workspace = yield* relationships.workspace(checkout.workspaceId);
    return { session, originCheckout, checkout, workspace };
  }).pipe(Effect.mapError(normalize));

export const layer = Layer.effect(
  CurrentCheckout,
  Effect.gen(function* () {
    yield* Migrations.migrate;
    const dependencies = yield* Effect.context<SqlClient.SqlClient | Relationships.Relationships>();
    const changed = yield* SubscriptionRef.make(0);
    return CurrentCheckout.of({
      current: (id) => resolveCurrentCheckout(id).pipe(Effect.provide(dependencies)),
      forThread: (id) => resolveCurrentThread(id).pipe(Effect.provide(dependencies)),
      assertPhysicalAvailable: (id) =>
        assertPhysicalAvailable(id).pipe(Effect.provide(dependencies)),
      changes: SubscriptionRef.changes(changed),
      invalidate: SubscriptionRef.update(changed, (n) => n + 1),
    });
  }),
);

/** Completed ownership may authorize the same feature's current native workspace;
 * its original primary checkout link and historical workspace are never rewritten. */
export const currentFeatureWorkspaceAuthorized = (featureID: string, targetWorkspaceID: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`SELECT fc.checkout_id FROM deckhand_features f
  JOIN deckhand_feature_checkouts fc ON fc.feature_id=f.id AND fc.is_primary=1
  JOIN deckhand_checkouts origin ON origin.id=fc.checkout_id AND origin.workspace_id=f.workspace_id
  JOIN deckhand_checkout_ownership alias ON alias.original_checkout_id=origin.id
  JOIN deckhand_ownership_transitions receipt ON receipt.id=alias.transition_id AND json_extract(receipt.record_json,'$.state')='completed'
  JOIN deckhand_checkouts target ON target.id=alias.target_checkout_id
  WHERE f.id=${featureID} AND target.workspace_id=${targetWorkspaceID}
   AND json_extract(f.record_json,'$.status')='active' AND json_extract(target.record_json,'$.state')='ready'
   AND NOT EXISTS(SELECT 1 FROM deckhand_ownership_transitions pending,json_each(target.record_json,'$.repositories') repo
    WHERE pending.physical_id=json_extract(repo.value,'$.physicalId') AND json_extract(pending.record_json,'$.state') IN ('pending','unknown_outcome')) LIMIT 1`;
    return rows.length === 1;
  }).pipe(Effect.mapError(normalize));
