import * as Contracts from "@t3tools/contracts/deckhand";
import type { IntegrationWriterReservationInput } from "@t3tools/contracts/deckhand/integration";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as Relationships from "./Relationships.ts";
import * as Migrations from "./Migrations.ts";

export class ManagedCheckoutError extends Schema.TaggedError<ManagedCheckoutError>()(
  "ManagedCheckoutError",
  {
    reason: Schema.Literals([
      "missing",
      "unavailable",
      "stale_binding",
      "wrong_checkout",
      "unsupported_access",
      "storage",
    ]),
    threadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Managed checkout ${this.reason}.`;
  }
}
export interface ManagedContext {
  readonly cwd: string;
  readonly physicalId: string;
  readonly writerScope: ReadonlyArray<string>;
  readonly native?: Omit<IntegrationWriterReservationInput, "id" | "token" | "ownerID">;
}
const decodeSession = Schema.decodeEffect(Schema.fromJsonString(Contracts.SessionBinding));
const isCheckoutError = Schema.is(ManagedCheckoutError);
export class ManagedCheckoutGuard extends Context.Service<
  ManagedCheckoutGuard,
  {
    readonly connected: (threadId: ThreadId) => Effect.Effect<boolean, ManagedCheckoutError>;
    readonly resolve: (
      threadId: ThreadId,
      cwd: string | null,
    ) => Effect.Effect<ManagedContext | null, ManagedCheckoutError>;
  }
>()("t3/deckhand/ManagedCheckoutGuard") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Migrations.migrate;
  const identity = yield* CheckoutIdentity.CheckoutIdentity;
  const relationships = yield* Relationships.Relationships;
  const hub = yield* IntegrationHub.IntegrationHub;
  const session = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_sessions WHERE thread_id = ${threadId}`;
      return rows[0] ? yield* decodeSession(rows[0].record_json) : null;
    });
  const storage = (threadId: ThreadId) => (cause: unknown) =>
    isCheckoutError(cause)
      ? cause
      : new ManagedCheckoutError({ threadId, reason: "storage", cause });
  const connected = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const binding = yield* session(threadId);
      return (
        binding !== null &&
        (yield* relationships.checkout(binding.checkoutId)).backend === "cinderdeck"
      );
    }).pipe(Effect.mapError(storage(threadId)));
  const resolve = (threadId: ThreadId, cwd: string | null) =>
    Effect.gen(function* () {
      const binding = yield* session(threadId);
      const fail = (reason: ManagedCheckoutError["reason"]) =>
        new ManagedCheckoutError({ threadId, reason });
      if (cwd === null) {
        if (binding !== null) return yield* fail("missing");
        return null;
      }
      const checkout = yield* identity.resolve(cwd).pipe(Effect.result);
      if (checkout._tag === "Failure") {
        if (binding !== null) return yield* fail("missing");
        if (checkout.failure.operation !== "not_git") return yield* fail("unavailable");
        // Existing non-Git projects retain upstream behavior. They cannot acquire
        // a Git checkout reservation or masquerade as a connected checkout.
        return null;
      }
      if (binding === null)
        return {
          cwd: checkout.success.root,
          physicalId: checkout.success.physicalId,
          writerScope: [checkout.success.physicalId],
        };
      const target = yield* relationships.checkout(binding.checkoutId);
      const workspace = yield* relationships.workspace(target.workspaceId);
      if (
        target.state !== "ready" ||
        workspace.state !== "active" ||
        target.workspaceGeneration !== workspace.generation ||
        target.environmentId !== workspace.environmentId ||
        !binding.repositoryScope?.length
      )
        return yield* fail("stale_binding");
      // Read-only enforcement is a provider policy, never a prompt. Until that
      // provider-specific policy is installed, these bindings fail closed.
      if (binding.desiredAccess === "read_only" || binding.role === "observer")
        return yield* fail("unsupported_access");
      if (!binding.repositoryScope.includes(checkout.success.physicalId))
        return yield* fail("wrong_checkout");
      const wanted = target.repositories.filter((repo) =>
        binding.repositoryScope?.includes(repo.physicalId),
      );
      if (wanted.length !== binding.repositoryScope.length) return yield* fail("stale_binding");
      const physical = yield* Effect.forEach(wanted, (repo) => identity.resolve(repo.root));
      if (physical.some((repo, index) => repo.physicalId !== wanted[index]?.physicalId))
        return yield* fail("wrong_checkout");
      let nativeScope: ManagedContext["native"];
      if (target.backend === "cinderdeck") {
        if (target.nativeGeneration === undefined) return yield* fail("stale_binding");
        const native = yield* hub
          .resource(target.kind === "lane" ? (target.laneId ?? "") : workspace.ownerId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ManagedCheckoutError({
                  threadId,
                  reason: cause.reason === "unavailable" ? "unavailable" : "stale_binding",
                  cause,
                }),
            ),
          );
        if (
          native.hello.installationID !== workspace.environmentId ||
          native.resource.generation !== target.nativeGeneration
        )
          return yield* fail("stale_binding");
        const actual = yield* Effect.forEach(native.resource.workspace?.repos ?? [], (repo) =>
          identity.resolve(repo.path),
        );
        if (physical.some((repo) => !actual.some((item) => item.physicalId === repo.physicalId)))
          return yield* fail("wrong_checkout");
        nativeScope = {
          installationID: native.hello.installationID,
          workspaceID: native.resource.workspaceID,
          generation: native.resource.generation,
          revision: native.resource.revision,
          repos: (native.resource.workspace?.repos ?? [])
            .filter((_, index) =>
              binding.repositoryScope?.includes(actual[index]?.physicalId ?? ""),
            )
            .map((repo) => repo.id),
        };
      }
      return {
        cwd: checkout.success.root,
        physicalId: checkout.success.physicalId,
        writerScope: binding.repositoryScope,
        ...(nativeScope ? { native: nativeScope } : {}),
      };
    }).pipe(Effect.mapError(storage(threadId)));
  return ManagedCheckoutGuard.of({ connected, resolve });
});
export const layer = Layer.effect(ManagedCheckoutGuard, make);
