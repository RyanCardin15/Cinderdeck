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
import * as ManagedCheckoutGuard from "./ManagedCheckoutGuard.ts";
import * as ManagedSessionLaunch from "./ManagedSessionLaunch.ts";
import * as Relationships from "./Relationships.ts";

const instanceId = ProviderInstanceId.make("codex-fixture");
const decodeInput = Schema.decodeUnknownSync(Rpc.ManagedLaunchInput);
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
  capabilities: ["checkout.reservations"],
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
  Layer.provide(CheckoutIdentity.layer),
);
const baseLayer = Layer.mergeAll(
  NodeSqliteClient.layer({ filename: ":memory:" }),
  ProcessRunner.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
const fixture = Effect.gen(function* () {
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
  const external = (launch: ThreadLaunchService.ThreadLaunchService["Service"]["launch"]) =>
    Layer.mergeAll(
      hubLayer,
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
  return { root, source, lane, git, fs, resources, external, hubLayer };
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

describe("managed lane session launch", () => {
  it.effect(
    "persists scoped bindings before intake, uses the existing lane, and replays concurrent retries",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const deps = yield* Effect.context<
          SqlClient.SqlClient | FileSystem.FileSystem | ProcessRunner.ProcessRunner
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
