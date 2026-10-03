import * as Contracts from "@t3tools/contracts/deckhand";
import * as Integration from "@t3tools/contracts/deckhand/integration";
import * as Rpc from "@t3tools/contracts/deckhand/rpc";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as Migrations from "./Migrations.ts";
import * as ProcessRunner from "../processRunner.ts";

export class CheckoutMutationError extends Schema.TaggedError<CheckoutMutationError>()(
  "CheckoutMutationError",
  {
    reason: Schema.Literals([
      "busy",
      "unavailable",
      "stale_binding",
      "native_lifecycle",
      "uncertain",
      "storage",
    ]),
  },
) {
  override get message() {
    return `Checkout mutation ${this.reason}.`;
  }
}
export interface MutationInput {
  readonly cwd: string;
  readonly sharedRefs: boolean;
  readonly worktreeLifecycle?: boolean;
  readonly gitDirectory?: string;
}
export interface MutationContext {
  readonly backend: "standalone" | "cinderdeck";
  readonly current: Contracts.PhysicalCheckout;
  readonly physicalIDs: ReadonlyArray<string>;
  readonly contexts: ReadonlyArray<Integration.IntegrationCheckoutContext>;
  readonly installationID: string | null;
}
// Backend selection follows physical ownership. A lost native socket cannot
// transfer a checkout into standalone lifecycle authority.
export class WorkspaceBackend extends Context.Service<
  WorkspaceBackend,
  {
    readonly inspect: (
      input: MutationInput,
    ) => Effect.Effect<MutationContext | null, CheckoutMutationError>;
    readonly inventory: IntegrationHub.IntegrationHub["Service"]["overview"];
    readonly context: IntegrationHub.IntegrationHub["Service"]["resource"];
    readonly createLane: (
      actorID: string,
      input: Omit<Integration.IntegrationOperationInput, "method">,
    ) => Effect.Effect<Integration.IntegrationOperationReceipt, Rpc.DeckhandRpcError>;
  }
