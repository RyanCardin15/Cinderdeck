// @effect-diagnostics globalDate:off
// @effect-diagnostics preferSchemaOverJson:off
// Tests exercise opaque CDP JSON, including malformed/redacted remote values.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as C from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import * as Service from "./ExternalDebug.ts";
import {
  debugEndpoint,
  debugURL,
  redactDebugText,
  sanitizeDebugValue,
  type DebugTransport,
} from "./ExternalDebugCDP.ts";

const isSnapshot = Schema.is(C.DebugSnapshot);
function fixture(native = false) {
  const calls: { method: string; params: Record<string, unknown> | undefined }[] = [];
  let emit: (method: string, params: Record<string, unknown>) => void = () => {};
  let disconnect: () => void = () => {};
  let closed = 0;
  let failing = "";
  const target = {
    id: "excel-pane",
    title: "Excel add-in",
    url: native ? "com.microsoft.Excel" : "https://localhost:3000/taskpane.html",
    type: native ? "mac-window" : "page",
    socketURL: "ws://127.0.0.1:9222/devtools/page/excel-pane",
  };
  let targets = [target];
  const transport: DebugTransport = {
    open: async (bundleId) => {
      calls.push({ method: "Native.open", params: { bundleId } });
    },
    discover: async () => targets,
    connect: async (_target, event, disconnected) => {
      emit = event;
      disconnect = disconnected;
      return {
        call: async (method, params) => {
          calls.push({
            method,
            params: method === "Native.press" ? { ...params, dispatched: Date.now() } : params,
          });
          if (method === failing) throw new C.ExternalDebugError({ reason: "unsupported" });
          if (method === "Page.captureScreenshot") return { data: "aGVsbG8=" };
          if (method === "Native.frame")
            return params?.known === 1
              ? { sequence: 1, unchanged: true }
              : { sequence: 1, data: "aGVsbG8=" };
          if (method === "Native.press") return { accepted: true, at: Date.now() };
          if (method === "Native.benchmark")
            return { enabled: params?.enabled, processes: 3, grouped: true };
          if (method === "Native.timeline") {
            const since = Number(params?.since);
            const press = calls.findLast((call) => call.method === "Native.press");
            const at = press ? Number(press.params?.dispatched) : 0;
            return {
              now: Date.now(),
              changes:
                at && at + 25 > since && at + 25 <= Date.now()
                  ? [{ t: at + 25, area: 0.1, rects: [[0.7, 0, 0.3, 1]] }]
                  : [],
              samples: [{ t: Date.now(), cpu: 35, memory: 250_000_000, processes: 3 }],
            };
          }
          if (method === "Native.snapshot")
            return {
              text: '[e0] Window "Book1"\n  [e1] Button "Run add-in" @0.500,0.400',
              elements: 2,
            };
          if (method === "Runtime.evaluate")
            return {
              result: {
                value: {
                  office: true,
                  access_token: "secret",
                  url: "https://graph.microsoft.com/me?token=secret",
                },
              },
            };
          if (method === "Debugger.setBreakpoint") return { breakpointId: "bp-1" };
          return {};
        },
        close: () => {
          closed += 1;
          disconnect();
        },
      };
    },
  };
  return {
    calls,
    emit: (method: string, params: Record<string, unknown>) => emit(method, params),
    disconnect: () => disconnect(),
    fail: (method: string) => {
      failing = method;
    },
    closed: () => closed,
    layer: Service.layer.pipe(
      Layer.provide(Layer.succeed(Service.ExternalDebugTransport, transport)),
      Layer.provide(
        Layer.succeed(Service.ExcelPerformanceOptions, { probePort: 0, reportsDirectory: null }),
      ),
    ),
    target,
    targets: (value: typeof targets) => {
      targets = value;
    },
  };
}
const withService = (
  f: ReturnType<typeof fixture>,
  run: (service: Service.ExternalDebug["Service"]) => Effect.Effect<void, C.ExternalDebugError>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* run(yield* Service.ExternalDebug);
    }).pipe(Effect.provide(f.layer)),
  );
