// @effect-diagnostics nodeBuiltinImport:off - Stable intent/report hashes and unguessable external IDs never grant process authority.
import * as NodeCrypto from "node:crypto";
import * as C from "@t3tools/contracts/deckhand/externalSessionsRpc";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Relationships from "./Relationships.ts";
import * as Hub from "./IntegrationHub.ts";
import * as Migrations from "./Migrations.ts";
export class ExternalSessions extends Context.Service<
  ExternalSessions,
  {
    readonly changes: Stream.Stream<void>;
    readonly changeVisibility: (
      actor: string,
      input: C.ExternalSessionVisibility,
    ) => Effect.Effect<C.ExternalSessionView, C.ExternalSessionError>;
    readonly summaries: (
      input: C.ExternalSessionSummaryInput,
    ) => Effect.Effect<ReadonlyArray<C.ExternalSessionSummary>, C.ExternalSessionError>;
    readonly register: (
      actor: string,
      input: C.ExternalSessionRegister,
    ) => Effect.Effect<C.ExternalSessionView, C.ExternalSessionError>;
    readonly heartbeat: (
      actor: string,
      input: C.ExternalSessionHeartbeat,
    ) => Effect.Effect<C.ExternalSessionView, C.ExternalSessionError>;
    readonly list: (
      input: C.ExternalSessionList,
    ) => Effect.Effect<ReadonlyArray<C.ExternalSessionView>, C.ExternalSessionError>;
  }
