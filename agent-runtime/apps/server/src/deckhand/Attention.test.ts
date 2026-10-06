import { assert, describe, it } from "@effect/vitest";
import {
  ThreadId,
  RuntimeRequestId,
  OrchestrationV2ThreadShell,
  OrchestrationV2PlanArtifact,
} from "@cinderdeck/contracts";
import * as C from "@cinderdeck/contracts/deckhand/attentionRpc";
import * as Q from "@cinderdeck/contracts/deckhand/reviewerRpc";
import type { RunsOverview, RunFailures } from "@cinderdeck/contracts/deckhand/runsRpc";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Hub from "./IntegrationHub.ts";
import * as Runs from "./Runs.ts";
import * as Attention from "./Attention.ts";
import * as O from "./AttentionObservations.ts";
const id = ThreadId.make("thread");
const now = DateTime.makeUnsafe(0);
const base = Schema.decodeUnknownSync(OrchestrationV2ThreadShell)({
  createdBy: "user",
  creationSource: "web",
  id,
  projectId: "project",
  title: "Retry payment",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  activeProviderThreadId: "provider",
  latestRunId: "run",
  activeRunId: null,
  status: "completed",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
});
const decodeRequest = Schema.decodeUnknownSync(
  OrchestrationV2ThreadShell.fields.pendingRuntimeRequest,
);
const decodePlan = Schema.decodeUnknownSync(OrchestrationV2PlanArtifact);
const decodeQueue = Schema.decodeUnknownEffect(Q.ReviewerQueueRecord);
const encodeQueue = Schema.encodeEffect(Schema.fromJsonString(Q.ReviewerQueueRecord));
const request = (requestId: string) =>
  decodeRequest({
    id: requestId,
    kind: "user_input",
    createdAt: now,
  });
const input: C.AttentionListInput = {
  threadIds: [id],
  nativeContexts: [],
  offset: 0,
  limit: 100,
  view: "active",
};
const context = { installationID: "installation", workspaceID: "workspace", generation: 3 };
const state = () => ({
  shell: { ...base, pendingRuntimeRequest: request("request1") } as typeof base | null,
  plans: [] as Array<typeof OrchestrationV2PlanArtifact.Type>,
  resolutions: [] as RunFailures["resolutions"],
  native: {
    revision: "r",
    storageError: null,
    retainedRunCount: 0,
    runsTruncated: false,
    services: [],
    tasks: [],
    workflows: [],
    runs: [],
  } as RunsOverview,
});
const layer = (source: ReturnType<typeof state>, filename = ":memory:") =>
  Attention.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Projection.ProjectionStoreV2, {
          getThreadShell: () => Effect.sync(() => source.shell),
          getThreadRecords: () => Effect.sync(() => ({ plans: source.plans })),
        } as unknown as Projection.ProjectionStoreV2["Service"]),
        Layer.succeed(Hub.IntegrationHub, {
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
        } as unknown as Hub.IntegrationHub["Service"]),
        Layer.succeed(Runs.Runs, {
          list: () => Effect.sync(() => source.native),
          failures: () =>
            Effect.sync(() => ({
              revision: source.native.revision,
              storageError: source.native.storageError,
              retainedRunCount: source.native.runs.length,
              runsTruncated: false,
              runs: source.native.runs
                .filter((run) => run.status === "failed" || run.status === "interrupted")
                .map((run) => ({
                  id: run.id,
                  name: run.name,
                  status: run.status as "failed" | "interrupted",
                  finishedAt: run.finishedAt,
                  detail: run.detail,
                  causeVersion: O.digest([run.id, run.status, run.finishedAt, run.steps]),
                })),
              resolutions: source.resolutions,
            })),
        } as unknown as Runs.Runs["Service"]),
      ),
    ),
    Layer.provideMerge(NodeSqliteClient.layer({ filename })),
  );
