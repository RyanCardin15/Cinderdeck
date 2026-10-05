// @effect-diagnostics nodeBuiltinImport:off - Tests use real, isolated Unix sockets.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as CinderdeckClient from "./CinderdeckClient.ts";

const TestLayer = CinderdeckClient.layer.pipe(Layer.provideMerge(NodeServices.layer));
const hello = {
  protocolVersion: 1,
  installationID: "installation",
  executionHostID: "host",
  channel: "development",
  runtimeEpoch: "epoch",
  capabilities: ["projection.snapshot", "projection.events"],
  maximumFrameBytes: 4194304,
  maximumPageSize: 500,
  maximumWaitMs: 25000,
};
const peer = (
  respond: (
    request: {
      id: number;
      method: string;
      params: object;
      client?: { session?: string };
    },
    socket: NodeNet.Socket,
  ) => object | string | Buffer | undefined,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "dh-socket-" });
    const path = root + "/control.sock";
    const server = NodeNet.createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString("utf8");
        if (!input.endsWith("\n")) return;
        const request = JSON.parse(input);
        const response = respond(request, socket);
        if (response === undefined) return;
        const result = Buffer.isBuffer(response)
          ? response
          : Buffer.from(typeof response === "string" ? response : JSON.stringify(response) + "\n");
        // A response may arrive across transport frames.
        socket.write(result.subarray(0, 8));
        socket.end(result.subarray(8));
      });
    });
    yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(path, resolve);
          }),
        catch: (cause) => new CinderdeckClient.BridgeError({ reason: "unavailable", cause }),
      }),
      () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    yield* fs.chmod(path, 0o600);
    return path;
  });
