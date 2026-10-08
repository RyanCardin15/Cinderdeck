import * as ReviewerLaunch from "./ReviewerLaunch.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
// @effect-diagnostics nodeBuiltinImport:off - construct an adversarial derived launch-key collision.
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
import {
  ProjectId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Project,
  ServerProvider,
} from "@cinderdeck/contracts";
import * as Contracts from "@cinderdeck/contracts/deckhand";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
import * as Integration from "@cinderdeck/contracts/deckhand/integration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as WorkspaceBackend from "./WorkspaceBackend.ts";
import * as ManagedCheckoutGuard from "./ManagedCheckoutGuard.ts";
import * as ManagedSessionLaunch from "./ManagedSessionLaunch.ts";
import * as Relationships from "./Relationships.ts";
import { resolveReviewerSource } from "./ReviewerSource.ts";
import { currentFeatureWorkspaceAuthorized } from "./CurrentCheckout.ts";
import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath, resolveAttachmentPathById } from "../attachmentStore.ts";

const instanceId = ProviderInstanceId.make("codex-fixture");
const decodeInput = Schema.decodeUnknownSync(Rpc.ManagedLaunchInput);
const decodeCreationInput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Rpc.ManagedCreateInput),
);
const decodeFeatureJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Contracts.Feature));
const encodeCreationInputJson = Schema.encodeEffect(Schema.fromJsonString(Rpc.ManagedCreateInput));
const encodeCreationRecordJson = Schema.encodeEffect(
  Schema.fromJsonString(Rpc.ManagedCreateRecord),
);
const decodeCreationRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Rpc.ManagedCreateRecord),
);
const decodeLaunchInputJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Rpc.ManagedLaunchInput),
);
const decodeCreationInputSync = Schema.decodeUnknownSync(Rpc.ManagedCreateInput);
const decodeReceipt = Schema.decodeUnknownEffect(Integration.IntegrationOperationReceipt);
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Rpc.ManagedLaunchRecord));
const input = (key = "launch-one") =>
  decodeInput({
    operationKey: key,
    installationID: "installation",
    workspaceID: "lane",
    generation: 7,
    revision: "current",
    repositoryID: "frontend",
    title: "Verify lane",
    objective: "Inspect this lane",
    modelSelection: { instanceId, model: "fixture-model" },
    runtimeMode: "approval-required",
  });
const hello = Schema.decodeUnknownSync(Integration.IntegrationHello)({
  protocolVersion: 1,
  installationID: "installation",
  executionHostID: "host",
  channel: "development",
  runtimeEpoch: "epoch",
  maximumFrameBytes: 4194304,
  maximumPageSize: 100,
  maximumWaitMs: 25000,
  capabilities: [
    "operations.lane.create.repositoryRefs",
    "operations.lane.create.reviewer",
    "operations.receipts.wait",
  ],
});
const provider = Schema.decodeSync(ServerProvider)({
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  displayName: "Fixture account",
  version: "fixture",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-03T00:00:00Z",
  models: [{ slug: "fixture-model", name: "Fixture model", isCustom: false, capabilities: null }],
});
const serviceLayer = ManagedSessionLaunch.layer.pipe(
  Layer.provideMerge(Relationships.layer),
  Layer.provideMerge(WorkspaceBackend.layer.pipe(Layer.provide(CheckoutIdentity.layer))),
  Layer.provideMerge(CheckoutIdentity.layer),
);
const baseLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  ProcessRunner.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "dh-skill-attachments-" }),
).pipe(Layer.provideMerge(NodeServices.layer));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const identities = yield* CheckoutIdentity.CheckoutIdentity.pipe(
    Effect.provide(CheckoutIdentity.layer),
  );
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "dh-launch-" });
  const source = `${root}/source`;
  const lane = `${root}/lane`;
  yield* fs.makeDirectory(source);
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    runner
      .run({ command: "git", args: ["-C", cwd, ...args] })
      .pipe(Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0, result.stderr))));
  yield* git(source, ["init", "-b", "main"]);
  yield* git(source, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Fixture",
  ]);
  yield* git(source, ["worktree", "add", "-b", "lane", lane]);
  const sourceIdentity = yield* identities.resolve(source);
  const laneIdentity = yield* identities.resolve(lane);
  const resource = (id: string) => ({
    workspaceID: id,
    generation: id === "lane" ? 7 : 2,
    revision: "current",
    available: true,
    workspace: {
      id,
      name: "Payment",
      file: `${root}/payment.toml`,
      state: "stopped",
      definitionChanged: false,
      issues: [],
      services: [],
      ...(id === "lane"
        ? {
            lane: {
              sourceStackID: "payment",
              name: "Lane",
              createdAt: "now",
              directory: lane,
              ports: {},
            },
          }
        : {}),
      repos: [
        {
          id: "frontend",
          path: id === "lane" ? lane : source,
          physicalID: (id === "lane" ? laneIdentity : sourceIdentity).physicalId,
          repositoryPhysicalID: (id === "lane" ? laneIdentity : sourceIdentity)
            .repositoryPhysicalId,
          branch: id === "lane" ? "lane" : "main",
          dirty: false,
          changedFiles: 0,
          ahead: 0,
          behind: 0,
        },
      ],
    },
  });
  const resources = new Map(["lane", "payment"].map((id) => [id, resource(id)]));
  const hubLayer = Layer.mock(IntegrationHub.IntegrationHub)({
    resource: (id) => {
      const item = resources.get(id);
      return item
        ? Effect.succeed({ hello, resource: item })
        : Effect.fail(new Rpc.DeckhandRpcError({ reason: "unavailable" }));
    },
  });
  const external = (
    launch: ThreadLaunchService.ThreadLaunchService["Service"]["launch"],
    hub = hubLayer,
  ) =>
    Layer.mergeAll(
      hub,
      Layer.mock(ProjectService.ProjectService)({
        bootstrap: (request) =>
          Effect.succeed({
            created: false,
            project: {
              id: ProjectId.make("project"),
              workspaceRoot: request.workspaceRoot,
            } as Project,
          }),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
        getMetadata: () =>
          Effect.succeed({
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            continuationKey: "fixture",
            capabilities: CodexProviderCapabilitiesV2,
          }),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({ launch }),
    );
  const nativeCreation = (
    mode:
      | "ready"
      | "native_shape"
      | "setup_failed"
      | "pending"
      | "unknown_outcome"
      | "stale_target"
      | "reviewed" = "ready",
  ) => {
    const receipts = new Map<string, Integration.IntegrationOperationReceipt>();
    let creations = 0;
    let targetReads = 0;
    const created = `${root}/created`;
    const hub = Layer.mock(IntegrationHub.IntegrationHub)({
      resource: (id) => {
        const item = resources.get(id);
        if (item && mode === "stale_target" && id === "created" && ++targetReads > 2)
          item.revision = "changed";
        return item
          ? Effect.succeed({ hello, resource: item })
          : Effect.fail(new Rpc.DeckhandRpcError({ reason: "unavailable" }));
      },
      submit: (_actor, request) =>
        Effect.gen(function* () {
          const prior = receipts.get(request.operationKey);
          if (prior) return prior;
          const intents = yield* sql<{
            input_json: string;
            record_json: string;
          }>`SELECT input_json, record_json FROM deckhand_managed_creations`;
          assert.equal(intents.length, 1, "intent must commit before native Git effects");
          const intentInput = yield* decodeCreationInput(intents[0]!.input_json);
          if (!intentInput.reviewerContext) assert.equal(intentInput.objective, input().objective);
          const intended = (yield* decodeCreationRecord(intents[0]!.record_json)).contextIntent;
          assert.isDefined(intended, "feature/context intent must exist before native Git");
          const features = yield* sql<{
            id: string;
            record_json: string;
          }>`SELECT id, record_json FROM deckhand_features`;
          const intendedFeatures = features.filter((feature) => feature.id === intended!.featureId);
          assert.equal(intendedFeatures.length, 1);
          const feature = yield* decodeFeatureJson(intendedFeatures[0]!.record_json);
          assert.equal(feature.objective, input().objective);
          assert.isTrue(
            intentInput.reviewerContext !== undefined ||
              feature.workspaceId === intended!.workspaceBindingId ||
              (yield* currentFeatureWorkspaceAuthorized(
                feature.id,
                intended!.workspaceBindingId,
              ).pipe(Effect.provideService(SqlClient.SqlClient, sql))),
          );
          assert.deepEqual(
            intended!.repositoryIDs,
            resources.get("payment")!.workspace.repos.map((repo) => repo.id),
          );
          assert.equal(
            (yield* sql`SELECT checkout_id FROM deckhand_feature_checkouts WHERE feature_id = ${intended!.featureId}`)
              .length,
            intentInput.reviewerContext ? 1 : 0,
            "a planned target is not a confirmed physical checkout",
          );
          assert.equal(
            (yield* sql`SELECT id FROM deckhand_sessions WHERE feature_id = ${intended!.featureId}`)
              .length,
            intentInput.reviewerContext ? 1 : 0,
          );
          assert.equal(request.arguments.reviewer, intentInput.reviewerContext ? true : undefined);
          assert.deepEqual(request.arguments.repositoryModes, intentInput.repositoryModes);
          const approvedBranch =
            mode === "reviewed" ? "codex/reviewed-feature" : String(request.arguments.branch);
          const resource = structuredClone(resources.get("lane")!);
          resource.workspaceID = "created";
          resource.workspace.id = "created";
          resource.workspace.lane!.name =
            mode === "reviewed" ? "Human reviewed name" : String(request.arguments.branch);
          resource.workspace.lane!.directory = created;
          for (const [index, repo] of resource.workspace.repos.entries()) {
            const parent = resources
              .get("payment")!
              .workspace.repos.find((item) => item.id === repo.id)!;
            const target = index === 0 ? created : `${created}-${repo.id}`;
            yield* git(parent.path, [
              "worktree",
              "add",
              "-b",
              approvedBranch,
              target,
              String((request.arguments.repositoryRefs as Record<string, string>)[repo.id]),
            ]);
            const identity = yield* identities.resolve(target);
            repo.physicalID = identity.physicalId;
            repo.repositoryPhysicalID = identity.repositoryPhysicalId;
            repo.path = target;
            repo.branch = approvedBranch;
          }
          creations++;
          resources.set("created", resource);
          const receipt = yield* decodeReceipt({
            id: "native-operation",
            operationKey: request.operationKey,
            argumentHash: "a".repeat(64),
            workspaceID: "payment",
            generation: 2,
            method: "lane.create",
            state: mode === "pending" ? "running" : mode === "unknown_outcome" ? mode : "succeeded",
            createdAt: "now",
            updatedAt: "now",
            result: {
              ...(mode === "reviewed"
                ? { creationReviewed: true, createdBranch: approvedBranch }
                : {}),
              ...(mode === "unknown_outcome"
                ? {}
                : { createdWorkspaceID: "created", workspace: resource.workspace }),
              ...(mode === "native_shape"
                ? { workspace: resource.workspace }
                : {
                    creationReady:
                      mode === "ready" || mode === "stale_target" || mode === "reviewed",
                  }),
              setup: { status: mode === "setup_failed" ? "failed" : "skipped", updatedAt: "now" },
            },
          });
          receipts.set(request.operationKey, receipt);
          return receipt;
        }).pipe(Effect.orDie),
      operation: (_actor, key) =>
        Effect.gen(function* () {
          const receipt = receipts.get(key);
          if (!receipt) return yield* new Rpc.DeckhandRpcError({ reason: "missing" });
          return receipt;
        }),
    });
    return { hub, created, receipts, creations: () => creations };
  };
  return { root, source, lane, git, fs, resources, external, hubLayer, nativeCreation };
});
const accepted = (request: ThreadLaunchService.ThreadLaunchInput) => ({
  threadId: request.threadId!,
  resumed: false,
  projection: {} as ThreadLaunchService.ThreadLaunchResult["projection"],
});
const failed = (request: ThreadLaunchService.ThreadLaunchInput) =>
  Effect.fail(
    new ThreadLaunchService.ThreadLaunchError({
      operation: "create-thread",
      commandId: request.commandId,
      projectId: request.projectId,
      cause: "fixture failure",
    }),
  );

