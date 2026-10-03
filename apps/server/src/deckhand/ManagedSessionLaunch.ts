// @effect-diagnostics nodeBuiltinImport:off - UUIDs and hashes identify durable launch intents.
import * as NodeCrypto from "node:crypto";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Contracts from "@t3tools/contracts/deckhand";
import * as Rpc from "@t3tools/contracts/deckhand/rpc";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as Migrations from "./Migrations.ts";
import * as Relationships from "./Relationships.ts";

export class ManagedLaunchError extends Schema.TaggedError<ManagedLaunchError>()(
  "ManagedLaunchError",
  {
    operationKey: Schema.String,
    reason: Schema.Literals([
      "missing",
      "wrong_actor",
      "key_conflict",
      "stale_context",
      "unavailable_provider",
      "storage",
      "launch_failed",
    ]),
  },
) {
  override get message() {
    return `Managed session launch ${this.reason}.`;
  }
}
export class ManagedSessionLaunch extends Context.Service<
  ManagedSessionLaunch,
  {
    readonly launch: (
      actorID: string,
      input: Rpc.ManagedLaunchInput,
    ) => Effect.Effect<Rpc.ManagedLaunchRecord, ManagedLaunchError>;
    readonly get: (
      actorID: string,
      operationKey: string,
    ) => Effect.Effect<Rpc.ManagedLaunchRecord, ManagedLaunchError>;
    readonly options: Effect.Effect<ReadonlyArray<typeof Rpc.ManagedLaunchOption.Type>>;
  }
>()("t3/deckhand/ManagedSessionLaunch") {}

