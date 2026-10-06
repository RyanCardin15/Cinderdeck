import type { OrchestrationV2StoredEvent } from "@cinderdeck/contracts";
import * as C from "@cinderdeck/contracts/deckhand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Relationships from "./Relationships.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as Migrations from "./Migrations.ts";

/** Applied inside the event sink transaction, before the new thread location is published. */
export class ManagedCheckoutTransfer extends Context.Service<
  ManagedCheckoutTransfer,
  {
    readonly apply: (
      stored: OrchestrationV2StoredEvent,
    ) => Effect.Effect<void, CheckoutTransferError>;
    readonly notify: Effect.Effect<void>;
  }
>()("@cinderdeck/server/deckhand/ManagedCheckoutTransfer") {}
export class CheckoutTransferError extends Schema.TaggedError<CheckoutTransferError>()(
  "CheckoutTransferError",
  { message: Schema.String },
) {}

export const layer = Layer.effect(
  ManagedCheckoutTransfer,
  Effect.gen(function* () {
    yield* Migrations.migrate;
    const sql = yield* SqlClient.SqlClient;
    const relationships = yield* Relationships.Relationships;
    const current = yield* CurrentCheckout.CurrentCheckout;
    return ManagedCheckoutTransfer.of({
      notify: current.invalidate,
      apply: (stored) =>
        Effect.gen(function* () {
          if (stored.event.type !== "thread.metadata-updated") return;
          const rows = yield* sql<{
            session_id: string;
            source_checkout_id: string;
            target_checkout_id: string;
            target_path: string;
          }>`
        SELECT session_id, source_checkout_id, target_checkout_id, target_path
        FROM deckhand_checkout_transfers WHERE command_id=${stored.commandId}`;
          const move = rows[0];
          if (!move) return;
          const session = yield* relationships.session(move.session_id);
          const target = yield* relationships.checkout(move.target_checkout_id);
          if (
            session.threadId !== stored.event.threadId ||
            session.role !== "writer" ||
            session.desiredAccess !== "write" ||
            session.checkoutId !== move.source_checkout_id ||
            stored.event.payload.worktreePath !== move.target_path ||
            target.workspaceId !== (yield* current.current(session.checkoutId)).workspaceId ||
            target.state !== "ready" ||
            target.kind !== "lane" ||
            !target.repositories.some((repo) => repo.root === move.target_path)
          ) {
            return yield* new CheckoutTransferError({
              message:
                "The conversation's lane changed during handoff. Retry from its current checkout.",
            });
          }
          yield* relationships.linkCheckout(session.featureId, target.id, true);
          const updated = yield* Schema.encodeEffect(Schema.fromJsonString(C.SessionBinding))({
            ...session,
            checkoutId: target.id,
            repositoryScope: target.repositories.map((repo) => repo.physicalId),
          });
          yield* sql`UPDATE deckhand_sessions SET checkout_id=${target.id}, record_json=${updated} WHERE id=${session.id}`;
          yield* sql`UPDATE deckhand_checkout_transfers SET completed=1 WHERE command_id=${stored.commandId}`;
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(CheckoutTransferError)(cause)
              ? cause
              : new CheckoutTransferError({ message: String(cause) }),
          ),
        ),
    });
  }),
);