const creationInput = (key = "create-one") =>
  decodeCreationInputSync({
    ...input(key),
    workspaceID: "payment",
    generation: 2,
    branch: "created-lane",
    repositoryRefs: { frontend: "main" },
    setup: false,
    start: false,
  });

describe("connected lane and session creation", () => {
  it.live("preserves repository checkout choices through durable managed creation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = f.nativeCreation("ready");
      const layer = serviceLayer.pipe(
        Layer.provide(f.external((request) => Effect.succeed(accepted(request)), native.hub)),
      );
      const chosen = decodeCreationInputSync({
        ...creationInput("checkout-modes"),
        repositoryModes: { frontend: "worktree" },
      });
      yield* Effect.gen(function* () {
        const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
        const created = yield* service.create("actor", chosen);
        assert.equal(created.state, "accepted");
        assert.deepEqual(yield* service.create("actor", chosen), created);
      }).pipe(Effect.provide(layer));
      assert.equal(native.creations(), 1);
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live.each(["ready", "native_shape", "reviewed"] as const)(
    "commits intent before Git, launches returned checkout, and replays requests (%s)",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation(mode);
        const calls: ThreadLaunchService.ThreadLaunchInput[] = [];
        const sql = yield* SqlClient.SqlClient;
        const external = f.external(
          (request) =>
            Effect.gen(function* () {
              calls.push(request);
              assert.equal(request.workspaceStrategy.type, "existing_worktree");
              if (request.workspaceStrategy.type === "existing_worktree")
                assert.equal(
                  request.workspaceStrategy.worktreePath,
                  yield* f.fs.realPath(native.created),
                );
              const saved = yield* sql<{
                launch_input_json: string;
                record_json: string;
              }>`SELECT * FROM deckhand_managed_creations`;
              assert.equal(
                (yield* decodeLaunchInputJson(saved[0]!.launch_input_json)).workspaceID,
                "created",
              );
              assert.equal((yield* decodeCreationRecord(saved[0]!.record_json)).laneID, "created");
              return accepted(request);
            }).pipe(Effect.orDie),
          native.hub,
        );
        const layer = serviceLayer.pipe(Layer.provide(external));
        const one = yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const [a, b] = yield* Effect.all(
            [service.create("actor", creationInput()), service.create("actor", creationInput())],
            { concurrency: "unbounded" },
          );
          assert.deepEqual(a, b);
          assert.equal(a.state, "accepted");
          assert.equal(a.laneID, "created");
          assert.equal(a.contextIntent?.featureId, a.launch?.featureId);
          const sql = yield* SqlClient.SqlClient;
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
          assert.equal(
            (yield* service.create("other", creationInput()).pipe(Effect.flip)).reason,
            "wrong_actor",
          );
          assert.equal(
            (yield* service
              .create("actor", { ...creationInput(), objective: "different" })
              .pipe(Effect.flip)).reason,
            "key_conflict",
          );
          return a;
        }).pipe(Effect.provide(layer));
        f.resources.clear();
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          assert.deepEqual(yield* service.create("actor", creationInput()), one);
          assert.deepEqual(yield* service.getCreation("actor", creationInput().operationKey), one);
        }).pipe(Effect.provide(layer));
        assert.equal(native.creations(), 1);
        assert.equal(calls.length, 1);
        assert.equal(
          (yield* f.git(f.source, ["symbolic-ref", "--short", "HEAD"])).stdout.trim(),
          "main",
        );
        assert.equal(
          (yield* f.git(f.source, ["worktree", "list", "--porcelain"])).stdout.split("worktree ")
            .length - 1,
          3,
        );
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live.each(["setup_failed", "unknown_outcome"] as const)(
    "retains the native lane after %s without launching or recreating it",
    (mode) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation(mode);
        let launches = 0;
        const layer = serviceLayer.pipe(
          Layer.provide(
            f.external((request) => {
              launches++;
              return Effect.succeed(accepted(request));
            }, native.hub),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          let one = yield* service.create("actor", creationInput());
          assert.equal(one.state, mode === "setup_failed" ? "failed" : "unknown_outcome");
          if (mode === "unknown_outcome") {
            assert.equal(one.laneID, null);
            const receipt = native.receipts.get(one.laneOperationKey)!;
            native.receipts.set(one.laneOperationKey, {
              ...receipt,
              result: { ...receipt.result, createdWorkspaceID: "created" },
            });
            one = yield* service.getCreation("actor", one.operationKey);
            assert.equal(
              one.state,
              "unknown_outcome",
              "manifest recovery does not infer successful creation",
            );
          }
          assert.equal(one.laneID, "created");
          assert.isDefined(one.contextIntent);
          const sql = yield* SqlClient.SqlClient;
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
          assert.equal((yield* sql`SELECT id FROM deckhand_checkouts`).length, 0);
          assert.equal((yield* sql`SELECT id FROM deckhand_sessions`).length, 0);
          assert.isTrue(yield* f.fs.exists(native.created));
          assert.deepEqual(yield* service.create("actor", creationInput()), one);
          assert.deepEqual(yield* service.getCreation("actor", creationInput().operationKey), one);
        }).pipe(Effect.provide(layer));
        assert.equal(native.creations(), 1);
        assert.equal(launches, 0);
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "refuses stale review and unavailable providers before persisting intent or creating a lane",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation();
        const layer = serviceLayer.pipe(
          Layer.provide(f.external((request) => Effect.succeed(accepted(request)), native.hub)),
        );
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          assert.equal(
            (yield* service
              .create("actor", { ...creationInput(), generation: creationInput().generation + 1 })
              .pipe(Effect.flip)).reason,
            "stale_context",
          );
          assert.equal(
            (yield* service
              .create("actor", {
                ...creationInput(),
                modelSelection: {
                  instanceId: ProviderInstanceId.make("missing"),
                  model: "fixture-model",
                },
              })
              .pipe(Effect.flip)).reason,
            "unavailable_provider",
          );
          const sql = yield* SqlClient.SqlClient;
          assert.equal(
            (yield* sql`SELECT operation_key FROM deckhand_managed_creations`).length,
            0,
          );
        }).pipe(Effect.provide(layer));
        assert.equal(native.creations(), 0);
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "rolls back the feature and workspace if operation intent cannot commit, before any native effect",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation();
        const layer = serviceLayer.pipe(
          Layer.provide(f.external((request) => Effect.succeed(accepted(request)), native.hub)),
        );
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TRIGGER refuse_creation BEFORE INSERT ON deckhand_managed_creations BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END`;
          assert.equal(
            (yield* service.create("actor", creationInput()).pipe(Effect.flip)).reason,
            "storage",
          );
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 0);
          assert.equal((yield* sql`SELECT id FROM deckhand_workspaces`).length, 0);
          assert.equal(
            (yield* sql`SELECT operation_key FROM deckhand_managed_creations`).length,
            0,
          );
          assert.equal(native.creations(), 0);
          yield* sql`DROP TRIGGER refuse_creation`;
          const saved = yield* service.create("actor", creationInput());
          assert.equal(saved.state, "accepted");
          assert.equal(saved.launch?.featureId, saved.contextIntent?.featureId);
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "retains a prepared feature after transport loss and resumes it after service restart",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation();
        let attempts = 0;
        const missingTransport = Layer.mock(IntegrationHub.IntegrationHub)({
          resource: (id) => {
            const item = f.resources.get(id);
            return item
              ? Effect.succeed({ hello, resource: item })
              : Effect.fail(new Rpc.DeckhandRpcError({ reason: "unavailable" }));
          },
          operation: () => Effect.fail(new Rpc.DeckhandRpcError({ reason: "missing" })),
          submit: () => {
            attempts++;
            return Effect.fail(new Rpc.DeckhandRpcError({ reason: "unavailable" }));
          },
        });
        const firstLayer = serviceLayer.pipe(
          Layer.provide(
            f.external((request) => Effect.succeed(accepted(request)), missingTransport),
          ),
        );
        const key = creationInput().operationKey;
        const original = yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          yield* service.create("actor", creationInput()).pipe(Effect.flip);
          const record = yield* service.getCreation("actor", key);
          assert.equal(record.state, "prepared");
          assert.isDefined(record.contextIntent);
          assert.equal(
            (yield* service.launch("other", input(record.launchOperationKey)).pipe(Effect.flip))
              .reason,
            "wrong_actor",
          );
          assert.equal(
            (yield* service.launch("actor", input(record.launchOperationKey)).pipe(Effect.flip))
              .reason,
            "key_conflict",
          );
          const sql = yield* SqlClient.SqlClient;
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
          assert.equal((yield* sql`SELECT id FROM deckhand_checkouts`).length, 0);
          assert.equal((yield* sql`SELECT id FROM deckhand_sessions`).length, 0);
          return record;
        }).pipe(Effect.provide(firstLayer));
        assert.equal(attempts, 1);
        const nextLayer = serviceLayer.pipe(
          Layer.provide(f.external((request) => Effect.succeed(accepted(request)), native.hub)),
        );
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const resumed = yield* service.create("actor", creationInput());
          assert.equal(resumed.contextIntent?.featureId, original.contextIntent?.featureId);
          assert.equal(resumed.launch?.featureId, original.contextIntent?.featureId);
          assert.equal(resumed.state, "accepted");
        }).pipe(Effect.provide(nextLayer));
        assert.equal(native.creations(), 1);
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "upgrades an unlaunched legacy request before native effects while lookup remains read-only",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation();
        const layer = serviceLayer.pipe(
          Layer.provide(f.external((request) => Effect.succeed(accepted(request)), native.hub)),
        );
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const sql = yield* SqlClient.SqlClient;
          const legacy: Rpc.ManagedCreateRecord = {
            operationKey: creationInput().operationKey,
            laneOperationKey: "legacy-native",
            launchOperationKey: "legacy-launch",
            state: "prepared",
            laneID: null,
            receipt: null,
            launch: null,
            error: null,
          };
          yield* sql`INSERT INTO deckhand_managed_creations(operation_key, actor_id, input_json, record_json) VALUES (${legacy.operationKey}, 'actor', ${yield* encodeCreationInputJson(creationInput())}, ${yield* encodeCreationRecordJson(legacy)})`;
          const read = yield* service.getCreation("actor", legacy.operationKey);
          assert.isUndefined(read.contextIntent);
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 0);
          assert.equal(native.creations(), 0);
          const accepted = yield* service.create("actor", creationInput());
          assert.isDefined(accepted.contextIntent);
          assert.equal(accepted.launch?.featureId, accepted.contextIntent?.featureId);
          assert.equal(accepted.laneOperationKey, legacy.laneOperationKey);
          assert.equal(accepted.launchOperationKey, legacy.launchOperationKey);
          assert.equal(native.creations(), 1);
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "preserves an accepted version-7 creation and feature after upgrade with its source unavailable",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation();
        let launches = 0;
        const layer = serviceLayer.pipe(
          Layer.provide(
            f.external((request) => {
              launches++;
              return Effect.succeed(accepted(request));
            }, native.hub),
          ),
        );
        const sql = yield* SqlClient.SqlClient;
        const one = yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          return yield* service.create("actor", creationInput());
        }).pipe(Effect.provide(layer));
        const legacy: Rpc.ManagedCreateRecord = {
          operationKey: one.operationKey,
          laneOperationKey: one.laneOperationKey,
          launchOperationKey: one.launchOperationKey,
          state: one.state,
          laneID: one.laneID,
          receipt: one.receipt,
          launch: one.launch,
          error: one.error,
        };
        const json = yield* encodeCreationRecordJson(legacy);
        yield* sql`UPDATE deckhand_managed_creations SET record_json = ${json} WHERE operation_key = ${one.operationKey}`;
        yield* sql`DROP INDEX deckhand_creations_launch_key`;
        yield* sql`DELETE FROM deckhand_schema WHERE version >= 8`;
        yield* sql`DROP TABLE deckhand_launch_reviews`;
        yield* sql`DROP TABLE deckhand_reviewer_queue`;
        yield* sql`DROP TABLE deckhand_checkout_transfers`;
        yield* sql`DROP VIEW IF EXISTS deckhand_current_checkouts`;
        yield* sql`DROP TABLE IF EXISTS deckhand_checkout_ownership`;
        yield* sql`DROP TABLE IF EXISTS deckhand_ownership_transitions`;
        yield* sql`DROP TABLE IF EXISTS deckhand_owned_preview_proofs`;
        yield* sql`DROP TABLE IF EXISTS deckhand_owned_preview_captures`;
        yield* sql`DROP TABLE IF EXISTS deckhand_verification_scenarios`;
        yield* sql`DROP TABLE IF EXISTS deckhand_verification_attempts`;
        yield* sql`DROP TABLE IF EXISTS deckhand_external_sessions`;
        yield* sql`DROP TABLE deckhand_attention_dispositions`;
        yield* sql`DROP INDEX deckhand_attention_source`;
        yield* sql`DROP INDEX deckhand_attention_page`;
        yield* sql`INSERT INTO deckhand_schema VALUES (7)`;
        f.resources.clear();
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          assert.deepEqual(yield* service.create("actor", creationInput()), legacy);
          assert.deepEqual(yield* service.getCreation("actor", legacy.operationKey), legacy);
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
          assert.equal(
            (yield* sql<{
              record_json: string;
            }>`SELECT record_json FROM deckhand_managed_creations`)[0]!.record_json,
            json,
          );
          assert.isTrue(
            (yield* sql<{ name: string }>`PRAGMA index_list(deckhand_managed_creations)`).some(
              (row) => row.name === "deckhand_creations_launch_key",
            ),
          );
        }).pipe(Effect.provide(layer));
        assert.equal(native.creations(), 1);
        assert.equal(launches, 1);
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live("reserves the feature in an existing canonical workspace binding", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = f.nativeCreation();
      const layer = serviceLayer.pipe(
        Layer.provide(f.external((request) => Effect.succeed(accepted(request)), native.hub)),
      );
      yield* Effect.gen(function* () {
        const store = yield* Relationships.Relationships;
        yield* store.putWorkspace(
          {
            id: Contracts.WorkspaceBindingId.make("existing-workspace"),
            environmentId: Contracts.EnvironmentId.make("installation"),
            backend: "cinderdeck",
            ownerId: "payment",
            generation: 2,
            revision: 1,
            name: "Existing workspace",
            state: "active",
          },
          null,
        );
        const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
        const one = yield* service.create("actor", creationInput());
        assert.equal(one.contextIntent?.workspaceBindingId, "existing-workspace");
        assert.equal(
          (yield* store.feature(one.contextIntent!.featureId)).workspaceId,
          "existing-workspace",
        );
        assert.equal(
          (yield* store.checkout(one.launch!.checkoutId)).workspaceId,
          "existing-workspace",
        );
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT id FROM deckhand_workspaces`).length, 1);
      }).pipe(Effect.provide(Relationships.layer.pipe(Layer.provideMerge(layer))));
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "keeps a new feature separate from an unrelated earlier launch with a colliding derived key",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation();
        let launches = 0;
        const layer = serviceLayer.pipe(
          Layer.provide(
            f.external((request) => {
              launches++;
              return Effect.succeed(accepted(request));
            }, native.hub),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const launchKey =
            "session:" +
            NodeCrypto.createHash("sha256")
              .update(`["${creationInput().operationKey}"]`)
              .digest("hex");
          const earlier = yield* service.launch("actor", input(launchKey));
          const collision = yield* service.create("actor", creationInput());
          assert.equal(collision.state, "failed");
          assert.equal(collision.error, "key_conflict");
          assert.equal(collision.launch, null);
          assert.notEqual(collision.contextIntent!.featureId, earlier.featureId);
          assert.equal(launches, 1);
          const sql = yield* SqlClient.SqlClient;
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 2);
          assert.equal((yield* sql`SELECT id FROM deckhand_sessions`).length, 1);
          assert.equal(native.creations(), 1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "reconciles a delayed receipt without provider effects, then explicitly retries the saved launch",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation("pending");
        const calls: ThreadLaunchService.ThreadLaunchInput[] = [];
        const layer = serviceLayer.pipe(
          Layer.provide(
            f.external((request) => {
              calls.push(request);
              return calls.length === 1 ? failed(request) : Effect.succeed(accepted(request));
            }, native.hub),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const first = yield* service.create("actor", creationInput());
          assert.equal(first.state, "creating");
          const old = native.receipts.get(first.laneOperationKey)!;
          native.receipts.set(first.laneOperationKey, {
            ...old,
            state: "succeeded",
            result: { ...old.result, creationReady: true },
          });
          const ready = yield* service.getCreation("actor", first.operationKey);
          assert.equal(ready.state, "ready");
          assert.equal(calls.length, 0);
          const failure = yield* service.create("actor", creationInput());
          assert.equal(failure.state, "failed");
          assert.equal(failure.error, "launch_failed");
          assert.equal(failure.launch?.state, "failed");
          assert.deepEqual(yield* service.getCreation("actor", first.operationKey), failure);
          assert.equal(calls.length, 1);
          const accepted = yield* service.create("actor", creationInput());
          assert.equal(accepted.state, "accepted");
          assert.equal(accepted.launch?.threadId, failure.launch?.threadId);
          assert.equal(calls[0]!.threadId, calls[1]!.threadId);
          assert.equal(accepted.launch?.featureId, first.contextIntent?.featureId);
          assert.equal(failure.contextIntent?.featureId, first.contextIntent?.featureId);
        }).pipe(Effect.provide(layer));
        assert.equal(native.creations(), 1);
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
});