>()("t3/deckhand/ExternalSessions") {}
const fail = (reason: C.ExternalSessionError["reason"]) => new C.ExternalSessionError({ reason });
const isError = Schema.is(C.ExternalSessionError);
const wrap = (error: unknown) => (isError(error) ? error : fail("storage"));
const decodeNewRecord = Schema.decodeUnknownEffect(C.ExternalSessionRecord);
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(C.ExternalSessionRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(C.ExternalSessionRecord));
const decodeRegister = Schema.decodeUnknownEffect(C.ExternalSessionRegister, {
  onExcessProperty: "error",
});
const decodeHeartbeat = Schema.decodeUnknownEffect(C.ExternalSessionHeartbeat, {
  onExcessProperty: "error",
});
const decodeList = Schema.decodeUnknownEffect(C.ExternalSessionList, { onExcessProperty: "error" });
const encodeRegister = Schema.encodeEffect(Schema.fromJsonString(C.ExternalSessionRegister));
const decodeVisibility = Schema.decodeUnknownEffect(C.ExternalSessionVisibility, {
  onExcessProperty: "error",
});
const encodeVisibility = Schema.encodeEffect(Schema.fromJsonString(C.ExternalSessionVisibility));
const decodeSummary = Schema.decodeUnknownEffect(C.ExternalSessionSummaryInput, {
  onExcessProperty: "error",
});
const encodeSummaryTargets = Schema.encodeEffect(
  Schema.fromJsonString(C.ExternalSessionSummaryInput.fields.contexts),
);
const encodeHeartbeat = Schema.encodeEffect(Schema.fromJsonString(C.ExternalSessionHeartbeat));
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const actorValid = (actor: string) => actor.length > 0 && actor.length <= 256;
const leaseMs = 120_000;
type Row = {
  actor_id: string;
  argument_hash: string;
  report_hash: string | null;
  expires_at: number;
  record_json: string;
};
const make = Effect.gen(function* () {
  yield* Migrations.migrate;
  const sql = yield* SqlClient.SqlClient;
  const relationships = yield* Relationships.Relationships;
  const hub = yield* Hub.IntegrationHub;
  const changes = yield* PubSub.unbounded<void>();
  const publish = () => PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const iso = (value: number) => DateTime.formatIso(DateTime.makeUnsafe(value));
  const view = (
    record: C.ExternalSessionRecord,
    expiresAt: number,
    clock: number,
  ): C.ExternalSessionView => ({
    ...record,
    connection: clock < expiresAt ? "connected" : "stale",
    leaseSeconds: 120,
    control: {
      transcript: false,
      interrupt: false,
      resume: false,
      approvals: false,
      writerReservation: false,
    },
  });
  const nativeContext = (input: typeof C.ExternalSessionContext.Type | C.ExternalSessionList) =>
    Effect.gen(function* () {
      const native = yield* hub
        .resource(input.workspaceID)
        .pipe(Effect.mapError(() => fail("source_unavailable")));
      if (
        native.hello.installationID !== input.installationID ||
        native.resource.generation !== input.generation ||
        !native.resource.available
      )
        return yield* fail("stale");
    });
  // Refresh owns the Hub lock and writes its snapshot through this same SQL
  // connection. Never await it while holding a registry transaction: an event
  // refresh (including writer release) would otherwise wait on our SQL lock.
  const currentNativeContext = (input: typeof C.ExternalSessionContext.Type) =>
    Effect.gen(function* () {
      const native = yield* hub.currentResources([input.workspaceID]);
      if (native.state !== "connected" || !native.hello) return yield* fail("source_unavailable");
      const resource = native.resources.find((item) => item.workspaceID === input.workspaceID);
      if (
        native.hello.installationID !== input.installationID ||
        resource?.generation !== input.generation ||
        !resource.available
      )
        return yield* fail("stale");
    }).pipe(Effect.mapError(wrap));
  const context = (
    input: typeof C.ExternalSessionContext.Type,
    repositoryScope?: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      yield* currentNativeContext(input);
      const feature = yield* relationships
        .feature(input.featureId)
        .pipe(Effect.mapError(() => fail("wrong_context")));
      const checkout = yield* relationships
        .checkout(input.checkoutId)
        .pipe(Effect.mapError(() => fail("wrong_context")));
      const parent = yield* relationships
        .workspace(checkout.workspaceId)
        .pipe(Effect.mapError(() => fail("wrong_context")));
      const source = yield* relationships
        .workspace(feature.workspaceId)
        .pipe(Effect.mapError(() => fail("wrong_context")));
      const links =
        yield* sql`SELECT checkout_id FROM deckhand_feature_checkouts WHERE feature_id=${input.featureId} AND checkout_id=${input.checkoutId}`;
      if (
        !links.length ||
        feature.status !== "active" ||
        checkout.state !== "ready" ||
        parent.state !== "active" ||
        source.state !== "active" ||
        checkout.backend !== "cinderdeck" ||
        parent.backend !== "cinderdeck" ||
        parent.environmentId !== input.installationID ||
        source.environmentId !== input.installationID ||
        checkout.environmentId !== input.installationID ||
        checkout.workspaceGeneration !== parent.generation ||
        checkout.nativeGeneration !== input.generation ||
        (checkout.laneId ?? parent.ownerId) !== input.workspaceID ||
        (repositoryScope &&
          (new Set(repositoryScope).size !== repositoryScope.length ||
            repositoryScope.some(
              (id) => !checkout.repositories.some((repo) => repo.physicalId === id),
            )))
      )
        return yield* fail("wrong_context");
    });
  const register: ExternalSessions["Service"]["register"] = (actor, payload) =>
    Effect.gen(function* () {
      if (!actorValid(actor)) return yield* fail("unauthorized");
      const input = yield* decodeRegister(payload).pipe(
        Effect.mapError(() => fail("invalid_request")),
      );
      const argumentHash = hash(yield* encodeRegister(input));
      yield* nativeContext(input);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* context(input, input.repositoryScope);
          const rows =
            yield* sql<Row>`SELECT actor_id,argument_hash,report_hash,expires_at,record_json FROM deckhand_external_sessions WHERE actor_id=${actor} AND operation_key=${input.operationKey}`;
          const clock = yield* now;
          if (rows[0]) {
            if (rows[0].argument_hash !== argumentHash) return yield* fail("stale");
            return view(yield* decodeRecord(rows[0].record_json), rows[0].expires_at, clock);
          }
          const count = yield* sql<{
            count: number;
          }>`SELECT count(*) AS count FROM deckhand_external_sessions WHERE actor_id=${actor}`;
          if ((count[0]?.count ?? 0) >= 200) return yield* fail("capacity");
          const duplicates =
            yield* sql`SELECT id FROM deckhand_external_sessions WHERE actor_id=${actor} AND checkout_id=${input.checkoutId} AND provider_name=${input.providerName} AND provider_session_id=${input.providerSessionId}`;
          if (duplicates.length) return yield* fail("stale");
          const record = yield* decodeNewRecord({
            ...input,
            id: `external:${NodeCrypto.randomUUID()}`,
            source: "registrant_reported",
            lastSequence: 0,
            registeredAt: iso(clock),
            lastSeenAt: iso(clock),
            expiresAt: iso(clock + leaseMs),
            archivedAt: null,
          });
          const encoded = yield* encodeRecord(record);
          yield* sql`INSERT INTO deckhand_external_sessions(id,actor_id,operation_key,argument_hash,feature_id,checkout_id,provider_name,provider_session_id,last_sequence,expires_at,record_json) VALUES(${record.id},${actor},${input.operationKey},${argumentHash},${input.featureId},${input.checkoutId},${input.providerName},${input.providerSessionId},0,${clock + leaseMs},${encoded})`;
          return view(record, clock + leaseMs, clock);
        }),
      );
    }).pipe(Effect.tap(publish), Effect.mapError(wrap));
  const heartbeatRecord = (actor: string, input: C.ExternalSessionHeartbeat) =>
    Effect.gen(function* () {
      const rows =
        yield* sql<Row>`SELECT actor_id,argument_hash,report_hash,expires_at,record_json FROM deckhand_external_sessions WHERE id=${input.id}`;
      if (!rows[0]) return yield* fail("missing");
      const row = rows[0];
      if (row.actor_id !== actor) return yield* fail("unauthorized");
      const old = yield* decodeRecord(row.record_json);
      if (
        old.installationID !== input.installationID ||
        old.workspaceID !== input.workspaceID ||
        old.generation !== input.generation ||
        old.featureId !== input.featureId ||
        old.checkoutId !== input.checkoutId
      )
        return yield* fail("wrong_context");
      if (old.archivedAt) return yield* fail("stale");
      return { row, old };
    });
  const heartbeat: ExternalSessions["Service"]["heartbeat"] = (actor, payload) =>
    Effect.gen(function* () {
      if (!actorValid(actor)) return yield* fail("unauthorized");
      const input = yield* decodeHeartbeat(payload).pipe(
        Effect.mapError(() => fail("invalid_request")),
      );
      const reportHash = hash(yield* encodeHeartbeat(input));
      // Refuse a foreign or retargeted registration before doing native I/O,
      // then reread under the transaction to preserve ownership and CAS.
      yield* heartbeatRecord(actor, input);
      yield* nativeContext(input);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const { row, old } = yield* heartbeatRecord(actor, input);
          yield* context(input, old.repositoryScope);
          const clock = yield* now;
          // A lost response can replay exactly; replay does not extend the original lease.
          if (old.lastSequence === input.sequence && row.report_hash === reportHash)
            return view(old, row.expires_at, clock);
          if (
            old.lastSequence !== input.expectedSequence ||
            input.sequence <= input.expectedSequence
          )
            return yield* fail("stale");
          const record: C.ExternalSessionRecord = {
            ...old,
            reportedExecution: input.reportedExecution,
            lastSequence: input.sequence,
            lastSeenAt: iso(clock),
            expiresAt: iso(clock + leaseMs),
          };
          const encoded = yield* encodeRecord(record);
          const updated =
            yield* sql`UPDATE deckhand_external_sessions SET last_sequence=${input.sequence},report_hash=${reportHash},expires_at=${clock + leaseMs},record_json=${encoded} WHERE id=${input.id} AND actor_id=${actor} AND last_sequence=${input.expectedSequence} RETURNING id`;
          if (!updated.length) return yield* fail("stale");
          return view(record, clock + leaseMs, clock);
        }),
      );
    }).pipe(Effect.tap(publish), Effect.mapError(wrap));
  const list: ExternalSessions["Service"]["list"] = (payload) =>
    Effect.gen(function* () {
      const input = yield* decodeList(payload).pipe(Effect.mapError(() => fail("invalid_request")));
      yield* nativeContext(input);
      const rows =
        yield* sql<Row>`SELECT e.actor_id,e.argument_hash,e.report_hash,e.expires_at,e.record_json FROM deckhand_external_sessions e JOIN deckhand_checkouts c ON c.id=e.checkout_id JOIN deckhand_workspaces w ON w.id=c.workspace_id WHERE w.environment_id=${input.installationID} AND w.backend='cinderdeck' AND json_extract(c.record_json,'$.nativeGeneration')=${input.generation} AND COALESCE(json_extract(c.record_json,'$.laneId'),w.owner_id)=${input.workspaceID} AND json_extract(e.record_json,'$.generation')=${input.generation} AND (${input.includeArchived ? 1 : 0} OR json_extract(e.record_json,'$.archivedAt') IS NULL) ORDER BY e.rowid DESC LIMIT ${input.limit}`;
      const clock = yield* now;
      return yield* Effect.forEach(rows, (row) =>
        decodeRecord(row.record_json).pipe(
          Effect.map((record) => view(record, row.expires_at, clock)),
        ),
      );
    }).pipe(Effect.mapError(wrap));
  const changeVisibility: ExternalSessions["Service"]["changeVisibility"] = (actor, payload) =>
    Effect.gen(function* () {
      if (!actorValid(actor)) return yield* fail("unauthorized");
      const input = yield* decodeVisibility(payload).pipe(
        Effect.mapError(() => fail("invalid_request")),
      );
      const eventHash = hash(yield* encodeVisibility(input));
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql<Row>`SELECT actor_id,argument_hash,report_hash,expires_at,record_json FROM deckhand_external_sessions WHERE id=${input.id}`;
          if (!rows[0]) return yield* fail("missing");
          const row = rows[0];
          if (row.actor_id !== actor) return yield* fail("unauthorized");
          const old = yield* decodeRecord(row.record_json);
          if (
            old.installationID !== input.installationID ||
            old.workspaceID !== input.workspaceID ||
            old.generation !== input.generation ||
            old.featureId !== input.featureId ||
            old.checkoutId !== input.checkoutId
          )
            return yield* fail("wrong_context");
          const clock = yield* now;
          // Visibility owns this saved registration even if its source checkout disappeared.
          // Archiving/restoring never changes process state, lastSeen or the heartbeat lease.
          if (old.lastSequence === input.expectedSequence + 1 && row.report_hash === eventHash)
            return view(old, row.expires_at, clock);
          if (old.lastSequence !== input.expectedSequence) return yield* fail("stale");
          if (Boolean(old.archivedAt) === input.archived) return view(old, row.expires_at, clock);
          const record: C.ExternalSessionRecord = {
            ...old,
            archivedAt: input.archived ? iso(clock) : null,
            lastSequence: old.lastSequence + 1,
          };
          const encoded = yield* encodeRecord(record);
          const updated =
            yield* sql`UPDATE deckhand_external_sessions SET last_sequence=${record.lastSequence},report_hash=${eventHash},record_json=${encoded} WHERE id=${input.id} AND actor_id=${actor} AND last_sequence=${input.expectedSequence} RETURNING id`;
          if (!updated.length) return yield* fail("stale");
          return view(record, row.expires_at, clock);
        }),
      );
    }).pipe(Effect.tap(publish), Effect.mapError(wrap));
  const summaries: ExternalSessions["Service"]["summaries"] = (payload) =>
    Effect.gen(function* () {
      const input = yield* decodeSummary(payload).pipe(
        Effect.mapError(() => fail("invalid_request")),
      );
      if (new Set(input.contexts.map((c) => c.workspaceID)).size !== input.contexts.length)
        return yield* fail("invalid_request");
      const targets = yield* encodeSummaryTargets(input.contexts);
      const clock = yield* now;
      const rows = yield* sql<{
        workspace_id: string;
        generation: number;
        active_count: number;
        stale_count: number;
        last_seen_at: string | null;
      }>`
      SELECT COALESCE(json_extract(c.record_json,'$.laneId'),w.owner_id) AS workspace_id,
        json_extract(c.record_json,'$.nativeGeneration') AS generation,COUNT(*) AS active_count,
        SUM(CASE WHEN e.expires_at<=${clock} THEN 1 ELSE 0 END) AS stale_count,
        MAX(json_extract(e.record_json,'$.lastSeenAt')) AS last_seen_at
      FROM deckhand_external_sessions e JOIN deckhand_checkouts c ON c.id=e.checkout_id JOIN deckhand_workspaces w ON w.id=c.workspace_id
      WHERE w.environment_id=${input.installationID} AND w.backend='cinderdeck'
        AND json_extract(e.record_json,'$.archivedAt') IS NULL
        AND json_extract(e.record_json,'$.generation')=json_extract(c.record_json,'$.nativeGeneration')
        AND EXISTS(SELECT 1 FROM json_each(${targets}) t WHERE json_extract(t.value,'$.workspaceID')=COALESCE(json_extract(c.record_json,'$.laneId'),w.owner_id) AND json_extract(t.value,'$.generation')=json_extract(c.record_json,'$.nativeGeneration'))
      GROUP BY COALESCE(json_extract(c.record_json,'$.laneId'),w.owner_id),json_extract(c.record_json,'$.nativeGeneration')`;
      const native = yield* hub.currentResources(
        input.contexts.map((target) => target.workspaceID),
      );
      return input.contexts.map((target) => {
        const resource = native.resources.find((item) => item.workspaceID === target.workspaceID);
        const unavailable =
          native.state !== "connected" ||
          native.hello?.installationID !== input.installationID ||
          resource?.generation !== target.generation ||
          !resource.available;
        const row = rows.find(
          (r) => r.workspace_id === target.workspaceID && r.generation === target.generation,
        );
        return {
          ...target,
          activeCount: row?.active_count ?? 0,
          staleCount: row?.stale_count ?? 0,
          lastSeenAt: row?.last_seen_at ?? null,
          unavailable,
        };
      });
    }).pipe(Effect.mapError(wrap));
  return ExternalSessions.of({
    register,
    heartbeat,
    list,
    changeVisibility,
    summaries,
    // Counts depend on the shared cached native catalog as well as registry writes.
    // A one-resource subscription retains the existing single Hub watcher and
    // invalidates startup/reconnect values without a native refresh per context.
    changes: Stream.mergeAll(
      [
        Stream.fromPubSub(changes),
        hub.subscribe({ offset: 0, limit: 1 }).pipe(
          Stream.map(() => undefined),
          Stream.catch(() => Stream.empty),
        ),
      ],
      { concurrency: 2 },
    ),
  });
});
export const layer = Layer.effect(ExternalSessions, make);