const encodeInput = Schema.encodeEffect(Schema.fromJsonString(Rpc.ManagedLaunchInput));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(Rpc.ManagedLaunchRecord));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Rpc.ManagedLaunchRecord));
const isLaunchError = Schema.is(ManagedLaunchError);
const bindingID = (kind: string, parts: ReadonlyArray<string | number>) =>
  `${kind}:${NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;

const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* IntegrationHub.IntegrationHub;
  const identities = yield* CheckoutIdentity.CheckoutIdentity;
  const relationships = yield* Relationships.Relationships;
  const projects = yield* ProjectService.ProjectService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const locks = yield* makeKeyedSerialExecutor<string>();
  const error = (operationKey: string, reason: ManagedLaunchError["reason"]) =>
    new ManagedLaunchError({ operationKey, reason });
  const storage = (operationKey: string) => (cause: unknown) =>
    isLaunchError(cause) ? cause : error(operationKey, "storage");
  const read = (actorID: string, operationKey: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ actor_id: string; input_json: string; record_json: string }>`
      SELECT actor_id, input_json, record_json FROM deckhand_managed_launches WHERE operation_key = ${operationKey}`;
      const row = rows[0];
      if (row && row.actor_id !== actorID) return yield* error(operationKey, "wrong_actor");
      return row ? { input: row.input_json, record: yield* decodeRecord(row.record_json) } : null;
    }).pipe(Effect.mapError(storage(operationKey)));
  const get = (actorID: string, operationKey: string) =>
    Effect.gen(function* () {
      const saved = yield* read(actorID, operationKey);
      if (!saved) return yield* error(operationKey, "missing");
      return saved.record;
    });
  const options = providers.getProviders.pipe(
    Effect.map((snapshots) =>
      snapshots
        .filter(
          (provider) =>
            provider.enabled && provider.installed && provider.availability !== "unavailable",
        )
        .map((provider) => ({
          instanceId: provider.instanceId,
          label: provider.displayName ?? provider.instanceId,
          models: provider.models.map((model) => ({ id: model.slug, label: model.name })),
        })),
    ),
  );
  const launch = (actorID: string, input: Rpc.ManagedLaunchInput) =>
    locks.withLock(
      input.operationKey,
      Effect.gen(function* () {
        const key = input.operationKey;
        const encodedInput = yield* encodeInput(input).pipe(
          Effect.mapError(() => error(key, "stale_context")),
        );
        const prior = yield* read(actorID, key);
        if (prior && prior.input !== encodedInput) return yield* error(key, "key_conflict");
        // An accepted receipt records intake, never provider completion. Reading it does not
        // reopen a provider or depend on a still-present native lane.
        if (prior?.record.state === "accepted") return prior.record;
        const snapshot = yield* hub
          .resource(input.workspaceID)
          .pipe(Effect.mapError(() => error(key, "stale_context")));
        const resource = snapshot.resource;
        const context = resource.workspace;
        if (
          snapshot.hello.installationID !== input.installationID ||
          !context ||
          !resource.available ||
          resource.generation !== input.generation ||
          resource.revision !== input.revision ||
          context.definitionChanged ||
          context.issues.length ||
          !context.repos.length ||
          context.repos.length > 64 ||
          new Set(context.repos.map((repo) => repo.id)).size !== context.repos.length ||
          !snapshot.hello.capabilities.includes("checkout.reservations")
        )
          return yield* error(key, "stale_context");
        const selected = context.repos.find((repo) => repo.id === input.repositoryID);
        if (!selected) return yield* error(key, "stale_context");
        const parentID = context.lane?.sourceStackID ?? resource.workspaceID;
        const parentSnapshot = context.lane
          ? yield* hub.resource(parentID).pipe(Effect.mapError(() => error(key, "stale_context")))
          : snapshot;
        const parent = parentSnapshot.resource;
        if (
          parentSnapshot.hello.installationID !== input.installationID ||
          !parent.available ||
          !parent.workspace ||
          parent.workspace.lane ||
          parent.workspace.definitionChanged ||
          parent.workspace.issues.length
        )
          return yield* error(key, "stale_context");
        const physical = yield* Effect.forEach(context.repos, (repo) =>
          identities.resolve(repo.path).pipe(Effect.mapError(() => error(key, "stale_context"))),
        );
        if (new Set(physical.map((repo) => repo.physicalId)).size !== physical.length)
          return yield* error(key, "stale_context");
        const cwd = physical[context.repos.indexOf(selected)]!;
        const metadata = adapters.getMetadata
          ? yield* adapters
              .getMetadata(input.modelSelection.instanceId)
              .pipe(Effect.mapError(() => error(key, "unavailable_provider")))
          : null;
        const provider = (yield* providers.getProviders).find(
          (item) => item.instanceId === input.modelSelection.instanceId,
        );
        if (
          !metadata?.enabled ||
          !provider?.enabled ||
          !provider.installed ||
          provider.availability === "unavailable" ||
          (provider.supportedRuntimeModes &&
            !provider.supportedRuntimeModes.includes(input.runtimeMode))
        )
          return yield* error(key, "unavailable_provider");
        return yield* locks.withLock(
          bindingID("context", [input.installationID, parentID, parent.generation]),
          Effect.gen(function* () {
            // Earlier bindings may have a legacy or imported ID. The native ownership tuple
            // remains canonical; reuse it rather than inventing a second workspace identity.
            const linkedWorkspaces = yield* sql<{ id: string }>`SELECT id FROM deckhand_workspaces
        WHERE environment_id = ${input.installationID} AND backend = 'cinderdeck'
          AND owner_id = ${parentID} AND generation = ${parent.generation}`;
            const workspaceId = Contracts.WorkspaceBindingId.make(
              linkedWorkspaces[0]?.id ??
                bindingID("workspace", [input.installationID, parentID, parent.generation]),
            );
            const checkoutId = Contracts.CheckoutBindingId.make(
              bindingID("checkout", [
                workspaceId,
                resource.workspaceID,
                resource.generation,
                ...physical.map((repo) => repo.physicalId).sort(),
              ]),
            );
            const expectedCheckout = prior
              ? yield* relationships
                  .checkout(prior.record.checkoutId)
                  .pipe(Effect.mapError(() => error(key, "stale_context")))
              : null;
            if (
              expectedCheckout &&
              (expectedCheckout.id !== checkoutId || expectedCheckout.state !== "ready")
            )
              return yield* error(key, "stale_context");
            let record = prior?.record;
            if (!record) {
              const project = yield* projects
                .bootstrap({
                  commandId: CommandId.make(`deckhand-project:${key}`),
                  projectId: ProjectId.make(NodeCrypto.randomUUID()),
                  title: `${context.name} · ${selected.id}`,
                  workspaceRoot: cwd.root,
                  createWorkspaceRootIfMissing: false,
                })
                .pipe(Effect.mapError(() => error(key, "launch_failed")));
              const now = DateTime.formatIso(yield* DateTime.now);
              const featureId = Contracts.FeatureId.make(NodeCrypto.randomUUID());
              const sessionId = Contracts.SessionBindingId.make(NodeCrypto.randomUUID());
              const threadId = ThreadId.make(NodeCrypto.randomUUID());
              record = {
                operationKey: key,
                projectId: project.project.id,
                threadId,
                featureId,
                sessionId,
                checkoutId,
                state: "prepared",
              };
              const recordJson = yield* encodeRecord(record);
              const caps = metadata.capabilities;
              yield* sql
                .withTransaction(
                  Effect.gen(function* () {
                    const existingWorkspace =
                      yield* sql`SELECT id FROM deckhand_workspaces WHERE id = ${workspaceId}`;
                    if (!existingWorkspace.length)
                      yield* relationships.putWorkspace(
                        {
                          id: workspaceId,
                          environmentId: Contracts.EnvironmentId.make(input.installationID),
                          backend: "cinderdeck",
                          ownerId: parentID,
                          generation: parent.generation,
                          revision: 1,
                          name: parent.workspace!.name,
                          state: "active",
                        },
                        null,
                      );
                    else if ((yield* relationships.workspace(workspaceId)).state !== "active")
                      return yield* error(key, "stale_context");
                    const existingCheckout =
                      yield* sql`SELECT id FROM deckhand_checkouts WHERE id = ${checkoutId}`;
                    if (!existingCheckout.length)
                      yield* relationships.putCheckout(
                        {
                          id: checkoutId,
                          workspaceId,
                          workspaceGeneration: parent.generation,
                          nativeGeneration: resource.generation,
                          environmentId: Contracts.EnvironmentId.make(input.installationID),
                          backend: "cinderdeck",
                          kind: context.lane ? "lane" : "primary",
                          laneId: context.lane ? resource.workspaceID : null,
                          state: "ready",
                          repositories: physical,
                          revision: 1,
                        },
                        null,
                      );
                    else if ((yield* relationships.checkout(checkoutId)).state !== "ready")
                      return yield* error(key, "stale_context");
                    yield* relationships.putFeature(
                      {
                        id: featureId,
                        workspaceId,
                        title: input.title,
                        objective: input.objective,
                        status: "active",
                        revision: 1,
                        createdAt: now,
                        updatedAt: now,
                      },
                      null,
                    );
                    yield* relationships.linkCheckout(featureId, checkoutId, true);
                    yield* relationships.putSession(
                      {
                        id: sessionId,
                        threadId,
                        providerSessionId: null,
                        providerInstanceId: input.modelSelection.instanceId,
                        featureId,
                        checkoutId,
                        repositoryScope: [cwd.physicalId],
                        role: "writer",
                        desiredAccess: "write",
                        execution: "queued",
                        connection: "connected",
                        lastSequence: 0,
                        capabilities: {
                          managed: true,
                          enforcedReadOnly: false,
                          // Upstream identity strength does not attest resumability.
                          nativeResume: false,
                          interrupt: caps.turns.supportsInterrupt,
                          steering: caps.turns.supportsActiveSteering,
                          approvals:
                            caps.approvals.supportsCommandApproval ||
                            caps.approvals.supportsFileChangeApproval,
                          questions: caps.planning.supportsStructuredQuestions,
                          imageInput: false,
                          videoInput: false,
                        },
                      },
                      null,
                    );
                    yield* sql`INSERT INTO deckhand_managed_launches(operation_key, actor_id, input_json, record_json)
            VALUES (${key}, ${actorID}, ${encodedInput}, ${recordJson})`;
                  }),
                )
                .pipe(Effect.mapError(storage(key)));
            }
            const prepared = record;
            const update = (state: Rpc.ManagedLaunchRecord["state"]) =>
              Effect.gen(function* () {
                const next = { ...prepared, state };
                const json = yield* encodeRecord(next);
                yield* sql`UPDATE deckhand_managed_launches SET record_json = ${json} WHERE operation_key = ${key}`;
                return next;
              }).pipe(Effect.mapError(storage(key)));
            // The ordinary launcher owns thread/turn receipts. Supplying the saved thread ID and
            // existing worktree prevents duplicate thread allocation or a second lane checkout.
            yield* launcher
              .launch({
                commandId: CommandId.make(`deckhand-launch:${key}`),
                threadId: prepared.threadId,
                projectId: prepared.projectId,
                title: input.title,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: "default",
                workspaceStrategy: {
                  type: "existing_worktree",
                  worktreePath: cwd.root,
                  ...(cwd.branch ? { branch: cwd.branch } : {}),
                },
                initialMessage: { text: input.objective, attachments: [] },
                createdBy: "user",
                creationSource: "web",
              })
              .pipe(
                Effect.catch(() =>
                  update("failed").pipe(Effect.andThen(Effect.fail(error(key, "launch_failed")))),
                ),
              );
            return yield* update("accepted");
          }),
        );
      }).pipe(Effect.mapError(storage(input.operationKey))),
    );
  return ManagedSessionLaunch.of({ launch, get, options });
});
export const layer = Layer.effect(ManagedSessionLaunch, make);
