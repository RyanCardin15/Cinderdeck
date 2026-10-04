// @effect-diagnostics nodeBuiltinImport:off - Stable hashes bind private operation keys to receipts.
import * as NodeCrypto from "node:crypto";
import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as C from "@t3tools/contracts/deckhand/ownershipRpc";
import * as B from "@t3tools/contracts/deckhand";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CurrentCheckout from "./CurrentCheckout.ts";
import * as Relationships from "./Relationships.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as WriterReservations from "./WriterReservations.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
export class OwnershipTransitions extends Context.Service<
  OwnershipTransitions,
  {
    readonly preview: (
      actor: string,
      input: C.OwnershipIntent,
    ) => Effect.Effect<C.OwnershipPreview, C.OwnershipError>;
    readonly submit: (
      actor: string,
      input: C.OwnershipSubmit,
    ) => Effect.Effect<C.OwnershipRecord, C.OwnershipError>;
    readonly get: (
      actor: string,
      input: C.OwnershipGet,
    ) => Effect.Effect<C.OwnershipRecord, C.OwnershipError>;
    readonly list: (
      actor: string,
      input: typeof C.OwnershipList.Type,
    ) => Effect.Effect<typeof C.OwnershipPage.Type, C.OwnershipError>;
  }
>()("t3/deckhand/OwnershipTransitions") {}
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(C.OwnershipRecord));
const encode = Schema.encodeEffect(Schema.fromJsonString(C.OwnershipRecord));
const encodePreview = Schema.encodeEffect(Schema.fromJsonString(C.OwnershipPreview));
const encodeSubmit = Schema.encodeEffect(Schema.fromJsonString(C.OwnershipSubmit));
const encodePaths = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const isError = Schema.is(C.OwnershipError);
const stable = (kind: string, value: string) =>
  kind + ":" + NodeCrypto.createHash("sha256").update(value).digest("hex");
const fail = (reason: C.OwnershipError["reason"]) => new C.OwnershipError({ reason });
const normalize = (cause: unknown) => (isError(cause) ? cause : fail("storage"));
const quiescent = (shell: OrchestrationV2ThreadShell) =>
  shell.activeRunId === null &&
  !shell.activityRunStatus &&
  shell.pendingRuntimeRequest === null &&
  !shell.pendingBackgroundTasks?.length &&
  !["queued", "preparing", "starting", "running", "waiting"].includes(shell.status);
