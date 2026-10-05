// @effect-diagnostics nodeBuiltinImport:off
// A loopback HTTP/WebSocket fixture exercises the native transport without opening a browser.
// @effect-diagnostics preferSchemaOverJson:off
// The peer intentionally sends opaque CDP JSON and tests its sanitized JSON response shape.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import { nativeDebugTransport } from "./ExternalDebugCDP.ts";
import { ExternalDebug, layerLive } from "./ExternalDebug.ts";

// An actual loopback HTTP/WebSocket peer exercises tunnel authority rewriting,
// native Node framing, command correlation, protocol errors, and disconnects.
async function runtimeFixture() {
  const sockets = new Set<NodeNet.Socket>();
  let requestPath = "";
  let advertised = "ws://some-other-machine:9999/devtools/page/add-in";
  let bodyOverride: string | null = null;
  const calls: string[] = [];
  const responses = new Map<string, Record<string, unknown>>();
  const events = new Map<string, { method: string; params: Record<string, unknown> }[]>();
  const send = (socket: NodeNet.Socket, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const header =
      bytes.length < 126
        ? Buffer.from([0x81, bytes.length])
        : Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]);
    socket.write(Buffer.concat([header, bytes]));
  };
  const server = NodeHttp.createServer((request, response) => {
    requestPath = request.url ?? "";
    response.setHeader("Content-Type", "application/json");
    response.end(
      bodyOverride ??
        JSON.stringify([
          {
            id: "add-in",
            type: "page",
            title: "Excel https://example.test/?token=secret",
            url: "https://example.test/taskpane.html?token=secret",
            webSocketDebuggerUrl: advertised,
          },
          {
            id: "worker",
            type: "worker",
            url: "https://example.test/worker",
            webSocketDebuggerUrl: advertised,
          },
        ]),
    );
  });
  server.on("upgrade", (request, socket) => {
    const owned = socket as NodeNet.Socket;
    sockets.add(owned);
    const key = request.headers["sec-websocket-key"];
    const digest = NodeCrypto.createHash("sha1")
      .update(String(key) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${digest}\r\n\r\n`,
    );
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        let length = buffered[1]! & 127;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127) {
          owned.destroy();
          return;
        }
        const masked = Boolean(buffered[1]! & 128);
        const payloadAt = offset + (masked ? 4 : 0);
        if (buffered.length < payloadAt + length) return;
        const opcode = buffered[0]! & 15;
        const payload = Buffer.from(buffered.subarray(payloadAt, payloadAt + length));
        if (masked)
          for (let i = 0; i < payload.length; i++)
            payload[i] = payload[i]! ^ buffered[offset + (i % 4)]!;
        buffered = buffered.subarray(payloadAt + length);
        if (opcode === 8) {
          owned.end(Buffer.from([0x88, 0]));
          return;
        }
        if (opcode !== 1) continue;
        const message: { id: number; method: string } = JSON.parse(payload.toString());
        calls.push(message.method);
        for (const event of events.get(message.method) ?? []) send(owned, event);
        if (message.method === "Unsupported.method")
          send(owned, { id: message.id, error: { code: -32601, message: "Unknown method" } });
        else
          send(owned, {
            id: message.id,
            result: responses.get(message.method) ?? { method: message.method },
          });
        if (message.method === "Runtime.enable")
          send(owned, {
            method: "Runtime.consoleAPICalled",
            params: { args: [{ value: "Live Office context" }] },
          });
      }
    });
    socket.on("close", () => sockets.delete(owned));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const endpoint = `http://127.0.0.1:${address.port}`;
  return {
    endpoint,
    calls,
    respond: (method: string, value: Record<string, unknown>) => responses.set(method, value),
    emitBeforeResponse: (
      method: string,
      value: { method: string; params: Record<string, unknown> }[],
    ) => events.set(method, value),
    requestPath: () => requestPath,
    advertise: (value: string) => {
      advertised = value;
    },
    body: (value: string) => {
      bodyOverride = value;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
describe("native external CDP transport", () => {
  it("discovers a real HTTP endpoint and rewrites a remote advertised socket through the selected tunnel", async () => {
    const fixture = await runtimeFixture();
    try {
      const targets = await nativeDebugTransport.discover(fixture.endpoint);
      expect(fixture.requestPath()).toBe("/json/list");
      expect(targets).toHaveLength(1);
      expect(targets[0]?.socketURL).toBe(
        fixture.endpoint.replace("http:", "ws:") + "/devtools/page/add-in",
      );
      expect(JSON.stringify(targets)).not.toContain("secret");
      let eventResolve: (method: string) => void = () => {};
      const event = new Promise<string>((resolve) => {
        eventResolve = resolve;
      });
      let disconnectedResolve: () => void = () => {};
      const disconnected = new Promise<void>((resolve) => {
        disconnectedResolve = resolve;
      });
      const peer = await nativeDebugTransport.connect(
        targets[0]!,
        (method) => eventResolve(method),
        disconnectedResolve,
      );
      const results = await Promise.all([peer.call("Runtime.enable"), peer.call("Page.enable")]);
      expect(results.map((r) => r.method)).toEqual(["Runtime.enable", "Page.enable"]);
      expect(await event).toBe("Runtime.consoleAPICalled");
      await expect(peer.call("Unsupported.method")).rejects.toMatchObject({
        reason: "unsupported",
      });
      peer.close();
      await disconnected;
      await expect(peer.call("Runtime.enable")).rejects.toMatchObject({ reason: "disconnected" });
    } finally {
      await fixture.close();
    }
  });
  it("rejects unsafe discovered socket paths and oversized target responses", async () => {
    const fixture = await runtimeFixture();
    try {
      fixture.advertise("ws://127.0.0.1:9999/admin?token=secret");
      expect(await nativeDebugTransport.discover(fixture.endpoint)).toEqual([]);
      fixture.body(" ".repeat(520000));
      await expect(nativeDebugTransport.discover(fixture.endpoint)).rejects.toMatchObject({
        reason: "too_large",
      });
    } finally {
      await fixture.close();
    }
  });
  effectIt.effect(
    "runs the production service over native HTTP/WebSocket traffic with preview, diagnostics, evaluation, and detach",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* Effect.acquireRelease(Effect.promise(runtimeFixture), (fixture) =>
            Effect.promise(() => fixture.close()),
          );
          fixture.respond("Page.captureScreenshot", { data: "aGVsbG8=" });
          fixture.respond("Runtime.evaluate", {
            result: { value: { office: true, host: "Excel", access_token: "private-token" } },
          });
          fixture.emitBeforeResponse("Debugger.enable", [
            {
              method: "Network.requestWillBeSent",
              params: {
                requestId: "graph",
                timestamp: 1,
                request: {
                  method: "GET",
                  url: "https://graph.microsoft.com/me?access_token=private-token",
                  headers: { Authorization: "Bearer private-token" },
                },
              },
            },
            {
              method: "Network.responseReceived",
              params: { requestId: "graph", timestamp: 1.25, response: { status: 401 } },
            },
            { method: "Network.loadingFinished", params: { requestId: "graph", timestamp: 1.5 } },
            {
              method: "Debugger.scriptParsed",
              params: { scriptId: "7", url: "https://example.test/taskpane.js" },
            },
          ]);
          const service = yield* ExternalDebug;
          const session = yield* service.attach("test-owner", {
            endpoint: fixture.endpoint,
            targetId: "add-in",
          });
          const snapshot = yield* service.read("test-owner", {
            sessionId: session.sessionId,
            after: 0,
            screenshot: true,
          });
          expect(snapshot.session.state).toBe("connected");
          expect(snapshot.image).toBe("aGVsbG8=");
          expect(
            snapshot.events.some(
              (event) => event.kind === "console" && event.text.includes("Office context"),
            ),
          ).toBe(true);
          expect(
            snapshot.events.some((event) => event.kind === "network" && event.text.includes("401")),
          ).toBe(true);
          expect(JSON.stringify(snapshot)).not.toContain("private-token");
          const sources = yield* service.command("test-owner", {
            sessionId: session.sessionId,
            action: "sources",
          });
          expect(JSON.parse(sources.text).scripts).toEqual([
            { id: "7", url: "https://example.test/taskpane.js" },
          ]);
          const evaluated = yield* service.command("test-owner", {
            sessionId: session.sessionId,
            action: "evaluate",
            expression: "({ office: true, host: 'Excel' })",
          });
          expect(JSON.parse(evaluated.text).result.value.host).toBe("Excel");
          expect(evaluated.text).not.toContain("private-token");
          expect(fixture.calls).toContain("Runtime.releaseObjectGroup");
          yield* service.detach("test-owner", { sessionId: session.sessionId });
          expect(yield* service.sessions("test-owner")).toEqual([]);
          expect(fixture.calls).toContain("Debugger.disable");
          expect(
            fixture.calls.some((method) => /navigate|closeTarget|setDeviceMetrics/.test(method)),
          ).toBe(false);
          // The host endpoint survives detach and remains available for a new attachment.
          expect(yield* service.discover({ endpoint: fixture.endpoint })).toHaveLength(1);
        }).pipe(Effect.provide(layerLive)),
      ),
  );
});
