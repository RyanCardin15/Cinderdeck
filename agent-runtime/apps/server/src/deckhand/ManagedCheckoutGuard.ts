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
  /** Set when the conversation runs in a native Cinderdeck lane. */
  readonly laneName?: string;
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
      const readOnly = binding?.desiredAccess === "read_only";
      if (readOnly && !binding.capabilities.enforcedReadOnly)
        return yield* fail("unsupported_access");
      let folders: ReadonlyArray<string> | undefined;
      let files: ReadonlyArray<string> | undefined;
      if (binding) {
        const target = yield* relationships.checkout(binding.checkoutId);
        const workspace = yield* relationships.workspace(target.workspaceId);
        // Legacy bindings provide folder context, never checkout reservations.
        // A thread can resume in its selected folder even while native tools are offline.
        const native =
          target.backend === "cinderdeck"
            ? yield* hub
                .resource(target.laneId ?? workspace.ownerId)
                .pipe(Effect.orElseSucceed(() => null))
            : null;
        const paths =
          native?.hello.installationID === workspace.environmentId
            ? [
                native.resource.workspace?.root,
                ...(native.resource.workspace?.repos.map((repo) => repo.path) ?? []),
              ]
            : target.repositories.map((repo) => repo.root);
        // A thread moved to another worktree uses that checkout rather than reintroducing old folders.
        const canonical = yield* Effect.forEach(
          paths.filter((path): path is string => !!path),
          (path) => fs.realPath(path).pipe(Effect.orElseSucceed(() => path)),
        );
        if (canonical.includes(checkout.success.root)) {
          const existing = yield* Effect.filter(
            paths.filter((path): path is string => !!path),
            (path) => fs.exists(path),
          );
          folders = [...new Set(existing)];
          files = native?.resource.workspace?.files;
        }
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
