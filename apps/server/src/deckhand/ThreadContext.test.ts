import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as Contracts from "@t3tools/contracts/deckhand";
import type { IntegrationView, ManagedSessionView } from "@t3tools/contracts/deckhand/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Relationships from "./Relationships.ts";
import * as ManagedSessions from "./ManagedSessions.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as ThreadContext from "./ThreadContext.ts";
const threadId = ThreadId.make("thread");
const instanceId = ProviderInstanceId.make("codex-account");

const baseLayer = Relationships.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const decodeWorkspace = Schema.decodeUnknownEffect(Contracts.WorkspaceBinding);
const decodeCheckout = Schema.decodeUnknownEffect(Contracts.CheckoutBinding);
const decodeFeature = Schema.decodeUnknownEffect(Contracts.Feature);
const decodeSession = Schema.decodeUnknownEffect(Contracts.SessionBinding);
const seed = Effect.gen(function* () {
  const store = yield* Relationships.Relationships;
  const workspace = yield* decodeWorkspace({
    id: "workspace",
    environmentId: "installation",
    backend: "cinderdeck",
    ownerId: "payment",
    generation: 2,
    revision: 1,
    name: "Payment",
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
        repositoryPhysicalId: "repository",
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
    title: "Payment retry",
    objective: "Verify retry",
    status: "active",
    revision: 1,
    createdAt: "now",
    updatedAt: "now",
  });
  const session = yield* decodeSession({
    id: "session",
    threadId,
    providerSessionId: null,
    providerInstanceId: instanceId,
    featureId: "feature",
    checkoutId: "checkout",
    repositoryScope: ["physical"],
    role: "writer",
    desiredAccess: "write",
    execution: "queued",
    connection: "connected",
    lastSequence: 0,
    capabilities: {
      nativeResume: true,
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
  yield* store.putWorkspace(workspace, null);
  yield* store.putCheckout(checkout, null);
  yield* store.putFeature(feature, null);
  yield* store.linkCheckout("feature", "checkout", true);
  yield* store.putSession(session, null);
});

const view: IntegrationView = {
  state: "connected",
  hello: {
    installationID: "installation",
    executionHostID: "host",
    protocolVersion: 1,
    channel: "development",
    runtimeEpoch: "epoch",
    capabilities: [],
    maximumFrameBytes: 10000,
    maximumPageSize: 100,
    maximumWaitMs: 0,
  },
  observedAt: "now",
  error: null,
  total: 1,
  nextOffset: null,
  activity: [],
  resources: [
    {
      workspaceID: "lane",
      generation: 7,
      revision: "head",
      available: true,
      workspace: {
        id: "lane",
        name: "Retry",
        file: "/fixture/t3.json",
        state: "running",
        definitionChanged: false,
        issues: [],
        repos: [],
        services: [
          {
            name: "web",
            phase: "ready",
            status: "running",
            ready: true,
            dependsOn: [],
            url: "http://localhost:3101",
          },
        ],
      },
    },
  ],
};
const fixture = (native = view, showSession = true) => {
  const projection = Layer.mock(ManagedSessions.ManagedSessions)({
    subscribe: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const binding = yield* decodeSession({
            id: "session",
            threadId,
            providerSessionId: null,
            providerInstanceId: instanceId,
            featureId: "feature",
            checkoutId: "checkout",
            repositoryScope: ["physical"],
            role: "writer",
            desiredAccess: "write",
            execution: "queued",
            connection: "connected",
            lastSequence: 0,
            capabilities: {
              nativeResume: true,
              interrupt: false,
              steering: false,
              approvals: false,
              questions: false,
              enforcedReadOnly: false,
              imageInput: false,
              videoInput: false,
              managed: true,
            },
          }).pipe(Effect.orDie);
          return Stream.make(
            showSession
              ? [
                  {
                    binding: { ...binding, execution: "working" as const },
                    title: "Retry",
                    source: "current" as const,
                    archived: false,
                  } satisfies ManagedSessionView,
                ]
              : [],
          );
        }),
      ),
  });
  const nativeLayer = Layer.mock(IntegrationHub.IntegrationHub)({
    overview: () => Effect.succeed(native),
    resource: () => Effect.fail({ reason: "offline" } as never),
    subscribe: () => Stream.make(native),
  });
  return ThreadContext.layer.pipe(
    Layer.provide(projection),
    Layer.provide(nativeLayer),
    Layer.provideMerge(baseLayer),
  );
};
describe("connected conversation context", () => {
  it.effect("resolves saved lane identity with live provider state and exact service target", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ThreadContext.ThreadContext;
      const [context] = yield* service
        .subscribe({ threadId })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.ok(context);
      assert.equal(context.feature.title, "Payment retry");
      assert.equal(context.checkout.laneId, "lane");
      assert.equal(context.workspace.ownerId, "payment");
      assert.equal(context.session.execution, "working");
      assert.equal(context.native?.workspace?.services[0]?.url, "http://localhost:3101");
    }).pipe(Effect.provide(fixture())),
  );
  it.effect("keeps saved breadcrumbs while refusing another native generation", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ThreadContext.ThreadContext;
      const [context] = yield* service
        .subscribe({ threadId })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.ok(context);
      assert.equal(context.checkout.nativeGeneration, 7);
      assert.equal(context.native, null);
    }).pipe(
      Effect.provide(
        fixture({ ...view, resources: view.resources.map((item) => ({ ...item, generation: 8 })) }),
      ),
    ),
  );
  it.effect("refuses another installation and never reuses stale provider working state", () =>
    Effect.gen(function* () {
      yield* seed;
      const service = yield* ThreadContext.ThreadContext;
      const [context] = yield* service
        .subscribe({ threadId })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.ok(context);
      assert.equal(context.native, null);
      assert.equal(context.nativeConnection, "identity_changed");
      assert.equal(context.session.execution, "unknown");
      assert.equal(context.session.connection, "unavailable");
    }).pipe(
      Effect.provide(
        fixture(
          { ...view, hello: { ...view.hello!, installationID: "other-installation" } },
          false,
        ),
      ),
    ),
  );
  it.effect("leaves unbound upstream conversations intact", () =>
    Effect.gen(function* () {
      const service = yield* ThreadContext.ThreadContext;
      const [context] = yield* service
        .subscribe({ threadId: ThreadId.make("unbound") })
        .pipe(Stream.runCollect);
      assert.equal(context, null);
    }).pipe(Effect.provide(fixture())),
  );
});
