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
} from "@cinderdeck/contracts";
import * as Contracts from "@cinderdeck/contracts/deckhand/integration";
import * as Bindings from "@cinderdeck/contracts/deckhand";
import * as Schema from "effect/Schema";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
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

const decodeWorkspace = Schema.decodeUnknownEffect(Bindings.WorkspaceBinding);
const decodeCheckout = Schema.decodeUnknownEffect(Bindings.CheckoutBinding);
const encodeWorkspace = Schema.encodeEffect(Schema.fromJsonString(Bindings.WorkspaceBinding));
const encodeCheckout = Schema.encodeEffect(Schema.fromJsonString(Bindings.CheckoutBinding));
const unavailable = () => Effect.fail(new Rpc.DeckhandRpcError({ reason: "unavailable" }));
const testLayer = (hub: Partial<IntegrationHub.IntegrationHub["Service"]> = {}) => {
  const dependencies = Layer.mergeAll(CheckoutIdentity.layer).pipe(
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
const saveNativeCheckout = Effect.fn(function* (
  id: string,
  repositories: ReadonlyArray<Bindings.PhysicalCheckout>,
  kind: "primary" | "lane",
) {
  const sql = yield* SqlClient.SqlClient;
  const workspace = yield* decodeWorkspace({
    id: "workspace-" + id,
    environmentId: "native",
    backend: "cinderdeck",
    ownerId: "owner-" + id,
    generation: 1,
    revision: 1,
    name: id,
    state: "active",
  });
  const binding = yield* decodeCheckout({
    id,
    workspaceId: workspace.id,
    workspaceGeneration: 1,
    nativeGeneration: 1,
    environmentId: "native",
    backend: "cinderdeck",
    kind,
    laneId: kind === "lane" ? id : null,
    state: "ready",
    repositories,
    revision: 1,
  });
  yield* sql`INSERT INTO deckhand_workspaces(id, environment_id, backend, owner_id, generation, revision, record_json)
    VALUES (${workspace.id}, 'native', 'cinderdeck', ${workspace.ownerId}, 1, 1, ${yield* encodeWorkspace(workspace)})`;
  yield* sql`INSERT INTO deckhand_checkouts(id, workspace_id, revision, record_json)
    VALUES (${id}, ${workspace.id}, 1, ${yield* encodeCheckout(binding)})`;
});
describe("checkout mutations across Git and files", () => {
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
    "switches a real branch after a settings generation changes, but rejects a replaced native checkout",
    () => {
      let contexts: ReadonlyArray<Contracts.IntegrationCheckoutContext> = [];
      return Effect.gen(function* () {
        const { repo, git, identity } = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        const workspace = yield* decodeWorkspace({
          id: "workspace",
          environmentId: "native",
          backend: "cinderdeck",
          ownerId: "native-workspace",
          generation: 1,
          revision: 1,
          name: "Native",
          state: "active",
        });
        const binding = yield* decodeCheckout({
          id: "checkout",
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
        yield* sql`INSERT INTO deckhand_workspaces(id, environment_id, backend, owner_id, generation, revision, record_json)
        VALUES ('workspace', 'native', 'cinderdeck', 'native-workspace', 1, 1, ${yield* encodeWorkspace(workspace)})`;
        yield* sql`INSERT INTO deckhand_checkouts(id, workspace_id, revision, record_json)
        VALUES ('checkout', 'workspace', 1, ${yield* encodeCheckout(binding)})`;
        contexts = [
          {
            workspaceID: "native-workspace",
            generation: 2,
            revision: "new-settings",
            available: true,
            repos: ["app"],
            physicalIDs: [identity.physicalId],
          },
        ];
        yield* git(repo, ["branch", "feature/settings-reload"]);
        yield* driver.execute({
          operation: "GitVcsDriver.switchRef.checkout",
          cwd: repo,
          args: ["checkout", "feature/settings-reload", "--"],
        });
        assert.equal(
          (yield* git(repo, ["branch", "--show-current"])).stdout.trim(),
          "feature/settings-reload",
        );
        // The same workspace name/generation is insufficient when its checkout changed.
        contexts = [{ ...contexts[0]!, physicalIDs: ["different-physical-checkout"] }];
        const result = yield* driver
          .execute({
            operation: "GitVcsDriver.switchRef.checkout",
            cwd: repo,
            args: ["checkout", "main", "--"],
          })
          .pipe(Effect.flip);
        assert.include(result.message, "saved workspace no longer matches");
        assert.equal(
          (yield* git(repo, ["branch", "--show-current"])).stdout.trim(),
          "feature/settings-reload",
        );
      }).pipe(
        Effect.provide(
          testLayer({
            checkoutContexts: () =>
              Effect.succeed({
                installationID: "native",
                runtimeEpoch: "epoch",
                contexts,
              }),
          }),
        ),
      );
    },
  );

  it.effect(
    "switches branches past a forgotten saved lane while protecting registered, damaged and replaced checkouts",
    () => {
      let contexts: ReadonlyArray<Contracts.IntegrationCheckoutContext> = [];
      return Effect.gen(function* () {
        const { root, repo, git, identity } = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const identities = yield* CheckoutIdentity.CheckoutIdentity;
        const sql = yield* SqlClient.SqlClient;
        const backend = yield* WorkspaceBackend.WorkspaceBackend;
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        const lane = root + "/old lane";
        yield* git(repo, ["worktree", "add", "-b", "old-lane", lane]);
        const linked = yield* identities.resolve(lane);
        yield* saveNativeCheckout("primary", [identity], "primary");
        yield* saveNativeCheckout("old-lane", [linked], "lane");
        contexts = [
          {
            workspaceID: "owner-primary",
            generation: 2,
            revision: "live",
            available: true,
            repos: ["app"],
            physicalIDs: [identity.physicalId],
          },
        ];
        yield* git(repo, ["branch", "feature/forgotten-lane"]);
        yield* fs.remove(lane, { recursive: true });
        // Missing files are insufficient: Git still owns the lane registration.
        assert.equal(
          (yield* backend.inspect({ cwd: repo, sharedRefs: true }).pipe(Effect.flip)).reason,
          "stale_binding",
        );
        yield* sql`INSERT INTO deckhand_ownership_transitions(id, actor_id, physical_id, original_json, record_json)
          VALUES ('move', 'actor', ${linked.physicalId}, '{}', '{"state":"pending"}')`;
        assert.equal(
          (yield* backend.inspect({ cwd: repo, sharedRefs: true }).pipe(Effect.flip)).reason,
          "uncertain",
        );
        yield* sql`UPDATE deckhand_ownership_transitions SET record_json='{"state":"completed"}' WHERE id='move'`;
        yield* git(repo, ["worktree", "prune", "--expire", "now"]);
        yield* driver.execute({
          operation: "GitVcsDriver.switchRef.checkout",
          cwd: repo,
          args: ["checkout", "feature/forgotten-lane", "--"],
        });
        assert.equal(
          (yield* git(repo, ["branch", "--show-current"])).stdout.trim(),
          "feature/forgotten-lane",
        );
        const inspected = yield* backend.inspect({ cwd: repo, sharedRefs: true });
        assert.deepEqual(inspected?.physicalIDs, [identity.physicalId]);
        assert.equal(inspected?.backend, "cinderdeck");
        const saved = yield* sql`SELECT id FROM deckhand_current_checkouts WHERE id='old-lane'`;
        assert.equal(saved.length, 1, "historical lane bindings remain saved");

        yield* fs.makeDirectory(lane);
        yield* fs.writeFileString(lane + "/.git", "damaged");
        assert.equal(
          (yield* backend.inspect({ cwd: repo, sharedRefs: true }).pipe(Effect.flip)).reason,
          "stale_binding",
        );
        yield* fs.remove(lane, { recursive: true });
        const replacement = yield* fixture;
        yield* fs.rename(replacement.repo, lane);
        const result = yield* driver
          .execute({
            operation: "GitVcsDriver.switchRef.checkout",
            cwd: repo,
            args: ["checkout", "main", "--"],
          })
          .pipe(Effect.flip);
        assert.include(result.message, "saved workspace no longer matches");
        assert.equal(
          (yield* git(repo, ["branch", "--show-current"])).stdout.trim(),
          "feature/forgotten-lane",
        );
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
    "keeps native ownership checks for the remaining repository in a partially forgotten lane",
    () => {
      let contexts: ReadonlyArray<Contracts.IntegrationCheckoutContext> = [];
      return Effect.gen(function* () {
        const { root, repo, git, identity } = yield* fixture;
        const identities = yield* CheckoutIdentity.CheckoutIdentity;
        const backend = yield* WorkspaceBackend.WorkspaceBackend;
        const removed = root + "/removed";
        const remaining = root + "/remaining";
        yield* git(repo, ["worktree", "add", "-b", "removed", removed]);
        yield* git(repo, ["worktree", "add", "-b", "remaining", remaining]);
        const removedIdentity = yield* identities.resolve(removed);
        const remainingIdentity = yield* identities.resolve(remaining);
        yield* saveNativeCheckout("partial-lane", [removedIdentity, remainingIdentity], "lane");
        yield* git(repo, ["worktree", "remove", removed]);
        contexts = [
          {
            workspaceID: "partial-lane",
            generation: 2,
            revision: "live",
            available: true,
            repos: ["remaining"],
            physicalIDs: [remainingIdentity.physicalId],
          },
        ];
        const inspected = yield* backend.inspect({ cwd: repo, sharedRefs: true });
        assert.sameMembers([...inspected!.physicalIDs], [
          identity.physicalId,
          remainingIdentity.physicalId,
        ]);
        assert.equal(inspected?.backend, "standalone");
        contexts = [];
        assert.equal(
          (yield* backend.inspect({ cwd: repo, sharedRefs: true }).pipe(Effect.flip)).reason,
          "stale_binding",
        );
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
    "refreshes a transient connection before mutation and never replays a failed mutation",
    () => {
      let refreshed = false;
      let mutationRuns = 0;
      let refreshes = 0;
      return Effect.gen(function* () {
        const { repo } = yield* fixture;
        const backend = yield* WorkspaceBackend.WorkspaceBackend;
        const effect = Effect.sync(() => {
          mutationRuns++;
        }).pipe(Effect.andThen(Effect.fail("git failed")));
        const result = yield* backend
          .withCheckout({ cwd: repo, sharedRefs: true }, effect)
          .pipe(Effect.flip);
        assert.equal(result, "git failed");
        assert.equal(mutationRuns, 1);
        assert.equal(refreshes, 1);
      }).pipe(
        Effect.provide(
          testLayer({
            checkoutContexts: () =>
              refreshed
                ? Effect.succeed({ installationID: "native", runtimeEpoch: "epoch", contexts: [] })
                : Effect.fail(new Rpc.DeckhandRpcError({ reason: "invalid_response" })),
            refresh: Effect.sync(() => {
              refreshed = true;
              refreshes++;
            }),
          }),
        ),
      );
    },
  );

  it.effect(
    "pending ownership in a sibling worktree blocks shared refs until that operation finishes",
    () =>
      Effect.gen(function* () {
        const { root, repo, git } = yield* fixture;
        const sql = yield* SqlClient.SqlClient;
        const identities = yield* CheckoutIdentity.CheckoutIdentity;
        const driver = yield* GitVcsDriver.makeVcsDriverShape();
        const lane = root + "/pending lane";
        yield* git(repo, ["worktree", "add", "-b", "pending-lane", lane]);
        yield* git(repo, ["branch", "other"]);
        const linked = yield* identities.resolve(lane);
        yield* sql`INSERT INTO deckhand_ownership_transitions(id, actor_id, physical_id, original_json, record_json)
        VALUES ('move', 'actor', ${linked.physicalId}, '{}', '{"state":"pending"}')`;
        const result = yield* driver
          .execute({ operation: "switch", cwd: repo, args: ["checkout", "other", "--"] })
          .pipe(Effect.flip);
        assert.include(result.message, "still pending");
        assert.equal((yield* git(repo, ["branch", "--show-current"])).stdout.trim(), "main");
        yield* sql`UPDATE deckhand_ownership_transitions SET record_json='{"state":"completed"}' WHERE id='move'`;
        yield* driver.execute({
          operation: "switch",
          cwd: repo,
          args: ["checkout", "other", "--"],
        });
        assert.equal((yield* git(repo, ["branch", "--show-current"])).stdout.trim(), "other");
      }).pipe(Effect.provide(testLayer())),
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
  it.effect("two agents can mutate an aliased checkout while another operation is active", () =>
    Effect.gen(function* () {
      const { root, repo, git } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const alias = root + "/alias";
      yield* fs.symlink(repo, alias);
      const service = yield* CheckoutMutations.CheckoutMutations;
      const entered = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const first = yield* service
        .run(
          { cwd: repo, sharedRefs: false },
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* service.run(
        { cwd: alias, sharedRefs: true },
        git(repo, ["branch", "concurrent-agent"]),
      );
      assert.include(
        (yield* git(repo, ["branch", "--list", "concurrent-agent"])).stdout,
        "concurrent-agent",
      );
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(first);
    }).pipe(Effect.provide(testLayer())),
  );
});
