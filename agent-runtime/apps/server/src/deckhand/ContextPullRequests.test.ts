import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@cinderdeck/shared/nodeSqliteClient";
import * as C from "@cinderdeck/contracts/deckhand";
import * as Managed from "./ManagedSessions.ts";
import * as Relationships from "./Relationships.ts";
import * as Hub from "./IntegrationHub.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as External from "./ExternalSessions.ts";
const scope = {
  installationID: "installation",
  workspaceID: "lane",
  generation: 7,
  offset: 0,
  limit: 50,
};
const native = {
  state: "connected",
  hello: { installationID: "installation", runtimeEpoch: "epoch" },
  resources: [
    {
      workspaceID: "lane",
      generation: 7,
      available: true,
      workspace: { issues: [], definitionChanged: false },
    },
  ],
};
const database = Relationships.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const dependencies = Layer.mergeAll(
  database,
  Layer.mock(Projection.ProjectionStoreV2)({}),
  Layer.mock(Events.EventSinkV2)({
    latestSequence: () => Effect.succeed(8),
    stream: () => Stream.empty,
  }),
  Layer.mock(External.ExternalSessions)({}),
);
const service = Managed.layer.pipe(Layer.provideMerge(dependencies));
const hub = (freshGeneration = 7) =>
  Layer.mock(Hub.IntegrationHub)({
    freshResource: () =>
      Effect.succeed({
        hello: native.hello,
        resource: { ...native.resources[0], generation: freshGeneration },
      } as never),
    currentResources: () => Effect.succeed(native as never),
    subscribe: () => Stream.empty,
  });