export const layer = Layer.effect(
  OwnershipTransitions,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const current = yield* CurrentCheckout.CurrentCheckout;
    const relationships = yield* Relationships.Relationships;
    const identity = yield* CheckoutIdentity.CheckoutIdentity;
    const fs = yield* FileSystem.FileSystem;
    const hub = yield* IntegrationHub.IntegrationHub;
    const writers = yield* WriterReservations.WriterReservations;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const locks = yield* makeKeyedSerialExecutor<string>();
    const now = Effect.map(DateTime.now, DateTime.formatIso);
    const read = (actor: string, id: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          actor_id: string;
          record_json: string;
          original_json: string;
        }>`SELECT actor_id,record_json,original_json FROM deckhand_ownership_transitions WHERE id=${id}`;
        if (!rows[0]) return yield* fail("missing");
        if (rows[0].actor_id !== actor) return yield* fail("wrong_actor");
        return { record: yield* decode(rows[0].record_json), original: rows[0].original_json };
      }).pipe(Effect.mapError(normalize));
    const save = (record: C.OwnershipRecord) =>
      Effect.gen(function* () {
        const json = yield* encode(record);
        yield* sql`UPDATE deckhand_ownership_transitions SET record_json=${json} WHERE id=${record.id}`;
        yield* current.invalidate;
        return record;
      });
    const preview = (actor: string, input: C.OwnershipIntent) =>
      Effect.gen(function* () {
        if (!actor) return yield* fail("wrong_actor");
        const shell = yield* projections.getThreadShell(input.threadId);
        if (!shell?.worktreePath) return yield* fail("stale_context");
        const physical = yield* identity.resolve(shell.worktreePath);
        const selected = yield* hub.resource(input.workspaceID);
        const resource = selected.resource,
          workspace = resource.workspace;
        if (
          selected.hello.installationID !== input.installationID ||
          resource.generation !== input.generation ||
          resource.revision !== input.revision ||
          !resource.available ||
          !workspace ||
          workspace.definitionChanged ||
          workspace.issues.length
        )
          return yield* fail("stale_context");
        if (workspace.repos.length !== 1) return yield* fail("unsupported_multi_repo");
        const selectedPhysical = yield* identity.resolve(workspace.repos[0]!.path);
        if (selectedPhysical.repositoryPhysicalId !== physical.repositoryPhysicalId)
          return yield* fail("stale_context");
        const lookup = yield* hub.checkoutContexts({
          physicalID: physical.physicalId,
          repositoryPhysicalID: physical.repositoryPhysicalId,
          physicalIDs: [physical.physicalId],
          sharedRefs: false,
        });
        if (lookup.installationID !== input.installationID) return yield* fail("stale_context");
        if (
          input.direction === "adopt" &&
          (workspace.lane ||
            lookup.contexts.length ||
            selectedPhysical.physicalId === physical.physicalId)
        )
          return yield* fail("stale_context");
        if (
          input.direction === "release" &&
          (!workspace.lane ||
            selectedPhysical.physicalId !== physical.physicalId ||
            lookup.contexts.length !== 1 ||
            lookup.contexts[0]?.workspaceID !== input.workspaceID ||
            lookup.contexts[0]?.generation !== input.generation)
        )
          return yield* fail("stale_context");
        const sourceRows = yield* sql<{
          origin_id: string;
        }>`SELECT origin_id FROM deckhand_current_checkouts WHERE EXISTS(SELECT 1 FROM json_each(record_json,'$.repositories') repo WHERE json_extract(repo.value,'$.physicalId')=${physical.physicalId}) LIMIT 101`;
        if (sourceRows.length > 100) return yield* fail("busy");
        for (const row of sourceRows) {
          const target = yield* current.current(row.origin_id);
          if (target.repositories.length !== 1) return yield* fail("unsupported_multi_repo");
          if (target.environmentId !== input.installationID) return yield* fail("stale_context");
        }
        // Include every current upstream conversation at this exact worktree, including
        // threads created before Deckhand bindings existed. No transcript is loaded.
        const pathRows = yield* sql<{
          path: string;
        }>`SELECT DISTINCT json_extract(payload_json,'$.worktreePath') AS path FROM orchestration_v2_projection_threads WHERE json_extract(payload_json,'$.worktreePath') IS NOT NULL AND json_extract(payload_json,'$.deletedAt') IS NULL LIMIT 1001`;
        if (pathRows.length > 1000) return yield* fail("busy");
        const aliases = yield* Effect.forEach(
          pathRows,
          (row) =>
            fs.realPath(row.path).pipe(
              Effect.map((path) => (path === physical.root ? row.path : null)),
              Effect.orElseSucceed(() => null),
            ),
          { concurrency: 16 },
        );
        const paths = yield* encodePaths([
          physical.root,
          shell.worktreePath,
          ...aliases.filter((path): path is string => path !== null),
        ]);
        const threadRows = yield* sql<{
          thread_id: string;
        }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE json_extract(payload_json,'$.worktreePath') IN(SELECT value FROM json_each(${paths})) AND json_extract(payload_json,'$.deletedAt') IS NULL
    UNION SELECT thread_id FROM deckhand_sessions WHERE checkout_id IN(SELECT origin_id FROM deckhand_current_checkouts WHERE EXISTS(SELECT 1 FROM json_each(record_json,'$.repositories') repo WHERE json_extract(repo.value,'$.physicalId')=${physical.physicalId})) LIMIT 101`;
        if (threadRows.length > 100) return yield* fail("busy");
        const affected = yield* Effect.forEach(threadRows, (row) =>
          projections.getThreadShell(ThreadId.make(row.thread_id)),
        );
        const found = affected.filter((item): item is OrchestrationV2ThreadShell => item !== null);
        if (!found.some((item) => item.id === input.threadId)) return yield* fail("stale_context");
        const blockers: string[] = [];
        if (
          input.direction === "adopt" &&
          !selected.hello.capabilities.includes("operations.lane.adopt.managedWriter")
        )
          blockers.push(
            "This Cinderdeck version cannot transfer an adopted lane to managed writer admission. Update Cinderdeck first.",
          );
        for (const item of found) {
          if (!quiescent(item))
            blockers.push(`Stop work in ${item.title || item.id} before changing ownership.`);
          if (
            item.worktreePath === null ||
            (yield* identity.resolve(item.worktreePath)).physicalId !== physical.physicalId
          )
            return yield* fail("stale_context");
        }
        const held = yield* writers.inspect;
        if (held.some((item) => item.physicalIds.includes(physical.physicalId)))
          blockers.push(
            "A provider or checkout mutation still holds this checkout. Stop it and wait for reservation release.",
          );
        const native =
          yield* sql`SELECT id FROM deckhand_native_writer_intents WHERE state <> 'released' AND EXISTS(SELECT 1 FROM json_each(control_json,'$.repos') WHERE value=${workspace.repos[0]!.id}) AND installation_id=${input.installationID} AND json_extract(control_json,'$.workspaceID')=${input.workspaceID}`;
        if (native.length)
          blockers.push("Native writer ownership still requires release or recovery.");
        if (
          input.direction === "release" &&
          workspace.services.some(
            (service) => !["idle", "stopped", "exited", "not_started"].includes(service.phase),
          )
        )
          blockers.push("Stop lane services before releasing ownership.");
        return {
          intent: input,
          checkout: physical,
          affectedThreads: found
            .map((item) => ({ threadId: item.id, title: item.title }))
            .sort((a, b) => a.threadId.localeCompare(b.threadId)),
          sourceCheckoutIDs: sourceRows.map((row) => row.origin_id).sort(),
          blockers,
        } satisfies C.OwnershipPreview;
      }).pipe(Effect.mapError(normalize));
    const origins = (view: C.OwnershipPreview) =>
      Effect.gen(function* () {
        const originID = B.CheckoutBindingId.make(
          stable("ownership-origin", view.checkout.physicalId),
        );
        const originWorkspaceID = B.WorkspaceBindingId.make(
          stable("ownership-origin-workspace", view.checkout.physicalId),
        );
        const existing = yield* sql`SELECT id FROM deckhand_checkouts WHERE id=${originID}`;
        if (!existing.length) {
          yield* relationships.putWorkspace(
            {
              id: originWorkspaceID,
              environmentId: B.EnvironmentId.make(view.intent.installationID),
              backend: "standalone",
              ownerId: originWorkspaceID,
              generation: 1,
              revision: 1,
              name: "Original standalone checkout",
              state: "active",
            },
            null,
          );
          yield* relationships.putCheckout(
            {
              id: originID,
              workspaceId: originWorkspaceID,
              workspaceGeneration: 1,
              environmentId: B.EnvironmentId.make(view.intent.installationID),
              backend: "standalone",
              kind: "primary",
              laneId: null,
              state: "ready",
              repositories: [view.checkout],
              revision: 1,
            },
            null,
          );
        }
        for (const item of view.affectedThreads) {
          const saved =
            yield* sql`SELECT id FROM deckhand_sessions WHERE thread_id=${item.threadId}`;
          if (saved.length) continue;
          const shell = yield* projections.getThreadShell(item.threadId);
          if (!shell) return yield* fail("stale_context");
          const featureID = B.FeatureId.make(stable("ownership-feature", item.threadId));
          const stamp = yield* now;
          yield* relationships.putFeature(
            {
              id: featureID,
              workspaceId: originWorkspaceID,
              title: item.title || "Existing conversation",
              objective:
                "Retain the existing conversation while explicitly changing checkout ownership.",
              status: "active",
              revision: 1,
              createdAt: stamp,
              updatedAt: stamp,
            },
            null,
          );
          yield* relationships.linkCheckout(featureID, originID, true);
          yield* relationships.putSession(
            {
              id: B.SessionBindingId.make(stable("ownership-session", item.threadId)),
              threadId: item.threadId,
              providerSessionId: null,
              providerInstanceId: shell.providerInstanceId,
              featureId: featureID,
              checkoutId: originID,
              repositoryScope: [view.checkout.physicalId],
              role: "writer",
              desiredAccess: "write",
              execution: "unknown",
              connection: "unavailable",
              capabilities: {
                nativeResume: false,
                interrupt: false,
                steering: false,
                approvals: false,
                questions: false,
                enforcedReadOnly: false,
                imageInput: false,
                videoInput: false,
                managed: true,
              },
              lastSequence: 0,
            },
            null,
          );
        }
        return originID;
      });
    const complete = (
      record: C.OwnershipRecord,
      target: B.CheckoutBinding,
      workspace: B.WorkspaceBinding,
    ) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const ws = yield* sql`SELECT id FROM deckhand_workspaces WHERE id=${workspace.id}`;
          if (!ws.length) yield* relationships.putWorkspace(workspace, null);
          const co = yield* sql`SELECT id FROM deckhand_checkouts WHERE id=${target.id}`;
          if (!co.length) yield* relationships.putCheckout(target, null);
          const rows = yield* sql<{
            origin_id: string;
          }>`SELECT origin_id FROM deckhand_current_checkouts WHERE EXISTS(SELECT 1 FROM json_each(record_json,'$.repositories') repo WHERE json_extract(repo.value,'$.physicalId')=${record.original.checkout.physicalId}) LIMIT 101`;
          if (rows.length > 100) return yield* fail("busy");
          for (const row of rows) {
            if (row.origin_id === target.id) continue;
            yield* sql`INSERT INTO deckhand_checkout_ownership(original_checkout_id,target_checkout_id,transition_id,revision) VALUES(${row.origin_id},${target.id},${record.id},1)
    ON CONFLICT(original_checkout_id) DO UPDATE SET target_checkout_id=excluded.target_checkout_id,transition_id=excluded.transition_id,revision=deckhand_checkout_ownership.revision+1`;
          }
          return yield* save({
            ...record,
            state: "completed",
            targetCheckoutID: target.id,
            updatedAt: yield* now,
            detail:
              "Ownership changed; original conversation and checkout identities remain in history.",
          });
        }),
      );
    const reconcile = (actor: string, record: C.OwnershipRecord) =>
      Effect.gen(function* () {
        if (record.state === "completed" || record.state === "failed") return record;
        const receipt = yield* hub
          .operation(actor, stable("ownership-native", record.id), 0)
          .pipe(Effect.result);
        if (receipt._tag === "Failure") {
          if (receipt.failure.reason === "operation_refused")
            return yield* save({
              ...record,
              state: "failed",
              updatedAt: yield* now,
              detail:
                "The durable operation journal records a definite refusal. No ownership alias was published.",
            });
          if (receipt.failure.reason === "operation_missing" && record.nativeOperationID === null) {
            // Hub never dispatches without first recording its actor-owned intent.
            // Recover legacy pre-dispatch failures only after fresh pinned native
            // ownership and physical identity still prove the original state.
            const physical = yield* identity.resolve(record.original.checkout.root);
            if (
              physical.physicalId !== record.original.checkout.physicalId ||
              physical.repositoryPhysicalId !== record.original.checkout.repositoryPhysicalId
            )
              return yield* fail("stale_context");
            const input = record.original.intent;
            const selected = yield* hub.resource(input.workspaceID);
            const lookup = yield* hub.checkoutContexts({
              physicalID: physical.physicalId,
              repositoryPhysicalID: physical.repositoryPhysicalId,
              physicalIDs: [physical.physicalId],
              sharedRefs: false,
            });
            if (
              selected.hello.installationID !== input.installationID ||
              selected.resource.generation !== input.generation ||
              lookup.installationID !== input.installationID ||
              (input.direction === "adopt"
                ? lookup.contexts.length !== 0
                : lookup.contexts.length !== 1 ||
                  lookup.contexts[0]?.workspaceID !== input.workspaceID ||
                  lookup.contexts[0]?.generation !== input.generation)
            )
              return yield* fail("stale_context");
            return yield* save({
              ...record,
              state: "failed",
              updatedAt: yield* now,
              detail:
                "No durable native intent was recorded and fresh identity checks confirm ownership is unchanged. Review a new attempt explicitly.",
            });
          }
          return yield* save({
            ...record,
            state: "unknown_outcome",
            updatedAt: yield* now,
            detail:
              "The native receipt is unavailable. Recover this same transition before starting work.",
          });
        }
        const native = receipt.success;
        record = { ...record, nativeOperationID: native.id };
        if (native.state === "failed")
          return yield* save({
            ...record,
            state: "failed",
            updatedAt: yield* now,
            detail:
              "Cinderdeck definitively refused the ownership change. Inspect the native operation receipt.",
          });
        if (native.state !== "succeeded")
          return yield* save({
            ...record,
            state: native.state === "unknown_outcome" ? "unknown_outcome" : "pending",
            updatedAt: yield* now,
            detail: "Waiting for Cinderdeck's durable ownership receipt.",
          });
        const physical = yield* identity.resolve(record.original.checkout.root);
        if (
          physical.physicalId !== record.original.checkout.physicalId ||
          physical.repositoryPhysicalId !== record.original.checkout.repositoryPhysicalId
        )
          return yield* fail("stale_context");
        const input = record.original.intent;
        const lookup = yield* hub.checkoutContexts({
          physicalID: physical.physicalId,
          repositoryPhysicalID: physical.repositoryPhysicalId,
          physicalIDs: [physical.physicalId],
          sharedRefs: false,
        });
        if (lookup.installationID !== input.installationID) return yield* fail("stale_context");
        if (input.direction === "release") {
          if (
            native.result?.released !== input.workspaceID ||
            lookup.contexts.length ||
            !native.result?.report?.keptWorktrees.includes(physical.root)
          )
            return yield* fail("stale_context");
          const workspaceID = B.WorkspaceBindingId.make(
            stable("ownership-standalone-workspace", record.id),
          );
          const workspace: B.WorkspaceBinding = {
            id: workspaceID,
            environmentId: B.EnvironmentId.make(input.installationID),
            backend: "standalone",
            ownerId: workspaceID,
            generation: 1,
            revision: 1,
            name: "Standalone checkout",
            state: "active",
          };
          const target: B.CheckoutBinding = {
            id: B.CheckoutBindingId.make(stable("ownership-checkout", record.id)),
            workspaceId: workspaceID,
            workspaceGeneration: 1,
            environmentId: workspace.environmentId,
            backend: "standalone",
            kind: "primary",
            laneId: null,
            state: "ready",
            repositories: [physical],
            revision: 1,
          };
          return yield* complete(record, target, workspace);
        }
        const id = native.result?.createdWorkspaceID ?? native.result?.workspace?.id;
        if (!id || lookup.contexts.length !== 1 || lookup.contexts[0]?.workspaceID !== id)
          return yield* fail("stale_context");
        const snapshot = yield* hub.resource(id),
          lane = snapshot.resource.workspace;
        if (
          snapshot.hello.installationID !== input.installationID ||
          !snapshot.resource.available ||
          !lane?.lane ||
          lane.lane.sourceStackID !== input.workspaceID ||
          lane.repos.length !== 1 ||
          (yield* identity.resolve(lane.repos[0]!.path)).physicalId !== physical.physicalId
        )
          return yield* fail("stale_context");
        const parent = yield* hub.resource(input.workspaceID);
        if (
          parent.hello.installationID !== input.installationID ||
          parent.resource.generation !== input.generation
        )
          return yield* fail("stale_context");
        const workspaceID = B.WorkspaceBindingId.make(
          stable(
            "ownership-native-workspace",
            input.installationID + ":" + input.workspaceID + ":" + input.generation,
          ),
        );
        const workspace: B.WorkspaceBinding = {
          id: workspaceID,
          environmentId: B.EnvironmentId.make(input.installationID),
          backend: "cinderdeck",
          ownerId: input.workspaceID,
          generation: input.generation,
          revision: 1,
          name: parent.resource.workspace?.name ?? input.workspaceID,
          state: "active",
        };
        const target: B.CheckoutBinding = {
          id: B.CheckoutBindingId.make(stable("ownership-checkout", record.id)),
          workspaceId: workspaceID,
          workspaceGeneration: workspace.generation,
          nativeGeneration: snapshot.resource.generation,
          environmentId: workspace.environmentId,
          backend: "cinderdeck",
          kind: "lane",
          laneId: id,
          state: "ready",
          repositories: [physical],
          revision: 1,
        };
        return yield* complete(record, target, workspace);
      }).pipe(
        Effect.catch((cause) =>
          save({
            ...record,
            state: "unknown_outcome",
            updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            detail: isError(cause)
              ? cause.message
              : "Native success needs context reconciliation. Original ownership remains blocked.",
          }),
        ),
      );
    const submit = (actor: string, input: C.OwnershipSubmit) =>
      locks
        .withLock(
          input.preview.checkout.physicalId,
          Effect.gen(function* () {
            const id = stable("ownership", actor + "\0" + input.operationKey);
            const encoded = yield* encodeSubmit(input);
            const prior = yield* read(actor, id).pipe(Effect.result);
            if (prior._tag === "Success") {
              if (prior.success.original !== encoded) return yield* fail("key_conflict");
              return yield* reconcile(actor, prior.success.record);
            }
            if (prior.failure.reason !== "missing") return yield* prior.failure;
            return yield* Effect.scoped(
              Effect.gen(function* () {
                const fresh = yield* preview(actor, {
                  operationKey: input.operationKey,
                  threadId: input.threadId,
                  direction: input.direction,
                  installationID: input.installationID,
                  workspaceID: input.workspaceID,
                  generation: input.generation,
                  revision: input.revision,
                  ...(input.laneName ? { laneName: input.laneName } : {}),
                });
                if ((yield* encodePreview(fresh)) !== (yield* encodePreview(input.preview)))
                  return yield* fail("stale_context");
                if (fresh.blockers.length) return yield* fail("busy");
                yield* writers
                  .tryAcquire({ ownerId: id, physicalIds: [fresh.checkout.physicalId] })
                  .pipe(Effect.mapError(() => fail("busy")));
                const createdAt = yield* now;
                const record: C.OwnershipRecord = {
                  id,
                  operationKey: input.operationKey,
                  threadId: input.threadId,
                  direction: input.direction,
                  state: "pending",
                  original: fresh,
                  createdAt,
                  updatedAt: createdAt,
                  nativeOperationID: null,
                  targetCheckoutID: null,
                  detail: "Ownership transition accepted; no agent or service is started.",
                };
                yield* sql.withTransaction(
                  Effect.gen(function* () {
                    yield* origins(fresh);
                    const json = yield* encode(record);
                    yield* sql`INSERT INTO deckhand_ownership_transitions(id,actor_id,physical_id,original_json,record_json) VALUES(${id},${actor},${fresh.checkout.physicalId},${encoded},${json})`;
                  }),
                );
                yield* current.invalidate;
                const result = yield* hub
                  .submit(actor, {
                    operationKey: stable("ownership-native", id),
                    installationID: input.installationID,
                    workspaceID: input.workspaceID,
                    generation: input.generation,
                    revision: input.revision,
                    method: input.direction === "adopt" ? "lane.adopt" : "lane.release",
                    arguments:
                      input.direction === "adopt"
                        ? {
                            workspace: input.workspaceID,
                            path: fresh.checkout.root,
                            ...(input.laneName ? { name: input.laneName } : {}),
                            start: false,
                            setup: false,
                            managedWriter: true,
                          }
                        : { workspace: input.workspaceID, force: false, delete_logs: false },
                  })
                  .pipe(Effect.result);
                if (result._tag === "Failure") return yield* reconcile(actor, record);
                return yield* reconcile(actor, { ...record, nativeOperationID: result.success.id });
              }),
            );
          }),
        )
        .pipe(Effect.mapError(normalize));
    const get = (actor: string, input: C.OwnershipGet) =>
      locks
        .withLock(
          input.id,
          Effect.flatMap(read(actor, input.id), (saved) => reconcile(actor, saved.record)),
        )
        .pipe(Effect.mapError(normalize));
    const list = (actor: string, input: typeof C.OwnershipList.Type) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_ownership_transitions WHERE actor_id=${actor} AND EXISTS(SELECT 1 FROM json_each(record_json,'$.original.affectedThreads') WHERE json_extract(value,'$.threadId')=${input.threadId}) ORDER BY rowid DESC LIMIT ${input.limit} OFFSET ${input.offset}`;
        const count = yield* sql<{
          total: number;
        }>`SELECT COUNT(*) AS total FROM deckhand_ownership_transitions WHERE actor_id=${actor} AND EXISTS(SELECT 1 FROM json_each(record_json,'$.original.affectedThreads') WHERE json_extract(value,'$.threadId')=${input.threadId})`;
        const total = count[0]?.total ?? 0;
        return {
          items: yield* Effect.forEach(rows, (row) => decode(row.record_json)),
          total,
          nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null,
        };
      }).pipe(Effect.mapError(normalize));
    return OwnershipTransitions.of({ preview, submit, get, list });
  }),
);
