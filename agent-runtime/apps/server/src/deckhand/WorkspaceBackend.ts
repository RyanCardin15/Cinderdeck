import * as Contracts from "@cinderdeck/contracts/deckhand";
import * as Integration from "@cinderdeck/contracts/deckhand/integration";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as Migrations from "./Migrations.ts";
import * as ProcessRunner from "../processRunner.ts";

export class CheckoutMutationError extends Schema.TaggedError<CheckoutMutationError>()(
  "CheckoutMutationError",
  {
    reason: Schema.Literals([
      "unavailable",
      "stale_binding",
      "native_lifecycle",
      "uncertain",
      "storage",
    ]),
    detail: Schema.optional(Schema.String),
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
type LaneLifecycle = (
  actorID: string,
  input: Omit<Integration.IntegrationOperationInput, "method">,
) => Effect.Effect<Integration.IntegrationOperationReceipt, Rpc.DeckhandRpcError>;
interface MutationContextScope {
  readonly repositoryPhysicalId: string;
  readonly standaloneLifecycle: boolean;
  active: boolean;
}
const ActiveMutation = Context.Reference<MutationContextScope | null>(
  "t3/deckhand/ActiveCheckoutMutation",
  { defaultValue: () => null },
);
// Backend selection follows physical ownership. A lost native socket cannot
// transfer a checkout into standalone lifecycle authority.
export class WorkspaceBackend extends Context.Service<
  WorkspaceBackend,
  {
    readonly inspect: (
      input: MutationInput,
    ) => Effect.Effect<MutationContext | null, CheckoutMutationError>;
    readonly withCheckout: <A, E, R>(
      input: MutationInput,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | CheckoutMutationError, R>;
    readonly includeCheckout: <A, E, R>(
      cwd: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | CheckoutMutationError, R>;
    readonly inventory: IntegrationHub.IntegrationHub["Service"]["overview"];
    readonly context: IntegrationHub.IntegrationHub["Service"]["resource"];
    readonly createLane: LaneLifecycle;
    readonly adoptLane: LaneLifecycle;
    readonly setupLane: LaneLifecycle;
    readonly releaseLane: LaneLifecycle;
    readonly removeLane: LaneLifecycle;
    readonly submit: IntegrationHub.IntegrationHub["Service"]["submit"];
    readonly operation: IntegrationHub.IntegrationHub["Service"]["operation"];
  }
>()("@cinderdeck/server/deckhand/WorkspaceBackend") {}
const decodeCheckout = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.CheckoutBinding));
const decodeWorkspace = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Contracts.WorkspaceBinding),
);
const isMutationError = Schema.is(CheckoutMutationError);
const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const sql = yield* SqlClient.SqlClient;
  const ownershipDependencies = yield* Effect.context<SqlClient.SqlClient>();
  const fs = yield* FileSystem.FileSystem;
  const identities = yield* CheckoutIdentity.CheckoutIdentity;
  const runner = yield* ProcessRunner.ProcessRunner;
  const hub = yield* IntegrationHub.IntegrationHub;
  const retainsNativePath = (cwd: string) =>
    Effect.gen(function* () {
      const within = (parent: string) =>
        cwd === parent || cwd.startsWith(parent.replace(/\/+$/, "") + "/");
      const canonical = (root: string) => fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_current_checkouts
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
      yield* CurrentCheckout.assertPhysicalAvailable(current.physicalId).pipe(
        Effect.provide(ownershipDependencies),
        Effect.mapError(() => new CheckoutMutationError({ reason: "uncertain" })),
      );
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
      }>`SELECT DISTINCT c.record_json AS checkout_json,
      w.record_json AS workspace_json FROM deckhand_current_checkouts c JOIN deckhand_workspaces w ON w.id=c.workspace_id
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
        // to a Cinderdeck thread. Inventory Git itself rather than just our catalog.
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
          const linked = yield* identities.resolve(root).pipe(
            Effect.catch(() => identities.missingRegistration(current, root)),
            Effect.mapError(
              () =>
                new CheckoutMutationError({
                  reason: "unavailable",
                  detail: `Git cannot verify the linked worktree at ${root}. Restore access to that folder or repair its worktree registration before switching branches.`,
                }),
            ),
          );
          if (!linked)
            return yield* new CheckoutMutationError({
              reason: "unavailable",
              detail: `Git cannot verify the linked worktree at ${root}. Restore access to that folder or repair its worktree registration before switching branches.`,
            });
          if (linked.repositoryPhysicalId !== current.repositoryPhysicalId)
            return yield* new CheckoutMutationError({ reason: "stale_binding" });
          physicalIDs.add(linked.physicalId);
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
          const actual = yield* identities.resolve(repo.root).pipe(
            Effect.catch(() => identities.missingRegistration(current, repo.root)),
            Effect.mapError(() => new CheckoutMutationError({ reason: "stale_binding" })),
          );
          if (!actual) return yield* new CheckoutMutationError({ reason: "stale_binding" });
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
      // All registered worktrees share refs, including standalone or offline ones.
      for (const id of physicalIDs)
        yield* CurrentCheckout.assertPhysicalAvailable(id).pipe(
          Effect.provide(ownershipDependencies),
          Effect.mapError(() => new CheckoutMutationError({ reason: "uncertain" })),
        );
      const lookup = yield* hub
        .checkoutContexts({
          physicalID: current.physicalId,
          repositoryPhysicalID: current.repositoryPhysicalId,
          physicalIDs: [...physicalIDs],
          sharedRefs: input.sharedRefs,
        })
        .pipe(Effect.result);
      if (lookup._tag === "Failure") {
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
      // A settings edit/reload changes the native generation. Git mutations use
      // the live context plus the verified physical identities above; an old
      // conversation generation must not block the same physical checkout.
      for (const { binding, workspace } of known.filter(
        (item) => item.binding.backend === "cinderdeck",
      )) {
        const id = binding.kind === "lane" ? binding.laneId : workspace.ownerId;
        if (
          workspace.environmentId !== lookup.success.installationID ||
          !contexts.some(
            (item) =>
              item.workspaceID === id &&
              binding.repositories
                .filter((repo) => physicalIDs.has(repo.physicalId))
                .every((repo) => item.physicalIDs.includes(repo.physicalId)),
          )
        )
          return yield* new CheckoutMutationError({ reason: "stale_binding" });
      }
      if (input.worktreeLifecycle && contexts.length)
        return yield* new CheckoutMutationError({ reason: "native_lifecycle" });
      for (const context of contexts) for (const id of context.physicalIDs) physicalIDs.add(id);
      if (physicalIDs.size > 64)
        return yield* new CheckoutMutationError({ reason: "stale_binding" });
      for (const id of physicalIDs)
        yield* CurrentCheckout.assertPhysicalAvailable(id).pipe(
          Effect.provide(ownershipDependencies),
          Effect.mapError(() => new CheckoutMutationError({ reason: "uncertain" })),
        );
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
  const withCheckout: WorkspaceBackend["Service"]["withCheckout"] = (input, effect) =>
    Effect.gen(function* () {
      // Retry only the read-only inspection after a transient connection failure.
      // The Git/file effect below is never replayed, even if it fails.
      const resolved = yield* inspect(input).pipe(
        Effect.catchIf(
          (error) => error.reason === "unavailable",
          (error) =>
            hub.refresh.pipe(
              Effect.mapError(() => error),
              Effect.andThen(inspect(input)),
            ),
        ),
      );
      if (resolved === null) return yield* effect;
      const context: MutationContextScope = {
        repositoryPhysicalId: resolved.current.repositoryPhysicalId,
        standaloneLifecycle:
          !!input.worktreeLifecycle &&
          resolved.backend === "standalone" &&
          resolved.contexts.length === 0,
        active: true,
      };
      return yield* effect.pipe(
        Effect.provideService(ActiveMutation, context),
        Effect.ensuring(
          Effect.sync(() => {
            context.active = false;
          }),
        ),
      );
    });
  const includeCheckout: WorkspaceBackend["Service"]["includeCheckout"] = (cwd, effect) =>
    Effect.gen(function* () {
      const context = yield* ActiveMutation;
      if (!context?.active || !context.standaloneLifecycle)
        return yield* new CheckoutMutationError({ reason: "native_lifecycle" });
      const target = yield* inspect({ cwd, sharedRefs: false });
      if (
        !target ||
        target.backend !== "standalone" ||
        target.contexts.length ||
        target.current.repositoryPhysicalId !== context.repositoryPhysicalId
      )
        return yield* new CheckoutMutationError({ reason: "stale_binding" });
      const fresh = yield* identities
        .resolve(cwd)
        .pipe(Effect.mapError(() => new CheckoutMutationError({ reason: "stale_binding" })));
      if (
        fresh.physicalId !== target.current.physicalId ||
        fresh.repositoryPhysicalId !== context.repositoryPhysicalId
      ) {
        return yield* new CheckoutMutationError({ reason: "stale_binding" });
      }
      return yield* effect;
    });
  return WorkspaceBackend.of({
    inspect,
    withCheckout,
    includeCheckout,
    inventory: hub.overview,
    context: hub.resource,
    createLane: (actorID, input) => hub.submit(actorID, { ...input, method: "lane.create" }),
    adoptLane: (actorID, input) => hub.submit(actorID, { ...input, method: "lane.adopt" }),
    setupLane: (actorID, input) => hub.submit(actorID, { ...input, method: "lane.setup" }),
    releaseLane: (actorID, input) => hub.submit(actorID, { ...input, method: "lane.release" }),
    removeLane: (actorID, input) => hub.submit(actorID, { ...input, method: "lane.remove" }),
    submit: hub.submit,
    operation: hub.operation,
  });
});
export const layer = Layer.effect(WorkspaceBackend, make);
export const layerLive = layer.pipe(
  Layer.provide(CheckoutIdentity.layer.pipe(Layer.provide(ProcessRunner.layer))),
  Layer.provide(IntegrationHub.layerLive),
  Layer.provide(ProcessRunner.layer),
);
