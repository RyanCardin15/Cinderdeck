// @effect-diagnostics nodeBuiltinImport:off - Tests use real, isolated Unix sockets.
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
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
  respond: (request: {
    id: number;
    method: string;
    params: object;
    client?: { session?: string };
  }) => object | string | Buffer,
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
        const response = respond(request);
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
});
