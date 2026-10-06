import { type ThreadId } from "@cinderdeck/contracts";
import * as C from "@cinderdeck/contracts/deckhand/attentionRpc";
import * as Queue from "@cinderdeck/contracts/deckhand/reviewerRpc";
import type { RunContext } from "@cinderdeck/contracts/deckhand/runsRpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Hub from "./IntegrationHub.ts";
import * as Runs from "./Runs.ts";
import * as Migrations from "./Migrations.ts";
import * as O from "./AttentionObservations.ts";
export class Attention extends Context.Service<
  Attention,
  {
    readonly list: (
      actor: string,
      input: C.AttentionListInput,
    ) => Effect.Effect<C.AttentionPage, C.AttentionError>;
    readonly change: (
      actor: string,
      input: C.AttentionChange,
    ) => Effect.Effect<C.AttentionItem, C.AttentionError>;
  }
>()("@cinderdeck/server/deckhand/Attention") {}
const Preference = Schema.Struct({
  read: Schema.Boolean,
  snoozedUntil: Schema.NullOr(Schema.String),
});
const decodePreference = Schema.decodeUnknownEffect(Schema.fromJsonString(Preference));
const encodePreference = Schema.encodeEffect(Schema.fromJsonString(Preference));
const encodeScopes = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeQueue = Schema.decodeUnknownEffect(Schema.fromJsonString(Queue.ReviewerQueueRecord));
const fail = (reason: C.AttentionError["reason"]) => new C.AttentionError({ reason });
const isAttentionError = Schema.is(C.AttentionError);
const wrap = (error: unknown) => (isAttentionError(error) ? error : fail("storage"));
const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const sql = yield* SqlClient.SqlClient;
  const projection = yield* Projection.ProjectionStoreV2;
  const hub = yield* Hub.IntegrationHub;
  const runs = yield* Runs.Runs;
  const clock = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const thread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const scopeKey = `thread:${threadId}`;
      const now = yield* clock;
      const shell = yield* projection.getThreadShell(threadId);
      if (!shell) {
        yield* O.reconcile(scopeKey, [], now, "unknown");
        return;
      }
      const present: string[] = [];
      const add = (
        kind: C.AttentionCause["kind"],
        version: unknown,
        title: string,
        detail: string,
        canSnooze = true,
      ) =>
        Effect.gen(function* () {
          const cause = yield* O.save({
            scopeKey,
            kind,
            causeVersion: O.digest(version),
            title: title.slice(0, 200),
            detail: detail.slice(0, 1200),
            severity: kind === "agent_failure" ? "error" : "info",
            target: {
              kind: "thread",
              threadId,
              ...(shell.pendingRuntimeRequest && ["approval", "input", "auth"].includes(kind)
                ? { requestId: shell.pendingRuntimeRequest.id }
                : {}),
            },
            observedAt: now,
            canSnooze,
          });
          present.push(cause.id);
        });
      if (shell.deletedAt) {
        yield* O.reconcile(scopeKey, [], now, "unknown");
        return;
      }
      const request = shell.pendingRuntimeRequest;
      if (request) {
        const kind =
          request.kind === "auth_refresh"
            ? "auth"
            : request.kind === "user_input"
              ? "input"
              : "approval";
        yield* add(
          kind,
          [request.id, request.kind, DateTime.formatIso(request.createdAt)],
          kind === "auth"
            ? "Sign-in is needed"
            : kind === "input"
              ? "Your input is needed"
              : "Approval needed",
          `${shell.title}: open the conversation to respond to this exact request.`,
          false,
        );
      }
      if (shell.hasActionableProposedPlan) {
        const plans = (yield* projection.getThreadRecords(threadId, ["plans"])).plans.filter(
          (p) => p.kind === "proposed_plan" && p.status === "active",
        );
        if (plans.length)
          yield* add(
            "plan",
            plans,
            "Plan ready for review",
            `${shell.title}: review the proposed plan in its original conversation.`,
          );
      }
      if (shell.status === "failed" || shell.lastError)
        yield* add(
          "agent_failure",
          [shell.latestRunId, shell.status, shell.lastError],
          "Agent needs attention",
          `${shell.title}: ${shell.lastError ?? "The last agent run failed."}`,
        );
      yield* O.reconcile(scopeKey, present, now);
    });
  const nativeRuns = (actor: string, context: RunContext, runIDs?: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const scopeKey = `runs:${O.digest(context)}`;
      const now = yield* clock;
      const value = yield* runs.failures(actor, { ...context, ...(runIDs ? { runIDs } : {}) });
      if (value.storageError) return yield* fail("source_unavailable");
      const resolutions = new Map(value.resolutions.map((proof) => [proof.runID, proof]));
      const present = new Set<string>();
      const cachedRows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_attention WHERE json_extract(record_json,'$.scopeKey') IN (SELECT value FROM json_each(${encodeScopes(value.runs.map((run) => `${scopeKey}:${run.id}`))})) AND entity_id='*'`;
      const cached = yield* Effect.forEach(cachedRows, (row) => O.decodeCause(row.record_json));
      const previous = new Map(cached.map((cause) => [cause.scopeKey, cause]));
      for (const run of value.runs) {
        const scope = `${scopeKey}:${run.id}`;
        const proof = resolutions.get(run.id);
        const old = previous.get(scope);
        const savedProof =
          old?.state === "resolved" &&
          old.target.kind === "runs" &&
          old.target.resolvedByRunID &&
          old.causeVersion === O.digest([run.causeVersion, old.target.resolvedByRunID])
            ? { resolvedByRunID: old.target.resolvedByRunID }
            : null;
        // A bounded proof window cannot undo a previously proven resolution of this same outcome.
        const resolved = proof?.causeVersion === run.causeVersion ? proof : savedProof;
        yield* O.save({
          scopeKey: scope,
          kind: "run_failure",
          causeVersion: resolved
            ? O.digest([run.causeVersion, resolved.resolvedByRunID])
            : run.causeVersion,
          title: `${run.name} ${run.status}`.slice(0, 200),
          detail: resolved
            ? "A matching explicit rerun succeeded. The original failed run remains saved as history."
            : (run.detail ?? "Inspect the saved steps and logs for this run.").slice(0, 1200),
          severity: "error",
          target: {
            kind: "runs",
            context,
            runID: run.id,
            ...(resolved ? { resolvedByRunID: resolved.resolvedByRunID } : {}),
          },
          observedAt: now,
          state: resolved ? "resolved" : "active",
          canSnooze: true,
        });
        present.add(run.id);
      }
      // A positive source-owned resolution can also update an older retained cause.
      for (const proof of value.resolutions) {
        if (present.has(proof.runID)) continue;
        const scope = `${scopeKey}:${proof.runID}`;
        const rows = yield* sql<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_attention WHERE json_extract(record_json,'$.scopeKey')=${scope} AND entity_id='*'`;
        for (const row of rows) {
          const cause = yield* O.decodeCause(row.record_json);
          const version = O.digest([proof.causeVersion, proof.resolvedByRunID]);
          if (cause.causeVersion !== proof.causeVersion && cause.causeVersion !== version) continue;
          if (cause.target.kind !== "runs") continue;
          yield* O.save({
            ...cause,
            causeVersion: version,
            state: "resolved",
            observedAt: now,
            detail:
              "A matching explicit rerun succeeded. The original failed run remains saved as history.",
            target: { ...cause.target, resolvedByRunID: proof.resolvedByRunID },
          });
        }
      }
      // Missing exact targets cannot authorize a preference change or fabricate completion.
      const missing = runIDs?.filter((id) => !present.has(id) && !resolutions.has(id)) ?? [];
      for (const id of missing) yield* O.reconcile(`${scopeKey}:${id}`, [], now, "unknown");
      if (missing.length) return yield* fail("source_unavailable");
      // Runs omitted by the bounded default inventory are not proof of resolution.
    });
  const connection = Effect.gen(function* () {
    const now = yield* clock;
    const value = yield* hub.overview({ offset: 0, limit: 1 });
    const registered = yield* sql<{
      id: string;
    }>`SELECT id FROM deckhand_workspaces WHERE json_extract(record_json,'$.backend')='cinderdeck' LIMIT 1`;
    if (!value.hello && !registered.length) return;
    const present: string[] = [];
    if (value.state !== "connected") {
      yield* O.unavailable("runs", now);
      const cause = yield* O.save({
        scopeKey: "native_connection",
        kind: "connection",
        causeVersion: O.digest([value.state, value.hello?.installationID, value.error]),
        title: "Cinderdeck needs attention",
        detail: `Native connection is ${value.state.replaceAll("_", " ")}. Reconnect the matching Cinderdeck installation to refresh its workspaces.`,
        severity: "warning",
        target: { kind: "connection" },
        observedAt: now,
        canSnooze: true,
      });
      present.push(cause.id);
    }
    yield* O.reconcile("native_connection", present, now);
  });
  const reviews = (actor: string, operationKey?: string) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        record_json: string;
      }>`SELECT record_json FROM deckhand_reviewer_queue WHERE actor_id=${actor} ${operationKey ? sql`AND operation_key=${operationKey}` : sql``} ORDER BY updated_at DESC LIMIT 100`;
      const now = yield* clock;
      if (operationKey && !rows.length) {
        yield* O.reconcile(`review:${O.digest([actor, operationKey])}`, [], now, "unknown");
        return yield* fail("source_unavailable");
      }
      for (const row of rows) {
        const queue = yield* decodeQueue(row.record_json);
        const scopeKey = `review:${O.digest([actor, queue.operationKey])}`;
        const present: string[] = [];
        const threadId = queue.creation?.threadID ?? null;
        let kind: C.AttentionCause["kind"] | null = null;
        let version: unknown = queue;
        if (["failed", "needs_refresh", "unknown_outcome"].includes(queue.state))
          kind = "review_blocked";
        else if (queue.state === "accepted" && threadId) {
          const shell = yield* projection
            .getThreadShell(threadId)
            .pipe(Effect.orElseSucceed(() => null));
          if (!shell) {
            yield* O.reconcile(scopeKey, [], now, "unknown");
            continue;
          }
          if (
            shell.latestRunCompletedAt &&
            !shell.activeRunId &&
            !shell.pendingRuntimeRequest &&
            shell.status === "completed" &&
            (shell.pendingBackgroundTasks?.length ?? 0) === 0 &&
            !shell.lastError
          ) {
            kind = "review_ready";
            version = [
              queue.operationKey,
              queue.preview.reviewerContext,
              shell.latestRunId,
              DateTime.formatIso(shell.latestRunCompletedAt),
            ];
          }
        }
        if (kind) {
          const cause = yield* O.save(
            {
              scopeKey,
              kind,
              causeVersion: O.digest(version),
              title:
                kind === "review_ready" ? "Reviewer result is ready" : "Reviewer needs attention",
              detail: (kind === "review_ready"
                ? "The reviewer finished its agent run. Open its conversation to inspect the result and saved review context."
                : (queue.detail ?? "Inspect the saved scheduling request before retrying.")
              ).slice(0, 1200),
              severity: kind === "review_ready" ? "info" : "warning",
              target: {
                kind: "review",
                operationKey: queue.operationKey,
                threadId,
                baseWorkspaceID: queue.preview.workspaceID,
                context: {
                  installationID: queue.preview.installationID,
                  workspaceID: queue.preview.reviewerContext.sourceWorkspaceID,
                  generation: queue.preview.reviewerContext.sourceGeneration,
                },
              },
              observedAt: now,
              canSnooze: true,
            },
            actor,
          );
          present.push(cause.id);
        }
        yield* O.reconcile(scopeKey, present, now);
      }
    });
  type SavedPreference = { cause_version: string; revision: number; record_json: string };
  const preference = (
    actor: string,
    cause: C.AttentionCause,
    now: string,
    saved?: SavedPreference | null,
  ) =>
    Effect.gen(function* () {
      const row =
        saved === undefined
          ? (yield* sql<SavedPreference>`SELECT cause_version,revision,record_json FROM deckhand_attention_dispositions WHERE actor_id=${actor} AND attention_id=${cause.id}`)[0]
          : saved;
      const pref =
        row && row.cause_version === cause.causeVersion
          ? yield* decodePreference(row.record_json)
          : { read: false, snoozedUntil: null };
      return {
        ...cause,
        read: pref.read,
        snoozedUntil: pref.snoozedUntil && pref.snoozedUntil > now ? pref.snoozedUntil : null,
        dispositionRevision: row?.revision ?? 0,
        freshness:
          cause.state !== "unknown" &&
          Date.parse(now) - Date.parse(cause.observedAt) <
            (cause.kind === "verification" ? 300_000 : 75_000)
            ? ("current" as const)
            : ("last_observed" as const),
      };
    });
  const refreshTarget = (actor: string, target: C.AttentionCause["target"]) =>
    Effect.gen(function* () {
      switch (target.kind) {
        case "thread":
          yield* thread(target.threadId);
          break;
        case "runs":
          yield* nativeRuns(actor, target.context, [target.runID]);
          break;
        case "review":
          yield* reviews(actor, target.operationKey);
          break;
        case "connection":
          yield* connection;
          break;
        case "verification":
          break;
      }
    });
  const list: Attention["Service"]["list"] = (actor, input) =>
    Effect.gen(function* () {
      const warnings: string[] = [];
      const refresh = <E, R>(
        effect: Effect.Effect<unknown, E, R>,
        label: string,
        scopeKey?: string,
      ) =>
        effect.pipe(
          Effect.catch(() =>
            Effect.gen(function* () {
              const warning = `${label} could not be refreshed. Saved items remain last observed.`;
              if (warnings.length < 32 && !warnings.includes(warning)) warnings.push(warning);
              if (scopeKey) yield* O.unavailable(scopeKey, yield* clock);
            }),
          ),
        );
      yield* Effect.forEach(
        [...new Set(input.threadIds)],
        (id) => refresh(thread(id), "Conversation", `thread:${id}`),
        { concurrency: 4 },
      );
      yield* Effect.forEach(
        input.nativeContexts,
        (context) =>
          refresh(nativeRuns(actor, context), "Native runs", `runs:${O.digest(context)}`),
        { concurrency: 2 },
      );
      yield* refresh(connection, "Cinderdeck", "native_connection");
      yield* refresh(reviews(actor), "Reviewer queue");
      const now = yield* clock;
      const snoozed = sql`COALESCE(p.cause_version=json_extract(a.record_json,'$.causeVersion') AND json_extract(p.record_json,'$.snoozedUntil')>${now},0)`;
      const filter =
        input.view === "history"
          ? sql`json_extract(a.record_json,'$.state')='resolved'`
          : sql`json_extract(a.record_json,'$.state')!='resolved' AND ${snoozed}=${input.view === "snoozed" ? 1 : 0}`;
      const totalRows = yield* sql<{
        total: number;
      }>`SELECT COUNT(*) AS total FROM deckhand_attention a LEFT JOIN deckhand_attention_dispositions p ON p.attention_id=a.id AND p.actor_id=${actor} WHERE (a.entity_id='*' OR a.entity_id=${actor}) AND ${filter}`;
      const rows = yield* sql<{
        record_json: string;
        preference_json: string | null;
        cause_version: string | null;
        preference_revision: number | null;
      }>`SELECT a.record_json,p.record_json AS preference_json,p.cause_version,p.revision AS preference_revision FROM deckhand_attention a LEFT JOIN deckhand_attention_dispositions p ON p.attention_id=a.id AND p.actor_id=${actor} WHERE (a.entity_id='*' OR a.entity_id=${actor}) AND ${filter} ORDER BY json_extract(a.record_json,'$.observedAt') DESC,a.id LIMIT ${input.limit} OFFSET ${input.offset}`;
      const items = yield* Effect.forEach(rows, (row) =>
        O.decodeCause(row.record_json).pipe(
          Effect.flatMap((cause) =>
            preference(
              actor,
              cause,
              now,
              row.preference_json && row.cause_version && row.preference_revision
                ? {
                    record_json: row.preference_json,
                    cause_version: row.cause_version,
                    revision: row.preference_revision,
                  }
                : null,
            ),
          ),
        ),
      );
      const total = totalRows[0]?.total ?? 0;
      return {
        items,
        total,
        nextOffset: input.offset + input.limit < total ? input.offset + input.limit : null,
        warnings,
        observedAt: now,
      };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(wrap));
  const change: Attention["Service"]["change"] = (actor, input) =>
    Effect.gen(function* () {
      const lookup = () =>
        sql<{
          record_json: string;
        }>`SELECT record_json FROM deckhand_attention WHERE id=${input.id} AND (entity_id='*' OR entity_id=${actor})`;
      let rows = yield* lookup();
      if (!rows[0]) return yield* fail("missing");
      const old = yield* O.decodeCause(rows[0].record_json);
      yield* refreshTarget(actor, old.target).pipe(
        Effect.mapError(() => fail("source_unavailable")),
      );
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          rows = yield* lookup();
          if (!rows[0]) return yield* fail("missing");
          const cause = yield* O.decodeCause(rows[0].record_json);
          const now = yield* clock;
          const item = yield* preference(actor, cause, now);
          if (cause.causeVersion !== input.causeVersion || cause.revision !== input.revision)
            return yield* fail("stale_cause");
          if (item.dispositionRevision !== input.dispositionRevision)
            return yield* fail("conflict");
          if (item.freshness !== "current") return yield* fail("source_unavailable");
          let read = item.read;
          let snoozedUntil = item.snoozedUntil;
          if (input.action === "read") read = true;
          else if (input.action === "unread") read = false;
          else if (input.action === "unsnooze") snoozedUntil = null;
          else {
            if (!cause.canSnooze || cause.state === "resolved")
              return yield* fail("snooze_blocked");
            if (
              !input.snoozedUntil ||
              !Number.isFinite(Date.parse(input.snoozedUntil)) ||
              Date.parse(input.snoozedUntil) <= Date.parse(now) ||
              Date.parse(input.snoozedUntil) > Date.parse(now) + 7 * 86400_000
            )
              return yield* fail("invalid_time");
            snoozedUntil = DateTime.formatIso(DateTime.makeUnsafe(Date.parse(input.snoozedUntil)));
          }
          const json = yield* encodePreference({ read, snoozedUntil });
          const updated = yield* sql<{
            revision: number;
          }>`INSERT INTO deckhand_attention_dispositions(actor_id,attention_id,cause_version,revision,record_json) VALUES(${actor},${cause.id},${cause.causeVersion},1,${json}) ON CONFLICT(actor_id,attention_id) DO UPDATE SET cause_version=excluded.cause_version,revision=deckhand_attention_dispositions.revision+1,record_json=excluded.record_json WHERE deckhand_attention_dispositions.revision=${input.dispositionRevision} RETURNING revision`;
          if (!updated[0]) return yield* fail("conflict");
          return { ...item, read, snoozedUntil, dispositionRevision: updated[0].revision };
        }),
      );
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.mapError(wrap));
  return Attention.of({ list, change });
});
export const layer = Layer.effect(Attention, make);
