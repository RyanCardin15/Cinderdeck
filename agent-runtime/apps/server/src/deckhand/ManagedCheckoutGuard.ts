import * as Contracts from "@cinderdeck/contracts/deckhand";
import type { ThreadId } from "@cinderdeck/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as Relationships from "./Relationships.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as Migrations from "./Migrations.ts";
import { resolveWorkspaceFolder } from "./WorkspaceFolderIdentity.ts";

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
  readonly access?: "read_only" | "write";
  readonly folders?: ReadonlyArray<string>;
  readonly files?: ReadonlyArray<string>;
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
>()("@cinderdeck/server/deckhand/ManagedCheckoutGuard") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Migrations.migrate;
  const identity = yield* CheckoutIdentity.CheckoutIdentity;
  const fs = yield* FileSystem.FileSystem;
  const resolveFolder = (path: string) =>
    resolveWorkspaceFolder(identity, path).pipe(Effect.provideService(FileSystem.FileSystem, fs));
  const relationships = yield* Relationships.Relationships;
  const ownershipDependencies = yield* Effect.context<
    SqlClient.SqlClient | Relationships.Relationships
  >();
  const currentCheckout = (id: string) =>
    CurrentCheckout.resolveCurrentCheckout(id).pipe(Effect.provide(ownershipDependencies));
  const assertOwnership = (id: string) =>
    CurrentCheckout.assertPhysicalAvailable(id).pipe(Effect.provide(ownershipDependencies));
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
        binding !== null && (yield* currentCheckout(binding.checkoutId)).backend === "cinderdeck"
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
      const checkout = yield* (binding === null ? identity.resolve(cwd) : resolveFolder(cwd)).pipe(
        Effect.result,
      );
      if (checkout._tag === "Failure") {
        if (binding !== null) return yield* fail("missing");
        if (checkout.failure.operation !== "not_git") return yield* fail("unavailable");
        // Existing non-Git projects retain upstream behavior. They cannot acquire
        // a connected checkout identity.
        return null;
      }
      yield* assertOwnership(checkout.success.physicalId);
      if (binding === null) {
        const managed =
          yield* sql`SELECT origin_id FROM deckhand_current_checkouts WHERE json_extract(record_json,'$.backend')='cinderdeck' AND EXISTS(SELECT 1 FROM json_each(record_json,'$.repositories') repo WHERE json_extract(repo.value,'$.physicalId')=${checkout.success.physicalId}) LIMIT 1`;
        if (managed.length) return yield* fail("missing");
        return {
          cwd: checkout.success.root,
          physicalId: checkout.success.physicalId,
        };
      }
      const target = yield* currentCheckout(binding.checkoutId);
      const workspace = yield* relationships.workspace(target.workspaceId);
      if (
        target.state !== "ready" ||
        workspace.state !== "active" ||
        target.workspaceGeneration !== workspace.generation ||
        target.environmentId !== workspace.environmentId ||
        !binding.repositoryScope?.length
      )
        return yield* fail("stale_binding");
      // Admission only accepts the persisted, enforced observer contract. The
      // provider wrapper separately checks the actual adapter before effects.
      const readOnly = binding.desiredAccess === "read_only";
      if (
        (readOnly && (binding.role !== "observer" || !binding.capabilities.enforcedReadOnly)) ||
        (binding.role === "observer" && !readOnly)
      )
        return yield* fail("unsupported_access");
      if (!binding.repositoryScope.includes(checkout.success.physicalId))
        return yield* fail("wrong_checkout");
      const wanted = target.repositories.filter((repo) =>
        binding.repositoryScope?.includes(repo.physicalId),
      );
      if (wanted.length !== binding.repositoryScope.length) return yield* fail("stale_binding");
      const physical = yield* Effect.forEach(wanted, (repo) => resolveFolder(repo.root));
      if (physical.some((repo, index) => repo.physicalId !== wanted[index]?.physicalId))
        return yield* fail("wrong_checkout");
      let folders: ReadonlyArray<string> | undefined;
      let files: ReadonlyArray<string> | undefined;
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
          resolveFolder(repo.path),
        );
        if (physical.some((repo) => !actual.some((item) => item.physicalId === repo.physicalId)))
          return yield* fail("wrong_checkout");
        // Membership comes from the live native definition, including shared folders in lanes.
        folders = [
          ...new Set([
            ...(native.resource.workspace?.root ? [native.resource.workspace.root] : []),
            ...(native.resource.workspace?.repos.map((repo) => repo.path) ?? []),
          ]),
        ];
        files = native.resource.workspace?.files ?? [];
      }
      return {
        cwd: checkout.success.root,
        physicalId: checkout.success.physicalId,
        access: readOnly ? ("read_only" as const) : ("write" as const),
        ...(folders === undefined ? {} : { folders }),
        ...(files === undefined ? {} : { files }),
      };
    }).pipe(Effect.mapError(storage(threadId)));
  return ManagedCheckoutGuard.of({ connected, resolve });
});
export const layer = Layer.effect(ManagedCheckoutGuard, make);
