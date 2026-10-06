import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@cinderdeck/contracts";
import * as C from "@cinderdeck/contracts/deckhand";
import * as I from "@cinderdeck/contracts/deckhand/integration";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ProcessRunner from "../processRunner.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Relationships from "./Relationships.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as Transfer from "./ManagedCheckoutTransfer.ts";
import * as Handoff from "./ManagedWorktreeHandoff.ts";
import * as Backend from "./WorkspaceBackend.ts";
import * as Migrations from "./Migrations.ts";

const threadId = ThreadId.make("thread");
const scope: McpInvocationScope = {
  threadId,
  environmentId: EnvironmentId.make("server"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "provider",
  issuedAt: 1,
  capabilities: new Set(["worktree"]),
};
const currentLayer = CurrentCheckout.layer.pipe(Layer.provideMerge(Relationships.layer));
const base = Layer.mergeAll(
  currentLayer,
  CheckoutIdentity.layer.pipe(Layer.provide(ProcessRunner.layer)),
).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  Layer.provideMerge(ProcessRunner.layer),
  Layer.provideMerge(NodeServices.layer),
);
type NativeContext = Effect.Success<ReturnType<Backend.WorkspaceBackend["Service"]["context"]>>;

const encodeOwnershipState = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Struct({ state: Schema.String })),
);
const fixture = (
  options: {
    readOnly?: boolean;
    failCommit?: boolean;
    pending?: boolean;
    legacyHost?: boolean;
    generation?: number;
    sourceFailures?: number;
    targetFailures?: number;
    reviewed?: boolean;
    sourceTransform?: (context: NativeContext) => NativeContext;
  } = {},
) =>
  Effect.gen(function* () {
    yield* Migrations.migrate;
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner.ProcessRunner;
    const identities = yield* CheckoutIdentity.CheckoutIdentity;
    const relationships = yield* Relationships.Relationships;
    const current = yield* CurrentCheckout.CurrentCheckout;
    const sql = yield* SqlClient.SqlClient;
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "cinderdeck-chat-lane-" });
    const root = `${temp}/primary`;
    const lanePath = `${temp}/lane`;
    const git = (args: string[]) => runner.run({ command: "git", args: ["-C", root, ...args] });
    yield* fs.makeDirectory(root);
    yield* git(["init", "-b", "main"]);
    yield* git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    const source = yield* identities.resolve(root);
    const workspace = yield* Schema.decodeUnknownEffect(C.WorkspaceBinding)({
      id: "workspace",
      environmentId: "installation",
      backend: "cinderdeck",
      ownerId: "primary",
      generation: 1,
      revision: 1,
      name: "Fixture",
      state: "active",
    });
    const checkout = yield* Schema.decodeUnknownEffect(C.CheckoutBinding)({
      id: "primary",
      workspaceId: workspace.id,
      environmentId: workspace.environmentId,
      backend: "cinderdeck",
      workspaceGeneration: 1,
      nativeGeneration: 1,
      revision: 1,
      kind: "primary",
      laneId: null,
      state: "ready",
      repositories: [source],
    });
    yield* relationships.putWorkspace(workspace, null);
    yield* relationships.putCheckout(checkout, null);
    yield* relationships.putFeature(
      yield* Schema.decodeUnknownEffect(C.Feature)({
        id: "feature",
        workspaceId: workspace.id,
        title: "Task",
        objective: "Move task",
        status: "active",
        revision: 1,
        createdAt: "now",
        updatedAt: "now",
      }),
      null,
    );
    yield* relationships.linkCheckout("feature", "primary", true);
    const session = yield* Schema.decodeUnknownEffect(C.SessionBinding)({
      id: "session",
      threadId,
      providerSessionId: "provider",
      providerInstanceId: scope.providerInstanceId,
      featureId: "feature",
      checkoutId: "primary",
      repositoryScope: [source.physicalId],
      role: options.readOnly ? "observer" : "writer",
      desiredAccess: options.readOnly ? "read_only" : "write",
      execution: "working",
      connection: "connected",
      lastSequence: 0,
      capabilities: {
        managed: true,
        enforcedReadOnly: !!options.readOnly,
        nativeResume: true,
        interrupt: true,
        steering: true,
        approvals: true,
        questions: true,
        imageInput: false,
        videoInput: false,
      },
    });
    yield* relationships.putSession(session, null);
    yield* relationships.putSession(
      { ...session, id: C.SessionBindingId.make("sibling"), threadId: ThreadId.make("sibling") },
      null,
    );
    yield* sql`CREATE TABLE fixture_thread (path TEXT)`;
    yield* sql`INSERT INTO fixture_thread(path) VALUES(${source.root})`;
    let thread = {
      id: threadId,
      projectId: ProjectId.make("project"),
      worktreePath: source.root,
      branch: "main",
      archivedAt: null,
      deletedAt: null,
    };
    let created = 0;
    let adopted = 0;
    let continuationPath: string | null = null;
    let failCommit = options.failCommit ?? false;
    let generation = options.generation ?? 1;
    let sourceReads = 0;
    let targetReads = 0;
    let submittedGeneration: number | undefined;
    let submittedRefs: unknown;
    const hello = yield* Schema.decodeUnknownEffect(I.IntegrationHello)({
      protocolVersion: 1,
      installationID: "installation",
      executionHostID: "host",
      channel: "development",
      runtimeEpoch: "epoch",
      maximumFrameBytes: 10000,
      maximumPageSize: 100,
      maximumWaitMs: 25000,
      capabilities: [
        "operations.lane.create.repositoryRefs",
        "operations.receipts.wait",
        ...(options.legacyHost ? [] : ["linked-work.lane-transfer"]),
      ],
    });
    const resource = (lane: boolean) =>
      Effect.gen(function* () {
        const repo = lane ? yield* identities.resolve(lanePath) : source;
        return {
          hello,
          resource: {
            workspaceID: lane ? "lane" : "primary",
            generation,
            revision: "revision",
            available: true,
            workspace: {
              id: lane ? "lane" : "primary",
              name: lane ? "feature/task" : "Fixture",
              file: `${temp}/workspace.json`,
              state: "stopped",
              definitionChanged: false,
              issues: [],
              services: [],
              ...(lane
                ? {
                    lane: {
                      sourceStackID: "primary",
                      name: options.reviewed ? "Reviewed handoff lane" : "feature/task",
                      directory: lanePath,
                      adopted: false,
                      createdAt: "now",
                      ports: {},
                    },
                  }
                : {}),
              repos: [
                {
                  id: "repo",
                  path: repo.root,
                  physicalID: repo.physicalId,
                  repositoryPhysicalID: repo.repositoryPhysicalId,
                  branch: repo.branch!,
                  dirty: false,
                  changedFiles: 0,
                  ahead: 0,
                  behind: 0,
                },
              ],
            },
          },
        };
      }).pipe(Effect.orDie);
    let receipt: I.IntegrationOperationReceipt;
    const native = Layer.mock(Backend.WorkspaceBackend)({
      context: (name) =>
        Effect.gen(function* () {
          const lane = name === "lane";
          const read = lane ? ++targetReads : ++sourceReads;
          if (read <= (lane ? (options.targetFailures ?? 0) : (options.sourceFailures ?? 0)))
            return yield* new Rpc.DeckhandRpcError({ reason: "unavailable" });
          const result = yield* resource(lane);
          return !lane && options.sourceTransform ? options.sourceTransform(result) : result;
        }),
      createLane: (_actor, input) =>
        Effect.gen(function* () {
          created++;
          submittedGeneration = input.generation;
          submittedRefs = input.arguments.repositoryRefs;
          yield* git([
            "worktree",
            "add",
            "-b",
            options.reviewed ? "codex/reviewed-handoff" : "feature/task",
            lanePath,
            String(
              (input.arguments.repositoryRefs as Record<string, string> | undefined)?.repo ??
                "HEAD",
            ),
          ]);
          receipt = yield* Schema.decodeUnknownEffect(I.IntegrationOperationReceipt)({
            id: "receipt",
            operationKey: input.operationKey,
            argumentHash: "a".repeat(64),
            workspaceID: "primary",
            generation: 1,
            method: "lane.create",
            state: options.pending ? "running" : "succeeded",
            createdAt: "now",
            updatedAt: "now",
            result: {
              ...(options.reviewed
                ? { creationReviewed: true, createdBranch: "codex/reviewed-handoff" }
                : {}),
              createdWorkspaceID: "lane",
              workspace: (yield* resource(true)).resource.workspace,
              creationReady: true,
            },
          });
          yield* sql`INSERT INTO deckhand_operations(operation_key,environment_id,actor_id,argument_hash,resource_generation,state,record_json) VALUES(${input.operationKey},'installation',${_actor},'hash',1,'pending','{}')`;
          return receipt;
        }).pipe(Effect.orDie),
      adoptLane: (_actor, input) =>
        Effect.gen(function* () {
          adopted++;
          submittedGeneration = input.generation;
          return yield* Schema.decodeUnknownEffect(I.IntegrationOperationReceipt)({
            id: "adopt",
            operationKey: input.operationKey,
            argumentHash: "b".repeat(64),
            workspaceID: "primary",
            generation: 1,
            method: "lane.adopt",
            state: "succeeded",
            createdAt: "now",
            updatedAt: "now",
            result: {
              createdWorkspaceID: "lane",
              workspace: (yield* resource(true)).resource.workspace,
            },
          });
        }).pipe(Effect.orDie),
      operation: () => Effect.succeed(receipt),
    });
    const dependencies = yield* Effect.context<
      | Relationships.Relationships
      | CurrentCheckout.CurrentCheckout
      | SqlClient.SqlClient
      | CheckoutIdentity.CheckoutIdentity
    >();
    const transfers = Transfer.layer.pipe(Layer.provide(Layer.succeedContext(dependencies)));
    const threads = Layer.unwrap(
      Effect.gen(function* () {
        const transfer = yield* Transfer.ManagedCheckoutTransfer;
        return Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed({ thread } as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.gen(function* () {
              assert.equal(command.type, "thread.metadata.update");
              if (command.type !== "thread.metadata.update")
                return yield* Effect.die("unexpected command");
              const next = {
                ...thread,
                branch: command.branch!,
                worktreePath: command.worktreePath!,
              };
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* transfer.apply({
                    commandId: command.commandId,
                    event: { type: "thread.metadata-updated", threadId, payload: next },
                  } as OrchestrationV2StoredEvent);
                  yield* sql`UPDATE fixture_thread SET path=${next.worktreePath}`;
                  if (failCommit)
                    return yield* new Transfer.CheckoutTransferError({
                      message: "injected commit failure",
                    });
                }),
              );
              thread = next;
              yield* transfer.notify;
              return { sequence: 1, storedEvents: [] };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            ),
          sendToThread: () =>
            Effect.gen(function* () {
              continuationPath = (yield* current.forThread(threadId))!.checkout.repositories[0]!
                .root;
              return { delivery: "queued" } as ThreadManagement.ThreadManagementSendResult;
            }).pipe(Effect.orDie),
        });
      }),
    ).pipe(Layer.provide(transfers));
    const layer = Handoff.layer.pipe(
      Layer.provide(
        Layer.mergeAll(native, threads, Layer.mock(GitWorkflow.GitWorkflowService)({})),
      ),
      Layer.provide(Layer.succeedContext(dependencies)),
    );
    const run = (input = {}) =>
      Effect.gen(function* () {
        return yield* (yield* Handoff.ManagedWorktreeHandoff).handoff(scope, {
          branch: "feature/task",
          runSetupScript: false,
          ...input,
        });
      }).pipe(Effect.provide(layer));
    return {
      run,
      git,
      root: source.root,
      lanePath,
      created: () => created,
      adopted: () => adopted,
      current,
      relationships,
      sql,
      fs,
      sourceReads: () => sourceReads,
      targetReads: () => targetReads,
      submittedGeneration: () => submittedGeneration,
      submittedRefs: () => submittedRefs,
      reloadWorkspace: () => {
        generation++;
      },
      continuationPath: () => continuationPath,
      allowCommit: () => {
        failCommit = false;
      },
    };
  });