describe("same-host Cinderdeck bridge", () => {
  it.effect(
    "bounds fresh catalogue refreshes without extending selected or pinned-page deadlines",
    () =>
      Effect.gen(function* () {
        let requestArrived!: () => void;
        let arrived = new Promise<void>((resolve) => {
          requestArrived = resolve;
        });
        let pending: { id: number; socket: NodeNet.Socket } | undefined;
        let snapshots = 0;
        const socketPath = yield* peer((request, socket) => {
          if (request.method === "integration.hello") return { id: request.id, result: hello };
          assert.equal(request.method, "integration.snapshot");
          snapshots++;
          pending = { id: request.id, socket };
          requestArrived();
          return undefined;
        });
        const client = yield* CinderdeckClient.CinderdeckClient;
        const connection = yield* client.connect(socketPath, { channel: "development" });
        const catalogue = yield* client
          .snapshot(connection, { limit: 100 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => arrived);
        yield* TestClock.adjust("6 seconds");
        assert.isDefined(pending);
        pending!.socket.end(
          // @effect-diagnostics-next-line preferSchemaOverJson:off - Deliberately construct the raw native wire fixture.
          JSON.stringify({
            id: pending!.id,
            result: {
              installationID: "installation",
              runtimeEpoch: "epoch",
              cursor: "opaque",
              resources: [],
              total: 0,
            },
          }) + "\n",
        );
        assert.equal((yield* Fiber.join(catalogue)).cursor, "opaque");
        for (const input of [
          { workspaceID: "workspace", limit: 1 },
          { expectedCursor: "opaque", offset: 100, limit: 100 },
        ]) {
          arrived = new Promise<void>((resolve) => {
            requestArrived = resolve;
          });
          const read = yield* client
            .snapshot(connection, input)
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => arrived);
          yield* TestClock.adjust("5 seconds");
          assert.equal((yield* Fiber.join(read)).reason, "timeout");
        }
        // Timeouts are explicit, with no hidden transport retries.
        assert.equal(snapshots, 3);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "attests native checkout aliases over the real Unix transport and rejects foreign, duplicate or malformed lookup scopes",
    () =>
      Effect.gen(function* () {
        const physical = "a".repeat(64);
        const other = "b".repeat(64);
        const context = {
          workspaceID: "workspace",
          generation: 1,
          revision: "revision",
          available: true,
          repos: ["app"],
          physicalIDs: [physical],
        };
        let result: unknown = {
          installationID: "installation",
          runtimeEpoch: "epoch",
          contexts: [context, { ...context, workspaceID: "alias" }],
        };
        let lookups = 0;
        const socketPath = yield* peer((request) => {
          if (request.method === "integration.hello")
            return {
              id: request.id,
              result: { ...hello, capabilities: [...hello.capabilities, "checkout.contexts"] },
            };
          assert.equal(request.method, "integration.checkout.contexts");
          lookups++;
          return { id: request.id, result };
        });
        const client = yield* CinderdeckClient.CinderdeckClient;
        const connection = yield* client.connect(socketPath, { channel: "development" });
        const input = {
          installationID: "installation",
          physicalID: physical,
          repositoryPhysicalID: physical,
          physicalIDs: [physical],
          sharedRefs: false,
        };
        assert.equal((yield* client.checkoutContexts(connection, input)).contexts.length, 2);
        for (const invalid of [
          { installationID: "foreign", runtimeEpoch: "epoch", contexts: [context] },
          { installationID: "installation", runtimeEpoch: "foreign", contexts: [context] },
          { installationID: "installation", runtimeEpoch: "epoch", contexts: [context, context] },
          {
            installationID: "installation",
            runtimeEpoch: "epoch",
            contexts: [{ ...context, repos: ["app", "app"], physicalIDs: [physical, physical] }],
          },
          {
            installationID: "installation",
            runtimeEpoch: "epoch",
            contexts: [{ ...context, physicalIDs: [other] }],
          },
          {
            installationID: "installation",
            runtimeEpoch: "epoch",
            contexts: [{ ...context, physicalIDs: [physical, physical] }],
          },
          {
            installationID: "installation",
            runtimeEpoch: "epoch",
            contexts: Array.from({ length: 65 }, (_, i) => ({
              ...context,
              workspaceID: `workspace-${i}`,
            })),
          },
        ]) {
          result = invalid;
          assert.equal(
            (yield* client.checkoutContexts(connection, input).pipe(Effect.flip)).reason,
            "invalid_response",
          );
        }
        result = {
          installationID: "installation",
          runtimeEpoch: "epoch",
          contexts: [{ ...context, physicalIDs: [other] }],
        };
        assert.equal(
          (yield* client.checkoutContexts(connection, {
            ...input,
            sharedRefs: true,
            physicalIDs: [physical, other],
          })).contexts[0]?.physicalIDs[0],
          other,
        );
        const before = lookups;
        assert.equal(
          (yield* client
            .checkoutContexts(connection, { ...input, installationID: "foreign" })
            .pipe(Effect.flip)).reason,
          "stale_binding",
        );
        assert.equal(
          (yield* client
            .checkoutContexts(connection, { ...input, physicalID: "bad" })
            .pipe(Effect.flip)).reason,
          "invalid_request",
        );
        assert.equal(lookups, before);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect(
    "decodes fragmented replies and preserves installation binding across snapshot and replay",
    () =>
      Effect.gen(function* () {
        const methods: string[] = [];
        const socketPath = yield* peer((request) => {
          methods.push(request.method);
          if (request.method === "integration.hello") {
            assert.deepEqual(request.params, {
              protocolVersions: [1],
              expectedChannel: "development",
              expectedInstallationID: "installation",
              expectedExecutionHostID: "host",
            });
            return { id: request.id, result: hello };
          }
          if (request.method === "integration.snapshot")
            return {
              id: request.id,
              result: {
                installationID: "installation",
                runtimeEpoch: "epoch",
                cursor: "opaque",
                resources: [],
                total: 0,
              },
            };
          return {
            id: request.id,
            result: {
              installationID: "installation",
              runtimeEpoch: "epoch",
              events: [],
              cursor: "opaque",
              resyncRequired: false,
            },
          };
        });
        const client = yield* CinderdeckClient.CinderdeckClient;
        const connection = yield* client.connect(socketPath, {
          channel: "development",
          installationID: "installation",
          executionHostID: "host",
        });
        const snapshot = yield* client.snapshot(connection);
        const events = yield* client.events(connection, { after: snapshot.cursor });
        assert.equal(events.cursor, "opaque");
        assert.deepEqual(methods, [
          "integration.hello",
          "integration.snapshot",
          "integration.events",
        ]);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect("does not retry a peer refusal and rejects a silently replaced installation", () =>
    Effect.gen(function* () {
      let requests = 0;
      const socketPath = yield* peer((request) => {
        requests++;
        return { id: request.id, error: { code: "installation_changed", message: "changed" } };
      });
      const client = yield* CinderdeckClient.CinderdeckClient;
      const refused = yield* client
        .connect(socketPath, { channel: "development", installationID: "original" })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "peer_rejected");
      assert.equal(refused.code, "installation_changed");
      assert.equal(requests, 1);
      const other = yield* peer((request) => ({ id: request.id, result: hello }));
      const invalid = yield* client
        .connect(other, { channel: "development", installationID: "different" })
        .pipe(Effect.flip);
      assert.equal(invalid.reason, "invalid_response");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect(
    "refuses a permissive socket before sending metadata and rejects response IDs/types",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let requests = 0;
        const socketPath = yield* peer((request) => {
          requests++;
          return { id: request.id, result: hello };
        });
        yield* fs.chmod(socketPath, 0o666);
        const client = yield* CinderdeckClient.CinderdeckClient;
        const denied = yield* client
          .connect(socketPath, { channel: "development" })
          .pipe(Effect.flip);
        assert.equal(denied.reason, "unauthorized_socket");
        assert.equal(requests, 0);
        const malformed = yield* peer(() => ({ id: 999, result: hello }));
        const badID = yield* client
          .connect(malformed, { channel: "development" })
          .pipe(Effect.flip);
        assert.equal(badID.reason, "invalid_response");
        const wrongType = yield* peer((request) => ({
          id: request.id,
          result: { ...hello, protocolVersion: "1" },
        }));
        const badType = yield* client
          .connect(wrongType, { channel: "development" })
          .pipe(Effect.flip);
        assert.equal(badType.reason, "invalid_response");
        const absent = yield* client
          .connect(socketPath + ".absent", { channel: "development" })
          .pipe(Effect.flip);
        assert.equal(absent.reason, "unavailable");
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect("bounds requests before transport and requires reconnect after a native restart", () =>
    Effect.gen(function* () {
      let requests = 0;
      const socketPath = yield* peer((request) => {
        requests++;
        if (request.method === "integration.hello") return { id: 1, result: hello };
        return {
          id: 1,
          result: {
            installationID: "installation",
            runtimeEpoch: "new-epoch",
            cursor: "opaque",
            resources: [],
            total: 0,
            events: [],
            resyncRequired: false,
          },
        };
      });
      const client = yield* CinderdeckClient.CinderdeckClient;
      const connection = yield* client.connect(socketPath, { channel: "development" });
      for (const limit of [0, -1, 1.5, 501, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.equal(
          (yield* client.snapshot(connection, { limit }).pipe(Effect.flip)).reason,
          "invalid_request",
        );
      }
      assert.equal(
        (yield* client.events(connection, { after: "opaque", waitMs: -1 }).pipe(Effect.flip))
          .reason,
        "invalid_request",
      );
      assert.equal(
        (yield* client.events(connection, { after: " ", waitMs: 1 }).pipe(Effect.flip)).reason,
        "invalid_request",
      );
      assert.equal(requests, 1);
      assert.equal((yield* client.snapshot(connection).pipe(Effect.flip)).reason, "stale_binding");
      assert.equal(
        (yield* client.events(connection, { after: "opaque" }).pipe(Effect.flip)).reason,
        "stale_binding",
      );
      const unsupported = { ...connection, hello: { ...connection.hello, capabilities: [] } };
      assert.equal(
        (yield* client.snapshot(unsupported).pipe(Effect.flip)).reason,
        "unsupported_capability",
      );
      assert.equal(requests, 3);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect("rejects malformed UTF-8, oversized frames and malformed error envelopes", () =>
    Effect.gen(function* () {
      const client = yield* CinderdeckClient.CinderdeckClient;
      for (const response of [
        Buffer.from([123, 34, 255, 34, 58, 49, 125, 10]),
        "x".repeat(4194305) + "\n",
        { id: 1, error: "unexpected" },
        { id: 1, error: {} },
        { id: 1, result: hello, error: { code: "ambiguous" } },
        "null\n",
      ]) {
        const socketPath = yield* peer(() => response);
        const invalid = yield* client
          .connect(socketPath, { channel: "development" })
          .pipe(Effect.flip);
        assert.equal(invalid.reason, "invalid_response");
      }
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect(
    "requires each native lifecycle capability and preserves safe removal/setup receipts",
    () =>
      Effect.gen(function* () {
        const capabilities = [
          ...hello.capabilities,
          "operations.lane.create",
          "operations.services",
        ];
        let submissions = 0;
        const socketPath = yield* peer((request) => {
          if (request.method === "integration.hello")
            return { id: 1, result: { ...hello, capabilities } };
          assert.equal(request.method, "integration.operation.submit");
          submissions++;
          const input = request.params as {
            operationKey: string;
            workspaceID: string;
            method: string;
          };
          return {
            id: 1,
            result: {
              id: "receipt-" + input.method,
              operationKey: input.operationKey,
              argumentHash: "a".repeat(64),
              workspaceID: input.workspaceID,
              generation: 1,
              method: input.method,
              state: "succeeded",
              createdAt: "2026-10-03T00:00:00Z",
              updatedAt: "2026-10-03T00:00:01Z",
              result: {
                removed: "lane",
                released: "lane",
                resourceAvailable: false,
                report: {
                  removedWorktrees: ["/fixture/lane"],
                  keptWorktrees: ["/fixture/adopted"],
                  unpushed: { feature: 1 },
                  ignored: [],
                  environment: { SECRET: "hidden" },
                },
                setup: {
                  status: "succeeded",
                  updatedAt: "2026-10-03T00:00:01Z",
                  integrationOperationID: "receipt-" + input.method,
                },
              },
            },
          };
        });
        const client = yield* CinderdeckClient.CinderdeckClient;
        for (const method of ["lane.adopt", "lane.setup", "lane.release", "lane.remove"] as const) {
          const input = {
            operationKey: method,
            installationID: "installation",
            workspaceID: "lane",
            generation: 1,
            revision: "revision",
            method,
            arguments: { workspace: "lane" },
          };
          const oldPeer = yield* client.connect(socketPath, {
            channel: "development",
            clientID: "server",
          });
          const before = submissions;
          assert.equal(
            (yield* client.submit(oldPeer, input).pipe(Effect.flip)).reason,
            "unsupported_capability",
          );
          assert.equal(
            submissions,
            before,
            "Older peers must never receive unsupported lifecycle mutations",
          );
          capabilities.push(`operations.${method}`);
          const upgraded = yield* client.connect(socketPath, {
            channel: "development",
            clientID: "server",
          });
          const receipt = yield* client.submit(upgraded, input);
          assert.equal(receipt.method, method);
          assert.equal(receipt.result?.removed, "lane");
          assert.equal(receipt.result?.released, "lane");
          assert.equal(receipt.result?.resourceAvailable, false);
          assert.deepEqual(receipt.result?.report?.keptWorktrees, ["/fixture/adopted"]);
          assert.equal(receipt.result?.setup?.integrationOperationID, receipt.id);
          assert.notProperty(receipt.result?.report, "environment");
          assert.equal(submissions, before + 1);
        }
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect(
    "repository start revisions require a precise capability and reject malformed maps before transport",
    () =>
      Effect.gen(function* () {
        const capabilities = [...hello.capabilities, "operations.lane.create"];
        let submissions = 0;
        let receivedArguments: unknown;
        const socketPath = yield* peer((request) => {
          if (request.method === "integration.hello")
            return { id: 1, result: { ...hello, capabilities } };
          submissions++;
          const input = request.params as { operationKey: string; arguments: unknown };
          receivedArguments = input.arguments;
          return {
            id: 1,
            result: {
              id: "operation",
              operationKey: input.operationKey,
              argumentHash: "b".repeat(64),
              workspaceID: "source",
              generation: 1,
              method: "lane.create",
              state: "succeeded",
              createdAt: "2026-10-03T00:00:00Z",
              updatedAt: "2026-10-03T00:00:01Z",
            },
          };
        });
        const client = yield* CinderdeckClient.CinderdeckClient;
        const input = {
          operationKey: "create",
          installationID: "installation",
          workspaceID: "source",
          generation: 1,
          revision: "r",
          method: "lane.create" as const,
          arguments: {
            workspace: "source",
            branch: "new",
            repositoryRefs: { app: "a".repeat(40) },
            start: false,
          },
        };
        const old = yield* client.connect(socketPath, {
          channel: "development",
          clientID: "actor",
        });
        assert.equal(
          (yield* client.submit(old, input).pipe(Effect.flip)).reason,
          "unsupported_capability",
        );
        assert.equal(submissions, 0);
        capabilities.push("operations.lane.create.repositoryRefs");
        const connection = yield* client.connect(socketPath, {
          channel: "development",
          clientID: "actor",
        });
        for (const repositoryRefs of [
          null,
          [],
          { app: 42 },
          { app: " " },
          { app: "-main" },
          { app: "main\n" },
          { app: "a".repeat(201) },
          Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`repo-${i}`, "HEAD"])),
        ]) {
          assert.equal(
            (yield* client
              .submit(connection, { ...input, arguments: { ...input.arguments, repositoryRefs } })
              .pipe(Effect.flip)).reason,
            "invalid_request",
          );
          assert.equal(submissions, 0);
        }
        assert.equal((yield* client.submit(connection, input)).state, "succeeded");
        assert.equal(submissions, 1);
        assert.deepEqual(receivedArguments, input.arguments);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect(
    "receipt waits require capability, bound the wait and preserve actor/key without submitting effects",
    () =>
      Effect.gen(function* () {
        const capabilities = ["operations.receipts"];
        const received: Array<{ params: object; client?: { session?: string } }> = [];
        const socketPath = yield* peer((request) => {
          if (request.method === "integration.hello")
            return { id: request.id, result: { ...hello, capabilities } };
          received.push(request);
          return {
            id: request.id,
            result: {
              id: "waited",
              operationKey: "stable",
              argumentHash: "a".repeat(64),
              workspaceID: "workspace",
              generation: 1,
              method: "lane.create",
              state: "running",
              createdAt: "2026-10-03",
              updatedAt: "2026-10-03",
            },
          };
        });
        const client = yield* CinderdeckClient.CinderdeckClient;
        const old = yield* client.connect(socketPath, {
          channel: "development",
          clientID: "owner",
        });
        assert.equal(
          (yield* client.operation(old, "stable", 50).pipe(Effect.flip)).reason,
          "unsupported_capability",
        );
        assert.equal(received.length, 0);
        capabilities.push("operations.receipts.wait");
        const connection = yield* client.connect(socketPath, {
          channel: "development",
          clientID: "owner",
        });
        for (const wait of [-1, 1.5, 25001, NaN, Infinity])
          assert.equal(
            (yield* client.operation(connection, "stable", wait).pipe(Effect.flip)).reason,
            "invalid_request",
          );
        assert.equal(received.length, 0);
        assert.equal((yield* client.operation(connection, "stable", 50)).state, "running");
        assert.deepEqual(received[0]?.params, {
          operationKey: "stable",
          installationID: "installation",
          waitMs: 50,
        });
        assert.equal(received[0]?.client?.session, "owner");
        yield* client.operation(connection, "stable");
        assert.deepEqual(received[1]?.params, {
          operationKey: "stable",
          installationID: "installation",
        });
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );

  it.effect("recovers a lost submit reply by receipt lookup without repeating a mutation", () =>
    Effect.gen(function* () {
      let mutations = 0;
      let lookups = 0;
      const input = {
        operationKey: "stable-operation",
        installationID: "installation",
        workspaceID: "payment",
        generation: 1,
        revision: "revision",
        method: "lane.create" as const,
        arguments: { workspace: "payment", branch: "feature/test", start: false },
      };
      const receipt = {
        id: "operation-id",
        operationKey: input.operationKey,
        argumentHash: "a".repeat(64),
        workspaceID: input.workspaceID,
        generation: 1,
        method: input.method,
        state: "succeeded",
        createdAt: "2026-10-03T00:00:00Z",
        updatedAt: "2026-10-03T00:00:01Z",
        result: { createdWorkspaceID: "lane" },
      };
      const socketPath = yield* peer((request) => {
        if (request.method === "integration.hello")
          return {
            id: 1,
            result: {
              ...hello,
              capabilities: [
                ...hello.capabilities,
                "operations.lane.create",
                "operations.receipts",
              ],
            },
          };
        if (request.method === "integration.operation.submit") {
          mutations++;
          assert.deepEqual(request.params, input);
          return ""; // The peer accepted the operation, but the reply was lost.
        }
        lookups++;
        assert.deepEqual(request.params, {
          operationKey: "stable-operation",
          installationID: "installation",
        });
        return { id: 1, result: receipt };
      });
      const client = yield* CinderdeckClient.CinderdeckClient;
      const connection = yield* client.connect(socketPath, {
        channel: "development",
        clientID: "test-server",
      });
      const lost = yield* client.submit(connection, input).pipe(Effect.flip);
      assert.equal(lost.reason, "invalid_response");
      assert.equal(mutations, 1);
      const recovered = yield* client.operation(connection, input.operationKey);
      assert.equal(recovered.id, "operation-id");
      assert.equal(recovered.state, "succeeded");
      assert.equal(mutations, 1);
      assert.equal(lookups, 1);
      assert.equal(
        (yield* client.submit(connection, { ...input, installationID: "wrong" }).pipe(Effect.flip))
          .reason,
        "invalid_request",
      );
      assert.equal(mutations, 1);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
  it.effect(
    "removes unrecognized native environment and owner fields from returned operation context",
    () =>
      Effect.gen(function* () {
        const socketPath = yield* peer((request) =>
          request.method === "integration.hello"
            ? { id: 1, result: { ...hello, capabilities: ["operations.receipts"] } }
            : {
                id: 1,
                result: {
                  id: "receipt",
                  operationKey: "safe",
                  argumentHash: "a".repeat(64),
                  workspaceID: "lane",
                  generation: 1,
                  method: "lane.create",
                  state: "succeeded",
                  createdAt: "2026-10-03T00:00:00Z",
                  updatedAt: "2026-10-03T00:00:00Z",
                  result: {
                    workspace: {
                      id: "lane",
                      name: "Workspace",
                      file: "/fixture/workspace.toml",
                      state: "Stopped",
                      definitionChanged: false,
                      issues: [],
                      services: [],
                      repos: [],
                      lane: {
                        sourceStackID: "workspace",
                        name: "test",
                        createdAt: "2026-10-03T00:00:00Z",
                        directory: "/fixture/lane",
                        ports: {},
                        environment: { SECRET_TOKEN: "must-not-cross-the-boundary" },
                        owner: { session: "native-owner" },
                      },
                    },
                    extra: "unrecognized-result",
                  },
                },
              },
        );
        const client = yield* CinderdeckClient.CinderdeckClient;
        const connection = yield* client.connect(socketPath, {
          channel: "development",
          clientID: "actor",
        });
        const result = (yield* client.operation(connection, "safe")).result;
        assert.equal(result?.workspace?.id, "lane");
        assert.notProperty(result, "extra");
        assert.notProperty(result?.workspace?.lane, "environment");
        assert.notProperty(result?.workspace?.lane, "owner");
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
  );
});

it.effect(
  "browses saved GitHub queries without a workspace catalog and refuses mismatched account replies",
  () =>
    Effect.gen(function* () {
      let foreign = false;
      const methods: string[] = [];
      const filters = {
        repository: null,
        organization: null,
        state: "open",
        role: "anyone",
        sort: "updated",
        text: "label:bug",
        label: "",
        advanced: true,
      };
      const socketPath = yield* peer((request) => {
        methods.push(request.method);
        if (request.method === "integration.hello")
          return { id: request.id, result: { ...hello, capabilities: ["github.workspace"] } };
        return {
          id: request.id,
          result: {
            kind: "preferences",
            preferences: {
              account: foreign ? "another-account" : "reviewer",
              hostname: "github.com",
              selectedViewID: "bugs",
              filters,
              query: "is:pr involves:reviewer label:bug sort:updated-desc",
              views: [
                { id: "bugs", name: "Bug reviews", builtIn: false, filters, query: "label:bug" },
              ],
            },
          },
        };
      });
      const client = yield* CinderdeckClient.CinderdeckClient;
      const connection = yield* client.connect(socketPath, { channel: "development" });
      const result = yield* client.github(connection, { action: "preferences" });
      assert.equal(result.kind, "preferences");
      if (result.kind === "preferences")
        assert.equal(result.preferences.views[0]?.name, "Bug reviews");
      assert.deepEqual(methods, ["integration.hello", "prs.browser"]);
      foreign = true;
      const refused = yield* client
        .github(connection, {
          action: "select",
          account: "reviewer",
          hostname: "github.com",
          id: "bugs",
        })
        .pipe(Effect.flip);
      assert.equal(refused.reason, "invalid_response");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "accepts terminal GitHub pages with omitted Swift cursors and preserves review refusal messages",
  () =>
    Effect.gen(function* () {
      const socketPath = yield* peer((request) => {
        if (request.method === "integration.hello")
          return { id: request.id, result: { ...hello, capabilities: ["github.workspace"] } };
        const params = request.params as { action: string };
        if (params.action === "organizations")
          return {
            id: request.id,
            result: {
              kind: "organizations",
              account: "reviewer",
              hostname: "github.com",
              page: { nodes: [{ login: "team" }], pageInfo: { hasNextPage: false } },
            },
          };
        return {
          id: request.id,
          error: {
            code: "failed",
            message:
              "New commits were pushed. Refresh and review the latest changes before submitting.",
          },
        };
      });
      const client = yield* CinderdeckClient.CinderdeckClient;
      const connection = yield* client.connect(socketPath, { channel: "development" });
      const result = yield* client.github(connection, {
        action: "organizations",
        account: "reviewer",
        hostname: "github.com",
      });
      assert.equal(result.kind, "organizations");
      const error = yield* client
        .github(connection, {
          action: "detail",
          account: "reviewer",
          hostname: "github.com",
          id: "PR-7",
        })
        .pipe(Effect.flip);
      assert.include(error.detail, "New commits were pushed");
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);

it.effect(
  "sets up agent access only on peers that advertise it, bound to the connected installation",
  () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; params: object }> = [];
      let capabilities = ["agents.setup"];
      const status = {
        cli: { installed: true, path: "/Users/me/.local/bin/cinderdeck" },
        clients: [
          {
            id: "claude",
            name: "Claude Code",
            mcpConfigured: false,
            mcpLocation: "claude mcp add --scope user",
            skills: { state: "missing", detail: "Installs to ~/.claude/skills" },
          },
        ],
        skills: [{ name: "cinderdeck-parallel-lanes", summary: "Run branches side by side." }],
        claudeMod: { state: "missing", detail: "Installs to ~/.claude/skills" },
      };
      const socketPath = yield* peer((request) => {
        if (request.method === "integration.hello")
          return { id: request.id, result: { ...hello, capabilities } };
        requests.push({ method: request.method, params: request.params });
        return request.method === "integration.agents.status"
          ? { id: request.id, result: status }
          : { id: request.id, result: { ok: true, detail: "registered", status } };
      });
      const client = yield* CinderdeckClient.CinderdeckClient;
      const connection = yield* client.connect(socketPath, { channel: "development" });

      const read = yield* client.agentAccess(connection, { action: "status" });
      assert.equal(read.status.clients[0]?.name, "Claude Code");
      const applied = yield* client.agentAccess(connection, {
        action: "mcp",
        agent: "claude",
        instructions: true,
      });
      assert.equal(applied.detail, "registered");
      assert.deepEqual(requests, [
        { method: "integration.agents.status", params: { installationID: "installation" } },
        {
          method: "integration.agents.apply",
          params: {
            installationID: "installation",
            action: "mcp",
            agent: "claude",
            instructions: true,
          },
        },
      ]);

      capabilities = [];
      const older = yield* client.connect(socketPath, { channel: "development" });
      const refused = yield* client.agentAccess(older, { action: "status" }).pipe(Effect.flip);
      assert.equal(refused.reason, "unsupported_capability");
      assert.equal(requests.length, 2);
    }).pipe(Effect.scoped, Effect.provide(TestLayer)),
);
