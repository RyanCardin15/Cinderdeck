import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointId,
  CheckpointScopeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Contracts from "@t3tools/contracts/deckhand/integration";
import * as Bindings from "@t3tools/contracts/deckhand";
import * as Schema from "effect/Schema";
import * as Rpc from "@t3tools/contracts/deckhand/rpc";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Option from "effect/Option";
import * as Rollback from "../orchestration-v2/CheckpointRollbackService.ts";
import * as Checkpoints from "../orchestration-v2/CheckpointService.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as CheckoutMutations from "./CheckoutMutations.ts";
import * as WorkspaceBackend from "./WorkspaceBackend.ts";
import * as GitMutationPolicy from "./GitMutationPolicy.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as NativeWriterReservations from "./NativeWriterReservations.ts";
import * as WriterReservations from "./WriterReservations.ts";

const decodeWorkspace = Schema.decodeUnknownEffect(Bindings.WorkspaceBinding);
const decodeCheckout = Schema.decodeUnknownEffect(Bindings.CheckoutBinding);
const encodeWorkspace = Schema.encodeEffect(Schema.fromJsonString(Bindings.WorkspaceBinding));
const encodeCheckout = Schema.encodeEffect(Schema.fromJsonString(Bindings.CheckoutBinding));
const unavailable = () => Effect.fail(new Rpc.DeckhandRpcError({ reason: "unavailable" }));
const testLayer = (hub: Partial<IntegrationHub.IntegrationHub["Service"]> = {}) => {
  const dependencies = Layer.mergeAll(
    CheckoutIdentity.layer,
    WriterReservations.layer,
    NativeWriterReservations.layer,
  ).pipe(
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provideMerge(
      Layer.mock(IntegrationHub.IntegrationHub)({
        checkoutContexts: unavailable,
        refresh: Effect.void,
        overview: () =>
          Effect.succeed({
            state: "unavailable",
            hello: null,
            observedAt: null,
            error: null,
            resources: [],
            activity: [],
            total: 0,
            nextOffset: null,
          }),
        ...hub,
      }),
    ),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
    Layer.provideMerge(NodeServices.layer),
  );
  return GitMutationPolicy.layer.pipe(
    Layer.provideMerge(
      CheckoutMutations.layer.pipe(
        Layer.provideMerge(WorkspaceBackend.layer.pipe(Layer.provideMerge(dependencies))),
      ),
    ),
    Layer.provideMerge(VcsProcess.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "deckhand-mutation-config-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
};
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const identities = yield* CheckoutIdentity.CheckoutIdentity;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-mutation-" });
  const repo = root + "/repo with spaces";
  const git = (cwd: string, args: ReadonlyArray<string>) =>
    runner
      .run({ command: "git", args: ["-C", cwd, ...args] })
      .pipe(Effect.tap((result) => Effect.sync(() => assert.equal(result.code, 0, result.stderr))));
  yield* fs.makeDirectory(repo);
  yield* git(repo, ["init", "-b", "main"]);
  yield* fs.writeFileString(repo + "/tracked.txt", "baseline");
  yield* git(repo, ["add", "."]);
  yield* git(repo, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "baseline",
  ]);
  const identity = yield* identities.resolve(repo);
  return { root, repo, git, identity };
});
const hold = (physicalIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const writers = yield* WriterReservations.WriterReservations;
    const scope = yield* Scope.make();
    yield* writers
      .acquire({ ownerId: "resident", physicalIds })
      .pipe(Effect.provideService(Scope.Scope, scope));
    return scope;
  });