describe("external runtime debugging", () => {
  it.effect("opens an exact app identity and reuses the thread's single attachment", () => {
    const f = fixture(true);
    return withService(f, (service) =>
      Effect.gen(function* () {
        const opened = yield* service.open("owner", { bundleId: "com.microsoft.Excel" });
        expect(opened.session?.target.id).toBe(f.target.id);
        const repeated = yield* service.open("owner", { bundleId: "com.microsoft.Excel" });
        expect(repeated.session?.sessionId).toBe(opened.session?.sessionId);
        expect(yield* service.sessions("owner")).toHaveLength(1);
        expect(yield* service.sessions("other")).toEqual([]);
        expect(
          (yield* service.open("other", { bundleId: "com.microsoft.Excel" }).pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        expect(f.calls.every((call) => call.method === "Native.open")).toBe(true);
      }),
    );
  });
  it.effect("opens without guessing among multiple workbooks, and rejects executable paths", () => {
    const f = fixture(true);
    f.targets([f.target, { ...f.target, id: "second-workbook" }]);
    return withService(f, (service) =>
      Effect.gen(function* () {
        expect(yield* service.open("owner", { bundleId: "com.microsoft.Excel" })).toMatchObject({
          session: null,
        });
        expect(yield* service.sessions("owner")).toEqual([]);
        const before = f.calls.length;
        for (const bundleId of [
          "/Applications/Excel.app",
          "https://example.test",
          "com.microsoft.Excel;touch /tmp/test",
          "Excel",
        ])
          expect((yield* service.open("owner", { bundleId }).pipe(Effect.result))._tag).toBe(
            "Failure",
          );
        expect(f.calls).toHaveLength(before);
      }),
    );
  });
  it.effect("records accepted and failed native actions without copying typed app data", () => {
    const f = fixture(true);
    return withService(f, (service) =>
      Effect.gen(function* () {
        const session = yield* service.attach("owner", {
          endpoint: "mac://local",
          targetId: f.target.id,
        });
        yield* service.command("owner", {
          sessionId: session.sessionId,
          action: "type",
          text: "private workbook data",
        });
        yield* service.command("owner", {
          sessionId: session.sessionId,
          action: "key",
          key: "n",
          modifiers: ["meta"],
        });
        f.fail("Native.click");
        yield* service
          .command("owner", { sessionId: session.sessionId, action: "click", x: 0.2, y: 0.3 })
          .pipe(Effect.result);
        const snapshot = yield* service.read("owner", {
          sessionId: session.sessionId,
          after: 0,
          screenshot: false,
        });
        expect(
          snapshot.events.filter((event) => event.kind === "action").map((event) => event.text),
        ).toEqual(["type accepted", "key accepted (meta+n)", "click failed: unsupported"]);
        expect(JSON.stringify(snapshot)).not.toContain("private workbook data");
      }),
    );
  });
  it.effect("reads accessibility outlines and targets elements, drags and repaints", () => {
    const f = fixture(true);
    return withService(f, (service) =>
      Effect.gen(function* () {
        const session = yield* service.attach("owner", {
          endpoint: "mac://local",
          targetId: f.target.id,
        });
        const outline = yield* service.command("owner", {
          sessionId: session.sessionId,
          action: "snapshot",
        });
        expect(outline.text).toContain('[e1] Button "Run add-in"');
        const first = yield* service.read("owner", {
          sessionId: session.sessionId,
          after: 0,
          screenshot: true,
        });
        // Reading the outline is observation: no action log, no repaint wait.
        expect(first.events.filter((event) => event.kind === "action")).toEqual([]);
        expect(f.calls.find((call) => call.method === "Native.frame")?.params).toEqual({});
        expect(first.image).toBe("aGVsbG8=");
        const before = f.calls.length;
        for (const invalid of [
          { action: "press" },
          { action: "click" },
          { action: "drag", x: 0.1, y: 0.1 },
          { action: "key" },
        ] as const)
          expect(
            (yield* service
              .command("owner", { sessionId: session.sessionId, ...invalid })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        expect(f.calls).toHaveLength(before);
        yield* service.command("owner", {
          sessionId: session.sessionId,
          action: "click",
          ref: "e1",
        });
        expect(f.calls.at(-1)).toEqual({ method: "Native.click", params: { ref: "e1" } });
        yield* service.command("owner", {
          sessionId: session.sessionId,
          action: "drag",
          x: 0.1,
          y: 0.2,
          toX: 0.3,
          toY: 0.4,
          modifiers: ["shift"],
        });
        expect(f.calls.at(-1)).toEqual({
          method: "Native.drag",
          params: { x: 0.1, y: 0.2, toX: 0.3, toY: 0.4, modifiers: ["shift"] },
        });
        yield* service.command("owner", {
          sessionId: session.sessionId,
          action: "press",
          ref: "e1",
        });
        const after = yield* service.read("owner", {
          sessionId: session.sessionId,
          after: first.nextSequence,
          screenshot: true,
          ...(first.imageSequence === undefined ? {} : { afterImage: first.imageSequence }),
        });
        // Input makes the next read wait for a newer frame; the helper withholds unchanged bytes.
        expect(f.calls.at(-1)).toEqual({
          method: "Native.frame",
          params: { known: 1, after: 1, waitMs: 600 },
        });
        expect(after.image).toBeNull();
        expect(after.imageSequence).toBe(first.imageSequence);
        expect(after.events.map((event) => event.text)).toEqual([
          "click accepted (e1)",
          "drag accepted",
          "press accepted (e1)",
        ]);
        const repeat = yield* service.read("owner", {
          sessionId: session.sessionId,
          after: 0,
          screenshot: true,
        });
        expect(repeat.image).toBe("aGVsbG8=");
      }),
    );
  });
  it.effect("benchmarks a native window, reserving its input while the run is active", () => {
    const f = fixture(true);
    return withService(f, (service) =>
      Effect.gen(function* () {
        const session = yield* service.attach("owner", {
          endpoint: "mac://local",
          targetId: f.target.id,
        });
        const steps = [{ label: "Run validation", action: "press" as const, ref: "e1" }];
        const started = yield* service.benchmark("owner", {
          action: "start",
          sessionId: session.sessionId,
          steps,
          iterations: 2,
          warmup: 0,
          settleMs: 150,
        });
        const runId = started.report!.id;
        expect(started.report?.state).toBe("running");
        expect(
          (yield* service
            .command("owner", { sessionId: session.sessionId, action: "press", ref: "e1" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* service.command("owner", { sessionId: session.sessionId, action: "snapshot" });
        expect(
          (yield* service.benchmark("other", { action: "get", runId }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        const finished = yield* service.benchmark("owner", { action: "get", runId, waitMs: 10000 });
        const report = finished.report!;
        expect(report.state).toBe("completed");
        expect(report.samples).toEqual([]);
        expect(report.steps[0]).toMatchObject({ label: "Run validation", samples: 2, timedOut: 0 });
        expect(report.steps[0]!.duration.p50).toBe(25);
        expect(report.steps[0]!.firstPaint?.p50).toBe(25);
        expect(report.steps[0]!.cpuAverage?.p50).toBe(35);
        expect(report.processesMeasured).toBe(3);
        expect(report.warnings.join(" ")).toContain("No add-in probe is connected");
        expect(
          f.calls
            .filter((call) => call.method === "Native.benchmark")
            .map((call) => call.params?.enabled),
        ).toEqual([true, false]);
        const withSamples = yield* service.benchmark("owner", {
          action: "get",
          runId,
          includeSamples: true,
        });
        expect(withSamples.report?.samples).toHaveLength(2);
        const listed = yield* service.benchmark("owner", { action: "list" });
        expect(listed.reports.map((entry) => entry.id)).toEqual([runId]);
        const compared = yield* service.benchmark("owner", {
          action: "start",
          sessionId: session.sessionId,
          steps,
          iterations: 1,
          warmup: 0,
          settleMs: 150,
          baselineId: runId,
          waitMs: 10000,
        });
        expect(compared.report?.comparison?.steps[0]).toMatchObject({
          label: "Run validation",
          verdict: "unchanged",
        });
        yield* service.command("owner", {
          sessionId: session.sessionId,
          action: "press",
          ref: "e1",
        });
      }),
    );
  });
  it.effect("arms, reads and disarms the add-in probe per thread", () => {
    const f = fixture(true);
    return withService(f, (service) =>
      Effect.gen(function* () {
        const armed = yield* service.probe("owner", { action: "arm", waitForClientMs: 0 });
        expect(armed.status).toMatchObject({ armed: true, listening: true, clients: [] });
        expect(armed.status.port).toBeGreaterThan(0);
        expect((yield* service.probe("other", { action: "status" })).status.armed).toBe(false);
        const read = yield* service.probe("owner", { action: "read", after: 0 });
        expect(read.events).toEqual([]);
        expect((yield* service.probe("owner", { action: "setup" }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect((yield* service.probe("owner", { action: "disarm" })).status.armed).toBe(false);
      }),
    );
  });
  it("accepts only an explicit loopback root, without credentials or redirects", () => {
    expect(debugEndpoint("mac://local").href).toBe("mac://local/");
    expect(debugEndpoint("http://localhost:9222").href).toBe("http://127.0.0.1:9222/");
    expect(debugEndpoint("http://[::1]:9222").hostname).toBe("[::1]");
    for (const endpoint of [
      "https://127.0.0.1:9222",
      "http://192.168.1.2:9222",
      "http://127.0.0.1.evil.test:9222",
      "http://user:password@127.0.0.1:9222",
      "http://127.0.0.1:9222/path",
      "http://127.0.0.1:9222?token=secret",
      "mac://local:123",
      "mac://other",
      "mac://local/path",
      "mac://local?token=secret",
    ])
      expect(() => debugEndpoint(endpoint)).toThrow();
  });
  it.effect(
    "controls a native host without CDP injection and transfers only changed images",
    () => {
      const f = fixture(true);
      return withService(f, (service) =>
        Effect.gen(function* () {
          const session = yield* service.attach("owner", {
            endpoint: "mac://local",
            targetId: f.target.id,
          });
          expect(f.calls).toEqual([]);
          yield* service.command("owner", {
            sessionId: session.sessionId,
            action: "click",
            x: 0.3,
            y: 0.4,
          });
          expect(f.calls.at(-1)).toEqual({ method: "Native.click", params: { x: 0.3, y: 0.4 } });
          const unsupported = yield* service
            .command("owner", {
              sessionId: session.sessionId,
              action: "evaluate",
              expression: "Office.context.host",
            })
            .pipe(Effect.result);
          expect(unsupported._tag).toBe("Failure");
          const first = yield* service.read("owner", {
            sessionId: session.sessionId,
            after: 0,
            screenshot: true,
          });
          expect(first.image).toBe("aGVsbG8=");
          const next = yield* service.read("owner", {
            sessionId: session.sessionId,
            after: first.nextSequence,
            screenshot: true,
            ...(first.imageSequence === undefined ? {} : { afterImage: first.imageSequence }),
          });
          expect(next.image).toBeNull();
          expect(next.imageSequence).toBe(first.imageSequence);
          yield* service.detach("owner", { sessionId: session.sessionId });
          expect(f.closed()).toBe(1);
          expect(
            f.calls.some((call) => /Debugger|Runtime|closeTarget|navigate/.test(call.method)),
          ).toBe(false);
        }),
      );
    },
  );
  it("redacts OAuth material while preserving valid JSON responses", () => {
    expect(debugURL("https://user:password@graph.microsoft.com/me?access_token=secret#code")).toBe(
      "https://graph.microsoft.com/me",
    );
    const value = JSON.stringify(
      sanitizeDebugValue({
        access_token: "secret",
        value: "Bearer secret https://graph.microsoft.com/me?code=secret",
        scriptSource: 'console.log("https://example.test/?token=secret");',
      }),
    );
    expect(JSON.parse(value).access_token).toBe("[redacted]");
    expect(value).not.toContain("secret");
    expect(redactDebugText("x".repeat(20000)).length).toBe(8192);
  });
  it.effect("attaches without replacing the runtime and isolates session ownership", () => {
    const f = fixture();
    return withService(f, (service) =>
      Effect.gen(function* () {
        const session = yield* service.attach("owner", {
          endpoint: "http://127.0.0.1:9222",
          targetId: f.target.id,
        });
        expect(f.calls.map((c) => c.method)).toEqual([
          "Runtime.enable",
          "Page.enable",
          "Network.enable",
          "Debugger.enable",
        ]);
        expect(yield* service.sessions("other")).toEqual([]);
        const denied = yield* service
          .read("other", { sessionId: session.sessionId, after: 0, screenshot: false })
          .pipe(Effect.result);
        expect(denied._tag).toBe("Failure");
        const duplicate = yield* service
          .attach("owner", { endpoint: session.endpoint, targetId: f.target.id })
          .pipe(Effect.result);
        expect(duplicate._tag).toBe("Failure");
        yield* service.detach("owner", { sessionId: session.sessionId });
        yield* service.detach("owner", { sessionId: session.sessionId });
        expect(f.closed()).toBe(1);
        expect(f.calls.at(-1)?.method).toBe("Debugger.disable");
        expect(f.calls.some((c) => /navigate|closeTarget|setDeviceMetrics/.test(c.method))).toBe(
          false,
        );
      }),
    );
  });
  it.effect("shares native capture with the calling thread and denies other threads", () => {
    const f = fixture(true);
    return withService(f, (service) =>
      Effect.gen(function* () {
        const panelOwner = Service.externalDebugThreadOwner("thread-a");
        const session = yield* service.attach(panelOwner, {
          endpoint: "mac://local",
          targetId: f.target.id,
        });
        const mcpOwner = Service.externalDebugThreadOwner("thread-a");
        expect(yield* service.sessions(mcpOwner)).toEqual([session]);
        yield* service.command(mcpOwner, { sessionId: session.sessionId, action: "focus" });
        const other = Service.externalDebugThreadOwner("thread-b");
        expect(yield* service.sessions(other)).toEqual([]);
        for (const attempt of [
          service.read(other, { sessionId: session.sessionId, after: 0, screenshot: true }),
          service.command(other, { sessionId: session.sessionId, action: "focus" }),
          service.detach(other, { sessionId: session.sessionId }),
        ])
          expect((yield* attempt.pipe(Effect.result))._tag).toBe("Failure");
        expect(f.closed()).toBe(0);
        yield* service.detach(mcpOwner, { sessionId: session.sessionId });
        expect(f.closed()).toBe(1);
        expect(yield* service.sessions(panelOwner)).toEqual([]);
      }),
    );
  });
  it.effect("bounds diagnostics and paginates without losing its cursor", () => {
    const f = fixture();
    return withService(f, (service) =>
      Effect.gen(function* () {
        const session = yield* service.attach("owner", {
          endpoint: "http://127.0.0.1:9222",
          targetId: f.target.id,
        });
        for (let i = 0; i < 610; i++)
          f.emit("Runtime.consoleAPICalled", { args: [{ value: `event ${i} Bearer secret` }] });
        const first = yield* service.read("owner", {
          sessionId: session.sessionId,
          after: 0,
          screenshot: true,
        });
        expect(first.events).toHaveLength(100);
        expect(first.dropped).toBe(111);
        expect(first.image).toBe("aGVsbG8=");
        expect(first.events.every((e) => !e.text.includes("secret"))).toBe(true);
        expect(isSnapshot(first)).toBe(true);
        const next = yield* service.read("owner", {
          sessionId: session.sessionId,
          after: first.nextSequence,
          screenshot: true,
        });
        expect(next.events[0]?.sequence).toBe(first.nextSequence + 1);
        expect(next.dropped).toBe(0);
        expect(f.calls.filter((c) => c.method === "Page.captureScreenshot")).toHaveLength(1);
      }),
    );
  });
  it.effect("collects failed Graph requests without capturing headers or bodies", () => {
    const f = fixture();
    return withService(f, (service) =>
      Effect.gen(function* () {
        const session = yield* service.attach("owner", {
          endpoint: "http://127.0.0.1:9222",
          targetId: f.target.id,
        });
        f.emit("Network.requestWillBeSent", {
          requestId: "req",
          timestamp: 5,
          request: {
            method: "GET",
            url: "https://graph.microsoft.com/me?token=secret",
            headers: { Authorization: "secret" },
            postData: "secret",
          },
        });
        f.emit("Network.responseReceived", {
          requestId: "req",
          response: { status: 401, headers: { cookie: "secret" } },
        });
        f.emit("Network.loadingFinished", { requestId: "req", timestamp: 5.12 });
        const result = yield* service.read("owner", {
          sessionId: session.sessionId,
          after: 0,
          screenshot: false,
        });
        const event = result.events.find((e) => e.kind === "network");
        expect(event?.text).toBe("GET 401 https://graph.microsoft.com/me · 120 ms");
        expect(event?.level).toBe("error");
        expect(JSON.stringify(result)).not.toContain("secret");
      }),
    );
  });
  it.effect("evaluates in the selected Office context and exposes paused frames", () => {
    const f = fixture();
    return withService(f, (service) =>
      Effect.gen(function* () {
        const session = yield* service.attach("owner", {
          endpoint: "http://127.0.0.1:9222",
          targetId: f.target.id,
        });
        const result = yield* service.command("owner", {
          sessionId: session.sessionId,
          action: "evaluate",
          expression: "Office.context.host",
          contextId: 7,
        });
        expect(f.calls.find((c) => c.method === "Runtime.evaluate")?.params?.contextId).toBe(7);
        expect(JSON.parse(result.text).result.value.access_token).toBe("[redacted]");
        f.emit("Debugger.paused", {
          reason: "breakpoint",
          callFrames: [
            {
              callFrameId: "frame",
              functionName: "loadWorkbook",
              url: "https://example.test/app.js",
              location: { scriptId: "script", lineNumber: 10, columnNumber: 0 },
            },
          ],
        });
        const paused = yield* service.read("owner", {
          sessionId: session.sessionId,
          after: 0,
          screenshot: false,
        });
        expect(paused.session.paused).toBe(true);
        expect(paused.callFrames[0]?.functionName).toBe("loadWorkbook");
        yield* service.command("owner", {
          sessionId: session.sessionId,
          action: "evaluate",
          expression: "localVariable",
          callFrameId: "frame",
        });
        expect(f.calls.some((c) => c.method === "Debugger.evaluateOnCallFrame")).toBe(true);
        f.disconnect();
        const disconnected = yield* service.read("owner", {
          sessionId: session.sessionId,
          after: 0,
          screenshot: false,
        });
        expect(disconnected.session.state).toBe("disconnected");
        expect(disconnected.callFrames).toEqual([]);
        expect(
          (yield* service
            .command("owner", { sessionId: session.sessionId, action: "pause" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    );
  });
  it.effect(
    "keeps diagnostics usable when screenshots are unsupported and cleans up failed attachments",
    () => {
      const f = fixture();
      return withService(f, (service) =>
        Effect.gen(function* () {
          f.fail("Page.enable");
          expect(
            (yield* service
              .attach("owner", { endpoint: "http://127.0.0.1:9222", targetId: f.target.id })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(f.closed()).toBe(1);
          f.fail("Page.captureScreenshot");
          const session = yield* service.attach("owner", {
            endpoint: "http://127.0.0.1:9222",
            targetId: f.target.id,
          });
          const result = yield* service.read("owner", {
            sessionId: session.sessionId,
            after: 0,
            screenshot: true,
          });
          expect(result.imageUnavailable).toBe(true);
          expect(result.session.state).toBe("connected");
        }),
      );
    },
  );
});
