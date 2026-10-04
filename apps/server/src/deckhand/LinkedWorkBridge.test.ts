import { DeckhandRpcError } from "@t3tools/contracts/deckhand/rpc";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as C from "@t3tools/contracts/deckhand";
import * as Linked from "@t3tools/contracts/deckhand/linkedWorkRpc";
import * as Native from "@t3tools/contracts/deckhand/integration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Relationships from "./Relationships.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as ManagedSessions from "./ManagedSessions.ts";
import * as RecordingTransport from "./RecordingTransport.ts";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Bridge from "./LinkedWorkBridge.ts";
const decodePublication = Schema.decodeUnknownSync(Linked.LinkedWorkPublication);
const session = Schema.decodeUnknownSync(C.SessionBinding)({
  id: "session",
  threadId: "thread",
  featureId: "feature",
  checkoutId: "checkout",
  providerSessionId: null,
  providerInstanceId: "codex",
  role: "writer",
  repositoryScope: ["a".repeat(64)],
  desiredAccess: "write",
  execution: "queued",
  connection: "unavailable",
  lastSequence: 0,
  capabilities: {
    nativeResume: true,
    interrupt: true,
    steering: false,
    approvals: true,
    questions: false,
    enforcedReadOnly: false,
    imageInput: false,
    videoInput: false,
    managed: true,
  },
});
const physical = Schema.decodeUnknownSync(C.PhysicalCheckout)({
  physicalId: "a".repeat(64),
  repositoryPhysicalId: "b".repeat(64),
  root: "/fixture/lane",
  gitDirectory: "/fixture/.git/worktrees/lane",
  commonDirectory: "/fixture/.git",
  commit: "c".repeat(40),
  branch: "feature",
  remotes: [],
});
const workspace = Schema.decodeUnknownSync(C.WorkspaceBinding)({
  id: "workspace",
  environmentId: "installation",
  backend: "cinderdeck",
  ownerId: "base",
  generation: 2,
  revision: 1,
  name: "Base",
  state: "active",
});
const checkout = Schema.decodeUnknownSync(C.CheckoutBinding)({
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
  repositories: [physical],
});
const feature = Schema.decodeUnknownSync(C.Feature)({
  id: "feature",
  workspaceId: "workspace",
  title: "Feature title",
  objective: "Implement",
  status: "active",
  revision: 1,
  createdAt: "now",
  updatedAt: "now",
});
const native = Schema.decodeUnknownSync(
  Schema.Struct({
    hello: Native.IntegrationHello,
    resource: Native.IntegrationSnapshot.fields.resources.value,
  }),
)({
  hello: {
    protocolVersion: 1,
    installationID: "installation",
    executionHostID: "host",
    channel: "development",
    runtimeEpoch: "epoch",
    capabilities: ["linked-work.projection"],
    maximumFrameBytes: 10000,
    maximumPageSize: 100,
    maximumWaitMs: 0,
  },
  resource: {
    workspaceID: "lane",
    generation: 7,
    revision: "revision",
    available: true,
    workspace: {
      id: "lane",
      name: "Lane",
      file: "/fixture/workspace.json",
      state: "running",
      definitionChanged: false,
      issues: [],
      services: [],
      repos: [
        {
          id: "frontend",
          path: physical.root,
          physicalID: physical.physicalId,
          repositoryPhysicalID: physical.repositoryPhysicalId,
          branch: "feature",
          dirty: false,
          changedFiles: 0,
          ahead: 0,
          behind: 0,
        },
      ],
    },
  },
});
const target = Schema.decodeUnknownSync(Linked.LinkedWorkTarget)({
  installation: "installation",
  workspace: "lane",
  generation: 7,
  session: "session",
  thread: "thread",
  environment: "environment",
});
const seed = Effect.gen(function* () {
  const relationships = yield* Relationships.Relationships;
  yield* relationships.putWorkspace(workspace, null);
  yield* relationships.putCheckout(checkout, null);
  yield* relationships.putFeature(feature, null);
  yield* relationships.linkCheckout(feature.id, checkout.id, true);
  yield* relationships.putSession(session, null);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO deckhand_managed_launches(operation_key,actor_id,input_json,record_json) VALUES ('launch','owner','{}','{"threadId":"thread","state":"accepted"}')`;
});
const fixture = (
  options: {
    wrongInstallation?: boolean;
    unavailable?: boolean;
    staleSource?: boolean;
    publication?: (value: Linked.LinkedWorkPublication) => void;
  } = {},
) => {
  const base = Relationships.layer.pipe(
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );
  const deps = Layer.mergeAll(
    base,
    Layer.mock(IntegrationHub.IntegrationHub)({
      resource: () =>
        options.unavailable
          ? Effect.fail(new DeckhandRpcError({ reason: "unavailable" }))
          : Effect.succeed(
              options.wrongInstallation
                ? { ...native, hello: { ...native.hello, installationID: "other" } }
                : native,
            ),
    }),
    Layer.mock(ManagedSessions.ManagedSessions)({
      list: () =>
        Effect.succeed(
          options.staleSource
            ? []
            : [
                {
                  binding: {
                    ...session,
                    execution: "working",
                    connection: "connected",
                    lastSequence: 12,
                  },
                  title: feature.title,
                  source: "current",
                  archived: false,
                  pullRequests: [
                    {
                      host: "github.com",
                      repository: "example/repo",
                      number: 1,
                      url: "https://github.com/example/repo/pull/1",
                      source: "manual",
                      linkedAt: "now",
                      snapshot: null,
                      stack: null,
                    },
                  ],
                },
              ],
        ),
    }),
    Layer.mock(CheckoutIdentity.CheckoutIdentity)({ resolve: () => Effect.succeed(physical) }),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
    }),
    Layer.mock(RecordingTransport.RecordingTransport)({
      request: (_actor, _method, params) => {
        const publication = Schema.decodeUnknownSync(Linked.LinkedWorkPublication)(
          params.publication,
        );
        options.publication?.(publication);
        return Effect.succeed({
          publication,
          actorKey: "owner",
          observedAt: "now",
          runtimeEpoch: "epoch",
        });
      },
    }),
  );
  return Bridge.layer.pipe(Layer.provideMerge(deps));
};
describe("native linked work from persisted managed context", () => {
  it.effect(
    "exports owned identity, actual heads, and canonical upstream PR without inventing recording attachments",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const bridge = yield* Bridge.LinkedWorkBridge;
        const result = yield* bridge.publish("owner", { threadId: ThreadId.make("thread") });
        assert.strictEqual(result.publication.threadID, "thread");
        assert.strictEqual(result.publication.featureID, "feature");
        assert.strictEqual(result.publication.execution, "working");
        assert.strictEqual(result.publication.repositories[0]?.head, physical.commit);
        assert.strictEqual(
          result.publication.pullRequests[0]?.url,
          "https://github.com/example/repo/pull/1",
        );
        assert.deepEqual(result.publication.recordingIDs, []);
        const resolved = yield* bridge.resolve(target);
        assert.isTrue(resolved.nativeAvailable);
        const unauthorized = yield* bridge
          .publish("other", { threadId: ThreadId.make("thread") })
          .pipe(Effect.result);
        assert.strictEqual(unauthorized._tag, "Failure");
      }).pipe(Effect.provide(fixture())),
  );
  it.effect(
    "refuses changed native identity and exact deep-link mismatches before publishing",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const bridge = yield* Bridge.LinkedWorkBridge;
        const changed = yield* bridge
          .publish("owner", { threadId: ThreadId.make("thread") })
          .pipe(Effect.result);
        assert.strictEqual(changed._tag, "Failure");
        const wrongLink = yield* bridge
          .resolve({ ...target, session: "another" })
          .pipe(Effect.result);
        assert.strictEqual(wrongLink._tag, "Failure");
      }).pipe(
        Effect.provide(
          fixture({ wrongInstallation: true, publication: () => assert.fail("Must not publish") }),
        ),
      ),
  );
  it.effect(
    "returns saved conversation recovery when native disappears, and unknown state for an unavailable upstream source",
    () =>
      Effect.gen(function* () {
        yield* seed;
        const bridge = yield* Bridge.LinkedWorkBridge;
        const result = yield* bridge.publish("owner", { threadId: ThreadId.make("thread") });
        assert.strictEqual(result.publication.execution, "unknown");
        assert.strictEqual(result.publication.connection, "unavailable");
      }).pipe(Effect.provide(fixture({ staleSource: true }))),
  );
  it.effect("preserves exact saved navigation while a native host is unavailable", () =>
    Effect.gen(function* () {
      yield* seed;
      const bridge = yield* Bridge.LinkedWorkBridge;
      const result = yield* bridge.resolve(target);
      assert.isFalse(result.nativeAvailable);
      assert.deepEqual(result.target, target);
    }).pipe(Effect.provide(fixture({ unavailable: true }))),
  );
});