describe("checkout mutations across Git and files", () => {
  it.effect(
    "both real Git drivers refuse a resident alias before effects; status and private capture still work; restore resumes after release",
    () =>
      Effect.gen(function* () {
        const { repo, root, git, identity } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const writers = yield* WriterReservations.WriterReservations;
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        const core = yield* GitVcsDriver.make;
        const alias = root + "/alias";
        yield* fs.symlink(repo, alias);
        const scope = yield* hold([identity.physicalId]);
        yield* fs.writeFileString(repo + "/tracked.txt", "changed");
        yield* fs.writeFileString(repo + "/untracked.txt", "keep until restore");
        const command = { operation: "ownership-test", cwd: alias, args: ["add", "."] };
        const refused = yield* driver.execute(command).pipe(Effect.flip);
        assert.include(refused.message, "active or uncertain writer");
        assert.include(
          (yield* core.execute(command).pipe(Effect.flip)).message,
          "active or uncertain writer",
        );
        assert.equal((yield* git(repo, ["diff", "--cached", "--name-only"])).stdout, "");
        assert.equal(
          (yield* driver.execute({ ...command, args: ["status", "--porcelain"] })).exitCode,
          0,
        );
        const ref = CheckpointRef.make("refs/t3/checkpoints/mutation-test");
        yield* driver.checkpoints.captureCheckpoint({ cwd: repo, checkpointRef: ref });
        assert.equal((yield* git(repo, ["diff", "--cached", "--name-only"])).stdout, "");
        yield* fs.writeFileString(repo + "/tracked.txt", "later");
        yield* fs.writeFileString(repo + "/later.txt", "later");
        assert.include(
          (yield* driver.checkpoints
            .restoreCheckpoint({ cwd: repo, checkpointRef: ref })
            .pipe(Effect.flip)).message,
          "active or uncertain writer",
        );
        assert.equal(yield* fs.readFileString(repo + "/tracked.txt"), "later");
        assert.isTrue(yield* fs.exists(repo + "/later.txt"));
        yield* Scope.close(scope, Exit.void);
        assert.isTrue(
          yield* driver.checkpoints.restoreCheckpoint({ cwd: repo, checkpointRef: ref }),
        );
        assert.equal(yield* fs.readFileString(repo + "/tracked.txt"), "changed");
        assert.equal(yield* fs.readFileString(repo + "/untracked.txt"), "keep until restore");
        assert.isFalse(yield* fs.exists(repo + "/later.txt"));
        assert.deepEqual(yield* writers.inspect, []);
        yield* core.execute({ ...command, args: ["add", "tracked.txt"] });
        assert.equal(
          (yield* git(repo, ["diff", "--cached", "--name-only"])).stdout.trim(),
          "tracked.txt",
        );
      }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "shared ref changes include unbound linked worktrees, while an independent checkout can stage files",
    () =>
      Effect.gen(function* () {
        const { root, repo, git, identity } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const identities = yield* CheckoutIdentity.CheckoutIdentity;
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        const lane = root + "/unbound lane";
        yield* git(repo, ["worktree", "add", "-b", "lane", lane]);
        const linked = yield* identities.resolve(lane);
        const scope = yield* hold([linked.physicalId]);
        assert.notEqual(identity.physicalId, linked.physicalId);
        const command = { operation: "shared-ref-test", cwd: repo, args: ["branch", "new-branch"] };
        assert.include(
          (yield* driver.execute(command).pipe(Effect.flip)).message,
          "active or uncertain writer",
        );
        assert.include(
          (yield* driver
            .execute({
              ...command,
              args: ["--git-dir", identity.commonDirectory, "branch", "new-branch"],
            })
            .pipe(Effect.flip)).message,
          "active or uncertain writer",
        );
        assert.equal((yield* git(repo, ["branch", "--list", "new-branch"])).stdout, "");
        yield* fs.writeFileString(repo + "/tracked.txt", "independent files");
        yield* driver.execute({ ...command, args: ["add", "tracked.txt"] });
        assert.equal(
          (yield* git(repo, ["diff", "--cached", "--name-only"])).stdout.trim(),
          "tracked.txt",
        );
        yield* Scope.close(scope, Exit.void);
        yield* driver.execute(command);
        assert.include((yield* git(repo, ["branch", "--list", "new-branch"])).stdout, "new-branch");
      }).pipe(Effect.provide(testLayer())),
  );

  it.effect(
    "unbound native aliases acquire one attested reservation and release only after process finalizers; native lifecycle stays with its owner",
    () => {
      let physical = "";
      let finalized = false;
      let admissions = 0;
      let releases = 0;
      let acquired: Contracts.IntegrationWriterReservationInput | undefined;
      const reservation = (): Contracts.IntegrationCheckoutReservation => ({
        id: acquired!.id,
        ownerID: acquired!.ownerID,
        workspaceID: acquired!.workspaceID,
        generation: acquired!.generation,
        kind: "writer",
        state: "held",
        physicalIDs: [physical],
        createdAt: "2026-10-03T00:00:00Z",
      });
      const hub = {
        checkoutContexts: () =>
          Effect.succeed({
            installationID: "native",
            runtimeEpoch: "epoch",
            contexts: ["workspace", "alias"].map((workspaceID) => ({
              workspaceID,
              generation: 1,
              revision: "revision",
              available: true,
              repos: ["app"],
              physicalIDs: [physical],
            })),
          }),
        reserveWriter: (_: string, input: Contracts.IntegrationWriterReservationInput) =>
          Effect.sync(() => {
            acquired = input;
            admissions++;
            return reservation();
          }),
        releaseWriter: () =>
          Effect.sync(() => {
            assert.isTrue(finalized);
            releases++;
            return { ...reservation(), state: "released" as const };
          }),
      };
      return Effect.gen(function* () {
        const { repo, identity } = yield* fixture;
        physical = identity.physicalId;
        const service = yield* CheckoutMutations.CheckoutMutations;
        const writers = yield* WriterReservations.WriterReservations;
        yield* service.run(
          { cwd: repo, sharedRefs: false },
          Effect.gen(function* () {
            assert.equal((yield* writers.inspect)[0]?.state, "held");
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized = true;
              }),
            );
          }),
        );
        assert.equal(admissions, 1);
        assert.equal(releases, 1);
        assert.deepEqual(yield* writers.inspect, []);
        const error = yield* service
          .run(
            { cwd: repo, sharedRefs: true, worktreeLifecycle: true },
            Effect.die("must not run lifecycle"),
          )
          .pipe(Effect.flip);
        assert.equal(error.reason, "native_lifecycle");
        assert.equal(admissions, 1);
      }).pipe(Effect.provide(testLayer(hub)));
    },
  );

  it.effect(
    "lost native release preserves both durable uncertain claims and blocks a subsequent mutation",
    () => {
      let physical = "";
      let acquired: Contracts.IntegrationWriterReservationInput | undefined;
      const hub = {
        checkoutContexts: () =>
          Effect.succeed({
            installationID: "native",
            runtimeEpoch: "epoch",
            contexts: [
              {
                workspaceID: "workspace",
                generation: 1,
                revision: "revision",
                available: true,
                repos: ["app"],
                physicalIDs: [physical],
              },
            ],
          }),
        reserveWriter: (_: string, input: Contracts.IntegrationWriterReservationInput) =>
          Effect.sync(() => {
            acquired = input;
            return {
              id: input.id,
              ownerID: input.ownerID,
              workspaceID: input.workspaceID,
              generation: input.generation,
              kind: "writer" as const,
              state: "held" as const,
              physicalIDs: [physical],
              createdAt: "2026-10-03T00:00:00Z",
            };
          }),
        releaseWriter: unavailable,
      };
      return Effect.gen(function* () {
        const { repo, identity } = yield* fixture;
        physical = identity.physicalId;
        const service = yield* CheckoutMutations.CheckoutMutations;
        const writers = yield* WriterReservations.WriterReservations;
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* service.run({ cwd: repo, sharedRefs: false }, Effect.void).pipe(Effect.flip))
            .reason,
          "uncertain",
        );
        assert.equal((yield* writers.inspect)[0]?.state, "uncertain");
        assert.equal(
          (yield* sql<{
            state: string;
          }>`SELECT state FROM deckhand_native_writer_intents WHERE id=${acquired!.id}`)[0]?.state,
          "uncertain",
        );
        assert.equal(
          (yield* service
            .run(
              { cwd: repo, sharedRefs: false },
              Effect.die("must not run with uncertain ownership"),
            )
            .pipe(Effect.flip)).reason,
          "busy",
        );
      }).pipe(Effect.provide(testLayer(hub)));
    },
  );
  it.effect("cancellation stops the actual child before releasing native ownership", () => {
    let physical = "";
    let acquired: Contracts.IntegrationWriterReservationInput | undefined;
    let child: ChildProcessSpawner.ChildProcessHandle | undefined;
    let releases = 0;
    const reservation = (): Contracts.IntegrationCheckoutReservation => ({
      id: acquired!.id,
      ownerID: acquired!.ownerID,
      workspaceID: acquired!.workspaceID,
      generation: acquired!.generation,
      kind: "writer",
      state: "held",
      physicalIDs: [physical],
      createdAt: "2026-10-03T00:00:00Z",
    });
    const hub = {
      checkoutContexts: () =>
        Effect.succeed({
          installationID: "native",
          runtimeEpoch: "epoch",
          contexts: [
            {
              workspaceID: "workspace",
              generation: 1,
              revision: "revision",
              available: true,
              repos: ["app"],
              physicalIDs: [physical],
            },
          ],
        }),
      reserveWriter: (_: string, input: Contracts.IntegrationWriterReservationInput) =>
        Effect.sync(() => {
          acquired = input;
          return reservation();
        }),
      releaseWriter: () =>
        Effect.gen(function* () {
          assert.isFalse(
            yield* child!.isRunning.pipe(
              Effect.mapError(() => new Rpc.DeckhandRpcError({ reason: "unavailable" })),
            ),
          );
          releases++;
          return { ...reservation(), state: "released" as const };
        }),
    };
    return Effect.gen(function* () {
      const { repo, identity } = yield* fixture;
      physical = identity.physicalId;
      const mutations = yield* CheckoutMutations.CheckoutMutations;
      const writers = yield* WriterReservations.WriterReservations;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const started = yield* Deferred.make<void>();
      const running = yield* mutations
        .run(
          { cwd: repo, sharedRefs: false },
          Effect.gen(function* () {
            child = yield* spawner.spawn(ChildProcess.make("/bin/sh", ["-c", "exec sleep 60"]));
            assert.isTrue(yield* child.isRunning);
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.equal((yield* writers.inspect)[0]?.state, "held");
      yield* Fiber.interrupt(running);
      assert.equal(releases, 1);
      assert.isFalse(yield* child!.isRunning);
      assert.deepEqual(yield* writers.inspect, []);
      yield* mutations.run({ cwd: repo, sharedRefs: false }, Effect.void);
      assert.equal(releases, 2);
    }).pipe(Effect.provide(testLayer(hub)));
  });
  it.effect(
    "a failed process finalizer retains native ownership and marks the local owner uncertain",
    () => {
      let physical = "";
      let releases = 0;
      const hub = {
        checkoutContexts: () =>
          Effect.succeed({
            installationID: "native",
            runtimeEpoch: "epoch",
            contexts: [
              {
                workspaceID: "workspace",
                generation: 1,
                revision: "revision",
                available: true,
                repos: ["app"],
                physicalIDs: [physical],
              },
            ],
          }),
        reserveWriter: (_: string, input: Contracts.IntegrationWriterReservationInput) =>
          Effect.succeed({
            id: input.id,
            ownerID: input.ownerID,
            workspaceID: input.workspaceID,
            generation: input.generation,
            kind: "writer" as const,
            state: "held" as const,
            physicalIDs: [physical],
            createdAt: "2026-10-03T00:00:00Z",
          }),
        releaseWriter: () =>
          Effect.sync(() => {
            releases++;
            throw new Error("must not release an unproved stop");
          }),
      };
      return Effect.gen(function* () {
        const { repo, identity } = yield* fixture;
        physical = identity.physicalId;
        const service = yield* CheckoutMutations.CheckoutMutations;
        const writers = yield* WriterReservations.WriterReservations;
        const sql = yield* SqlClient.SqlClient;
        const exit = yield* service
          .run(
            { cwd: repo, sharedRefs: false },
            Effect.addFinalizer(() => Effect.die("fixture process stop failed")),
          )
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        assert.equal(releases, 0);
        assert.equal((yield* writers.inspect)[0]?.state, "uncertain");
        assert.equal(
          (yield* sql<{ state: string }>`SELECT state FROM deckhand_native_writer_intents`)[0]
            ?.state,
          "held",
        );
      }).pipe(Effect.provide(testLayer(hub)));
    },
  );
  it.effect(
    "disconnected cached physical identities protect moved native worktrees and shared refs while unrelated standalone Git remains usable",
    () => {
      let cached: Rpc.IntegrationView = {
        state: "unavailable",
        hello: null,
        observedAt: null,
        error: null,
        resources: [],
        activity: [],
        total: 0,
        nextOffset: null,
      };
      return Effect.gen(function* () {
        const { root, repo, git, identity } = yield* fixture;
        const mutations = yield* CheckoutMutations.CheckoutMutations;
        const identities = yield* CheckoutIdentity.CheckoutIdentity;
        const lane = root + "/native lane";
        const moved = root + "/moved lane";
        yield* git(repo, ["worktree", "add", "-b", "native-lane", lane]);
        const original = yield* identities.resolve(lane);
        cached = {
          ...cached,
          total: 1,
          resources: [
            {
              workspaceID: "native",
              generation: 1,
              available: true,
              revision: "revision",
              workspace: {
                id: "native",
                name: "Native",
                file: "/native.toml",
                state: "stopped",
                definitionChanged: false,
                issues: [],
                services: [],
                repos: [
                  {
                    id: "app",
                    path: lane,
                    branch: "native-lane",
                    dirty: false,
                    changedFiles: 0,
                    ahead: 0,
                    behind: 0,
                    physicalID: original.physicalId,
                    repositoryPhysicalID: identity.repositoryPhysicalId,
                  },
                ],
              },
            },
          ],
        };
        yield* git(repo, ["worktree", "move", lane, moved]);
        assert.equal(
          (yield* mutations
            .run(
              { cwd: moved, sharedRefs: false },
              Effect.die("must not edit an offline native checkout"),
            )
            .pipe(Effect.flip)).reason,
          "unavailable",
        );
        assert.equal(
          (yield* mutations
            .run(
              { cwd: repo, sharedRefs: true },
              Effect.die("must not edit its shared refs while native ownership is unavailable"),
            )
            .pipe(Effect.flip)).reason,
          "unavailable",
        );
        const unrelated = yield* fixture;
        assert.equal(
          yield* mutations.run(
            { cwd: unrelated.repo, sharedRefs: true },
            Effect.succeed("standalone allowed"),
          ),
          "standalone allowed",
        );
      }).pipe(Effect.provide(testLayer({ overview: () => Effect.succeed(cached) })));
    },
  );
  it.effect("a durable native owner with no live definition refuses admission before effects", () =>
    Effect.gen(function* () {
      const { repo } = yield* fixture;
      const mutations = yield* CheckoutMutations.CheckoutMutations;
      const writers = yield* WriterReservations.WriterReservations;
      assert.equal(
        (yield* mutations
          .run({ cwd: repo, sharedRefs: false }, Effect.die("must not run without ownership"))
          .pipe(Effect.flip)).reason,
        "busy",
      );
      assert.deepEqual(yield* writers.inspect, []);
    }).pipe(
      Effect.provide(
        testLayer({
          checkoutContexts: () =>
            Effect.fail(
              new Rpc.DeckhandRpcError({ reason: "peer_rejected", code: "checkout_reserved" }),
            ),
        }),
      ),
    ),
  );
  it.effect(
    "resident ownership refuses coordinated rollback before provider rewind, file restoration or projection writes",
    () =>
      Effect.gen(function* () {
        const { repo, identity } = yield* fixture;
        const scope = yield* hold([identity.physicalId]);
        const threadId = ThreadId.make("rollback-owner");
        const providerThreadId = ProviderThreadId.make("rollback-native-thread");
        const providerSessionId = ProviderSessionId.make("rollback-session");
        const instanceId = ProviderInstanceId.make("rollback-provider");
        const checkpointId = CheckpointId.make("rollback-checkpoint");
        const scopeId = CheckpointScopeId.make("rollback-scope");
        const providerThread = {
          id: providerThreadId,
          providerSessionId,
          providerInstanceId: instanceId,
        };
        const projection = {
          thread: {
            worktreePath: repo,
            activeProviderThreadId: providerThreadId,
            modelSelection: { instanceId, model: "fixture" },
          },
          providerThreads: [providerThread],
          providerSessions: [],
          checkpoints: [{ id: checkpointId, scopeId, status: "ready", appRunOrdinal: null }],
          checkpointScopes: [{ id: scopeId, cwd: repo }],
          runs: [{ id: "run", ordinal: 1, status: "completed", rootNodeId: null }],
          attempts: [],
          nodes: [],
          providerTurns: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const calls: string[] = [];
        const domainLayer = Rollback.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Checkpoints.CheckpointServiceV2)({
                restore: () =>
                  Effect.sync(() => {
                    calls.push("files");
                  }),
              }),
              Layer.mock(Projection.ProjectionStoreV2)({
                getThreadRecords: () => Effect.succeed(projection),
                getThreadProviderContext: () => Effect.succeed({ providerSessions: [] } as never),
                getCheckpointContext: () =>
                  Effect.succeed({
                    checkpointScopes: [{ cwd: repo }],
                    runs: [],
                    checkpoints: [],
                  } as never),
                getShellSnapshot: () =>
                  Effect.succeed({
                    schemaVersion: 1,
                    snapshotSequence: 0,
                    threads: [],
                    archivedThreads: [],
                  }),
              }),
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: () =>
                  Effect.succeed(
                    Option.some({ workspaceRoot: repo + "/missing-project" } as never),
                  ),
              }),
              Layer.mock(Sessions.ProviderSessionManagerV2)({
                open: () =>
                  Effect.succeed({
                    rollbackThread: () =>
                      Effect.sync(() => {
                        calls.push("provider");
                        return { providerThread };
                      }),
                  } as never),
              }),
              Layer.mock(RuntimePolicy.RuntimePolicyV2)({
                resolve: () => Effect.succeed({} as never),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                write: () =>
                  Effect.sync(() => {
                    calls.push("projection");
                    return [];
                  }),
              }),
              IdAllocator.layer,
            ),
          ),
        );
        const blocked = yield* Effect.gen(function* () {
          const domain = yield* Rollback.CheckpointRollbackServiceV2;
          return yield* domain
            .execute({ threadId, providerThreadId, checkpointId, scopeId })
            .pipe(Effect.flip);
        }).pipe(Effect.provide(domainLayer));
        assert.equal(blocked.reason, "checkout-ownership");
        assert.deepEqual(calls, []);
        assert.include(blocked.message, "Neither rollback was applied");
        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(testLayer())),
  );
  it.effect(
    "native ownership survives removed Git metadata; nested paths and aliases cannot initialize it as standalone",
    () => {
      let cached: Rpc.IntegrationView = {
        state: "unavailable",
        hello: null,
        observedAt: null,
        error: null,
        resources: [],
        activity: [],
        total: 0,
        nextOffset: null,
      };
      return Effect.gen(function* () {
        const { root, repo, identity } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        const backend = yield* WorkspaceBackend.WorkspaceBackend;
        const sql = yield* SqlClient.SqlClient;
        cached = {
          ...cached,
          total: 1,
          resources: [
            {
              workspaceID: "native",
              generation: 1,
              revision: "r",
              available: true,
              workspace: {
                id: "native",
                name: "Native",
                file: "/native.toml",
                state: "stopped",
                definitionChanged: false,
                issues: [],
                services: [],
                repos: [
                  {
                    id: "app",
                    path: repo,
                    branch: "main",
                    dirty: false,
                    changedFiles: 0,
                    ahead: 0,
                    behind: 0,
                  },
                ],
              },
            },
          ],
        };
        yield* fs.remove(repo + "/.git", { recursive: true });
        const nested = repo + "/child";
        const alias = root + "/alias";
        yield* fs.makeDirectory(nested);
        yield* fs.symlink(nested, alias);
        for (const cwd of [repo, nested, alias]) {
          const result = yield* driver
            .execute({ operation: "initialize", cwd, args: ["init"] })
            .pipe(Effect.flip);
          assert.include(result.message, "ownership could not be verified");
          assert.isFalse(yield* fs.exists(cwd + "/.git"));
        }
        assert.equal(yield* fs.readFileString(repo + "/tracked.txt"), "baseline");
        cached = { ...cached, total: 0, resources: [] };
        const binding = yield* decodeCheckout({
          id: "saved-native",
          workspaceId: "workspace",
          workspaceGeneration: 1,
          nativeGeneration: 1,
          environmentId: "native",
          backend: "cinderdeck",
          kind: "primary",
          laneId: null,
          state: "ready",
          repositories: [identity],
          revision: 1,
        });
        const workspace = yield* decodeWorkspace({
          id: "workspace",
          environmentId: "native",
          backend: "cinderdeck",
          ownerId: "native",
          generation: 1,
          revision: 1,
          name: "Native",
          state: "active",
        });
        yield* sql`INSERT INTO deckhand_workspaces(id, environment_id, backend, owner_id, generation, revision, record_json)
        VALUES ('workspace', 'native', 'cinderdeck', 'native', 1, 1, ${yield* encodeWorkspace(workspace)})`;
        yield* sql`INSERT INTO deckhand_checkouts(id, workspace_id, revision, record_json) VALUES ('saved-native', 'workspace', 1, ${yield* encodeCheckout(binding)})`;
        assert.equal(
          (yield* backend.inspect({ cwd: alias, sharedRefs: true }).pipe(Effect.flip)).reason,
          "unavailable",
        );
        // A string-prefix neighbour is unrelated; ordinary standalone initialization stays available.
        const neighbour = repo + "-other";
        yield* fs.makeDirectory(neighbour);
        yield* driver.execute({
          operation: "initialize",
          cwd: neighbour,
          args: ["init", "-b", "main"],
        });
        assert.isTrue(yield* fs.exists(neighbour + "/.git"));
      }).pipe(Effect.provide(testLayer({ overview: () => Effect.succeed(cached) })));
    },
  );
  it.effect(
    "backend selection refuses an implicit transfer of a saved standalone checkout into native ownership",
    () => {
      let contexts: ReadonlyArray<Contracts.IntegrationCheckoutContext> = [];
      return Effect.gen(function* () {
        const { repo, root, git, identity } = yield* fixture;
        const backend = yield* WorkspaceBackend.WorkspaceBackend;
        const identities = yield* CheckoutIdentity.CheckoutIdentity;
        const sql = yield* SqlClient.SqlClient;
        assert.equal(
          (yield* backend.inspect({ cwd: repo, sharedRefs: false }))?.backend,
          "standalone",
        );
        contexts = [
          {
            workspaceID: "native",
            generation: 1,
            revision: "r",
            available: true,
            repos: ["app"],
            physicalIDs: [identity.physicalId],
          },
        ];
        assert.equal(
          (yield* backend.inspect({ cwd: repo, sharedRefs: false }))?.backend,
          "cinderdeck",
        );
        const workspace = yield* decodeWorkspace({
          id: "workspace",
          environmentId: "standalone",
          backend: "standalone",
          ownerId: "project",
          generation: 1,
          revision: 1,
          name: "Standalone",
          state: "active",
        });
        const binding = yield* decodeCheckout({
          id: "checkout",
          workspaceId: "workspace",
          workspaceGeneration: 1,
          environmentId: "standalone",
          backend: "standalone",
          kind: "primary",
          laneId: null,
          state: "ready",
          repositories: [identity],
          revision: 1,
        });
        yield* sql`INSERT INTO deckhand_workspaces(id, environment_id, backend, owner_id, generation, revision, record_json)
        VALUES ('workspace', 'standalone', 'standalone', 'project', 1, 1, ${yield* encodeWorkspace(workspace)})`;
        yield* sql`INSERT INTO deckhand_checkouts(id, workspace_id, revision, record_json) VALUES ('checkout', 'workspace', 1, ${yield* encodeCheckout(binding)})`;
        assert.equal(
          (yield* backend.inspect({ cwd: repo, sharedRefs: false }).pipe(Effect.flip)).reason,
          "stale_binding",
        );
        const mutation = yield* CheckoutMutations.CheckoutMutations;
        assert.equal(
          (yield* mutation
            .run(
              { cwd: repo, sharedRefs: false },
              Effect.die("must not mutate before explicit adoption"),
            )
            .pipe(Effect.flip)).reason,
          "stale_binding",
        );
        // Shared refs can span separately owned worktrees without transferring the
        // current standalone checkout's ownership to its native neighbour.
        const neighbour = root + "/native neighbour";
        yield* git(repo, ["worktree", "add", "-b", "native-neighbour", neighbour]);
        const linked = yield* identities.resolve(neighbour);
        contexts = [{ ...contexts[0]!, physicalIDs: [linked.physicalId] }];
        const shared = yield* backend.inspect({ cwd: repo, sharedRefs: true });
        assert.equal(shared?.backend, "standalone");
        assert.include(shared!.physicalIDs, linked.physicalId);
        assert.equal(shared?.contexts[0]?.physicalIDs[0], linked.physicalId);
      }).pipe(
        Effect.provide(
          testLayer({
            checkoutContexts: () =>
              Effect.succeed({ installationID: "native", runtimeEpoch: "epoch", contexts }),
          }),
        ),
      );
    },
  );
  it.effect(
    "delegates every connected lifecycle intent with unchanged actor, generation and operation identity",
    () => {
      const seen: Array<{
        actorID: string;
        method: string;
        generation: number;
        operationKey: string;
      }> = [];
      return Effect.gen(function* () {
        const backend = yield* WorkspaceBackend.WorkspaceBackend;
        const input = {
          operationKey: "durable-lifecycle",
          installationID: "native",
          workspaceID: "lane",
          generation: 7,
          revision: "selected-revision",
          arguments: { workspace: "lane" },
        };
        for (const [entry, method] of [
          ["createLane", "lane.create"],
          ["adoptLane", "lane.adopt"],
          ["setupLane", "lane.setup"],
          ["releaseLane", "lane.release"],
          ["removeLane", "lane.remove"],
        ] as const) {
          const receipt = yield* backend[entry]("authenticated-actor", input);
          assert.equal(receipt.method, method);
          assert.equal(
            receipt.state,
            "failed",
            "Backend must preserve the owner's actual refused outcome",
          );
        }
        yield* backend.submit("authenticated-actor", { ...input, method: "lane.remove" });
        assert.deepEqual(
          seen.map((row) => row.method),
          ["lane.create", "lane.adopt", "lane.setup", "lane.release", "lane.remove", "lane.remove"],
        );
        assert.ok(
          seen.every(
            (row) =>
              row.actorID === "authenticated-actor" &&
              row.generation === 7 &&
              row.operationKey === "durable-lifecycle",
          ),
        );
      }).pipe(
        Effect.provide(
          testLayer({
            submit: (actorID, input) => {
              seen.push({
                actorID,
                method: input.method,
                generation: input.generation,
                operationKey: input.operationKey,
              });
              return Effect.succeed({
                id: "native-refusal",
                operationKey: input.operationKey,
                argumentHash: "a".repeat(64),
                workspaceID: input.workspaceID,
                generation: input.generation,
                method: input.method,
                state: "failed",
                createdAt: "2026-10-03T00:00:00Z",
                updatedAt: "2026-10-03T00:00:01Z",
                error: { code: "checkout_reserved", message: "Held writer" },
              });
            },
          }),
        ),
      );
    },
  );
});
