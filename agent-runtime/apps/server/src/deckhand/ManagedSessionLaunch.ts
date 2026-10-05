// @effect-diagnostics nodeBuiltinImport:off - UUIDs and hashes identify durable launch intents.
import * as NodeCrypto from "node:crypto";
import { CommandId, ProjectId, ThreadId } from "@cinderdeck/contracts";
import * as Contracts from "@cinderdeck/contracts/deckhand";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
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
import * as WorkspaceBackend from "./WorkspaceBackend.ts";
import * as Migrations from "./Migrations.ts";
import * as Relationships from "./Relationships.ts";
import { resolveReviewerSource } from "./ReviewerSource.ts";
import { currentFeatureWorkspaceAuthorized, resolveCurrentCheckout } from "./CurrentCheckout.ts";
import * as ProcessRunner from "../processRunner.ts";

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
      "unsupported_access",
      "storage",
      "launch_failed",
      "not_retryable",
      "dirty_source",
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
    readonly create: (
      actorID: string,
      input: Rpc.ManagedCreateInput,
    ) => Effect.Effect<Rpc.ManagedCreateRecord, ManagedLaunchError>;
    readonly getCreation: (
      actorID: string,
      operationKey: string,
    ) => Effect.Effect<Rpc.ManagedCreateRecord, ManagedLaunchError>;
    readonly reviewPreview: (
      actorID: string,
      input: Rpc.ManagedLaunchReviewInput,
    ) => Effect.Effect<Rpc.ManagedLaunchReview, ManagedLaunchError>;
    readonly reviewConfirm: (
      actorID: string,
      input: Rpc.ManagedLaunchReview,
    ) => Effect.Effect<Rpc.ManagedLaunchReview, ManagedLaunchError>;
    readonly options: Effect.Effect<ReadonlyArray<typeof Rpc.ManagedLaunchOption.Type>>;
  }
>()("@cinderdeck/server/deckhand/ManagedSessionLaunch") {}

