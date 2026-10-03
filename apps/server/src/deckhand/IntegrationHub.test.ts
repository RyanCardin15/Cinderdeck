// @effect-diagnostics nodeBuiltinImport:off - These tests exercise the real Unix adapter and SQLite, replacing only the external native peer.
// @effect-diagnostics preferSchemaOverJson:off - The simulated native process speaks raw JSON envelopes.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as CinderdeckClient from "./CinderdeckClient.ts";
import * as IntegrationDiscovery from "./IntegrationDiscovery.ts";
import * as IntegrationHub from "./IntegrationHub.ts";
import * as Migrations from "./Migrations.ts";
import * as OperationJournal from "./OperationJournal.ts";
import * as Contracts from "@t3tools/contracts/deckhand";
import { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as CheckoutIdentity from "./CheckoutIdentity.ts";
import * as ManagedCheckoutGuard from "./ManagedCheckoutGuard.ts";
import * as Relationships from "./Relationships.ts";
import * as ProcessRunner from "../processRunner.ts";

const decodeWorkspaceBinding = Schema.decodeUnknownEffect(Contracts.WorkspaceBinding);
const decodeCheckoutBinding = Schema.decodeUnknownEffect(Contracts.CheckoutBinding);
const decodeFeature = Schema.decodeUnknownEffect(Contracts.Feature);
const decodeSessionBinding = Schema.decodeUnknownEffect(Contracts.SessionBinding);
const hello = {
  protocolVersion: 1,
  installationID: "installation",
  executionHostID: "host",
  channel: "development",
  runtimeEpoch: "epoch",
  maximumFrameBytes: 4194304,
  maximumPageSize: 2,
  maximumWaitMs: 25000,
  capabilities: [
    "projection.snapshot",
    "projection.events",
    "operations.services",
    "operations.receipts",
  ],
};
type Request = {
  id: number;
  method: string;
  params: Record<string, unknown>;
  client?: { session?: string };
};
const resource = (workspaceID: string) => ({
  workspaceID,
  generation: 1,
  revision: "revision",
  available: true,
});
const operation = {
  operationKey: "durable-key",
  installationID: "installation",
  workspaceID: "one",
  generation: 1,
  revision: "revision",
  method: "services.start" as const,
  arguments: { workspace: "one" },
};
const receipt = {
  id: "native-receipt",
  operationKey: "durable-key",
  argumentHash: "a".repeat(64),
  workspaceID: "one",
  generation: 1,
  method: "services.start",
  state: "succeeded",
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:01Z",
};
const peer = (respond: (request: Request, socket: NodeNet.Socket) => object | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "dh-hub-" });
    const socketPath = `${root}/control.sock`;
    const sockets = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.endsWith("\n")) return;
        const request = JSON.parse(input) as Request;
        const response = respond(request, socket);
        if (response !== null) socket.end(JSON.stringify({ id: request.id, ...response }) + "\n");
      });
    });
    yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
          }),
      ),
      () =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const socket of sockets) socket.destroy();
              server.close(() => resolve());
            }),
        ),
    );
    yield* fs.chmod(socketPath, 0o600);
    return socketPath;
  });
const hubLayer = (socketPath: string) =>
  IntegrationHub.layer.pipe(
    Layer.provide(OperationJournal.layer),
    Layer.provide(CinderdeckClient.layer),
    Layer.provide(
      IntegrationDiscovery.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(IntegrationDiscovery.DiscoveryConfig, {
            channel: "development",
            socketPath,
            statePath: "/unused",
          }),
        ),
        Layer.provide(
          Layer.succeed(IntegrationDiscovery.HostIdentity, { get: Effect.succeed("host") }),
        ),
      ),
    ),
  );