>()("t3/deckhand/WorkspaceBackend") {}
const decodeCheckout = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.CheckoutBinding));
const decodeWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Contracts.WorkspaceBinding),
);
const isMutationError = Schema.is(CheckoutMutationError);
const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const identities = yield* CheckoutIdentity.CheckoutIdentity;
  const runner = yield* ProcessRunner.ProcessRunner;
  const hub = yield* IntegrationHub.IntegrationHub;
  const retainsNativePath = (cwd: string) =>
    Effect.gen(function* () {
      const within = (parent: string) =>
        cwd === parent || cwd.startsWith(parent.replace(/\/+$/, "") + "/");
      const canonical = (root: string) => fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
      const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM deckhand_checkouts
      WHERE json_extract(record_json, '$.backend')='cinderdeck' LIMIT 5001`;
      if (rows.length > 5000) return yield* new CheckoutMutationError({ reason: "unavailable" });
      for (const row of rows) {
        const binding = yield* decodeCheckout(row.record_json);
        for (const repo of binding.repositories)
          if (within(yield* canonical(repo.root))) return true;
      }
      // Git metadata may have been removed, or the native workspace may be a
      // directory awaiting initialization. Refresh ownership before treating it as ordinary.
      yield* hub.refresh.pipe(Effect.ignore);
      const first = yield* hub.overview({ offset: 0, limit: 100 });
      for (let offset = 0; offset < first.total; offset += 100) {
        const page = offset === 0 ? first : yield* hub.overview({ offset, limit: 100 });
        for (const resource of page.resources)
          for (const repo of resource.workspace?.repos ?? []) {
            if (within(yield* canonical(repo.path))) return true;
          }
      }
      return false;
    });
  const inspect: WorkspaceBackend["Service"]["inspect"] = (input) =>
    Effect.gen(function* () {
      const checkout = yield* identities.resolve(input.cwd).pipe(Effect.result);
      if (checkout._tag === "Failure") {
        if (checkout.failure.operation === "not_git" && !input.gitDirectory) {
          const cwd = yield* fs.realPath(input.cwd);
          if (yield* retainsNativePath(cwd))
            return yield* new CheckoutMutationError({ reason: "unavailable" });
          return null;
        }
        return yield* new CheckoutMutationError({ reason: "unavailable" });
      }
      const current = checkout.success;
      if (input.gitDirectory) {
        const selected = yield* fs
          .realPath(input.gitDirectory)
          .pipe(Effect.mapError(() => new CheckoutMutationError({ reason: "unavailable" })));
        if (selected !== current.commonDirectory && selected !== current.gitDirectory)
          return yield* new CheckoutMutationError({ reason: "stale_binding" });
      }
      const rows = yield* sql<{
        checkout_json: string;
        workspace_json: string;
      }>`SELECT c.record_json AS checkout_json,
      w.record_json AS workspace_json FROM deckhand_checkouts c JOIN deckhand_workspaces w ON w.id=c.workspace_id
      WHERE EXISTS (SELECT 1 FROM json_each(c.record_json, '$.repositories') repo
        WHERE json_extract(repo.value,'$.physicalId')=${current.physicalId}
          OR json_extract(repo.value,'$.root')=${current.root}
          OR (${input.sharedRefs ? 1 : 0} AND json_extract(repo.value,'$.repositoryPhysicalId')=${current.repositoryPhysicalId})) LIMIT 65`;
      if (rows.length > 64) return yield* new CheckoutMutationError({ reason: "stale_binding" });
      const known = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const binding = yield* decodeCheckout(row.checkout_json);
          const workspace = yield* decodeWorkspace(row.workspace_json);
          if (
            binding.state !== "ready" ||
            workspace.state !== "active" ||
            binding.workspaceGeneration !== workspace.generation ||
            binding.environmentId !== workspace.environmentId
          )
            return yield* new CheckoutMutationError({ reason: "stale_binding" });
          return { binding, workspace };
        }),
      );
      const physicalIDs = new Set([current.physicalId]);
      if (input.sharedRefs) {
        // Git refs/config are shared even with worktrees that have never been bound
        // to a Deckhand thread. Inventory Git itself rather than just our catalog.
        const inventory = yield* runner.run({
          command: "git",
          args: ["-C", current.root, "worktree", "list", "--porcelain", "-z"],
          timeout: Duration.seconds(10),
          maxOutputBytes: 65536,
          env: { LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
        });
        if (inventory.code !== 0 || inventory.stdoutTruncated || inventory.stdoutInvalidUtf8)
          return yield* new CheckoutMutationError({ reason: "unavailable" });
        const records = inventory.stdout.split("\0\0").filter(Boolean);
        if (!records.length || records.length > 64)
          return yield* new CheckoutMutationError({ reason: "unavailable" });
        for (const record of records) {
          const fields = record.split("\0");
          const first = fields[0];
          if (!first?.startsWith("worktree "))
            return yield* new CheckoutMutationError({ reason: "unavailable" });
          if (fields.includes("bare")) continue;
          const root = first.slice(9);
          const linked = yield* identities.resolve(root).pipe(Effect.result);
          if (linked._tag === "Failure")
            return yield* new CheckoutMutationError({ reason: "unavailable" });
          if (linked.success.repositoryPhysicalId !== current.repositoryPhysicalId)
            return yield* new CheckoutMutationError({ reason: "stale_binding" });
          physicalIDs.add(linked.success.physicalId);
        }
      }
      for (const { binding } of known) {
        for (const repo of binding.repositories) {
          if (
            repo.physicalId !== current.physicalId &&
            repo.root !== current.root &&
            !(input.sharedRefs && repo.repositoryPhysicalId === current.repositoryPhysicalId)
          )
            continue;
          const actual = yield* identities
            .resolve(repo.root)
            .pipe(Effect.mapError(() => new CheckoutMutationError({ reason: "stale_binding" })));
          if (
            actual.physicalId !== repo.physicalId ||
            actual.repositoryPhysicalId !== repo.repositoryPhysicalId
          )
            return yield* new CheckoutMutationError({ reason: "stale_binding" });
          physicalIDs.add(repo.physicalId);
        }
      }
      if (physicalIDs.size > 64)
        return yield* new CheckoutMutationError({ reason: "stale_binding" });
      const lookup = yield* hub
        .checkoutContexts({
          physicalID: current.physicalId,
          repositoryPhysicalID: current.repositoryPhysicalId,
          physicalIDs: [...physicalIDs],
          sharedRefs: input.sharedRefs,
        })
        .pipe(Effect.result);
      if (lookup._tag === "Failure") {
        if (lookup.failure.code === "checkout_reserved")
          return yield* new CheckoutMutationError({ reason: "busy" });
        if (
          known.some((item) => item.binding.backend === "cinderdeck") ||
          lookup.failure.reason !== "unavailable"
        )
          return yield* new CheckoutMutationError({ reason: "unavailable" });
        // Cached native ownership remains a boundary during disconnection. Ordinary
        // standalone repositories retain their backend; socket loss never adopts them.
        const view = yield* hub.overview({ offset: 0, limit: 100 });
        for (let offset = 0; offset < view.total; offset += 100) {
          const page = offset === 0 ? view : yield* hub.overview({ offset, limit: 100 });
          for (const resource of page.resources) {
            for (const repo of resource.workspace?.repos ?? []) {
              if (
                (repo.physicalID && physicalIDs.has(repo.physicalID)) ||
                (input.sharedRefs && repo.repositoryPhysicalID === current.repositoryPhysicalId)
              )
                return yield* new CheckoutMutationError({ reason: "unavailable" });
              const actual = yield* identities.resolve(repo.path).pipe(Effect.result);
              if (
                actual._tag === "Success" &&
                (physicalIDs.has(actual.success.physicalId) ||
                  (input.sharedRefs &&
                    actual.success.repositoryPhysicalId === current.repositoryPhysicalId))
              )
                return yield* new CheckoutMutationError({ reason: "unavailable" });
              const path = yield* fs
                .realPath(repo.path)
                .pipe(Effect.orElseSucceed(() => repo.path));
              if (path === current.root)
                return yield* new CheckoutMutationError({ reason: "unavailable" });
            }
          }
        }
        return {
          backend: "standalone" as const,
          current,
          physicalIDs: [...physicalIDs],
          contexts: [],
          installationID: null,
        };
      }
      const contexts = lookup.success.contexts;
      const nativeIDs = new Set(contexts.flatMap((item) => item.physicalIDs));
      if (
        known.some(
          (item) =>
            item.binding.backend === "standalone" &&
            item.binding.repositories.some((repo) => nativeIDs.has(repo.physicalId)),
        )
      )
        return yield* new CheckoutMutationError({ reason: "stale_binding" });
      if (contexts.some((item) => !item.available))
        return yield* new CheckoutMutationError({ reason: "unavailable" });
      for (const { binding, workspace } of known.filter(
        (item) => item.binding.backend === "cinderdeck",
      )) {
        const id = binding.kind === "lane" ? binding.laneId : workspace.ownerId;
        if (
          workspace.environmentId !== lookup.success.installationID ||
          !contexts.some(
            (item) => item.workspaceID === id && item.generation === binding.nativeGeneration,
          )
        )
          return yield* new CheckoutMutationError({ reason: "stale_binding" });
      }
      if (input.worktreeLifecycle && contexts.length)
        return yield* new CheckoutMutationError({ reason: "native_lifecycle" });
      for (const context of contexts) for (const id of context.physicalIDs) physicalIDs.add(id);
      if (physicalIDs.size > 64)
        return yield* new CheckoutMutationError({ reason: "stale_binding" });
      return {
        backend: nativeIDs.has(current.physicalId)
          ? ("cinderdeck" as const)
          : ("standalone" as const),
        current,
        physicalIDs: [...physicalIDs],
        contexts,
        installationID: lookup.success.installationID,
      };
    }).pipe(
      Effect.mapError((cause) =>
        isMutationError(cause) ? cause : new CheckoutMutationError({ reason: "storage" }),
      ),
    );
  return WorkspaceBackend.of({
    inspect,
    inventory: hub.overview,
    context: hub.resource,
    createLane: (actorID, input) => hub.submit(actorID, { ...input, method: "lane.create" }),
  });
});
export const layer = Layer.effect(WorkspaceBackend, make);
export const layerLive = layer.pipe(
  Layer.provide(CheckoutIdentity.layer.pipe(Layer.provide(ProcessRunner.layer))),
  Layer.provide(IntegrationHub.layerLive),
  Layer.provide(ProcessRunner.layer),
);
