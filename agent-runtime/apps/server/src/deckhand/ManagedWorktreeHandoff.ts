// @effect-diagnostics nodeBuiltinImport:off - Stable IDs make interrupted native operations retryable.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  WorktreeMcpFailure,
  type WorktreeMcpHandoffInput,
  type WorktreeMcpHandoffResult,
} from "@cinderdeck/contracts";
import * as C from "@cinderdeck/contracts/deckhand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as Relationships from "./Relationships.ts";
import * as WorkspaceBackend from "./WorkspaceBackend.ts";

export class ManagedWorktreeHandoff extends Context.Service<
  ManagedWorktreeHandoff,
  {
    readonly handoff: (
      scope: McpInvocationScope,
      input: WorktreeMcpHandoffInput,
    ) => Effect.Effect<WorktreeMcpHandoffResult | null, WorktreeMcpFailure>;
  }
>()("@cinderdeck/server/deckhand/ManagedWorktreeHandoff") {}
const id = (kind: string, parts: unknown[]) =>
  `${kind}:${NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
const fail = (message: string, code: WorktreeMcpFailure["code"] = "operation_failed") =>
  new WorktreeMcpFailure({ code, message });

export const layer = Layer.effect(
  ManagedWorktreeHandoff,
  Effect.gen(function* () {
    const current = yield* CurrentCheckout.CurrentCheckout;
    const sql = yield* SqlClient.SqlClient;
    const backend = yield* WorkspaceBackend.WorkspaceBackend;
    const identities = yield* CheckoutIdentity.CheckoutIdentity;
    const relationships = yield* Relationships.Relationships;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const git = yield* GitWorkflow.GitWorkflowService;
    const locks = yield* makeKeyedSerialExecutor<string>();
    // context refreshes the native connection. Retry only that read, never lane
    // creation/adoption or a transfer whose outcome may already be committed.
    const readContext = (workspaceID: string) =>
      backend.context(workspaceID).pipe(
        Effect.catchIf(
          (error) => error.reason === "unavailable",
          () => backend.context(workspaceID),
        ),
      );
    return ManagedWorktreeHandoff.of({
      handoff: (scope, input) =>
        locks.withLock(
          scope.threadId,
          Effect.gen(function* () {
            const context = yield* current.forThread(scope.threadId);
            if (!context || context.checkout.backend !== "cinderdeck") return null;
            const { session, checkout, workspace } = context;
            if (session.role !== "writer" || session.desiredAccess !== "write")
              return yield* fail(
                "Only a writable parent conversation can move to a lane.",
                "capability_denied",
              );
            if (checkout.kind === "lane")
              return yield* fail("This conversation is already in a lane.", "already_in_worktree");
            if (input.path && !input.adoptExisting)
              return yield* fail(
                "Cinderdeck chooses new lane folders. To move this chat to an existing worktree, pass path and adoptExisting: true.",
                "invalid_request",
              );
            if (input.adoptExisting && (!input.path || input.baseRef || input.startFromOrigin))
              return yield* fail(
                "Adopting a worktree requires path and does not accept baseRef or startFromOrigin.",
                "invalid_request",
              );
            const projection = yield* threads.getThreadRecords(scope.threadId, []);
            if (projection.thread.deletedAt !== null || projection.thread.archivedAt !== null)
              return yield* fail("This conversation is no longer active.", "thread_not_found");
            const source = yield* readContext(workspace.ownerId);
            if (!source.hello.capabilities.includes("linked-work.lane-transfer"))
              return yield* fail(
                "This Cinderdeck host needs an update before conversations can move between checkouts.",
              );
            const sourceWorkspace = source.resource.workspace;
            if (source.hello.installationID !== workspace.environmentId)
              return yield* fail(
                "This conversation belongs to a different Cinderdeck installation. Reconnect it to the current workspace before moving it.",
              );
            if (
              !source.resource.available ||
              !sourceWorkspace ||
              source.resource.workspaceID !== workspace.ownerId ||
              sourceWorkspace.id !== workspace.ownerId ||
              sourceWorkspace.lane
            )
              return yield* fail(
                "The conversation's primary workspace is no longer available. Check its folders in workspace settings before moving it.",
              );
            if (sourceWorkspace.definitionChanged)
              return yield* fail(
                "The workspace has unapplied settings. Reload its definition in workspace settings before moving this conversation.",
              );
            if (sourceWorkspace.issues.length)
              return yield* fail(
                "The workspace has configuration issues. Resolve them in workspace settings before moving this conversation.",
              );
            // A workspace reload can advance its generation while retaining the
            // exact checkout. Verify physical identity below and submit the live
            // generation/revision; refreshing cannot repair an old saved number.
            const sourcePhysical = yield* Effect.forEach(sourceWorkspace.repos, (repo) =>
              identities.resolve(repo.path),
            );
            const selectedIndex = sourcePhysical.findIndex(
              (repo) =>
                repo.root === projection.thread.worktreePath ||
                (projection.thread.worktreePath === null &&
                  session.repositoryScope?.includes(repo.physicalId)),
            );
            const selected = sourcePhysical[selectedIndex];
            if (
              !selected ||
              !session.repositoryScope?.includes(selected.physicalId) ||
              checkout.repositories.length !== sourcePhysical.length ||
              checkout.repositories.some(
                (repo) =>
                  !sourcePhysical.some(
                    (actual) =>
                      actual.physicalId === repo.physicalId &&
                      actual.repositoryPhysicalId === repo.repositoryPhysicalId,
                  ),
              ) ||
              sourcePhysical.some(
                (actual, index) =>
                  actual.physicalId !== sourceWorkspace.repos[index]!.physicalID ||
                  actual.repositoryPhysicalId !==
                    sourceWorkspace.repos[index]!.repositoryPhysicalID,
              )
            )
              return yield* fail(
                "The conversation's working directory does not match its workspace. Reconnect before moving it.",
              );
            const baseRef = input.baseRef ?? selected.branch ?? selected.commit;
            if (!baseRef)
              return yield* fail("Choose a baseRef for this checkout.", "invalid_request");
            const operationKey = id("chat-lane", [
              scope.threadId,
              checkout.id,
              input.branch,
              input.baseRef ?? null,
              input.path ?? null,
              input.adoptExisting ?? false,
              input.startFromOrigin ?? false,
              input.runSetupScript ?? true,
            ]);
            const actorID = `chat-${NodeCrypto.createHash("sha256").update(scope.threadId).digest("hex").slice(0, 40)}`;
            const previous =
              yield* sql`SELECT operation_key FROM deckhand_operations WHERE operation_key=${operationKey}`;
            let receipt;
            if (previous.length) {
              receipt = yield* backend.operation(actorID, operationKey, 25000);
            } else {
              let ref = baseRef;
              if (input.startFromOrigin) {
                yield* git.fetchRemote({ cwd: selected.root, remoteName: "origin" });
                ref = (yield* git.resolveRemoteTrackingCommit({
                  cwd: selected.root,
                  refName: baseRef,
                  fallbackRemoteName: "origin",
                })).commitSha;
              }
              if (input.adoptExisting) {
                const adopted = yield* identities.resolve(input.path!);
                if (
                  adopted.repositoryPhysicalId !== selected.repositoryPhysicalId ||
                  adopted.physicalId === selected.physicalId ||
                  adopted.branch !== input.branch
                )
                  return yield* fail(
                    "That path is not a separate worktree on the requested branch in this repository.",
                    "invalid_request",
                  );
              }
              const request = {
                operationKey,
                installationID: workspace.environmentId,
                workspaceID: workspace.ownerId,
                generation: source.resource.generation,
                revision: source.resource.revision,
                arguments: {
                  workspace: workspace.ownerId,
                  branch: input.branch,
                  start: false,
                  setup: input.runSetupScript ?? true,
                  ...(input.adoptExisting
                    ? { path: input.path }
                    : {
                        repositoryRefs: Object.fromEntries(
                          sourceWorkspace.repos.map((repo, index) => [
                            repo.id,
                            index === selectedIndex
                              ? ref
                              : (sourcePhysical[index]!.commit ?? "HEAD"),
                          ]),
                        ),
                      }),
                },
              };
              receipt = yield* input.adoptExisting
                ? backend.adoptLane(actorID, request)
                : backend.createLane(actorID, request);
              if (["pending", "running", "unknown_outcome"].includes(receipt.state))
                receipt = yield* backend.operation(actorID, operationKey, 25000);
            }
            const laneID = receipt.result?.createdWorkspaceID ?? receipt.result?.workspace?.id;
            if (
              receipt.state !== "succeeded" ||
              !laneID ||
              receipt.result?.creationReady === false ||
              (receipt.result?.setup &&
                !["succeeded", "skipped"].includes(receipt.result.setup.status))
            )
              return yield* fail(
                `Lane handoff ${receipt.state}. The conversation has not moved. Retry the same request to inspect operation ${operationKey}; any created lane is retained.`,
                ["pending", "running", "unknown_outcome"].includes(receipt.state)
                  ? "handoff_in_progress"
                  : "operation_failed",
              );
            const target = yield* readContext(laneID);
            const lane = target.resource.workspace;
            if (
              target.hello.installationID !== workspace.environmentId ||
              !target.resource.available ||
              !lane?.lane ||
              lane.lane.sourceStackID !== workspace.ownerId ||
              lane.lane.name !== input.branch ||
              lane.definitionChanged ||
              lane.issues.length ||
              lane.repos.length !== sourceWorkspace.repos.length
            )
              return yield* fail(
                "The created lane could not be verified. It was retained; the conversation has not moved.",
              );
            const physical = yield* Effect.forEach(lane.repos, (repo) =>
              identities.resolve(repo.path),
            );
            const destinationIndex = lane.repos.findIndex(
              (repo) => repo.id === sourceWorkspace.repos[selectedIndex]!.id,
            );
            const destination = physical[destinationIndex];
            if (
              !destination ||
              destination.physicalId === selected.physicalId ||
              destination.branch !== input.branch ||
              physical.some((repo, index) => {
                const originalIndex = sourceWorkspace.repos.findIndex(
                  (item) => item.id === lane.repos[index]!.id,
                );
                return (
                  originalIndex < 0 ||
                  repo.repositoryPhysicalId !==
                    sourcePhysical[originalIndex]!.repositoryPhysicalId ||
                  repo.physicalId !== lane.repos[index]!.physicalID
                );
              })
            )
              return yield* fail(
                "Lane repository identity changed. The conversation has not moved.",
              );
            const checkoutId = C.CheckoutBindingId.make(
              id("checkout", [
                workspace.id,
                laneID,
                target.resource.generation,
                ...physical.map((repo) => repo.physicalId).sort(),
              ]),
            );
            const commandId = CommandId.make(`${operationKey}:move`);
            return yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    const old = yield* relationships.session(session.id);
                    if (old.checkoutId !== session.checkoutId)
                      return yield* fail(
                        "This conversation moved while its lane was being created.",
                      );
                    const exists =
                      yield* sql`SELECT id FROM deckhand_checkouts WHERE id=${checkoutId}`;
                    if (!exists.length)
                      yield* relationships.putCheckout(
                        {
                          id: checkoutId,
                          workspaceId: workspace.id,
                          environmentId: checkout.environmentId,
                          workspaceGeneration: workspace.generation,
                          nativeGeneration: target.resource.generation,
                          backend: "cinderdeck",
                          kind: "lane",
                          laneId: laneID,
                          state: "ready",
                          repositories: physical,
                          revision: 1,
                        },
                        null,
                      );
                    yield* sql`INSERT INTO deckhand_checkout_transfers(command_id,session_id,source_checkout_id,target_checkout_id,target_path)
          VALUES(${commandId},${session.id},${session.checkoutId},${checkoutId},${destination.root}) ON CONFLICT(command_id) DO NOTHING`;
                  }),
                );
                // EventSink commits both bindings in one transaction, then publishes and detaches the old provider.
                yield* threads.dispatch({
                  type: "thread.metadata.update",
                  commandId,
                  threadId: scope.threadId,
                  branch: destination.branch,
                  worktreePath: destination.root,
                  expectedWorktreePath: projection.thread.worktreePath,
                });
                const verified = yield* current.forThread(scope.threadId);
                if (verified?.session.checkoutId !== checkoutId)
                  return yield* fail(
                    "The lane binding did not commit. Retry this handoff before continuing.",
                  );
                let continuation: WorktreeMcpHandoffResult["continuation"] = { status: "skipped" };
                if (input.continuationPrompt) {
                  continuation = yield* threads
                    .sendToThread({
                      projectId: projection.thread.projectId,
                      commandId: CommandId.make(`${operationKey}:continue`),
                      messageId: MessageId.make(`${operationKey}:message`),
                      threadId: scope.threadId,
                      text: input.continuationPrompt,
                      attachments: [],
                      mode: "queue",
                      createdBy: "agent",
                      creationSource: "mcp",
                    })
                    .pipe(
                      Effect.map((result) => ({
                        status: "scheduled" as const,
                        delivery: result.delivery,
                      })),
                      Effect.catchCause(() =>
                        Effect.succeed({
                          status: "failed" as const,
                          detail: "The conversation moved. Send a message to continue in its lane.",
                        }),
                      ),
                    );
                }
                return {
                  worktreePath: destination.root,
                  branch: input.branch,
                  baseRef,
                  startedFromOrigin: input.startFromOrigin ?? false,
                  setupScript: {
                    status:
                      input.runSetupScript === false || receipt.result?.setup?.status === "skipped"
                        ? "skipped"
                        : receipt.result?.setup?.status === "succeeded"
                          ? "completed"
                          : "no-script",
                  },
                  continuation,
                  note: "Conversation moved to its Cinderdeck lane with history preserved. The old provider detaches; subsequent turns, files, diffs and lane controls use the new checkout. Existing terminal processes and recordings retain their original context. Uncommitted primary-checkout files remain in place.",
                } satisfies WorktreeMcpHandoffResult;
              }),
            );
          }).pipe(
            Effect.mapError((cause) =>
              Schema.is(WorktreeMcpFailure)(cause)
                ? cause
                : fail(
                    `Unable to move the conversation to a lane: ${cause instanceof Error ? cause.message : String(cause)}`,
                  ),
            ),
          ),
        ),
    });
  }),
);