const TestLayer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
describe("Deckhand integration hub", () => {
  it.effect(
    "guards the exact lane generation and physical repository before connected execution",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "dh-guard-" });
        let generation = 7;
        let available = true;
        const socketPath = yield* peer((request) => {
          if (request.method === "integration.hello") return { result: hello };
          if (request.method === "integration.snapshot")
            return {
              result: {
                installationID: "installation",
                runtimeEpoch: "epoch",
                cursor: "installation:0",
                total: 1,
                resources: [
                  {
                    workspaceID: "native-lane",
                    generation,
                    revision: "rev",
                    available,
                    workspace: {
                      id: "native-lane",
                      name: "Lane",
                      file: "/lane.toml",
                      state: "stopped",
                      definitionChanged: false,
                      issues: [],
                      services: [],
                      repos: [
                        {
                          id: "app",
                          path: root,
                          branch: "main",
                          dirty: false,
                          changedFiles: 0,
                          ahead: 0,
                          behind: 0,
                        },
                      ],
                    },
                  },
                ],
              },
            };
          return null;
        });
        const guardLayer = ManagedCheckoutGuard.layer.pipe(
          Layer.provideMerge(Relationships.layer),
          Layer.provideMerge(CheckoutIdentity.layer.pipe(Layer.provideMerge(ProcessRunner.layer))),
          Layer.provide(hubLayer(socketPath)),
        );
        yield* Effect.gen(function* () {
          const runner = yield* ProcessRunner.ProcessRunner;
          const identity = yield* CheckoutIdentity.CheckoutIdentity;
          const store = yield* Relationships.Relationships;
          const guard = yield* ManagedCheckoutGuard.ManagedCheckoutGuard;
          const initialized = yield* runner.run({
            command: "git",
            args: ["-C", root, "init", "-b", "main"],
          });
          assert.equal(initialized.code, 0);
          const physical = yield* identity.resolve(root);
          const workspace = yield* decodeWorkspaceBinding({
            id: "workspace",
            environmentId: "installation",
            backend: "cinderdeck",
            ownerId: "native-base",
            generation: 2,
            revision: 1,
            name: "Workspace",
            state: "active",
          });
          const checkout = yield* decodeCheckoutBinding({
            id: "checkout",
            workspaceId: workspace.id,
            workspaceGeneration: 2,
            nativeGeneration: 7,
            environmentId: "installation",
            backend: "cinderdeck",
            kind: "lane",
            laneId: "native-lane",
            state: "ready",
            repositories: [physical],
            revision: 1,
          });
          const feature = yield* decodeFeature({
            id: "feature",
            workspaceId: workspace.id,
            title: "Payment",
            objective: "Verify payment",
            status: "active",
            revision: 1,
            createdAt: "created",
            updatedAt: "created",
          });
          const binding = yield* decodeSessionBinding({
            id: "session",
            threadId: "thread",
            providerSessionId: null,
            providerInstanceId: "codex",
            featureId: feature.id,
            checkoutId: checkout.id,
            repositoryScope: [physical.physicalId],
            role: "writer",
            desiredAccess: "write",
            execution: "queued",
            connection: "connected",
            lastSequence: 0,
            capabilities: {
              nativeResume: true,
              interrupt: true,
              steering: false,
              approvals: true,
              questions: true,
              enforcedReadOnly: false,
              imageInput: true,
              videoInput: false,
              managed: true,
            },
          });
          yield* store.putWorkspace(workspace, null);
          yield* store.putCheckout(checkout, null);
          yield* store.putFeature(feature, null);
          yield* store.linkCheckout(feature.id, checkout.id, true);
          yield* store.putSession(binding, null);
          assert.isTrue(yield* guard.connected(binding.threadId));
          assert.equal(
            (yield* guard.resolve(binding.threadId, root))?.physicalId,
            physical.physicalId,
          );
          generation = 8;
          assert.equal(
            (yield* guard.resolve(binding.threadId, root).pipe(Effect.flip)).reason,
            "stale_binding",
          );
          generation = 7;
          available = false;
          assert.equal(
            (yield* guard.resolve(binding.threadId, root).pipe(Effect.flip)).reason,
            "stale_binding",
          );
          available = true;
          assert.equal(
            (yield* guard.resolve(binding.threadId, `${root}/gone`).pipe(Effect.flip)).reason,
            "missing",
          );
          const reviewer = {
            ...binding,
            id: Contracts.SessionBindingId.make("review"),
            threadId: ThreadId.make("review"),
            role: "reviewer" as const,
            desiredAccess: "read_only" as const,
            capabilities: { ...binding.capabilities, enforcedReadOnly: true },
          };
          yield* store.putSession(reviewer, null);
          assert.equal(
            (yield* guard.resolve(reviewer.threadId, root).pipe(Effect.flip)).reason,
            "unsupported_access",
          );
          assert.equal((yield* store.session(binding.id)).checkoutId, checkout.id);
        }).pipe(Effect.provide(guardLayer));
      }).pipe(Effect.provide(TestLayer)),
  );
  it.effect(
    "publishes a coherent paged snapshot, refuses torn pagination and pins the installation after reopen",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        let torn = false;
        let replaced = false;
        const offsets: unknown[] = [];
        const socketPath = yield* peer((request) => {
          if (request.method === "integration.hello") {
            if (replaced) {
              assert.equal(request.params.expectedInstallationID, "installation");
              return { error: { code: "installation_changed" } };
            }
            return { result: hello };
          }
          offsets.push(request.params.offset ?? 0);
          if (request.params.offset) {
            assert.equal(request.params.expectedCursor, "cursor");
            return {
              result: {
                installationID: "installation",
                runtimeEpoch: "epoch",
                cursor: torn ? "torn" : "cursor",
                resources: [resource("three")],
                total: 3,
                nextOffset: null,
              },
            };
          }
          return {
            result: {
              installationID: "installation",
              runtimeEpoch: "epoch",
              cursor: "cursor",
              resources: [resource("one"), resource("two")],
              total: 3,
              nextOffset: 2,
            },
          };
        });
        yield* Effect.gen(function* () {
          const hub = yield* IntegrationHub.IntegrationHub;
          yield* hub.refresh;
          const page = yield* hub.overview({ offset: 1, limit: 1 });
          assert.equal(page.resources[0]?.workspaceID, "two");
          assert.equal(page.nextOffset, 2);
          assert.deepEqual(offsets, [0, 2]);
          torn = true;
          assert.equal((yield* hub.refresh.pipe(Effect.flip)).reason, "invalid_response");
          const preserved = yield* hub.overview({ offset: 0, limit: 100 });
          assert.equal(preserved.state, "incompatible");
          assert.equal(preserved.resources.length, 3);
        }).pipe(Effect.provide(hubLayer(socketPath)), Effect.scoped);
        replaced = true;
        yield* Effect.gen(function* () {
          const hub = yield* IntegrationHub.IntegrationHub;
          assert.equal((yield* hub.overview({ offset: 0, limit: 100 })).state, "reconnecting");
          yield* hub.refresh.pipe(Effect.flip);
          const view = yield* hub.overview({ offset: 0, limit: 100 });
          assert.equal(view.state, "identity_changed");
          assert.equal(view.hello?.installationID, "installation");
          assert.equal(view.resources.length, 3);
        }).pipe(Effect.provide(hubLayer(socketPath)), Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "shares one replay connection, allows commands while replay waits, and cancels replay after the last subscriber",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        let polls = 0;
        let activePolls = 0;
        let releases = 0;
        let installationID = hello.installationID;
        const control = { id: "writer", installationID, token: "b".repeat(64) };
        let resolvePollStarted: () => void = () => {};
        let resolvePollClosed: () => void = () => {};
        const pollStarted = new Promise<void>((resolve) => {
          resolvePollStarted = resolve;
        });
        const pollClosed = new Promise<void>((resolve) => {
          resolvePollClosed = resolve;
        });
        const socketPath = yield* peer((request, socket) => {
          if (request.method === "integration.hello")
            return {
              result: {
                ...hello,
                installationID,
                capabilities: [...hello.capabilities, "checkout.reservations"],
              },
            };
          if (request.method === "integration.snapshot")
            return {
              result: {
                installationID: "installation",
                runtimeEpoch: "epoch",
                cursor: "cursor",
                resources: [],
                total: 0,
              },
            };
          if (request.method === "integration.events") {
            assert.equal(request.params.limit, 2);
            polls++;
            activePolls++;
            resolvePollStarted();
            socket.once("close", () => {
              activePolls--;
              resolvePollClosed();
            });
            // Detect the client's cancellation even when the peer has not finished the long poll.
            socket.on("end", () => socket.end());
            return null;
          }
          assert.equal(request.client?.session, "actor");
          if (request.method === "integration.reservation.release") {
            releases++;
            assert.deepEqual(request.params, control);
            return {
              result: {
                id: control.id,
                ownerID: "actor",
                workspaceID: "one",
                generation: 1,
                kind: "writer",
                state: "released",
                physicalIDs: ["a".repeat(64)],
                createdAt: "2026-10-03T00:00:00Z",
              },
            };
          }
          return { result: receipt };
        });
        yield* Effect.gen(function* () {
          const hub = yield* IntegrationHub.IntegrationHub;
          const first = yield* hub
            .subscribe({ offset: 0, limit: 100 })
            .pipe(Stream.runDrain, Effect.forkChild);
          yield* Effect.promise(() => pollStarted);
          const second = yield* hub
            .subscribe({ offset: 0, limit: 1 })
            .pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));
          assert.equal((yield* hub.submit("actor", operation)).id, "native-receipt");
          assert.equal(polls, 1);
          yield* Fiber.interrupt(first);
          assert.equal(activePolls, 1);
          yield* Fiber.interrupt(second);
          yield* Effect.promise(() => pollClosed);
          assert.equal(activePolls, 0);
          assert.equal((yield* hub.overview({ offset: 0, limit: 1 })).state, "reconnecting");
          assert.equal((yield* hub.releaseWriter("actor", control)).state, "released");
          assert.equal(releases, 1);
          assert.equal(polls, 1);
          installationID = "replacement";
          yield* hub.releaseWriter("actor", control).pipe(Effect.flip);
          assert.equal(releases, 1);
          assert.equal(
            (yield* hub.submit("actor", { ...operation, operationKey: "other" }).pipe(Effect.flip))
              .reason,
            "unavailable",
          );
        }).pipe(Effect.provide(hubLayer(socketPath)), Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "recovers lost replies after reopening without repeating a mutation or allowing another actor to claim its key",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        let mutations = 0;
        const socketPath = yield* peer((request, socket) => {
          if (request.method === "integration.hello") return { result: hello };
          if (request.method === "integration.snapshot")
            return {
              result: {
                installationID: "installation",
                runtimeEpoch: "epoch",
                cursor: "cursor",
                resources: [],
                total: 0,
              },
            };
          if (request.method === "integration.operation.submit") {
            mutations++;
            socket.end();
            return null;
          }
          assert.equal(request.method, "integration.operation.get");
          assert.equal(request.client?.session, "actor");
          return { result: receipt };
        });
        yield* Effect.gen(function* () {
          const hub = yield* IntegrationHub.IntegrationHub;
          yield* hub.refresh;
          yield* hub.submit("actor", operation).pipe(Effect.flip);
          const records = yield* hub.operations("actor");
          assert.equal(records.length, 1);
          assert.equal(records[0]?.receipt, null);
          assert.equal(records[0]?.refused, false);
          assert.equal(mutations, 1);
        }).pipe(Effect.provide(hubLayer(socketPath)), Effect.scoped);
        yield* Effect.gen(function* () {
          const hub = yield* IntegrationHub.IntegrationHub;
          yield* hub.refresh;
          assert.equal((yield* hub.operations("actor"))[0]?.input.operationKey, "durable-key");
          assert.deepEqual(yield* hub.operations("other"), []);
          assert.equal(
            (yield* hub.operation("other", "durable-key").pipe(Effect.flip)).reason,
            "operation_missing",
          );
          assert.equal(
            (yield* hub.submit("other", operation).pipe(Effect.flip)).reason,
            "operation_key_conflict",
          );
          assert.equal(
            (yield* hub
              .submit("actor", { ...operation, method: "services.stop" })
              .pipe(Effect.flip)).reason,
            "operation_key_conflict",
          );
          assert.equal((yield* hub.submit("actor", operation)).state, "succeeded");
          assert.equal(mutations, 1);
          assert.equal((yield* hub.operations("actor"))[0]?.receipt?.id, "native-receipt");
        }).pipe(Effect.provide(hubLayer(socketPath)), Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect(
    "records a stale revision refusal without inventing a native receipt or blocking future recovery",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        let mutations = 0;
        const socketPath = yield* peer((request) => {
          if (request.method === "integration.hello") return { result: hello };
          if (request.method === "integration.snapshot")
            return {
              result: {
                installationID: "installation",
                runtimeEpoch: "epoch",
                cursor: "cursor",
                resources: [],
                total: 0,
              },
            };
          assert.equal(request.method, "integration.operation.submit");
          mutations++;
          return { error: { code: "stale_revision" } };
        });
        yield* Effect.gen(function* () {
          const hub = yield* IntegrationHub.IntegrationHub;
          yield* hub.refresh;
          assert.equal(
            (yield* hub.submit("actor", operation).pipe(Effect.flip)).code,
            "stale_revision",
          );
          const record = (yield* hub.operations("actor"))[0];
          assert.equal(record?.refused, true);
          assert.equal(record?.receipt, null);
          assert.equal(
            (yield* hub.operation("actor", operation.operationKey).pipe(Effect.flip)).reason,
            "operation_refused",
          );
          assert.equal(
            (yield* hub.submit("actor", operation).pipe(Effect.flip)).reason,
            "operation_refused",
          );
          assert.equal(mutations, 1);
        }).pipe(Effect.provide(hubLayer(socketPath)), Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect(
    "replays workspace changes once and retains the last catalog when a foreign event is rejected",
    () =>
      Effect.gen(function* () {
        yield* Migrations.migrate;
        const polls: NodeNet.Socket[] = [];
        const incoming: Array<() => void> = [];
        const started = Array.from(
          { length: 3 },
          () => new Promise<void>((resolve) => incoming.push(resolve)),
        );
        let updated = false;
        let changed: () => void = () => {};
        let rejected: () => void = () => {};
        const changedView = new Promise<void>((resolve) => {
          changed = resolve;
        });
        const rejectedView = new Promise<void>((resolve) => {
          rejected = resolve;
        });
        const socketPath = yield* peer((request, socket) => {
          if (request.method === "integration.hello") return { result: hello };
          if (request.method === "integration.snapshot")
            return {
              result: {
                installationID: "installation",
                runtimeEpoch: "epoch",
                cursor: updated ? "cursor-1" : "cursor-0",
                resources: [{ ...resource("one"), revision: updated ? "updated" : "revision" }],
                total: 1,
              },
            };
          assert.equal(request.method, "integration.events");
          polls.push(socket);
          incoming[polls.length - 1]?.();
          return null;
        });
        const event = {
          eventID: "installation:1",
          sourceID: "installation",
          sequence: 1,
          workspaceID: "one",
          generation: 1,
          kind: "workspace.updated",
        };
        yield* Effect.gen(function* () {
          const hub = yield* IntegrationHub.IntegrationHub;
          yield* hub.subscribe({ offset: 0, limit: 100 }).pipe(
            Stream.runForEach((view) =>
              Effect.sync(() => {
                if (view.activity.length === 1 && view.resources[0]?.revision === "updated")
                  changed();
                if (view.state === "incompatible") rejected();
              }),
            ),
            Effect.forkChild,
          );
          yield* Effect.promise(() => started[0]!);
          updated = true;
          polls[0]!.end(
            JSON.stringify({
              id: 1,
              result: {
                installationID: "installation",
                runtimeEpoch: "epoch",
                events: [event],
                cursor: "cursor-1",
                resyncRequired: false,
              },
            }) + "\n",
          );
          yield* Effect.promise(() => changedView);
          yield* Effect.promise(() => started[1]!);
          polls[1]!.end(
            JSON.stringify({
              id: 1,
              result: {
                installationID: "installation",
                runtimeEpoch: "epoch",
                events: [event],
                cursor: "cursor-1",
                resyncRequired: false,
              },
            }) + "\n",
          );
          yield* Effect.promise(() => started[2]!);
          assert.equal((yield* hub.overview({ offset: 0, limit: 100 })).activity.length, 1);
          polls[2]!.end(
            JSON.stringify({
              id: 1,
              result: {
                installationID: "installation",
                runtimeEpoch: "epoch",
                events: [{ ...event, eventID: "foreign:2", sourceID: "foreign", sequence: 2 }],
                cursor: "cursor-2",
                resyncRequired: false,
              },
            }) + "\n",
          );
          yield* Effect.promise(() => rejectedView);
          const view = yield* hub.overview({ offset: 0, limit: 100 });
          assert.equal(view.resources[0]?.revision, "updated");
          assert.equal(view.activity.length, 1);
        }).pipe(Effect.provide(hubLayer(socketPath)), Effect.scoped);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});
