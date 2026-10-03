// @effect-diagnostics nodeBuiltinImport:off - construct an adversarial derived launch-key collision.
import * as NodeCrypto from "node:crypto";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Project,
  ServerProvider,
} from "@t3tools/contracts";
import * as Contracts from "@t3tools/contracts/deckhand";
import * as Rpc from "@t3tools/contracts/deckhand/rpc";
import * as Integration from "@t3tools/contracts/deckhand/integration";
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
import * as WriterReservations from "./WriterReservations.ts";
import * as NativeWriterReservations from "./NativeWriterReservations.ts";
import * as WorkspaceBackend from "./WorkspaceBackend.ts";
import * as ManagedCheckoutGuard from "./ManagedCheckoutGuard.ts";
import * as ManagedSessionLaunch from "./ManagedSessionLaunch.ts";
import * as Relationships from "./Relationships.ts";

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
    "checkout.reservations",
    "operations.lane.create.repositoryRefs",
    "operations.receipts.wait",
    "operations.lane.create.managedWriter",
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
  Layer.provide(Relationships.layer),
  Layer.provide(
    WorkspaceBackend.layer.pipe(
      Layer.provide(CheckoutIdentity.layer),
      Layer.provide(WriterReservations.layer),
      Layer.provide(NativeWriterReservations.layer),
    ),
  ),
  Layer.provide(CheckoutIdentity.layer),
);
const baseLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  ProcessRunner.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
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
    mode: "ready" | "native_shape" | "setup_failed" | "pending" | "unknown_outcome" = "ready",
  ) => {
    const receipts = new Map<string, Integration.IntegrationOperationReceipt>();
    let creations = 0;
    const created = `${root}/created`;
    const hub = Layer.mock(IntegrationHub.IntegrationHub)({
      resource: (id) => {
        const item = resources.get(id);
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
          assert.equal(
            (yield* decodeCreationInput(intents[0]!.input_json)).objective,
            input().objective,
          );
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
          assert.equal(feature.workspaceId, intended!.workspaceBindingId);
          assert.deepEqual(intended!.repositoryIDs, ["frontend"]);
          assert.equal(
            (yield* sql`SELECT checkout_id FROM deckhand_feature_checkouts WHERE feature_id = ${intended!.featureId}`)
              .length,
            0,
            "a planned target is not a confirmed physical checkout",
          );
          assert.equal(
            (yield* sql`SELECT id FROM deckhand_sessions WHERE feature_id = ${intended!.featureId}`)
              .length,
            0,
          );
          yield* git(source, [
            "worktree",
            "add",
            "-b",
            String(request.arguments.branch),
            created,
            String((request.arguments.repositoryRefs as Record<string, string>).frontend),
          ]);
          creations++;
          const resource = structuredClone(resources.get("lane")!);
          resource.workspaceID = "created";
          resource.workspace.id = "created";
          resource.workspace.lane!.directory = created;
          resource.workspace.repos[0]!.path = created;
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
              ...(mode === "unknown_outcome" ? {} : { createdWorkspaceID: "created" }),
              ...(mode === "native_shape"
                ? { workspace: resource.workspace }
                : { creationReady: mode === "ready" }),
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
  it.effect.each(["ready", "native_shape"] as const)(
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

  it.effect.each(["setup_failed", "unknown_outcome"] as const)(
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

  it.effect(
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
              .create("actor", { ...creationInput(), revision: "old" })
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

  it.effect(
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

  it.effect(
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

  it.effect(
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

  it.effect(
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
        yield* sql`DELETE FROM deckhand_schema WHERE version = 8`;
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

  it.effect("reserves the feature in an existing canonical workspace binding", () =>
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

  it.effect(
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

  it.effect(
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

describe("managed lane session launch", () => {
  it.effect(
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
            assert.equal(context?.native?.workspaceID, "lane");
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

  it.effect(
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

  it.effect("retains the feature and same thread across intake failure and service restart", () =>
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

  it.effect(
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

  it.effect(
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
