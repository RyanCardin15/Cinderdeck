import * as ProcessRunner from "../processRunner.ts";
import * as Contracts from "@t3tools/contracts/deckhand/integration";
import * as Rpc from "@t3tools/contracts/deckhand/rpc";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as CinderdeckClient from "./CinderdeckClient.ts";
import * as OperationJournal from "./OperationJournal.ts";
import * as IntegrationDiscovery from "./IntegrationDiscovery.ts";

type Connection = Effect.Success<
  ReturnType<CinderdeckClient.CinderdeckClient["Service"]["connect"]>
>;
type Page = typeof Rpc.OverviewPageInput.Type;
export class IntegrationHub extends Context.Service<
  IntegrationHub,
  {
    readonly overview: (input: Page) => Effect.Effect<Rpc.IntegrationView, Rpc.DeckhandRpcError>;
    readonly subscribe: (input: Page) => Stream.Stream<Rpc.IntegrationView, Rpc.DeckhandRpcError>;
    readonly refresh: Effect.Effect<void, Rpc.DeckhandRpcError>;
    readonly resource: (workspaceID: string) => Effect.Effect<
      {
        readonly hello: Contracts.IntegrationHello;
        readonly resource: Contracts.IntegrationSnapshot["resources"][number];
      },
      Rpc.DeckhandRpcError
    >;
    readonly reserveWriter: (
      actorID: string,
      input: Contracts.IntegrationWriterReservationInput,
    ) => Effect.Effect<Contracts.IntegrationCheckoutReservation, Rpc.DeckhandRpcError>;
    readonly reservation: (
      actorID: string,
      input: Contracts.IntegrationReservationControl,
    ) => Effect.Effect<Contracts.IntegrationCheckoutReservation, Rpc.DeckhandRpcError>;
    readonly releaseWriter: (
      actorID: string,
      input: Contracts.IntegrationReservationControl,
    ) => Effect.Effect<Contracts.IntegrationCheckoutReservation, Rpc.DeckhandRpcError>;
    readonly submit: (
      actorID: string,
      input: Contracts.IntegrationOperationInput,
    ) => Effect.Effect<Contracts.IntegrationOperationReceipt, Rpc.DeckhandRpcError>;
    readonly operations: (
      actorID: string,
    ) => Effect.Effect<ReadonlyArray<Rpc.OperationRecord>, Rpc.DeckhandRpcError>;
    readonly operation: (
      actorID: string,
      operationKey: string,
    ) => Effect.Effect<Contracts.IntegrationOperationReceipt, Rpc.DeckhandRpcError>;
  }
>()("t3/deckhand/IntegrationHub") {}
const encodeView = Schema.encodeEffect(Schema.fromJsonString(Rpc.IntegrationView));
const decodeView = Schema.decodeUnknownEffect(Schema.fromJsonString(Rpc.IntegrationView));
const isBridgeError = Schema.is(CinderdeckClient.BridgeError);
const isRpcError = Schema.is(Rpc.DeckhandRpcError);
const rpcError = (cause: unknown) =>
  isRpcError(cause)
    ? cause
    : isBridgeError(cause)
      ? new Rpc.DeckhandRpcError({
          reason: cause.reason,
          ...(cause.code ? { code: cause.code } : {}),
        })
      : new Rpc.DeckhandRpcError({ reason: "storage" });