describe("saved launch context review", () => {
  it.live(
    "repairs a stale resolved creation before any thread exists while retaining its original feature and lane",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation("stale_target");
        let launches = 0;
        const layer = serviceLayer.pipe(
          Layer.provide(
            f.external((request) => {
              launches++;
              return Effect.succeed(accepted(request));
            }, native.hub),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const first = yield* service.create("actor", creationInput());
          assert.equal(first.state, "failed");
          assert.equal(first.error, "stale_context");
          assert.equal(first.launch, null);
          const review = yield* service.reviewPreview("actor", {
            kind: "creation",
            operationKey: first.operationKey,
          });
          assert.equal(review.workspaceID, first.laneID);
          assert.equal(review.revision, "changed");
          yield* service.reviewConfirm("actor", review);
          assert.equal(launches, 0);
          const accepted = yield* service.create("actor", creationInput());
          assert.equal(accepted.state, "accepted");
          assert.equal(accepted.launch?.featureId, first.contextIntent?.featureId);
          assert.equal(accepted.laneID, first.laneID);
          assert.equal(native.creations(), 1);
          assert.equal(launches, 1);
          const sql = yield* SqlClient.SqlClient;
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
          assert.equal(
            (yield* decodeLaunchInputJson(
              (yield* sql<{
                launch_input_json: string;
              }>`SELECT launch_input_json FROM deckhand_managed_creations`)[0]!.launch_input_json,
            )).revision,
            "current",
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "requires explicit fresh review, preserves immutable intent and thread through restart, and rejects changed heads",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let calls = 0;
        const layer = serviceLayer.pipe(
          Layer.provide(
            f.external((request) => {
              calls++;
              return calls === 1 ? failed(request) : Effect.succeed(accepted(request));
            }),
          ),
        );
        const reviewInput: Rpc.ManagedLaunchReviewInput = {
          kind: "launch",
          operationKey: input().operationKey,
        };
        const sql = yield* SqlClient.SqlClient;
        const original = yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          yield* service.launch("actor", input()).pipe(Effect.flip);
          const original = yield* service.get("actor", input().operationKey);
          yield* f.git(f.lane, [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "Head changed before review",
          ]);
          assert.equal(
            (yield* service.launch("actor", input()).pipe(Effect.flip)).reason,
            "stale_context",
            "a changed head requires review even if native metadata revision is unchanged",
          );
          f.resources.get("lane")!.revision = "changed";
          assert.equal(
            (yield* service.launch("actor", input()).pipe(Effect.flip)).reason,
            "stale_context",
          );
          const review = yield* service.reviewPreview("actor", reviewInput);
          assert.equal(review.revision, "changed");
          assert.equal(calls, 1);
          assert.equal(
            (yield* sql`SELECT launch_operation_key FROM deckhand_launch_reviews`).length,
            0,
          );
          assert.equal(
            (yield* service.reviewPreview("other", reviewInput).pipe(Effect.flip)).reason,
            "wrong_actor",
          );
          assert.equal(
            (yield* service
              .reviewConfirm("actor", { ...review, revision: "old" })
              .pipe(Effect.flip)).reason,
            "stale_context",
          );
          yield* service.reviewConfirm("actor", review);
          assert.equal(calls, 1, "confirmation cannot start a provider");
          yield* f.git(f.lane, [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "New reviewed head",
          ]);
          assert.equal(
            (yield* service.launch("actor", input()).pipe(Effect.flip)).reason,
            "stale_context",
          );
          yield* service.reviewConfirm("actor", yield* service.reviewPreview("actor", reviewInput));
          return original;
        }).pipe(Effect.provide(layer));
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const current = yield* service.launch("actor", input());
          assert.equal(current.state, "accepted");
          assert.equal(current.threadId, original.threadId);
          assert.equal(current.featureId, original.featureId);
          const checkout = yield* Effect.gen(function* () {
            const store = yield* Relationships.Relationships;
            return yield* store.checkout(current.checkoutId);
          }).pipe(Effect.provide(Relationships.layer));
          assert.equal(
            checkout.repositories[0]!.commit,
            (yield* f.git(f.lane, ["rev-parse", "HEAD"])).stdout.trim(),
          );
          assert.equal(
            (yield* service.reviewPreview("actor", reviewInput).pipe(Effect.flip)).reason,
            "not_retryable",
          );
          assert.equal(
            (yield* decodeLaunchInputJson(
              (yield* sql<{
                input_json: string;
              }>`SELECT input_json FROM deckhand_managed_launches`)[0]!.input_json,
            )).revision,
            "current",
          );
        }).pipe(Effect.provide(layer));
        assert.equal(calls, 2);
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "refuses to retarget an existing saved conversation to another physical checkout or generation",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const layer = serviceLayer.pipe(Layer.provide(f.external((request) => failed(request))));
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          yield* service.launch("actor", input()).pipe(Effect.flip);
          const request: Rpc.ManagedLaunchReviewInput = {
            kind: "launch",
            operationKey: input().operationKey,
          };
          const lane = f.resources.get("lane")!;
          lane.workspace.repos[0]!.path = f.source;
          assert.equal(
            (yield* service.reviewPreview("actor", request).pipe(Effect.flip)).reason,
            "stale_context",
          );
          lane.workspace.repos[0]!.path = f.lane;
          lane.generation++;
          assert.equal(
            (yield* service.reviewPreview("actor", request).pipe(Effect.flip)).reason,
            "stale_context",
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
});

describe("managed lane session launch", () => {
  it.live.each([false, true])(
    "attaches the %s configured editing skill and retains its file context across retries",
    (configured) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const calls: ThreadLaunchService.ThreadLaunchInput[] = [];
        const layer = serviceLayer.pipe(
          Layer.provide(
            f.external((request) => {
              calls.push(request);
              return calls.length === 1 ? failed(request) : Effect.succeed(accepted(request));
            }),
          ),
        );
        const path = `${f.source}/.cinderdeck/skills/code-review/SKILL.md`;
        const content = configured
          ? "Review race conditions and pagination."
          : Rpc.DEFAULT_CODE_REVIEW_SKILL;
        if (configured) {
          yield* f.fs.makeDirectory(`${f.source}/.cinderdeck/skills/code-review`, {
            recursive: true,
          });
          yield* f.fs.writeFileString(path, content);
        }
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const request = {
            ...input("edit-skill"),
            workspaceID: "payment",
            generation: 2,
            title: "Code Review Skill",
            objective: `Read the attached Code Review Skill. Save edits to ${path}.`,
            editReviewSkill: true as const,
          };
          assert.equal(
            (yield* service.launch("actor", request).pipe(Effect.flip)).reason,
            "launch_failed",
          );
          assert.equal(yield* f.fs.readFileString(path), content);
          yield* f.fs.writeFileString(path, "Edited after the initial launch");
          const result = yield* service.launch("actor", request);
          assert.equal(result.state, "accepted");
          assert.equal(calls[0]!.threadId, calls[1]!.threadId);
          const message = calls[1]!.initialMessage!;
          assert.equal(message.attachments.length, 1);
          assert.deepEqual(message.attachments, calls[0]!.initialMessage!.attachments);
          assert.notInclude(message.text, content);
          const attachment = message.attachments[0]!;
          const config = yield* ServerConfig.ServerConfig;
          const savedPath = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          })!;
          assert.equal(yield* f.fs.readFileString(savedPath), content);
          assert.equal(attachment.sizeBytes, new TextEncoder().encode(content).length);
          assert.equal(yield* f.fs.readFileString(path), "Edited after the initial launch");
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
  it.effect(
    "opens a parent folder workspace containing repos despite service warnings and changed service settings",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const workspace = f.resources.get("payment")!.workspace;
        workspace.repos.unshift({
          ...workspace.repos[0]!,
          id: "workspace",
          path: f.root,
          physicalID: "",
          repositoryPhysicalID: "",
          branch: "Not a Git repository",
        });
        Object.assign(workspace, {
          root: f.root,
          definitionChanged: true,
          issues: ["warning: api hard-codes localhost:3000"],
        });
        const dependencies = yield* Effect.context<
          FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner | SqlClient.SqlClient
        >();
        let called = false;
        const external = f.external((request) =>
          Effect.gen(function* () {
            assert.equal(request.workspaceStrategy.type, "existing_worktree");
            assert.equal(
              request.workspaceStrategy.type === "existing_worktree" &&
                request.workspaceStrategy.worktreePath,
              yield* f.fs.realPath(f.root),
            );
            assert.isUndefined(request.initialMessage);
            const guard = yield* ManagedCheckoutGuard.ManagedCheckoutGuard;
            const context = yield* guard.resolve(request.threadId!, f.root);
            assert.equal(context?.cwd, yield* f.fs.realPath(f.root));
            assert.deepEqual(context?.folders, [f.root, f.source]);
            called = true;
            return accepted(request);
          }).pipe(
            Effect.provide(
              ManagedCheckoutGuard.layer.pipe(
                Layer.provide(Relationships.layer),
                Layer.provide(CheckoutIdentity.layer),
                Layer.provide(f.hubLayer),
              ),
            ),
            Effect.provide(dependencies),
            Effect.orDie,
          ),
        );
        const service = yield* ManagedSessionLaunch.ManagedSessionLaunch.pipe(
          Effect.provide(serviceLayer.pipe(Layer.provide(external))),
        );
        assert.equal(
          (yield* service.launch("actor", {
            ...input("folder-workspace"),
            workspaceID: "payment",
            generation: 2,
            repositoryID: "workspace",
            deferStart: true,
            objective: "",
          })).state,
          "accepted",
        );
        assert.isTrue(called);
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.effect("refuses workspace definition errors before allocating or launching a chat", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      Object.assign(f.resources.get("lane")!.workspace, { issues: ["error: Folder is missing"] });
      let called = false;
      const external = f.external((request) => {
        called = true;
        return Effect.succeed(accepted(request));
      });
      const service = yield* ManagedSessionLaunch.ManagedSessionLaunch.pipe(
        Effect.provide(serviceLayer.pipe(Layer.provide(external))),
      );
      assert.equal(
        (yield* service
          .launch("actor", { ...input("invalid-workspace"), deferStart: true, objective: "" })
          .pipe(Effect.flip)).reason,
        "stale_context",
      );
      assert.isFalse(called);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql`SELECT * FROM deckhand_managed_launches`;
      assert.equal(rows.length, 0);
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.effect("reviews and retries the same interrupted chat in an ordinary workspace folder", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const resource = f.resources.get("payment")!;
      Object.assign(resource.workspace, {
        root: f.root,
        definitionChanged: true,
        issues: ["warning: Service URL uses the source port"],
        repos: [
          {
            ...resource.workspace.repos[0]!,
            id: "workspace",
            path: f.root,
            physicalID: "",
            repositoryPhysicalID: "",
            branch: "Not a Git repository",
          },
        ],
      });
      let failLaunch = true;
      const calls: ThreadLaunchService.ThreadLaunchInput[] = [];
      const external = f.external((request) => {
        calls.push(request);
        return failLaunch ? failed(request) : Effect.succeed(accepted(request));
      });
      const service = yield* ManagedSessionLaunch.ManagedSessionLaunch.pipe(
        Effect.provide(serviceLayer.pipe(Layer.provide(external))),
      );
      const request = {
        ...input("recover-folder-chat"),
        workspaceID: "payment",
        generation: 2,
        repositoryID: "workspace",
        deferStart: true,
        objective: "",
      };
      assert.equal(
        (yield* service.launch("actor", request).pipe(Effect.flip)).reason,
        "launch_failed",
      );
      resource.revision = "refreshed";
      const review = yield* service.reviewPreview("actor", {
        operationKey: request.operationKey,
        kind: "launch",
      });
      assert.equal(review.repositories[0]?.checkout.root, yield* f.fs.realPath(f.root));
      yield* service.reviewConfirm("actor", review);
      failLaunch = false;
      assert.equal((yield* service.launch("actor", request)).state, "accepted");
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.threadId, calls[1]?.threadId);
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.effect("launches across Git and ordinary folders with individual file context", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const docs = `${f.root}/docs`;
      yield* f.fs.makeDirectory(docs);
      const brief = `${f.root}/brief.md`;
      yield* f.fs.writeFileString(brief, "Workspace brief");
      const resource = f.resources.get("lane")!;
      resource.workspace.repos.push({
        id: "docs",
        path: docs,
        physicalID: "",
        repositoryPhysicalID: "",
        branch: "",
        dirty: false,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      });
      Object.assign(resource.workspace, { files: [brief] });
      let called = false;
      const dependencies = yield* Effect.context<
        FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner | SqlClient.SqlClient
      >();
      const external = f.external((request) =>
        Effect.gen(function* () {
          const guard = yield* ManagedCheckoutGuard.ManagedCheckoutGuard;
          const context = yield* guard.resolve(request.threadId!, docs);
          assert.deepEqual(context?.folders, [f.lane, docs]);
          assert.deepEqual(context?.files, [brief]);
          assert.equal(context?.cwd, yield* f.fs.realPath(docs));
          called = true;
          return accepted(request);
        }).pipe(
          Effect.provide(
            ManagedCheckoutGuard.layer.pipe(
              Layer.provide(Relationships.layer),
              Layer.provide(CheckoutIdentity.layer),
              Layer.provide(f.hubLayer),
            ),
          ),
          Effect.provide(dependencies),
          Effect.orDie,
        ),
      );
      const service = yield* ManagedSessionLaunch.ManagedSessionLaunch.pipe(
        Effect.provide(serviceLayer.pipe(Layer.provide(external))),
      );
      assert.equal(
        (yield* service.launch("actor", { ...input("multi-folder"), repositoryID: "docs" })).state,
        "accepted",
      );
      assert.isTrue(called);
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
  it.live("opens an idle bound chat with no initial message and replays its durable receipt", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const calls: ThreadLaunchService.ThreadLaunchInput[] = [];
      const external = f.external((request) => {
        calls.push(request);
        return Effect.succeed(accepted(request));
      });
      yield* Effect.gen(function* () {
        const launcher = yield* ManagedSessionLaunch.ManagedSessionLaunch;
        const request = decodeInput({
          ...input("empty-chat"),
          title: "New chat",
          objective: "",
          deferStart: true,
          interactionMode: "plan",
          modelSelection: {
            instanceId,
            model: "fixture-model",
            options: [{ id: "reasoning_effort", value: "high" }],
          },
        });
        const one = yield* launcher.launch("actor", request);
        const two = yield* launcher.launch("actor", request);
        assert.deepEqual(one, two);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.initialMessage, undefined);
        assert.equal(calls[0]!.deferPreparation, true);
        assert.equal(calls[0]!.interactionMode, "plan");
        assert.deepEqual(calls[0]!.modelSelection, request.modelSelection);
        const relationships = yield* Relationships.Relationships;
        const session = yield* relationships.session(one.sessionId);
        assert.equal(session.execution, "idle");
        assert.equal(session.connection, "unavailable");
        const sql = yield* SqlClient.SqlClient;
        assert.equal(session.providerSessionId, null);
        assert.equal((yield* relationships.feature(session.featureId)).objective, "");
        assert.equal((yield* relationships.checkout(session.checkoutId)).laneId, "lane");
        const rejected = yield* launcher
          .launch("actor", { ...request, operationKey: "no-message", deferStart: false })
          .pipe(Effect.flip);
        assert.equal(rejected.reason, "stale_context");
        assert.equal(calls.length, 1);
      }).pipe(Effect.provide(serviceLayer.pipe(Layer.provide(external))));
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "persists scoped bindings before intake, uses the existing lane, and replays concurrent retries",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const deps = yield* Effect.context<
          SqlClient.SqlClient | FileSystem.FileSystem | ProcessRunner.ProcessRunner | Path.Path
        >();
        const calls: ThreadLaunchService.ThreadLaunchInput[] = [];
        const external = f.external((request) =>
          Effect.gen(function* () {
            calls.push(request);
            const rows = yield* sql<{
              record_json: string;
            }>`SELECT record_json FROM deckhand_sessions WHERE thread_id = ${request.threadId!}`;
            assert.equal(rows.length, 1);
            const store = yield* Relationships.Relationships;
            const record = yield* decodeRecord(
              (yield* sql<{
                record_json: string;
              }>`SELECT record_json FROM deckhand_managed_launches`)[0]!.record_json,
            );
            const session = yield* store.session(record.sessionId);
            const checkout = yield* store.checkout(session.checkoutId);
            assert.equal(checkout.workspaceGeneration, 2);
            assert.equal(checkout.nativeGeneration, 7);
            assert.equal(checkout.laneId, "lane");
            assert.equal(checkout.repositories[0]!.root, yield* f.fs.realPath(f.lane));
            assert.deepEqual(session.repositoryScope, [checkout.repositories[0]!.physicalId]);
            assert.equal(session.execution, "queued");
            assert.equal((yield* store.feature(session.featureId)).objective, input().objective);
            const guard = yield* ManagedCheckoutGuard.ManagedCheckoutGuard;
            const context = yield* guard.resolve(request.threadId!, f.lane);
            assert.equal(context?.cwd, yield* f.fs.realPath(f.lane));
            return accepted(request);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Relationships.layer,
                ManagedCheckoutGuard.layer.pipe(
                  Layer.provide(Relationships.layer),
                  Layer.provide(CheckoutIdentity.layer),
                  Layer.provide(f.hubLayer),
                ),
              ).pipe(Layer.provideMerge(Layer.succeedContext(deps))),
            ),
            Effect.orDie,
          ),
        );
        const layer = serviceLayer.pipe(Layer.provide(external));
        yield* Effect.gen(function* () {
          const launch = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const [one, two] = yield* Effect.all(
            [launch.launch("actor", input()), launch.launch("actor", input())],
            { concurrency: "unbounded" },
          );
          assert.deepEqual(one, two);
          assert.equal(one.state, "accepted");
          assert.equal(calls.length, 1);
          assert.deepEqual(calls[0]!.workspaceStrategy, {
            type: "existing_worktree",
            worktreePath: yield* f.fs.realPath(f.lane),
            branch: "lane",
          });
          assert.equal(calls[0]!.threadId, one.threadId);
          assert.equal((yield* launch.get("actor", input().operationKey)).threadId, one.threadId);
          assert.equal(
            (yield* launch.launch("other", input()).pipe(Effect.flip)).reason,
            "wrong_actor",
          );
          assert.equal(
            (yield* launch
              .launch("actor", { ...input(), objective: "different" })
              .pipe(Effect.flip)).reason,
            "key_conflict",
          );
          f.resources.clear();
          assert.deepEqual(yield* launch.launch("actor", input()), one);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "reuses a prior workspace ownership tuple and serializes distinct launches without duplicating it",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const layer = serviceLayer.pipe(
          Layer.provide(f.external((request) => Effect.succeed(accepted(request)))),
        );
        yield* Effect.gen(function* () {
          const launch = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const store = yield* Relationships.Relationships;
          yield* store.putWorkspace(
            {
              id: Contracts.WorkspaceBindingId.make("legacy-workspace"),
              environmentId: Contracts.EnvironmentId.make("installation"),
              backend: "cinderdeck",
              ownerId: "payment",
              generation: 2,
              revision: 1,
              name: "Existing workspace",
              state: "active",
            },
            null,
          );
          const records = yield* Effect.all(
            [launch.launch("actor", input("one")), launch.launch("actor", input("two"))],
            { concurrency: "unbounded" },
          );
          assert.notEqual(records[0]!.threadId, records[1]!.threadId);
          assert.equal(records[0]!.checkoutId, records[1]!.checkoutId);
          assert.equal(
            (yield* store.checkout(records[0]!.checkoutId)).workspaceId,
            "legacy-workspace",
          );
          const sql = yield* SqlClient.SqlClient;
          assert.equal((yield* sql`SELECT id FROM deckhand_workspaces`).length, 1);
          assert.equal((yield* sql`SELECT id FROM deckhand_sessions`).length, 2);
        }).pipe(Effect.provide(Relationships.layer.pipe(Layer.provideMerge(layer))));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live("retains the feature and same thread across intake failure and service restart", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const attempts: ThreadLaunchService.ThreadLaunchInput[] = [];
      const firstLayer = serviceLayer.pipe(
        Layer.provide(
          f.external((request) => {
            attempts.push(request);
            return failed(request);
          }),
        ),
      );
      const original = yield* Effect.gen(function* () {
        const launch = yield* ManagedSessionLaunch.ManagedSessionLaunch;
        assert.equal(
          (yield* launch.launch("actor", input()).pipe(Effect.flip)).reason,
          "launch_failed",
        );
        const saved = yield* launch.get("actor", input().operationKey);
        assert.equal(saved.state, "failed");
        return saved;
      }).pipe(Effect.provide(firstLayer));
      const nextLayer = serviceLayer.pipe(
        Layer.provide(
          f.external((request) => {
            attempts.push(request);
            return Effect.succeed(accepted(request));
          }),
        ),
      );
      const resumed = yield* Effect.gen(function* () {
        const launch = yield* ManagedSessionLaunch.ManagedSessionLaunch;
        return yield* launch.launch("actor", input());
      }).pipe(Effect.provide(nextLayer));
      assert.equal(resumed.threadId, original.threadId);
      assert.equal(resumed.featureId, original.featureId);
      assert.equal(resumed.state, "accepted");
      assert.equal(attempts[0]!.commandId, attempts[1]!.commandId);
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT id FROM deckhand_sessions`).length, 1);
      assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "refuses stale generations, missing repositories, and replaced worktrees before intake",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        let calls = 0;
        const layer = serviceLayer.pipe(
          Layer.provide(
            f.external((request) => {
              calls++;
              return failed(request);
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const launch = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          for (const changed of [
            { ...input(), generation: 9 },
            { ...input(), installationID: "other" },
            { ...input(), revision: "old" },
            { ...input(), repositoryID: "unknown" },
          ]) {
            assert.equal(
              (yield* launch.launch("actor", changed).pipe(Effect.flip)).reason,
              "stale_context",
            );
          }
          assert.equal(calls, 0);
          yield* launch.launch("actor", input()).pipe(Effect.flip);
          const saved = yield* launch.get("actor", input().operationKey);
          yield* f.git(f.source, ["worktree", "remove", f.lane]);
          yield* f.git(f.source, ["worktree", "add", "-b", "replacement", f.lane]);
          assert.equal(
            (yield* launch.launch("actor", input()).pipe(Effect.flip)).reason,
            "stale_context",
          );
          assert.equal(calls, 1);
          assert.equal((yield* launch.get("actor", input().operationKey)).threadId, saved.threadId);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );

  it.live(
    "recovers an interrupted intake with its saved IDs and never leaves a partial binding transaction",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const entered = yield* Deferred.make<void>();
        const layer = serviceLayer.pipe(
          Layer.provide(
            f.external(() =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const launch = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const fiber = yield* launch.launch("actor", input()).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const prepared = yield* launch.get("actor", input().operationKey);
          assert.equal(prepared.state, "prepared");
          yield* Fiber.interrupt(fiber);
          assert.equal(
            (yield* launch.get("actor", input().operationKey)).threadId,
            prepared.threadId,
          );
        }).pipe(Effect.provide(layer));
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER reject_launch BEFORE INSERT ON deckhand_managed_launches BEGIN SELECT RAISE(ABORT, 'fixture'); END`;
        const failedLayer = serviceLayer.pipe(
          Layer.provide(f.external((request) => Effect.succeed(accepted(request)))),
        );
        yield* Effect.gen(function* () {
          const launch = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          assert.equal(
            (yield* launch.launch("actor", input("second")).pipe(Effect.flip)).reason,
            "storage",
          );
        }).pipe(Effect.provide(failedLayer));
        assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
        assert.equal((yield* sql`SELECT id FROM deckhand_sessions`).length, 1);
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
});

describe("isolated reviewer scheduling", () => {
  it.live.each([false, true])(
    "pins reviewed commits, reuses the original feature, and preserves its primary checkout (adopted=%s)",
    (adopted) =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation();
        let launches = 0;
        const layer = serviceLayer.pipe(
          Layer.provide(
            f.external((request) => {
              launches++;
              return Effect.succeed(accepted(request));
            }, native.hub),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const store = yield* Relationships.Relationships;
          let writer = yield* service.launch("actor", input("writer"));
          const sql = yield* SqlClient.SqlClient;
          if (adopted) {
            const target = yield* store.checkout(writer.checkoutId);
            const targetWorkspace = yield* store.workspace(target.workspaceId);
            const originalFeature = yield* store.feature(writer.featureId);
            const originalSession = yield* store.session(writer.sessionId);
            const originWorkspaceID = Contracts.WorkspaceBindingId.make("original-standalone");
            const originCheckoutID = Contracts.CheckoutBindingId.make("original-checkout");
            const featureID = Contracts.FeatureId.make("original-feature");
            const sessionID = Contracts.SessionBindingId.make("original-session");
            yield* store.putWorkspace(
              {
                ...targetWorkspace,
                id: originWorkspaceID,
                backend: "standalone",
                ownerId: originWorkspaceID,
                generation: 1,
              },
              null,
            );
            const { nativeGeneration, ...originalCheckout } = target;
            void nativeGeneration;
            yield* store.putCheckout(
              {
                ...originalCheckout,
                id: originCheckoutID,
                workspaceId: originWorkspaceID,
                workspaceGeneration: 1,
                backend: "standalone",
                kind: "primary",
                laneId: null,
              },
              null,
            );
            yield* store.putFeature(
              { ...originalFeature, id: featureID, workspaceId: originWorkspaceID },
              null,
            );
            yield* store.linkCheckout(featureID, originCheckoutID, true);
            yield* store.putSession(
              {
                ...originalSession,
                id: sessionID,
                threadId: ThreadId.make("original-thread"),
                featureId: featureID,
                checkoutId: originCheckoutID,
              },
              null,
            );
            yield* sql`INSERT INTO deckhand_ownership_transitions(id,actor_id,physical_id,original_json,record_json) VALUES('fixture-adoption','actor',${target.repositories[0]!.physicalId},'{}','{"state":"completed"}')`;
            yield* sql`INSERT INTO deckhand_checkout_ownership(original_checkout_id,target_checkout_id,transition_id,revision) VALUES(${originCheckoutID},${target.id},'fixture-adoption',1)`;
            writer = {
              ...writer,
              featureId: featureID,
              sessionId: sessionID,
              checkoutId: originCheckoutID,
              threadId: ThreadId.make("original-thread"),
            };
          }
          const originalRows = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM deckhand_features WHERE id=${writer.featureId}`;
          const originalSessions = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM deckhand_sessions WHERE id=${writer.sessionId}`;
          const preview = yield* resolveReviewerSource({
            featureId: writer.featureId,
            sourceCheckoutId: writer.checkoutId,
          });
          const request = {
            ...creationInput("reviewer"),
            ...preview,
            reviewerContext: preview.reviewerContext,
            repositoryRefs: Object.fromEntries(
              preview.reviewerContext.repositories.map((repo) => [repo.repositoryID, repo.commit]),
            ),
          };
          const reviewed = yield* service.create("actor", request);
          assert.equal(reviewed.state, "accepted", reviewed.error ?? undefined);
          assert.equal(reviewed.launch?.featureId, writer.featureId);
          const binding = yield* store.session(reviewed.launch!.sessionId);
          const checkout = yield* store.checkout(reviewed.launch!.checkoutId);
          assert.equal(binding.role, "reviewer");
          assert.equal(binding.desiredAccess, "isolated");
          assert.isFalse(binding.capabilities.enforcedReadOnly);
          assert.notEqual(
            checkout.repositories[0]!.physicalId,
            (yield* store.checkout(writer.checkoutId)).repositories[0]!.physicalId,
          );
          assert.equal(
            checkout.repositories[0]!.commit,
            preview.reviewerContext.repositories[0]!.commit,
          );
          const links = yield* sql<{
            checkout_id: string;
          }>`SELECT checkout_id FROM deckhand_feature_checkouts WHERE feature_id=${writer.featureId} AND is_primary=1`;
          assert.equal(links[0]!.checkout_id, writer.checkoutId);
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, adopted ? 2 : 1);
          assert.deepEqual(
            yield* sql<{
              record_json: string;
            }>`SELECT record_json FROM deckhand_features WHERE id=${writer.featureId}`,
            originalRows,
          );
          assert.deepEqual(
            yield* sql<{
              record_json: string;
            }>`SELECT record_json FROM deckhand_sessions WHERE id=${writer.sessionId}`,
            originalSessions,
          );
          f.resources.clear();
          assert.deepEqual(yield* service.create("actor", request), reviewed);
        }).pipe(Effect.provide(Relationships.layer.pipe(Layer.provideMerge(layer))));
        assert.equal(native.creations(), 1);
        assert.equal(launches, 2);
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
  it.live.each(["head_changed"] as const)("refuses %s source changes before native creation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = f.nativeCreation();
      const layer = serviceLayer.pipe(
        Layer.provide(f.external((request) => Effect.succeed(accepted(request)), native.hub)),
      );
      yield* Effect.gen(function* () {
        const service = yield* ManagedSessionLaunch.ManagedSessionLaunch;
        const writer = yield* service.launch("actor", input("writer"));
        const preview = yield* resolveReviewerSource({
          featureId: writer.featureId,
          sourceCheckoutId: writer.checkoutId,
        });
        yield* f.git(f.lane, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "New source head",
        ]);
        const refused = yield* service
          .create("actor", {
            ...creationInput("reviewer"),
            ...preview,
            repositoryRefs: Object.fromEntries(
              preview.reviewerContext.repositories.map((repo) => [repo.repositoryID, repo.commit]),
            ),
          })
          .pipe(Effect.flip);
        assert.equal(refused.reason, "stale_context");
        assert.equal(native.creations(), 0);
        assert.equal(
          (yield* (yield* SqlClient.SqlClient)`SELECT operation_key FROM deckhand_managed_creations`)
            .length,
          0,
        );
      }).pipe(Effect.provide(Relationships.layer.pipe(Layer.provideMerge(layer))));
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
});

describe("durable reviewer scheduling", () => {
  const queueLayer = (
    f: Effect.Success<typeof fixture>,
    native: ReturnType<Effect.Success<typeof fixture>["nativeCreation"]>,
    launch: ThreadLaunchService.ThreadLaunchService["Service"]["launch"] = (request) =>
      Effect.succeed(accepted(request)),
  ) =>
    ReviewerLaunch.layer.pipe(
      Layer.provideMerge(serviceLayer),
      Layer.provide(f.external(launch, native.hub)),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        ),
      ),
    );
  const queuedInput = (preview: Rpc.ReviewerLaunchPreview, operationKey = "queued-review") => ({
    operationKey,
    preview,
    modelSelection: { instanceId, model: "fixture-model" },
    runtimeMode: "approval-required" as const,
    objective: "Inspect correctness",
  });
  it.live(
    "persists an immutable review and creates one pinned lane while its writer remains active",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation();
        yield* Effect.gen(function* () {
          const managed = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const queue = yield* ReviewerLaunch.ReviewerLaunch;
          const sql = yield* SqlClient.SqlClient;
          const writer = yield* managed.launch("actor", input("writer"));
          const preview = yield* queue.preview({ threadId: writer.threadId! });
          const request = queuedInput(preview);
          const waiting = yield* queue.schedule("actor", request);
          assert.equal(waiting.state, "accepted");
          assert.equal(waiting.attempts, 1);
          assert.equal(native.creations(), 1);
          assert.equal(
            (yield* queue.schedule("other", request).pipe(Effect.flip)).reason,
            "wrong_actor",
          );
          assert.equal(
            (yield* queue.schedule("actor", { ...request, objective: "Changed" }).pipe(Effect.flip))
              .reason,
            "key_conflict",
          );
          const original = (yield* sql<{
            original_input_json: string;
          }>`SELECT original_input_json FROM deckhand_reviewer_queue`)[0]!.original_input_json;
          const ready = yield* queue.schedule("actor", request);
          assert.equal(ready.state, "accepted");
          assert.equal(ready.attempts, 1);
          assert.notEqual(ready.creation?.threadID, writer.threadId);
          assert.equal(native.creations(), 1);
          assert.deepEqual(yield* queue.schedule("actor", request), ready);
          assert.equal(
            (yield* sql<{
              original_input_json: string;
            }>`SELECT original_input_json FROM deckhand_reviewer_queue`)[0]!.original_input_json,
            original,
          );
          const intent = yield* decodeCreationInput(
            (yield* sql<{
              input_json: string;
            }>`SELECT input_json FROM deckhand_managed_creations`)[0]!.input_json,
          );
          assert.equal(intent.reviewerContext?.featureId, writer.featureId);
          assert.equal(
            intent.repositoryRefs.frontend,
            preview.reviewerContext.repositories[0]!.commit,
          );
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
        }).pipe(Effect.provide(queueLayer(f, native)));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
  it.live(
    "reviews committed heads across generation reloads and leaves uncommitted files in the source",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const native = f.nativeCreation();
        yield* Effect.gen(function* () {
          const managed = yield* ManagedSessionLaunch.ManagedSessionLaunch;
          const queue = yield* ReviewerLaunch.ReviewerLaunch;
          const sql = yield* SqlClient.SqlClient;
          const writer = yield* managed.launch("actor", input("writer"));
          f.resources.get("lane")!.generation++;
          f.resources.get("payment")!.generation++;
          yield* f.fs.writeFileString(`${f.lane}/uncommitted.txt`, "pending");
          f.resources.get("lane")!.workspace!.repos[0]!.dirty = true;
          const preview = yield* queue.preview({ threadId: writer.threadId! });
          assert.equal(preview.generation, 3);
          assert.equal(preview.reviewerContext.sourceGeneration, 8);
          assert.equal(preview.codeReviewSkill?.configured, false);
          f.resources.get("lane")!.revision = "status-updated";
          f.resources.get("payment")!.revision = "service-updated";
          const result = yield* queue.schedule("actor", queuedInput(preview, "committed-review"));
          assert.equal(result.state, "accepted", result.detail ?? undefined);
          assert.equal(native.creations(), 1);
          assert.equal(yield* f.fs.readFileString(`${f.lane}/uncommitted.txt`), "pending");
          assert.isFalse(yield* f.fs.exists(`${f.root}/created/uncommitted.txt`));
          const actual = yield* (yield* CheckoutIdentity.CheckoutIdentity).resolve(
            `${f.root}/created`,
          );
          assert.equal(actual.commit, preview.reviewerContext.repositories[0]!.commit);
          const intent = yield* decodeCreationRecord(
            (yield* sql<{
              record_json: string;
            }>`SELECT record_json FROM deckhand_managed_creations`)[0]!.record_json,
          );
          assert.equal(intent.nativeRevision, "service-updated");
          assert.equal((yield* sql`SELECT id FROM deckhand_features`).length, 1);
        }).pipe(Effect.provide(queueLayer(f, native)));
      }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
  it.live("snapshots the workspace skill and delivers it with the chosen session settings", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = f.nativeCreation();
      const calls: ThreadLaunchService.ThreadLaunchInput[] = [];
      yield* Effect.gen(function* () {
        const managed = yield* ManagedSessionLaunch.ManagedSessionLaunch;
        const queue = yield* ReviewerLaunch.ReviewerLaunch;
        const writer = yield* managed.launch("actor", input("writer"));
        const path = `${f.source}/.cinderdeck/skills/code-review/SKILL.md`;
        yield* f.fs.makeDirectory(`${f.source}/.cinderdeck/skills/code-review`, {
          recursive: true,
        });
        yield* f.fs.writeFileString(path, "Check pagination and concurrency carefully.");
        const preview = yield* queue.preview({ threadId: writer.threadId! });
        assert.equal(
          preview.codeReviewSkill?.content,
          "Check pagination and concurrency carefully.",
        );
        assert.equal(preview.codeReviewSkill?.path, path);
        assert.equal(preview.codeReviewSkill?.configured, true);
        // Editing instructions after inspection does not change the saved request.
        yield* f.fs.writeFileString(path, "Changed later");
        const request = { ...queuedInput(preview), interactionMode: "plan" as const };
        const result = yield* queue.schedule("actor", request);
        assert.equal(result.state, "accepted");
        const sql = yield* SqlClient.SqlClient;
        const intent = yield* decodeCreationInput(
          (yield* sql<{
            input_json: string;
          }>`SELECT input_json FROM deckhand_managed_creations`)[0]!.input_json,
        );
        assert.notInclude(intent.objective, "Check pagination and concurrency carefully.");
        assert.notInclude(intent.objective, "Changed later");
        assert.include(intent.objective, "attached Code Review Skill");
        assert.equal(
          intent.codeReviewSkill?.content,
          "Check pagination and concurrency carefully.",
        );
        const initial = calls.at(-1)!.initialMessage!;
        assert.equal(initial.attachments.length, 1);
        const attachment = initial.attachments[0]!;
        assert.equal(attachment.type, "file");
        assert.equal(attachment.name, "Code Review Skill.md");
        const config = yield* ServerConfig.ServerConfig;
        const savedPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        })!;
        assert.equal(
          resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: attachment.id,
          }),
          savedPath,
        );
        assert.equal(
          yield* f.fs.readFileString(savedPath),
          "Check pagination and concurrency carefully.",
        );
        assert.notInclude(initial.text, "Check pagination and concurrency carefully.");
        assert.equal(intent.interactionMode, "plan");
      }).pipe(
        Effect.provide(
          queueLayer(f, native, (request) => {
            calls.push(request);
            return Effect.succeed(accepted(request));
          }),
        ),
      );
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
  it.live("creates each reviewer repository from its lane's committed head", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = f.nativeCreation();
      yield* Effect.gen(function* () {
        const identities = yield* CheckoutIdentity.CheckoutIdentity;
        const api = `${f.root}/api`;
        const apiLane = `${f.root}/api-lane`;
        yield* f.fs.makeDirectory(api);
        yield* f.git(api, ["init", "--initial-branch=main"]);
        yield* f.git(api, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "API base",
        ]);
        yield* f.git(api, ["worktree", "add", "-b", "feature-api", apiLane]);
        yield* f.git(apiLane, [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "API feature",
        ]);
        for (const [id, path] of [
          ["payment", api],
          ["lane", apiLane],
        ]) {
          const actual = yield* identities.resolve(path!);
          f.resources.get(id!)!.workspace.repos.push({
            ...f.resources.get(id!)!.workspace.repos[0]!,
            id: "api",
            path: path!,
            physicalID: actual.physicalId,
            repositoryPhysicalID: actual.repositoryPhysicalId,
            branch: actual.branch!,
          });
        }
        const managed = yield* ManagedSessionLaunch.ManagedSessionLaunch;
        const queue = yield* ReviewerLaunch.ReviewerLaunch;
        const writer = yield* managed.launch("actor", input("multi-writer"));
        const preview = yield* queue.preview({ threadId: writer.threadId! });
        assert.equal(preview.reviewerContext.repositories.length, 2);
        assert.notEqual(
          preview.reviewerContext.repositories[0]!.commit,
          preview.reviewerContext.repositories[1]!.commit,
        );
        const result = yield* queue.schedule("actor", queuedInput(preview, "multi-review"));
        assert.equal(result.state, "accepted", result.detail ?? undefined);
        for (const repo of preview.reviewerContext.repositories) {
          const created = f.resources
            .get("created")!
            .workspace.repos.find((item) => item.id === repo.repositoryID)!;
          const actual = yield* identities.resolve(created.path);
          assert.equal(actual.commit, repo.commit);
          assert.notEqual(actual.physicalId, repo.sourcePhysicalId);
        }
        assert.equal(native.creations(), 1);
      }).pipe(Effect.provide(queueLayer(f, native)));
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
  it.live("preserves uncertain native outcomes on one durable attempt key", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const native = f.nativeCreation("unknown_outcome");
      yield* Effect.gen(function* () {
        const managed = yield* ManagedSessionLaunch.ManagedSessionLaunch;
        const queue = yield* ReviewerLaunch.ReviewerLaunch;
        const writer = yield* managed.launch("actor", input("writer"));
        const preview = yield* queue.preview({ threadId: writer.threadId! });
        const request = queuedInput(preview);
        const first = yield* queue.schedule("actor", request);
        assert.equal(first.state, "unknown_outcome");
        assert.equal(
          (yield* queue
            .cancelScheduled("actor", { operationKey: request.operationKey })
            .pipe(Effect.flip)).reason,
          "not_retryable",
        );
        const retry = yield* queue.schedule("actor", request);
        assert.equal(retry.attemptKey, first.attemptKey);
        assert.equal(retry.attempts, 1);
        assert.equal(native.creations(), 1);
      }).pipe(Effect.provide(queueLayer(f, native)));
    }).pipe(Effect.provide(baseLayer), Effect.scoped),
  );
});