describe("Cinderdeck conversation lane handoff", () => {
  it.effect("moves into the name and branch approved in the shared creation sheet", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ reviewed: true });
      const result = yield* f.run({ continuationPrompt: "Continue" });
      assert.ok(result);
      assert.equal(result.branch, "codex/reviewed-handoff");
      assert.equal(f.submittedRefs(), undefined);
      assert.equal(f.created(), 1);
      assert.equal(f.continuationPath(), result.worktreePath);
    }).pipe(Effect.provide(base), Effect.scoped),
  );
  it.effect("prefills an explicit base only for the conversation's repository", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const result = yield* f.run({ baseRef: "main" });
      assert.ok(result);
      assert.deepEqual(f.submittedRefs(), { repo: "main" });
    }).pipe(Effect.provide(base), Effect.scoped),
  );
  it.effect("moves an older conversation using the live workspace generation", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ generation: 7 });
      const result = yield* f.run({ continuationPrompt: "Continue" });
      assert.ok(result);
      assert.equal(f.created(), 1);
      assert.equal(f.submittedGeneration(), 7);
      assert.equal(f.continuationPath(), result.worktreePath);
      assert.equal((yield* f.current.forThread(threadId))?.checkout.nativeGeneration, 7);
      assert.equal(
        (yield* f.current.forThread(ThreadId.make("sibling")))?.checkout.nativeGeneration,
        1,
      );
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("adopts a worktree after the primary workspace generation changes", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ generation: 7 });
      yield* f.git(["worktree", "add", "-b", "feature/task", f.lanePath]);
      assert.ok(yield* f.run({ adoptExisting: true, path: f.lanePath }));
      assert.equal(f.submittedGeneration(), 7);
      assert.equal(f.adopted(), 1);
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("refreshes transient source and target reads without replaying lane creation", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ sourceFailures: 1, targetFailures: 1 });
      assert.ok(yield* f.run());
      assert.equal(f.sourceReads(), 2);
      assert.equal(f.targetReads(), 2);
      assert.equal(f.created(), 1);
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("bounds connection recovery and leaves the chat in place", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ sourceFailures: 10 });
      assert.equal((yield* f.run().pipe(Effect.result))._tag, "Failure");
      assert.equal(f.sourceReads(), 2);
      assert.equal(f.created(), 0);
      assert.equal((yield* f.current.forThread(threadId))?.checkout.id, "primary");
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("reuses the created lane after a failed target read and a workspace reload", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ targetFailures: 2 });
      assert.equal((yield* f.run().pipe(Effect.result))._tag, "Failure");
      assert.equal((yield* f.current.forThread(threadId))?.checkout.id, "primary");
      f.reloadWorkspace();
      assert.ok(yield* f.run());
      assert.equal(f.created(), 1);
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  const invalidSources = [
    {
      name: "a replaced installation",
      message: "different Cinderdeck installation",
      transform: (context: NativeContext) => ({
        ...context,
        hello: { ...context.hello, installationID: "replacement" },
      }),
    },
    {
      name: "a different workspace",
      message: "primary workspace is no longer available",
      transform: (context: NativeContext) => ({
        ...context,
        resource: { ...context.resource, workspaceID: "other" },
      }),
    },
    {
      name: "unapplied settings",
      message: "unapplied settings",
      transform: (context: NativeContext) => ({
        ...context,
        resource: {
          ...context.resource,
          workspace: { ...context.resource.workspace!, definitionChanged: true },
        },
      }),
    },
    {
      name: "configuration issues",
      message: "configuration issues",
      transform: (context: NativeContext) => ({
        ...context,
        resource: {
          ...context.resource,
          workspace: { ...context.resource.workspace!, issues: ["Missing repository folder"] },
        },
      }),
    },
    {
      name: "native identity drift",
      message: "working directory does not match",
      transform: (context: NativeContext) => ({
        ...context,
        resource: {
          ...context.resource,
          workspace: {
            ...context.resource.workspace!,
            repos: context.resource.workspace!.repos.map((repo) => ({
              ...repo,
              physicalID: "replacement",
            })),
          },
        },
      }),
    },
  ] satisfies ReadonlyArray<{
    name: string;
    message: string;
    transform: NonNullable<Parameters<typeof fixture>[0]>["sourceTransform"];
  }>;
  it.effect.each(invalidSources)("still refuses $name after a generation change", (invalid) =>
    Effect.gen(function* () {
      const f = yield* fixture({ generation: 7, sourceTransform: invalid.transform });
      const result = yield* f.run().pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.include(result.failure.message, invalid.message);
      assert.equal(f.created(), 0);
      assert.equal((yield* f.current.forThread(threadId))?.checkout.id, "primary");
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("refuses a replaced Git checkout even at the same path", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ generation: 7 });
      yield* f.fs.rename(`${f.root}/.git`, `${f.root}/.old-git`);
      yield* f.git(["init", "-b", "main"]);
      assert.equal((yield* f.run().pipe(Effect.result))._tag, "Failure");
      assert.equal(f.created(), 0);
      assert.equal((yield* f.current.forThread(threadId))?.checkout.id, "primary");
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect.each(["pending", "unknown_outcome"])(
    "keeps %s ownership moves blocked after a generation change",
    (state) =>
      Effect.gen(function* () {
        const f = yield* fixture({ generation: 7 });
        const physicalId = (yield* f.current.forThread(threadId))!.checkout.repositories[0]!
          .physicalId;
        const record = yield* encodeOwnershipState({ state });
        yield* f.sql`INSERT INTO deckhand_ownership_transitions(id, actor_id, physical_id, original_json, record_json)
          VALUES ('move', 'actor', ${physicalId}, '{}', ${record})`;
        assert.equal((yield* f.run().pipe(Effect.result))._tag, "Failure");
        assert.equal(f.created(), 0);
        assert.equal((yield* f.relationships.session("session")).checkoutId, "primary");
      }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect("refuses an older native host before creating a lane", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ legacyHost: true });
      assert.equal((yield* f.run().pipe(Effect.result))._tag, "Failure");
      assert.equal(f.created(), 0);
      assert.equal((yield* f.current.forThread(threadId))?.checkout.id, "primary");
    }).pipe(Effect.provide(base), Effect.scoped),
  );

  it.effect(
    "moves a primary-bound chat and queues continuation in its native lane without moving a sibling",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = yield* f.run({ continuationPrompt: "Continue the task" });
        assert.ok(result);
        assert.equal(f.created(), 1);
        const moved = (yield* f.current.forThread(threadId))!;
        assert.equal(moved.checkout.kind, "lane");
        assert.equal(moved.checkout.laneId, "lane");
        assert.equal(moved.session.id, "session");
        assert.equal(moved.session.featureId, "feature");
        assert.equal(
          moved.session.repositoryScope?.[0],
          moved.checkout.repositories[0]?.physicalId,
        );
        assert.equal(f.continuationPath(), result.worktreePath);
        assert.equal(
          (yield* f.current.forThread(ThreadId.make("sibling")))?.checkout.id,
          "primary",
        );
        assert.equal((yield* f.git(["branch", "--show-current"])).stdout.trim(), "main");
      }).pipe(Effect.provide(base), Effect.scoped),
  );
  it.effect(
    "rolls back both bindings after a failed commit and reuses the native lane on retry",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture({ failCommit: true });
        assert.equal((yield* f.run().pipe(Effect.result))._tag, "Failure");
        assert.equal((yield* f.current.forThread(threadId))?.checkout.id, "primary");
        assert.equal(
          (yield* f.sql<{ path: string }>`SELECT path FROM fixture_thread`)[0]?.path,
          f.root,
        );
        f.allowCommit();
        assert.ok(yield* f.run());
        assert.equal(f.created(), 1);
        assert.equal((yield* f.current.forThread(threadId))?.checkout.laneId, "lane");
      }).pipe(Effect.provide(base), Effect.scoped),
  );
  it.effect("adopts an existing worktree and moves the same conversation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.git(["worktree", "add", "-b", "feature/task", f.lanePath]);
      assert.ok(yield* f.run({ adoptExisting: true, path: f.lanePath }));
      assert.equal(f.created(), 0);
      assert.equal(f.adopted(), 1);
      assert.equal((yield* f.current.forThread(threadId))?.checkout.kind, "lane");
    }).pipe(Effect.provide(base), Effect.scoped),
  );
  it.effect("does not turn a pending native creation into a completed chat transfer", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ pending: true });
      const result = yield* f.run().pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal((yield* f.current.forThread(threadId))?.checkout.id, "primary");
      yield* f.run().pipe(Effect.result);
      assert.equal(f.created(), 1);
    }).pipe(Effect.provide(base), Effect.scoped),
  );
  it.effect("refuses read-only chats and adoption of the primary directory", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ readOnly: true });
      assert.equal((yield* f.run().pipe(Effect.result))._tag, "Failure");
      assert.equal(f.created(), 0);
    }).pipe(Effect.provide(base), Effect.scoped),
  );
  it.effect("rejects a primary directory passed as an existing worktree", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      assert.equal(
        (yield* f.run({ adoptExisting: true, path: f.root }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(f.adopted(), 0);
      assert.equal((yield* f.current.forThread(threadId))?.checkout.id, "primary");
    }).pipe(Effect.provide(base), Effect.scoped),
  );
});