const change = (
  item: C.AttentionItem,
  action: C.AttentionChange["action"],
  snoozedUntil?: string,
): C.AttentionChange => ({
  id: item.id,
  causeVersion: item.causeVersion,
  revision: item.revision,
  dispositionRevision: item.dispositionRevision,
  action,
  ...(snoozedUntil ? { snoozedUntil } : {}),
});
describe("Cinderdeck authoritative attention", () => {
  it.effect("read preferences reopen durably without copying the conversation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "deckhand-attention-" });
      const source = state();
      const filename = `${root}/state.sqlite`;
      yield* Effect.gen(function* () {
        const attention = yield* Attention.Attention;
        const item = (yield* attention.list("alice", input)).items[0]!;
        yield* attention.change("alice", change(item, "read"));
      }).pipe(Effect.provide(layer(source, filename)));
      yield* Effect.gen(function* () {
        const attention = yield* Attention.Attention;
        assert.isTrue((yield* attention.list("alice", input)).items[0]!.read);
        assert.isFalse((yield* attention.list("bob", input)).items[0]!.read);
      }).pipe(Effect.provide(layer(source, filename)));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "read does not answer a request; answered source resolves it and a new request resets old preferences",
    () => {
      const source = state();
      return Effect.gen(function* () {
        const attention = yield* Attention.Attention;
        const original = (yield* attention.list("alice", input)).items[0]!;
        assert.equal(original.kind, "input");
        assert.equal(
          original.target.kind === "thread" && original.target.requestId,
          RuntimeRequestId.make("request1"),
        );
        assert.equal(original.canSnooze, false);
        const read = yield* attention.change("alice", change(original, "read"));
        assert.isTrue(read.read);
        assert.equal((yield* attention.list("alice", input)).items[0]!.state, "active");
        source.shell = { ...source.shell!, archivedAt: now };
        assert.equal((yield* attention.list("alice", input)).items[0]!.state, "active");

        source.shell = { ...base, pendingRuntimeRequest: null };
        assert.equal((yield* attention.list("alice", input)).items.length, 0);
        const history = yield* attention.list("alice", { ...input, view: "history" });
        assert.equal(history.items[0]!.state, "resolved");
        source.shell = { ...base, pendingRuntimeRequest: request("request2") };
        const next = (yield* attention.list("alice", input)).items[0]!;
        assert.equal(next.id, original.id);
        assert.notEqual(next.causeVersion, original.causeVersion);
        assert.equal(
          next.target.kind === "thread" && next.target.requestId,
          RuntimeRequestId.make("request2"),
        );
        assert.isFalse(next.read);
        assert.equal(
          (yield* attention.change("alice", change(read, "unread")).pipe(Effect.flip)).reason,
          "stale_cause",
        );
      }).pipe(Effect.provide(layer(source)));
    },
  );
  it.effect(
    "actor preferences are isolated, reversible and compare-and-swap guarded; approvals cannot snooze",
    () => {
      const source = state();
      return Effect.gen(function* () {
        const attention = yield* Attention.Attention;
        const original = (yield* attention.list("alice", input)).items[0]!;
        assert.equal(
          (yield* attention
            .change("alice", change(original, "snooze", "1970-01-01T01:00:00.000Z"))
            .pipe(Effect.flip)).reason,
          "snooze_blocked",
        );
        const read = yield* attention.change("alice", change(original, "read"));
        assert.isFalse((yield* attention.list("bob", input)).items[0]!.read);
        assert.equal(
          (yield* attention.change("alice", change(original, "unread")).pipe(Effect.flip)).reason,
          "conflict",
        );
        assert.isFalse((yield* attention.change("alice", change(read, "unread"))).read);
      }).pipe(Effect.provide(layer(source)));
    },
  );
  it.effect("snooze expiry wakes the same active cause; changed plan content resets it", () => {
    const source = state();
    source.shell = { ...base, hasActionableProposedPlan: true };
    source.plans = [
      decodePlan({
        id: "plan",
        threadId: id,
        nodeId: "node",
        runId: "run",
        kind: "proposed_plan",
        status: "active",
        markdown: "Plan one",
      }),
    ];
    return Effect.gen(function* () {
      const attention = yield* Attention.Attention;
      const item = (yield* attention.list("alice", input)).items[0]!;
      assert.equal(
        (yield* attention.change("alice", change(item, "snooze", "not-a-date")).pipe(Effect.flip))
          .reason,
        "invalid_time",
      );
      assert.equal(
        (yield* attention
          .change("alice", change(item, "snooze", "1970-01-09T00:00:00.000Z"))
          .pipe(Effect.flip)).reason,
        "invalid_time",
      );
      const snoozed = yield* attention.change(
        "alice",
        change(item, "snooze", "1970-01-01T02:00:00+01:00"),
      );
      assert.equal(snoozed.snoozedUntil, "1970-01-01T01:00:00.000Z");
      assert.equal(snoozed.state, "active");
      assert.equal((yield* attention.list("alice", input)).items.length, 0);
      assert.equal((yield* attention.list("alice", { ...input, view: "snoozed" })).items.length, 1);
      const awake = yield* attention.change("alice", change(snoozed, "unsnooze"));
      assert.equal(awake.snoozedUntil, null);
      yield* attention.change("alice", change(awake, "snooze", "1970-01-01T01:00:00.000Z"));
      yield* TestClock.adjust("1 hour");
      const expired = (yield* attention.list("alice", input)).items[0]!;
      assert.equal(expired.state, "active");
      assert.equal(expired.snoozedUntil, null);
      const read = yield* attention.change("alice", change(expired, "read"));
      source.plans = [{ ...source.plans[0]!, kind: "proposed_plan", markdown: "Plan two" }];
      const revised = (yield* attention.list("alice", input)).items[0]!;
      assert.notEqual(revised.causeVersion, read.causeVersion);
      assert.isFalse(revised.read);
    }).pipe(Effect.provide(layer(source)));
  });
  it.effect(
    "missing source is unknown, never completed, and cannot mutate remembered causes",
    () => {
      const source = state();
      return Effect.gen(function* () {
        const attention = yield* Attention.Attention;
        yield* attention.list("alice", input);
        source.shell = null;
        const saved = (yield* attention.list("alice", input)).items[0]!;
        assert.equal(saved.state, "unknown");
        assert.equal(saved.freshness, "last_observed");
        assert.equal(
          (yield* attention.list("alice", { ...input, view: "history" })).items.length,
          0,
        );
        assert.equal(
          (yield* attention.change("alice", change(saved, "read")).pipe(Effect.flip)).reason,
          "source_unavailable",
        );
        source.shell = { ...base, pendingRuntimeRequest: request("request1") };
        assert.equal((yield* attention.list("alice", input)).items[0]!.freshness, "current");
      }).pipe(Effect.provide(layer(source)));
    },
  );
  it.effect(
    "review acceptance alone is not ready; completed reviewer and exact failed native run produce distinct causes",
    () => {
      const source = state();
      source.shell = { ...base, latestRunCompletedAt: null };
      source.native = {
        ...source.native,
        runs: [
          {
            id: "native-run",
            workspaceID: context.workspaceID,
            name: "Check",
            definitionID: "check",
            kind: "task",
            status: "failed",
            actor: "alice",
            createdAt: "1970-01-01T00:00:00.000Z",
            finishedAt: "1970-01-01T00:00:01.000Z",
            duration: 1,
            detail: "Exit 2",
            cancelAllowed: false,
            steps: [],
          },
        ],
      };
      return Effect.gen(function* () {
        const attention = yield* Attention.Attention;
        const sql = yield* SqlClient.SqlClient;
        const queue = yield* decodeQueue({
          operationKey: "review",
          state: "accepted",
          attempts: 1,
          attemptKey: "attempt",
          preview: {
            installationID: "installation",
            workspaceID: "workspace",
            generation: 3,
            revision: "revision",
            repositoryID: "repo",
            title: "Review",
            reviewerContext: {
              featureId: "feature",
              sourceCheckoutId: "checkout",
              sourceWorkspaceID: "lane",
              sourceGeneration: 3,
              sourceRevision: "source",
              repositories: [
                {
                  repositoryID: "repo",
                  sourcePhysicalId: "physical",
                  repositoryPhysicalId: "repo-physical",
                  commit: "a".repeat(40),
                },
              ],
            },
          },
          creation: {
            operationKey: "attempt",
            state: "accepted",
            laneID: "reviewer-lane",
            threadID: id,
            error: null,
          },
          detail: null,
          createdAt: "now",
          updatedAt: "now",
        });
        const json = yield* encodeQueue(queue);
        yield* sql`INSERT INTO deckhand_reviewer_queue(operation_key,actor_id,original_input_json,state,updated_at,record_json) VALUES('review','alice','{}','accepted','now',${json})`;
        const first = yield* attention.list("alice", { ...input, nativeContexts: [context] });
        assert.equal(first.items.length, 1);
        assert.equal(first.items[0]!.kind, "run_failure");
        source.shell = { ...base, latestRunCompletedAt: now, status: "cancelled" };
        assert.equal(
          (yield* attention.list("alice", input)).items.filter((i) => i.kind === "review_ready")
            .length,
          0,
        );
        source.shell = { ...base, latestRunCompletedAt: now };
        const completed = yield* attention.list("alice", { ...input, nativeContexts: [context] });
        assert.equal(completed.items.filter((i) => i.kind === "review_ready").length, 1);
        assert.equal(
          (yield* attention.list("bob", input)).items.filter((i) => i.kind === "review_ready")
            .length,
          0,
        );
        const failedRun = source.native.runs[0]!;
        source.native = { ...source.native, runs: [] };
        yield* TestClock.adjust("76 seconds");
        const omitted = (yield* attention.list("alice", {
          ...input,
          nativeContexts: [context],
        })).items.find((i) => i.kind === "run_failure")!;
        assert.equal(omitted.state, "active");
        assert.equal(omitted.freshness, "last_observed");
        assert.equal(
          (yield* attention.change("alice", change(omitted, "read")).pipe(Effect.flip)).reason,
          "source_unavailable",
        );
        source.resolutions = [
          {
            runID: "native-run",
            causeVersion: omitted.causeVersion,
            resolvedByRunID: "matching-rerun",
            observedAt: "1970-01-01T00:01:16.000Z",
          },
        ];
        const afterProof = yield* attention.list("alice", { ...input, nativeContexts: [context] });
        assert.equal(afterProof.items.filter((i) => i.kind === "run_failure").length, 0);
        const history = yield* attention.list("alice", {
          ...input,
          nativeContexts: [context],
          view: "history",
        });
        const resolved = history.items.find((i) => i.kind === "run_failure")!;
        assert.equal(resolved.state, "resolved");
        assert.equal(
          resolved.target.kind === "runs" ? resolved.target.resolvedByRunID : null,
          "matching-rerun",
        );
        const again = (yield* attention.list("alice", {
          ...input,
          nativeContexts: [context],
          view: "history",
        })).items.find((i) => i.id === resolved.id)!;
        assert.equal(again.revision, resolved.revision);
        source.native = { ...source.native, runs: [failedRun] };
        source.resolutions = [];
        assert.equal(
          (yield* attention.list("alice", { ...input, nativeContexts: [context] })).items.filter(
            (i) => i.kind === "run_failure",
          ).length,
          0,
        );
        assert.equal(
          (yield* attention.list("alice", {
            ...input,
            nativeContexts: [context],
            view: "history",
          })).items.find((i) => i.id === resolved.id)!.revision,
          resolved.revision,
        );
      }).pipe(Effect.provide(layer(source)));
    },
  );
  it.effect(
    "older observations cannot replace a new version and unrelated absent scopes cannot resolve it",
    () => {
      const source = state();
      return Effect.gen(function* () {
        yield* Attention.Attention;
        const original = {
          scopeKey: "verification:test",
          kind: "verification" as const,
          causeVersion: "new",
          title: "Check",
          detail: "Check saved proof",
          severity: "warning" as const,
          target: { kind: "connection" as const },
          observedAt: "1970-01-01T00:00:02.000Z",
          canSnooze: true,
        };
        const current = yield* O.save(original);
        const old = yield* O.save({
          ...original,
          causeVersion: "old",
          observedAt: "1970-01-01T00:00:01.000Z",
        });
        assert.equal(old.causeVersion, current.causeVersion);
        yield* O.reconcile("verification:another", [], "1970-01-01T00:00:03.000Z");
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_attention WHERE id=${current.id}`;
        assert.equal((yield* O.decodeCause(rows[0]!.record_json)).state, "active");
      }).pipe(Effect.provide(layer(source)));
    },
  );
});