const encodeInput = Schema.encodeEffect(Schema.fromJsonString(Rpc.ManagedLaunchInput));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(Rpc.ManagedLaunchRecord));
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Rpc.ManagedLaunchRecord));
const decodeCreation = Schema.decodeUnknownEffect(Schema.fromJsonString(Rpc.ManagedCreateRecord));
const encodeCreation = Schema.encodeEffect(Schema.fromJsonString(Rpc.ManagedCreateRecord));
const encodeReview = Schema.encodeEffect(Schema.fromJsonString(Rpc.ManagedLaunchReview));
const decodeReview = Schema.decodeUnknownEffect(Schema.fromJsonString(Rpc.ManagedLaunchReview));
const encodeCheckouts = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Contracts.PhysicalCheckout)),
);
const encodeReviewerContext = Schema.encodeSync(Schema.fromJsonString(Rpc.ReviewerLaunchContext));
const isLaunchError = Schema.is(ManagedLaunchError);
const bindingID = (kind: string, parts: ReadonlyArray<string | number>) =>
  `${kind}:${NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;

const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const reviewerDependencies = yield* Effect.context<
    | Relationships.Relationships
    | WorkspaceBackend.WorkspaceBackend
    | CheckoutIdentity.CheckoutIdentity
    | ProcessRunner.ProcessRunner
    | SqlClient.SqlClient
  >();
  const sql = yield* SqlClient.SqlClient;
  const backend = yield* WorkspaceBackend.WorkspaceBackend;
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
        .filter((provider) => provider.enabled)
        .map((provider) => ({
          ...(provider.runtimeModeAdjustments === undefined
            ? {}
            : { runtimeModeAdjustments: provider.runtimeModeAdjustments }),
          supportsReadOnly: provider.driver === "codex",
          instanceId: provider.instanceId,
          label: provider.displayName ?? provider.instanceId,
          models: provider.models.map((model) => ({ id: model.slug, label: model.name })),
          readiness:
            !provider.installed ||
            provider.availability === "unavailable" ||
            provider.status === "error"
              ? ("unavailable" as const)
              : provider.auth.status === "unauthenticated"
                ? ("sign_in_required" as const)
                : provider.auth.status === "authenticated"
                  ? ("ready" as const)
                  : ("unknown" as const),
          ...(provider.message ? { message: provider.message } : {}),
        })),
    ),
  );
  const validateAccess = (input: Rpc.ManagedLaunchInput) =>
    Effect.gen(function* () {
      if (!input.deferStart && !input.objective.trim())
        return yield* error(input.operationKey, "stale_context");
      if (input.deferStart && input.reviewerContext)
        return yield* error(input.operationKey, "unsupported_access");
      if (input.reviewerContext && input.access !== undefined)
        return yield* error(input.operationKey, "unsupported_access");
      if (input.access !== "read_only") return;
      const metadata = adapters.getMetadata
        ? yield* adapters
            .getMetadata(input.modelSelection.instanceId)
            .pipe(Effect.mapError(() => error(input.operationKey, "unavailable_provider")))
        : null;
      if (!metadata?.enabled || metadata.driver !== "codex")
        return yield* error(input.operationKey, "unsupported_access");
    });
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
        yield* validateAccess(input);
        const creationRows = yield* sql<{
          actor_id: string;
          launch_input_json: string | null;
          record_json: string;
        }>`SELECT actor_id, launch_input_json, record_json FROM deckhand_managed_creations
          WHERE json_extract(record_json, '$.launchOperationKey') = ${key}`;
        const creation = creationRows[0];
        if (creation && creation.actor_id !== actorID) return yield* error(key, "wrong_actor");
        if (creation && creation.launch_input_json !== encodedInput)
          return yield* error(key, "key_conflict");
        const reservedContext = creation
          ? (yield* decodeCreation(creation.record_json)).contextIntent
          : undefined;
        const reviews = yield* sql<{
          actor_id: string;
          original_input_json: string;
          review_json: string;
        }>`SELECT * FROM deckhand_launch_reviews WHERE launch_operation_key = ${key}`;
        const savedReview = reviews[0];
        if (savedReview && savedReview.actor_id !== actorID)
          return yield* error(key, "wrong_actor");
        if (savedReview && savedReview.original_input_json !== encodedInput)
          return yield* error(key, "key_conflict");
        const review = savedReview ? yield* decodeReview(savedReview.review_json) : null;
        if (
          input.reviewerContext &&
          (!creation || reservedContext?.featureId !== input.reviewerContext.featureId)
        )
          return yield* error(key, "stale_context");
        if (
          review &&
          (review.installationID !== input.installationID ||
            review.workspaceID !== input.workspaceID ||
            review.generation !== input.generation)
        )
          return yield* error(key, "stale_context");
        const snapshot = yield* backend
          .context(input.workspaceID)
          .pipe(Effect.mapError(() => error(key, "stale_context")));
        const resource = snapshot.resource;
        const context = resource.workspace;
        if (
          snapshot.hello.installationID !== input.installationID ||
          !context ||
          !resource.available ||
          resource.generation !== input.generation ||
          resource.revision !== (review?.revision ?? input.revision) ||
          context.definitionChanged ||
          context.issues.length ||
          !context.repos.length ||
          context.repos.length > 64 ||
          new Set(context.repos.map((repo) => repo.id)).size !== context.repos.length
        )
          return yield* error(key, "stale_context");
        const selected = context.repos.find((repo) => repo.id === input.repositoryID);
        if (!selected) return yield* error(key, "stale_context");
        const parentID = context.lane?.sourceStackID ?? resource.workspaceID;
        const parentSnapshot = context.lane
          ? yield* backend
              .context(parentID)
              .pipe(Effect.mapError(() => error(key, "stale_context")))
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
        if (
          review &&
          (review.repositories.length !== context.repos.length ||
            review.repositories.some(
              (item, index) => item.repositoryID !== context.repos[index]?.id,
            ) ||
            encodeCheckouts(review.repositories.map((item) => item.checkout)) !==
              encodeCheckouts(physical))
        )
          return yield* error(key, "stale_context");
        if (new Set(physical.map((repo) => repo.physicalId)).size !== physical.length)
          return yield* error(key, "stale_context");
        const cwd = physical[context.repos.indexOf(selected)]!;
        const metadata = adapters.getMetadata
          ? yield* adapters
              .getMetadata(input.modelSelection.instanceId)
              .pipe(Effect.mapError(() => error(key, "unavailable_provider")))
          : null;
        if (input.reviewerContext) {
          const pinned = input.reviewerContext;
          const original = yield* relationships
            .checkout(pinned.sourceCheckoutId)
            .pipe(Effect.mapError(() => error(key, "stale_context")));
          const currentSource = yield* resolveCurrentCheckout(original.id).pipe(
            Effect.provideContext(reviewerDependencies),
            Effect.mapError(() => error(key, "stale_context")),
          );
          const currentSourceWorkspace = yield* relationships
            .workspace(currentSource.workspaceId)
            .pipe(Effect.mapError(() => error(key, "stale_context")));
          if (
            !context.lane ||
            resource.workspaceID === pinned.sourceWorkspaceID ||
            currentSource.workspaceId !== reservedContext?.workspaceBindingId ||
            currentSource.backend !== "cinderdeck" ||
            currentSource.state !== "ready" ||
            currentSource.environmentId !== input.installationID ||
            currentSource.nativeGeneration !== pinned.sourceGeneration ||
            (currentSource.laneId ?? currentSourceWorkspace.ownerId) !== pinned.sourceWorkspaceID ||
            currentSourceWorkspace.state !== "active" ||
            currentSource.workspaceGeneration !== currentSourceWorkspace.generation ||
            pinned.repositories.length !== context.repos.length ||
            physical.some((repo, index) => {
              const expected = pinned.repositories.find(
                (item) => item.repositoryID === context.repos[index]?.id,
              );
              return (
                !expected ||
                expected.commit !== repo.commit ||
                expected.repositoryPhysicalId !== repo.repositoryPhysicalId ||
                pinned.repositories.some((item) => item.sourcePhysicalId === repo.physicalId)
              );
            })
          )
            return yield* error(key, "stale_context");
        }
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
            const reservedFeature = reservedContext
              ? yield* relationships
                  .feature(reservedContext.featureId)
                  .pipe(Effect.mapError(() => error(key, "stale_context")))
              : null;
            const reservedFeatureWorkspaceAuthorized =
              reservedFeature &&
              (reservedFeature.workspaceId === workspaceId ||
                (yield* currentFeatureWorkspaceAuthorized(reservedFeature.id, workspaceId).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                  Effect.mapError(() => error(key, "stale_context")),
                )));
            if (
              reservedContext &&
              (!reservedFeature ||
                reservedContext.workspaceBindingId !== workspaceId ||
                !reservedFeatureWorkspaceAuthorized ||
                reservedFeature.status !== "active" ||
                new Set(reservedContext.repositoryIDs).size !==
                  reservedContext.repositoryIDs.length ||
                reservedContext.repositoryIDs.length !== context.repos.length ||
                reservedContext.repositoryIDs.some(
                  (id) => !context.repos.some((repo) => repo.id === id),
                ))
            )
              return yield* error(key, "stale_context");
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
              (expectedCheckout.id !== checkoutId ||
                expectedCheckout.state !== "ready" ||
                (!review &&
                  encodeCheckouts(expectedCheckout.repositories) !== encodeCheckouts(physical)))
            )
              return yield* error(key, "stale_context");
            if (
              review &&
              expectedCheckout &&
              encodeCheckouts(expectedCheckout.repositories) !== encodeCheckouts(physical)
            ) {
              yield* relationships
                .putCheckout(
                  {
                    ...expectedCheckout,
                    repositories: physical,
                    revision: expectedCheckout.revision + 1,
                  },
                  expectedCheckout.revision,
                )
                .pipe(Effect.mapError(() => error(key, "stale_context")));
            }
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
              const featureId =
                reservedFeature?.id ?? Contracts.FeatureId.make(NodeCrypto.randomUUID());
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
                    if (!reservedFeature)
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
                    yield* relationships.linkCheckout(
                      featureId,
                      checkoutId,
                      !input.reviewerContext,
                    );
                    yield* relationships.putSession(
                      {
                        id: sessionId,
                        threadId,
                        providerSessionId: null,
                        providerInstanceId: input.modelSelection.instanceId,
                        featureId,
                        checkoutId,
                        repositoryScope: [cwd.physicalId],
                        role: input.reviewerContext
                          ? "reviewer"
                          : input.access === "read_only"
                            ? "observer"
                            : "writer",
                        desiredAccess: input.reviewerContext
                          ? "isolated"
                          : input.access === "read_only"
                            ? "read_only"
                            : "write",
                        execution: input.deferStart ? "idle" : "queued",
                        connection: input.deferStart ? "unavailable" : "connected",
                        lastSequence: 0,
                        capabilities: {
                          managed: true,
                          enforcedReadOnly:
                            input.access === "read_only" && metadata.driver === "codex",
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
                interactionMode: input.interactionMode ?? "default",
                ...(input.deferStart ? { deferPreparation: true } : {}),
                workspaceStrategy: {
                  type: "existing_worktree",
                  worktreePath: cwd.root,
                  ...(cwd.branch ? { branch: cwd.branch } : {}),
                },
                ...(input.deferStart
                  ? {}
                  : { initialMessage: { text: input.objective, attachments: [] } }),
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
  const creationLocks = yield* makeKeyedSerialExecutor<string>();
  const encodeCreationInput = Schema.encodeEffect(Schema.fromJsonString(Rpc.ManagedCreateInput));
  const decodeLaunchInput = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Rpc.ManagedLaunchInput),
  );
  const readCreation = (actorID: string, key: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        actor_id: string;
        input_json: string;
        launch_input_json: string | null;
        record_json: string;
      }>`SELECT actor_id, input_json, launch_input_json, record_json FROM deckhand_managed_creations
      WHERE operation_key = ${key}`;
      const row = rows[0];
      if (!row) return null;
      if (row.actor_id !== actorID) return yield* error(key, "wrong_actor");
      return {
        input: row.input_json,
        launchInput: row.launch_input_json ? yield* decodeLaunchInput(row.launch_input_json) : null,
        record: yield* decodeCreation(row.record_json),
      };
    }).pipe(Effect.mapError(storage(key)));
  const saveCreation = (record: Rpc.ManagedCreateRecord) =>
    Effect.gen(function* () {
      const json = yield* encodeCreation(record);
      yield* sql`UPDATE deckhand_managed_creations SET record_json = ${json}
      WHERE operation_key = ${record.operationKey}`;
      return record;
    }).pipe(Effect.mapError(storage(record.operationKey)));
  const observeCreation = (actorID: string, record: Rpc.ManagedCreateRecord, waitMs: number) =>
    Effect.gen(function* () {
      const receipt =
        record.receipt && !["pending", "running", "unknown_outcome"].includes(record.receipt.state)
          ? record.receipt
          : yield* backend.operation(actorID, record.laneOperationKey, waitMs);
      const laneID =
        receipt.result?.createdWorkspaceID ?? receipt.result?.workspace?.id ?? record.laneID;
      const ready =
        receipt.state === "succeeded" &&
        !!laneID &&
        (!receipt.result?.setup ||
          ["succeeded", "skipped"].includes(receipt.result.setup.status)) &&
        (receipt.result?.creationReady === true ||
          (receipt.result?.creationReady === undefined &&
            !!receipt.result?.workspace?.lane &&
            !receipt.result.workspace.definitionChanged &&
            !receipt.result.workspace.issues.length));
      return yield* saveCreation({
        ...record,
        receipt,
        laneID,
        state: ready
          ? "ready"
          : receipt.state === "unknown_outcome"
            ? "unknown_outcome"
            : receipt.state === "failed" || receipt.state === "succeeded"
              ? "failed"
              : "creating",
        error: ready
          ? null
          : (receipt.error?.code ?? (receipt.state === "succeeded" ? "creation_not_ready" : null)),
      });
    }).pipe(Effect.mapError(() => error(record.operationKey, "stale_context")));
  // Receipt inspection may reconcile native state; it never submits creation or starts a provider.
  const getCreation = (actorID: string, key: string) =>
    creationLocks.withLock(
      key,
      Effect.gen(function* () {
        const saved = yield* readCreation(actorID, key);
        if (!saved) return yield* error(key, "missing");
        if (saved.record.state === "accepted" || saved.record.launch) return saved.record;
        return yield* observeCreation(actorID, saved.record, 0).pipe(
          Effect.catch(() => Effect.succeed(saved.record)),
        );
      }),
    );
  const reserveFeatureContext = (
    actorID: string,
    input: Rpc.ManagedCreateInput,
    source: Rpc.IntegrationView["resources"][number],
    record: Rpc.ManagedCreateRecord,
    insertInput?: string,
  ) =>
    locks.withLock(
      bindingID("context", [input.installationID, input.workspaceID, input.generation]),
      sql
        .withTransaction(
          Effect.gen(function* () {
            const workspace = source.workspace;
            if (
              !workspace ||
              !workspace.repos.length ||
              workspace.repos.length > 64 ||
              new Set(workspace.repos.map((repo) => repo.id)).size !== workspace.repos.length
            )
              return yield* error(input.operationKey, "stale_context");
            const linked = yield* sql<{ id: string }>`SELECT id FROM deckhand_workspaces
        WHERE environment_id = ${input.installationID} AND backend = 'cinderdeck'
          AND owner_id = ${input.workspaceID} AND generation = ${input.generation}`;
            const workspaceBindingId = Contracts.WorkspaceBindingId.make(
              linked[0]?.id ??
                bindingID("workspace", [input.installationID, input.workspaceID, input.generation]),
            );
            if (!linked.length)
              yield* relationships.putWorkspace(
                {
                  id: workspaceBindingId,
                  environmentId: Contracts.EnvironmentId.make(input.installationID),
                  backend: "cinderdeck",
                  ownerId: input.workspaceID,
                  generation: input.generation,
                  revision: 1,
                  name: workspace.name,
                  state: "active",
                },
                null,
              );
            else if ((yield* relationships.workspace(workspaceBindingId)).state !== "active")
              return yield* error(input.operationKey, "stale_context");
            const now = DateTime.formatIso(yield* DateTime.now);
            const reviewedFeature = input.reviewerContext
              ? yield* relationships
                  .feature(input.reviewerContext.featureId)
                  .pipe(Effect.mapError(() => error(input.operationKey, "stale_context")))
              : null;
            const reviewedFeatureWorkspaceAuthorized =
              reviewedFeature &&
              (reviewedFeature.workspaceId === workspaceBindingId ||
                (yield* currentFeatureWorkspaceAuthorized(
                  reviewedFeature.id,
                  workspaceBindingId,
                ).pipe(
                  Effect.provideService(SqlClient.SqlClient, sql),
                  Effect.mapError(() => error(input.operationKey, "stale_context")),
                )));
            if (
              reviewedFeature &&
              (!reviewedFeatureWorkspaceAuthorized || reviewedFeature.status !== "active")
            )
              return yield* error(input.operationKey, "stale_context");
            const featureId =
              reviewedFeature?.id ?? Contracts.FeatureId.make(NodeCrypto.randomUUID());
            if (!reviewedFeature)
              yield* relationships.putFeature(
                {
                  id: featureId,
                  workspaceId: workspaceBindingId,
                  title: input.title,
                  objective: input.objective,
                  status: "active",
                  revision: 1,
                  createdAt: now,
                  updatedAt: now,
                },
                null,
              );
            const next = {
              ...record,
              contextIntent: {
                featureId,
                workspaceBindingId,
                repositoryIDs: workspace.repos.map((repo) => repo.id),
              },
            };
            const json = yield* encodeCreation(next);
            if (insertInput !== undefined) {
              // Commit the feature, reviewed target and full operation intent atomically before Git.
              yield* sql`INSERT INTO deckhand_managed_creations(operation_key, actor_id, input_json, record_json)
          VALUES (${input.operationKey}, ${actorID}, ${insertInput}, ${json})`;
            } else {
              const changed = yield* sql`UPDATE deckhand_managed_creations SET record_json = ${json}
          WHERE operation_key = ${input.operationKey} AND actor_id = ${actorID} RETURNING operation_key`;
              if (!changed.length) return yield* error(input.operationKey, "missing");
            }
            return next;
          }),
        )
        .pipe(Effect.mapError(storage(input.operationKey))),
    );
  // A native creation receipt can precede Git-monitor hydration. Its revision
  // covers presentation/runtime state as well as source; wait for the created
  // checkout to settle before committing the immutable provider intake request.
  const createdLaunchContext = (input: Rpc.ManagedCreateInput, record: Rpc.ManagedCreateRecord) =>
    Effect.gen(function* () {
      const created = record.receipt?.result?.workspace;
      if (
        !record.laneID ||
        record.receipt?.state !== "succeeded" ||
        !created?.lane ||
        created.id !== record.laneID ||
        created.lane.sourceStackID !== input.workspaceID ||
        created.lane.name !== input.branch ||
        !created.repos.length ||
        created.repos.some((repo) => !repo.physicalID || !repo.repositoryPhysicalID)
      )
        return yield* error(input.operationKey, "stale_context");
      let initialPhysical: string | null = null;
      let initialGeneration: number | null = null;
      let readyRevision: string | null = null;
      for (let attempt = 0; attempt < 8; attempt++) {
        const target: Effect.Success<ReturnType<typeof backend.context>> = yield* backend
          .context(record.laneID)
          .pipe(Effect.mapError(() => error(input.operationKey, "stale_context")));
        const workspace = target.resource.workspace;
        if (
          target.hello.installationID !== input.installationID ||
          target.resource.workspaceID !== record.laneID ||
          !target.resource.available ||
          !workspace?.lane ||
          workspace.id !== created.id ||
          workspace.lane.sourceStackID !== input.workspaceID ||
          workspace.lane.name !== created.lane.name ||
          workspace.lane.directory !== created.lane.directory ||
          workspace.definitionChanged ||
          workspace.issues.length ||
          workspace.repos.length !== created.repos.length ||
          new Set(workspace.repos.map((repo) => repo.id)).size !== workspace.repos.length ||
          (initialGeneration !== null && target.resource.generation !== initialGeneration)
        )
          return yield* error(input.operationKey, "stale_context");
        initialGeneration ??= target.resource.generation;
        const physical = yield* Effect.forEach(workspace.repos, (repo) =>
          identities
            .resolve(repo.path)
            .pipe(Effect.mapError(() => error(input.operationKey, "stale_context"))),
        );
        for (const [index, repo] of workspace.repos.entries()) {
          const original = created.repos.find((item) => item.id === repo.id);
          const actual = physical[index]!;
          const pinnedHead = created.lane.repositoryRefs?.[repo.id];
          if (
            !original ||
            original.physicalID !== actual.physicalId ||
            original.repositoryPhysicalID !== actual.repositoryPhysicalId ||
            (pinnedHead !== undefined && actual.commit !== pinnedHead)
          )
            return yield* error(input.operationKey, "stale_context");
        }
        const observedPhysical = encodeCheckouts(
          [...physical].sort((a, b) => a.physicalId.localeCompare(b.physicalId)),
        );
        // A changed head, physical checkout, branch or remote needs review; only
        // native display hydration may settle during this first intake window.
        if (initialPhysical !== null && observedPhysical !== initialPhysical)
          return yield* error(input.operationKey, "stale_context");
        initialPhysical ??= observedPhysical;
        const hydrated = workspace.repos.every(
          (repo, index) =>
            physical[index]!.branch !== null && repo.branch === physical[index]!.branch,
        );
        if (hydrated && readyRevision === target.resource.revision) return target;
        readyRevision = hydrated ? target.resource.revision : null;
        if (attempt < 7) yield* Effect.sleep("150 millis");
      }
      return yield* error(input.operationKey, "stale_context");
    });
  const create = (actorID: string, input: Rpc.ManagedCreateInput) =>
    creationLocks.withLock(
      input.operationKey,
      Effect.gen(function* () {
        const key = input.operationKey;
        const encoded = yield* encodeCreationInput(input);
        let saved = yield* readCreation(actorID, key);
        if (saved && saved.input !== encoded) return yield* error(key, "key_conflict");
        if (saved?.record.state === "accepted") return saved.record;
        yield* validateAccess(input);
        if (!saved) {
          const source = yield* backend.context(input.workspaceID);
          const workspace = source.resource.workspace;
          if (
            source.hello.installationID !== input.installationID ||
            !source.resource.available ||
            source.resource.generation !== input.generation ||
            source.resource.revision !== input.revision ||
            !workspace ||
            workspace.lane ||
            workspace.definitionChanged ||
            workspace.issues.length ||
            !workspace.repos.some((repo) => repo.id === input.repositoryID) ||
            !source.hello.capabilities.includes("operations.lane.create.repositoryRefs") ||
            !source.hello.capabilities.includes("operations.receipts.wait")
          )
            return yield* error(key, "stale_context");
          if (input.reviewerContext) {
            const pinned = input.reviewerContext;
            const selected = pinned.repositories.find(
              (repo) => repo.repositoryID === input.repositoryID,
            );
            if (!selected) return yield* error(key, "stale_context");
            const current = yield* resolveReviewerSource({
              featureId: pinned.featureId,
              sourceCheckoutId: pinned.sourceCheckoutId,
              repositoryPhysicalId: selected.sourcePhysicalId,
            }).pipe(
              Effect.provideContext(reviewerDependencies),
              Effect.mapError((cause) =>
                error(key, cause.reason === "dirty_source" ? "dirty_source" : "stale_context"),
              ),
            );
            if (
              current.installationID !== input.installationID ||
              current.workspaceID !== input.workspaceID ||
              current.generation !== input.generation ||
              current.revision !== input.revision ||
              encodeReviewerContext(current.reviewerContext) !== encodeReviewerContext(pinned) ||
              Object.keys(input.repositoryRefs).length !== pinned.repositories.length ||
              pinned.repositories.some(
                (repo) => input.repositoryRefs[repo.repositoryID] !== repo.commit,
              )
            )
              return yield* error(key, "stale_context");
          }
          // Reject unavailable providers before creating a checkout that cannot launch its session.
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
          const record = yield* reserveFeatureContext(
            actorID,
            input,
            source.resource,
            {
              operationKey: key,
              laneOperationKey: bindingID("lane", [key]),
              launchOperationKey: bindingID("session", [key]),
              state: "prepared",
              laneID: null,
              receipt: null,
              launch: null,
              error: null,
            },
            encoded,
          );
          saved = { input: encoded, record, launchInput: null };
        }
        // Upgrade an unlaunched legacy intent before allowing any further native effects.
        if (!saved.record.contextIntent && !saved.record.launch) {
          const source = yield* backend.context(input.workspaceID);
          if (
            source.hello.installationID !== input.installationID ||
            source.resource.generation !== input.generation ||
            source.resource.revision !== input.revision ||
            !source.resource.available ||
            !source.resource.workspace ||
            source.resource.workspace.lane ||
            source.resource.workspace.definitionChanged ||
            source.resource.workspace.issues.length
          )
            return yield* error(input.operationKey, "stale_context");
          const record = yield* reserveFeatureContext(
            actorID,
            input,
            source.resource,
            saved.record,
          );
          saved = { ...saved, record };
        }
        let record = saved.record;
        if (!record.receipt) {
          const receipt = yield* backend.createLane(actorID, {
            operationKey: record.laneOperationKey,
            installationID: input.installationID,
            workspaceID: input.workspaceID,
            generation: input.generation,
            revision: input.revision,
            arguments: {
              workspace: input.workspaceID,
              branch: input.branch,
              repositoryRefs: input.repositoryRefs,
              setup: input.setup,
              start: input.start,
            },
          });
          record = yield* saveCreation({ ...record, receipt, state: "creating" });
        }
        record = yield* observeCreation(actorID, record, 25000);
        if (record.state !== "ready" && !(record.state === "failed" && record.launch))
          return record;
        let launchInput = saved.launchInput;
        if (!launchInput) {
          const target = yield* createdLaunchContext(input, record);
          launchInput = {
            operationKey: record.launchOperationKey,
            installationID: input.installationID,
            workspaceID: record.laneID!,
            generation: target.resource.generation,
            revision: target.resource.revision,
            repositoryID: input.repositoryID,
            title: input.title,
            objective: input.objective,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            ...(input.interactionMode === undefined
              ? {}
              : { interactionMode: input.interactionMode }),
            ...(input.access === undefined ? {} : { access: input.access }),
            ...(input.reviewerContext ? { reviewerContext: input.reviewerContext } : {}),
          };
          const json = yield* encodeInput(launchInput);
          yield* sql`UPDATE deckhand_managed_creations SET launch_input_json = ${json} WHERE operation_key = ${key}`;
        }
        const result = yield* launch(actorID, launchInput).pipe(Effect.result);
        if (result._tag === "Success")
          return yield* saveCreation({
            ...record,
            launch: result.success,
            state: "accepted",
            error: null,
          });
        const failedLaunch = yield* read(actorID, record.launchOperationKey).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        // A collision with an earlier launch must never attach that unrelated session.
        const priorLaunch =
          failedLaunch?.input === (yield* encodeInput(launchInput)) ? failedLaunch.record : null;
        return yield* saveCreation({
          ...record,
          launch: priorLaunch,
          state: "failed",
          error: result.failure.reason,
        });
      }).pipe(Effect.mapError(storage(input.operationKey))),
    );
  const reviewSource = (actorID: string, input: Rpc.ManagedLaunchReviewInput) =>
    Effect.gen(function* () {
      if (input.kind === "launch") {
        const saved = yield* read(actorID, input.operationKey);
        if (!saved) return yield* error(input.operationKey, "missing");
        if (saved.record.state === "accepted")
          return yield* error(input.operationKey, "not_retryable");
        return { input: yield* decodeLaunchInput(saved.input), record: saved.record };
      }
      const creation = yield* readCreation(actorID, input.operationKey);
      if (!creation) return yield* error(input.operationKey, "missing");
      if (
        creation.record.state === "accepted" ||
        !creation.launchInput ||
        creation.record.receipt?.state !== "succeeded" ||
        (creation.record.receipt.result?.setup &&
          !["succeeded", "skipped"].includes(creation.record.receipt.result.setup.status))
      )
        return yield* error(input.operationKey, "not_retryable");
      const launch = yield* read(actorID, creation.launchInput.operationKey);
      if (launch && launch.input !== (yield* encodeInput(creation.launchInput)))
        return yield* error(input.operationKey, "key_conflict");
      if (launch?.record.state === "accepted")
        return yield* error(input.operationKey, "not_retryable");
      return { input: creation.launchInput, record: launch?.record ?? null };
    });
  const currentReview = (actorID: string, input: Rpc.ManagedLaunchReviewInput) =>
    Effect.gen(function* () {
      const saved = yield* reviewSource(actorID, input);
      const target = yield* backend
        .context(saved.input.workspaceID)
        .pipe(Effect.mapError(() => error(input.operationKey, "stale_context")));
      const resource = target.resource;
      const workspace = resource.workspace;
      if (
        target.hello.installationID !== saved.input.installationID ||
        resource.generation !== saved.input.generation ||
        !resource.available ||
        !workspace ||
        workspace.definitionChanged ||
        workspace.issues.length ||
        !workspace.repos.length ||
        workspace.repos.length > 64 ||
        new Set(workspace.repos.map((repo) => repo.id)).size !== workspace.repos.length ||
        !workspace.repos.some((repo) => repo.id === saved.input.repositoryID)
      )
        return yield* error(input.operationKey, "stale_context");
      const physical = yield* Effect.forEach(workspace.repos, (repo) =>
        identities
          .resolve(repo.path)
          .pipe(Effect.mapError(() => error(input.operationKey, "stale_context"))),
      );
      if (new Set(physical.map((repo) => repo.physicalId)).size !== physical.length)
        return yield* error(input.operationKey, "stale_context");
      if (saved.record) {
        const original = yield* relationships
          .checkout(saved.record.checkoutId)
          .pipe(Effect.mapError(() => error(input.operationKey, "stale_context")));
        if (
          original.state !== "ready" ||
          original.repositories.length !== physical.length ||
          original.repositories.some(
            (old) =>
              !physical.some(
                (next) =>
                  old.physicalId === next.physicalId &&
                  old.repositoryPhysicalId === next.repositoryPhysicalId &&
                  old.root === next.root &&
                  old.branch === next.branch,
              ),
          )
        )
          return yield* error(input.operationKey, "stale_context");
      }
      const review: Rpc.ManagedLaunchReview = {
        operationKey: input.operationKey,
        kind: input.kind,
        installationID: saved.input.installationID,
        workspaceID: saved.input.workspaceID,
        generation: resource.generation,
        revision: resource.revision,
        repositories: workspace.repos.map((repo, index) => ({
          repositoryID: repo.id,
          checkout: physical[index]!,
        })),
      };
      return { saved, review };
    }).pipe(Effect.mapError(storage(input.operationKey)));
  const withReviewLock = <A>(
    actorID: string,
    input: Rpc.ManagedLaunchReviewInput,
    action: Effect.Effect<A, ManagedLaunchError>,
  ) =>
    input.kind === "creation"
      ? creationLocks.withLock(
          input.operationKey,
          Effect.gen(function* () {
            const saved = yield* readCreation(actorID, input.operationKey);
            if (!saved) return yield* error(input.operationKey, "missing");
            return yield* locks.withLock(saved.record.launchOperationKey, action);
          }),
        )
      : locks.withLock(input.operationKey, action);
  const reviewPreview = (actorID: string, input: Rpc.ManagedLaunchReviewInput) =>
    withReviewLock(
      actorID,
      input,
      currentReview(actorID, input).pipe(Effect.map((value) => value.review)),
    );
  const reviewConfirm = (actorID: string, input: Rpc.ManagedLaunchReview) =>
    withReviewLock(
      actorID,
      input,
      Effect.gen(function* () {
        const { saved, review } = yield* currentReview(actorID, input);
        const encoded = yield* encodeReview(input);
        if (encoded !== (yield* encodeReview(review)))
          return yield* error(input.operationKey, "stale_context");
        const updated =
          yield* sql`INSERT INTO deckhand_launch_reviews(launch_operation_key, actor_id, original_input_json, review_json)
        VALUES (${saved.input.operationKey}, ${actorID}, ${yield* encodeInput(saved.input)}, ${encoded})
        ON CONFLICT(launch_operation_key) DO UPDATE SET original_input_json = excluded.original_input_json, review_json = excluded.review_json
        WHERE actor_id = excluded.actor_id RETURNING launch_operation_key`;
        if (!updated.length) return yield* error(input.operationKey, "wrong_actor");
        return review;
      }).pipe(Effect.mapError(storage(input.operationKey))),
    );
  return ManagedSessionLaunch.of({
    launch,
    get,
    options,
    create,
    getCreation,
    reviewPreview,
    reviewConfirm,
  });
});
export const layer = Layer.effect(ManagedSessionLaunch, make);