const link = (host: string, number: number, source = "manual") => ({
  host,
  repository: "owner/app",
  number,
  url: `https://${host}/owner/app/pull/${number}`,
  source,
  linkedAt: "2026-10-04T00:00:00.000Z",
  snapshot: null,
  stack: null,
});
const decodeWorkspace = Schema.decodeUnknownEffect(C.WorkspaceBinding);
const decodeCheckout = Schema.decodeUnknownEffect(C.CheckoutBinding);
const decodeFeature = Schema.decodeUnknownEffect(C.Feature);
const decodeSession = Schema.decodeUnknownEffect(C.SessionBinding);
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const seed = Effect.gen(function* () {
  const store = yield* Relationships.Relationships;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,payload_json TEXT,deleted_at TEXT)`;
  const workspace = yield* decodeWorkspace({
    id: "workspace",
    environmentId: "installation",
    backend: "cinderdeck",
    ownerId: "base",
    generation: 2,
    revision: 1,
    name: "Base",
    state: "active",
  });
  const checkout = yield* decodeCheckout({
    id: "checkout",
    workspaceId: "workspace",
    environmentId: "installation",
    backend: "cinderdeck",
    workspaceGeneration: 2,
    nativeGeneration: 7,
    revision: 1,
    kind: "lane",
    laneId: "lane",
    state: "ready",
    repositories: [
      {
        physicalId: "physical",
        repositoryPhysicalId: "repo",
        root: "/fixture/lane",
        commonDirectory: "/fixture/.git",
        gitDirectory: "/fixture/.git/worktrees/lane",
        branch: "lane",
        commit: null,
        remotes: [],
      },
    ],
  });
  const feature = yield* decodeFeature({
    id: "feature",
    workspaceId: "workspace",
    title: "Feature",
    objective: "Check",
    status: "active",
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
  });
  yield* store.putWorkspace(workspace, null);
  yield* store.putCheckout(checkout, null);
  yield* store.putFeature(feature, null);
  yield* store.linkCheckout("feature", "checkout", true);
  for (let i = 0; i < 25; i++) {
    const threadId = `thread-${i}`;
    const session = yield* decodeSession({
      id: `session-${i}`,
      threadId,
      providerSessionId: null,
      providerInstanceId: "codex",
      featureId: "feature",
      checkoutId: "checkout",
      repositoryScope: ["physical"],
      role: "writer",
      desiredAccess: "write",
      execution: "idle",
      connection: "unavailable",
      lastSequence: 0,
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
    });
    yield* store.putSession(session, null);
    const pullRequests =
      i === 0
        ? [link("github.com", 1), link("enterprise.example", 1)]
        : i === 24
          ? [link("github.com", 1), link("github.com", 2), link("github.com", 3, "stack-dismissed")]
          : [];
    const payload = yield* encodePayload({
      id: threadId,
      projectId: i === 0 ? "project-old" : "project-new",
      archivedAt: i === 0 ? "2026-10-04T00:00:00.000Z" : null,
      pullRequests,
    });
    yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES(${threadId},${payload},NULL)`;
  }
  yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES('unbound',${yield* encodePayload({ projectId: "unbound-project", pullRequests: [link("github.com", 99)] })},NULL)`;
});
const page = (input = scope) =>
  Effect.gen(function* () {
    const managed = yield* Managed.ManagedSessions;
    const head = yield* managed.subscribePullRequests(input).pipe(Stream.take(1), Stream.runHead);
    assert(Option.isSome(head));
    return head.value;
  });
describe("exact context pull request history", () => {
  it.effect(
    "includes archived links beyond twenty sessions, deduplicates canonical identity and keeps host/multi-project boundaries",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const result = yield* page();
        assert.equal(result.total, 3);
        assert.equal(result.nextOffset, null);
        assert.deepEqual(
          result.items.map((item) => [item.link.host, item.link.number, item.projectId]),
          [
            ["enterprise.example", 1, "project-old"],
            ["github.com", 1, "project-new"],
            ["github.com", 2, "project-new"],
          ],
        );
      }).pipe(Effect.provide(Layer.merge(service, hub()))),
  );
  it.effect(
    "pages canonical links before limiting and reports the total on an empty later page",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const first = yield* page({ ...scope, limit: 1 });
        const next = yield* page({ ...scope, limit: 1, offset: 1 });
        const empty = yield* page({ ...scope, offset: 50 });
        assert.equal(first.total, 3);
        assert.equal(first.nextOffset, 1);
        assert.equal(next.items[0]?.link.host, "github.com");
        assert.equal(empty.total, 3);
        assert.deepEqual(empty.items, []);
        assert.equal(empty.nextOffset, null);
      }).pipe(Effect.provide(Layer.merge(service, hub()))),
  );
  it.effect(
    "refuses a replacement installation or generation instead of exposing unrelated links",
    () =>
      Effect.gen(function* () {
        yield* seed;
        for (const input of [
          { ...scope, installationID: "replacement" },
          { ...scope, generation: 8 },
        ]) {
          const result = yield* page(input).pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.equal(result.failure.reason, "source_unavailable");
        }
      }).pipe(Effect.provide(Layer.merge(service, hub()))),
  );
  it.effect(
    "refuses a freshly replaced generation even while the cached native catalogue retains the old generation",
    () =>
      Effect.gen(function* () {
        const result = yield* page().pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "source_unavailable");
      }).pipe(Effect.provide(Layer.merge(service, hub(8)))),
  );
  it.effect(
    "refuses a context replaced between the initial metadata read and native subscription registration",
    () => {
      let current = native;
      const changingHub = Layer.mock(Hub.IntegrationHub)({
        freshResource: () =>
          Effect.succeed({ hello: native.hello, resource: native.resources[0] } as never),
        currentResources: () => Effect.sync(() => current as never),
        subscribe: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              current = {
                ...native,
                resources: [{ ...native.resources[0]!, generation: 8 }],
              };
              return current as never;
            }),
          ),
      });
      return Effect.gen(function* () {
        yield* seed;
        const managed = yield* Managed.ManagedSessions;
        const result = yield* managed
          .subscribePullRequests(scope)
          .pipe(Stream.take(2), Stream.runCollect, Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "source_unavailable");
      }).pipe(Effect.provide(Layer.merge(service, changingHub)));
    },
  );
  it.effect("rejects oversized pages without reading source records", () =>
    Effect.gen(function* () {
      const result = yield* page({ ...scope, limit: 51 }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, "invalid_request");
    }).pipe(Effect.provide(Layer.merge(service, hub()))),
  );
});