const empty: Rpc.IntegrationView = {
  state: "connecting",
  hello: null,
  observedAt: null,
  error: null,
  resources: [],
  activity: [],
  total: 0,
  nextOffset: null,
};
const pageView = (view: Rpc.IntegrationView, page: Page): Rpc.IntegrationView => ({
  ...view,
  resources: view.resources.slice(page.offset, page.offset + page.limit),
  nextOffset: page.offset + page.limit < view.total ? page.offset + page.limit : null,
});
const validatePage = (page: Page) =>
  Number.isInteger(page.offset) &&
  page.offset >= 0 &&
  Number.isInteger(page.limit) &&
  page.limit > 0 &&
  page.limit <= 100;
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const client = yield* CinderdeckClient.CinderdeckClient;
  const journal = yield* OperationJournal.OperationJournal;
  const discovery = yield* IntegrationDiscovery.IntegrationDiscovery;
  const config = yield* IntegrationDiscovery.DiscoveryConfig;
  const scope = yield* Scope.Scope;
  const rows = yield* sql<{
    record_json: string;
  }>`SELECT record_json FROM deckhand_integrations WHERE channel = ${config.channel}`;
  const saved = rows[0] ? yield* decodeView(rows[0].record_json) : empty;
  const state = yield* SubscriptionRef.make<Rpc.IntegrationView>({
    ...saved,
    state: saved.hello ? "reconnecting" : "connecting",
  });
  const connection = yield* Ref.make<Option.Option<Connection>>(Option.none());
  const cursor = yield* Ref.make<string | null>(null);
  const refreshLock = yield* Semaphore.make(1);
  const watchersLock = yield* Semaphore.make(1);
  let watchers = 0;
  let worker: Fiber.Fiber<void, never> | null = null;
  const fail = (cause: unknown) =>
    Effect.gen(function* () {
      const error = rpcError(cause);
      yield* Ref.set(connection, Option.none());
      const old = yield* SubscriptionRef.get(state);
      const status: Rpc.IntegrationView["state"] =
        error.code === "unsupported_platform"
          ? "unsupported"
          : error.code === "installation_changed" ||
              error.code === "wrong_host" ||
              error.reason === "stale_binding"
            ? "identity_changed"
            : error.reason === "unauthorized_socket"
              ? "unauthorized"
              : error.reason === "invalid_response" ||
                  error.reason === "unsupported_capability" ||
                  error.reason === "peer_rejected" ||
                  error.reason === "storage"
                ? "incompatible"
                : "unavailable";
      yield* SubscriptionRef.set(state, {
        ...old,
        state: status,
        error: { reason: error.reason, ...(error.code ? { code: error.code } : {}) },
      });
    });
  const refresh = refreshLock.withPermits(1)(
    Effect.gen(function* () {
      const location = yield* discovery.locate;
      const old = yield* SubscriptionRef.get(state);
      const peer = yield* client.connect(location.socketPath, {
        channel: location.channel,
        executionHostID: location.hostID,
        ...(old.hello ? { installationID: old.hello.installationID } : {}),
      });
      const limit = Math.min(peer.hello.maximumPageSize, 500);
      const first = yield* client.snapshot(peer, { limit });
      if (first.total > 5000)
        return yield* new Rpc.DeckhandRpcError({
          reason: "invalid_response",
          code: "catalog_limit",
        });
      const resources = [...first.resources];
      let offset = first.nextOffset;
      while (offset !== undefined && offset !== null) {
        if (offset !== resources.length)
          return yield* new Rpc.DeckhandRpcError({ reason: "invalid_response" });
        const next = yield* client.snapshot(peer, { offset, limit, expectedCursor: first.cursor });
        if (next.cursor !== first.cursor || next.total !== first.total || !next.resources.length)
          return yield* new Rpc.DeckhandRpcError({ reason: "invalid_response" });
        resources.push(...next.resources);
        offset = next.nextOffset;
      }
      if (
        resources.length !== first.total ||
        new Set(resources.map((resource) => resource.workspaceID)).size !== resources.length
      )
        return yield* new Rpc.DeckhandRpcError({ reason: "invalid_response" });
      const view: Rpc.IntegrationView = {
        state: "connected",
        hello: peer.hello,
        observedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        error: null,
        resources,
        activity: old.activity,
        total: first.total,
        nextOffset: null,
      };
      const encoded = yield* encodeView(view);
      if (new TextEncoder().encode(encoded).byteLength > 4 * 1024 * 1024)
        return yield* new Rpc.DeckhandRpcError({
          reason: "invalid_response",
          code: "catalog_limit",
        });
      yield* sql`INSERT INTO deckhand_integrations(channel, installation_id, host_id, record_json)
      VALUES(${location.channel}, ${peer.hello.installationID}, ${peer.hello.executionHostID}, ${encoded})
      ON CONFLICT(channel) DO UPDATE SET record_json = excluded.record_json`;
      yield* Ref.set(connection, Option.some(peer));
      yield* Ref.set(cursor, first.cursor);
      yield* SubscriptionRef.set(state, view);
    }).pipe(Effect.mapError(rpcError), Effect.tapError(fail)),
  );
  const observeEvents = (batch: Contracts.IntegrationEvents) =>
    Effect.gen(function* () {
      const old = yield* SubscriptionRef.get(state);
      let last = 0;
      const seen = new Set(old.activity.map((event) => event.eventID));
      const added: Contracts.IntegrationEvents["events"][number][] = [];
      for (const event of batch.events) {
        if (event.sourceID !== batch.installationID || event.sequence <= last)
          return yield* new Rpc.DeckhandRpcError({ reason: "invalid_response" });
        last = event.sequence;
        if (!seen.has(event.eventID)) {
          added.push(event);
          seen.add(event.eventID);
        }
      }
      if (added.length)
        yield* SubscriptionRef.set(state, {
          ...old,
          activity: [...old.activity, ...added].slice(-30),
        });
      if (batch.resyncRequired || batch.events.length) yield* refresh;
    });
  const loop = Effect.gen(function* () {
    let failures = 0;
    while (true) {
      const result = yield* Effect.gen(function* () {
        let peer = yield* Ref.get(connection);
        if (Option.isNone(peer)) {
          yield* refresh;
          peer = yield* Ref.get(connection);
        }
        const after = yield* Ref.get(cursor);
        if (Option.isNone(peer) || after === null) return;
        const waitMs = Math.min(peer.value.hello.maximumWaitMs, 25000);
        const batch = yield* client.events(peer.value, {
          after,
          limit: Math.min(500, peer.value.hello.maximumPageSize),
          waitMs,
        });
        yield* observeEvents(batch);
        if (waitMs < 1000 && !batch.events.length) yield* Effect.sleep(Duration.seconds(1));
      }).pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* fail(result.failure);
        failures += 1;
        yield* Effect.sleep(Duration.seconds(Math.min(30, 2 ** Math.min(failures - 1, 5))));
      } else {
        failures = 0;
      }
    }
  });
  const subscribe = (page: Page) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (!validatePage(page))
          return yield* new Rpc.DeckhandRpcError({ reason: "invalid_request" });
        yield* Effect.acquireRelease(
          watchersLock.withPermits(1)(
            Effect.gen(function* () {
              watchers += 1;
              if (!worker) worker = yield* loop.pipe(Effect.forkIn(scope));
            }),
          ),
          () =>
            watchersLock.withPermits(1)(
              Effect.gen(function* () {
                watchers -= 1;
                if (!watchers && worker) {
                  yield* Fiber.interrupt(worker);
                  worker = null;
                  yield* Ref.set(connection, Option.none());
                  yield* Ref.set(cursor, null);
                  yield* SubscriptionRef.update(state, (view): Rpc.IntegrationView => ({
                    ...view,
                    state: view.hello ? "reconnecting" : "connecting",
                  }));
                }
              }),
            ),
        );
        return SubscriptionRef.changes(state).pipe(Stream.map((view) => pageView(view, page)));
      }),
    );
  const overview = (page: Page) =>
    validatePage(page)
      ? SubscriptionRef.get(state).pipe(Effect.map((view) => pageView(view, page)))
      : Effect.fail(new Rpc.DeckhandRpcError({ reason: "invalid_request" }));
  const commandConnection = (actorID: string) =>
    Effect.gen(function* () {
      const peer = yield* Ref.get(connection);
      const view = yield* SubscriptionRef.get(state);
      if (Option.isNone(peer) || view.state !== "connected")
        return yield* new Rpc.DeckhandRpcError({ reason: "unavailable" });
      if (!actorID || actorID.length > 60)
        return yield* new Rpc.DeckhandRpcError({ reason: "invalid_request" });
      // Recheck the peer epoch on a separate command connection before every mutation or reconciliation.
      return yield* client.connect(peer.value.socketPath, {
        installationID: peer.value.hello.installationID,
        executionHostID: peer.value.hello.executionHostID,
        channel: peer.value.hello.channel,
        clientID: actorID,
      });
    }).pipe(Effect.mapError(rpcError));
  const reconcile = (actorID: string, key: string) =>
    Effect.gen(function* () {
      const old = yield* journal.read(actorID, key);
      if (old.refused)
        return yield* new Rpc.DeckhandRpcError({
          reason: "operation_refused",
          ...(old.error?.code ? { code: old.error.code } : {}),
        });
      const peer = yield* commandConnection(actorID);
      if (old.input.installationID !== peer.hello.installationID)
        return yield* new Rpc.DeckhandRpcError({ reason: "stale_binding" });
      const receipt = yield* client.operation(peer, key).pipe(
        Effect.mapError(rpcError),
        Effect.tapError((error) => journal.update(actorID, key, null, error)),
      );
      yield* journal.update(actorID, key, receipt, null);
      return (yield* journal.read(actorID, key)).receipt ?? receipt;
    }).pipe(Effect.mapError(rpcError));
  const writerCommand = (
    method: "reserveWriter" | "reservation" | "releaseWriter",
    actorID: string,
    input: Contracts.IntegrationWriterReservationInput | Contracts.IntegrationReservationControl,
  ) =>
    Effect.gen(function* () {
      const peer = yield* commandConnection(actorID);
      if (input.installationID !== peer.hello.installationID)
        return yield* new Rpc.DeckhandRpcError({ reason: "stale_binding" });
      return yield* method === "reserveWriter" && "repos" in input
        ? client.reserveWriter(peer, input)
        : method === "releaseWriter"
          ? client.releaseWriter(peer, input)
          : client.reservation(peer, input);
    }).pipe(Effect.mapError(rpcError));
  return IntegrationHub.of({
    reserveWriter: (actorID, input) => writerCommand("reserveWriter", actorID, input),
    reservation: (actorID, input) => writerCommand("reservation", actorID, input),
    releaseWriter: (actorID, input) => writerCommand("releaseWriter", actorID, input),
    resource: (workspaceID) =>
      Effect.gen(function* () {
        yield* refresh;
        const view = yield* SubscriptionRef.get(state);
        if (view.state !== "connected" || view.hello === null)
          return yield* new Rpc.DeckhandRpcError({ reason: "unavailable" });
        const resource = view.resources.find((item) => item.workspaceID === workspaceID);
        if (!resource?.available || !resource.workspace)
          return yield* new Rpc.DeckhandRpcError({ reason: "stale_binding" });
        return { hello: view.hello, resource };
      }),
    overview,
    subscribe,
    refresh,
    operations: (actorID) =>
      SubscriptionRef.get(state).pipe(
        Effect.flatMap((view) =>
          view.hello ? journal.list(actorID, view.hello.installationID) : Effect.succeed([]),
        ),
      ),
    submit: (actorID, input) =>
      Effect.gen(function* () {
        const peer = yield* commandConnection(actorID);
        if (input.installationID !== peer.hello.installationID)
          return yield* new Rpc.DeckhandRpcError({ reason: "stale_binding" });
        // Once intent is durable, even an interrupted request must reconcile instead of resubmitting.
        const fresh = yield* journal.claim(actorID, input);
        if (!fresh) return yield* reconcile(actorID, input.operationKey);
        const receipt = yield* client.submit(peer, input).pipe(
          Effect.mapError(rpcError),
          Effect.tapError((error) =>
            journal.update(
              actorID,
              input.operationKey,
              null,
              error,
              error.reason === "peer_rejected" &&
                [
                  "invalid_params",
                  "stale_revision",
                  "resource_missing",
                  "installation_changed",
                  "operation_conflict",
                  "unauthorized_operation",
                ].includes(error.code ?? ""),
            ),
          ),
        );
        yield* journal.update(actorID, input.operationKey, receipt, null);
        return (yield* journal.read(actorID, input.operationKey)).receipt ?? receipt;
      }).pipe(Effect.mapError(rpcError)),
    operation: reconcile,
  });
}).pipe(Effect.mapError(rpcError));
export const layer = Layer.effect(IntegrationHub, make);

export const layerLive = layer.pipe(
  Layer.provide(CinderdeckClient.layer),
  Layer.provide(OperationJournal.layer),
  Layer.provide(
    IntegrationDiscovery.layer.pipe(
      Layer.provideMerge(IntegrationDiscovery.configLayer),
      Layer.provide(IntegrationDiscovery.hostLayer.pipe(Layer.provide(ProcessRunner.layer))),
    ),
  ),
);
