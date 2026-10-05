// @effect-diagnostics globalConsole:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
// Explicit acceptance test, never part of the unit test inventory or shipping helper.
// A real WKWebView loads a simulated add-in from a simulated dev server whose
// /__cinderdeck proxy reaches Cinderdeck's probe listener, exactly as the documented hook
// does. Office.js is simulated; WebKit, the probe, the proxy, the listener and the
// benchmark runner are real. Native capture is excluded: window input arrives through the
// fixture's test channel, so repaint and process metrics are reported unavailable.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { excelProbeSnippets } from "@cinderdeck/contracts/deckhand/excelPerformance";
import * as C from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import {
  ExcelPerformanceOptions,
  ExternalDebug,
  ExternalDebugTransport,
  layer,
} from "./ExternalDebug.ts";

const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
NodeFS.mkdirSync(NodePath.join(root, ".deckhand"), { recursive: true });
const state = NodeFS.mkdtempSync(NodePath.join(root, ".deckhand/excel-performance-test-"));
const bundle = NodePath.join(state, "ExcelProbeFixture.app");
const executable = NodePath.join(bundle, "Contents/MacOS/ExcelProbeFixture");
NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(bundle, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>ExcelProbeFixture</string><key>CFBundleIdentifier</key><string>com.cardinlabs.deckhand.excel-probe-fixture</string><key>CFBundleName</key><string>Excel Probe Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
);
NodeChildProcess.execFileSync(
  "/usr/bin/xcrun",
  [
    "swiftc",
    "-swift-version",
    "5",
    NodePath.join(root, "native/mac-external-debug/TestHost.swift"),
    "-o",
    executable,
  ],
  { stdio: "inherit" },
);
NodeChildProcess.execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", bundle], {
  stdio: "inherit",
});

const officeJs = `(function () {
  function ClientRequestContext() { this.m_pendingRequest = null; }
  ClientRequestContext.prototype.sync = function () {
    this.m_pendingRequest = null;
    return new Promise(function (resolve) { setTimeout(resolve, 30); });
  };
  function RequestContext() { ClientRequestContext.call(this); }
  RequestContext.prototype = Object.create(ClientRequestContext.prototype);
  window.OfficeExtension = { ClientRequestContext: ClientRequestContext };
  window.Excel = { RequestContext: RequestContext, run: function (batch) {
    var context = new RequestContext();
    return Promise.resolve().then(function () { return batch(context); });
  } };
  var ready = new Promise(function (resolve) { setTimeout(function () { resolve({ host: "Excel", platform: "Mac" }); }, 50); });
  window.Office = {
    onReady: function (callback) { return ready.then(function (info) { if (callback) callback(info); return info; }); },
    context: { diagnostics: { host: "Excel", platform: "Mac", version: "16.90 simulated" } }
  };
})();`;
const appJs = (loader: string) => `var process = { env: { NODE_ENV: "development" } };
${loader}
function stage(context, actions) { context.m_pendingRequest = { m_actions: new Array(actions) }; }
Office.onReady(function () { document.getElementById("out").textContent = "ready"; });
document.getElementById("validate").addEventListener("click", function () {
  performance.mark("validate:start");
  Excel.run(function (context) {
    stage(context, 12);
    return context.sync()
      .then(function () { return fetch("/api/validate?token=secret"); })
      .then(function (response) { return response.json(); })
      .then(function (result) { stage(context, 3); document.getElementById("out").textContent = "valid " + result.valid; return context.sync(); });
  }).then(function () { performance.measure("validate", "validate:start"); console.log("validated"); });
});
document.getElementById("load").addEventListener("click", function () {
  window.__cinderdeckProbe.time("load", function () {
    return Excel.run(function (context) {
      return fetch("/api/data").then(function (response) { return response.json(); }).then(function (rows) {
        stage(context, rows.length);
        document.getElementById("out").textContent = rows.length + " rows";
        return context.sync();
      });
    });
  });
});`;
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Contoso validation add-in</title>
<script src="/office.js"></script></head><body><button id="validate">Validate</button>
<button id="load">Load data</button><p id="out"></p><script src="/app.js"></script></body></html>`;

function devServer(probePort: number, loader: string) {
  const server = NodeHttp.createServer((request, response) => {
    const path = (request.url ?? "/").split("?")[0]!;
    if (path.startsWith("/__cinderdeck/")) {
      // What the generated webpack/Vite proxy rule does.
      const upstream = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: probePort,
          path: request.url,
          method: request.method,
          headers: request.headers,
        },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(response);
        },
      );
      upstream.on("error", () => response.writeHead(502).end());
      request.pipe(upstream);
      return;
    }
    const send = (type: string, body: string, delay = 0) =>
      setTimeout(
        () =>
          response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body),
        delay,
      );
    if (path === "/taskpane.html") return send("text/html", page);
    if (path === "/office.js") return send("text/javascript", officeJs);
    if (path === "/app.js") return send("text/javascript", appJs(loader));
    if (path === "/api/validate") return send("application/json", '{"valid":true}', 150);
    if (path === "/api/data")
      return send(
        "application/json",
        JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ row: i, value: "x".repeat(80) }))),
        80,
      );
    response.writeHead(404).end();
  });
  return new Promise<NodeHttp.Server>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

let host: NodeChildProcess.ChildProcess | undefined;
const elements: Record<string, string> = { e1: "validate", e2: "load" };
// Window input goes to the fixture's test channel instead of macOS input injection.
const transport = {
  discover: async () => [
    {
      id: "mac:1:1",
      title: "Contoso validation add-in",
      app: "Excel Probe Fixture",
      url: "com.cardinlabs.deckhand.excel-probe-fixture",
      type: "mac-window",
      socketURL: "",
    },
  ],
  connect: async () => ({
    call: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "Native.press") {
        host?.stdin?.write(`click ${elements[String(params.ref)]}\n`);
        return { accepted: true, at: Date.now() };
      }
      if (method === "Native.focus") return { accepted: true, at: Date.now() };
      throw new C.ExternalDebugError({ reason: "unsupported" });
    },
    close: () => undefined,
  }),
};

const outcome = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const service = yield* ExternalDebug;
      const actor = "excel-performance-acceptance";
      const armed = yield* service.probe(actor, { action: "arm", waitForClientMs: 0 });
      const { loaderSnippet } = excelProbeSnippets("webpack", armed.status.port);
      const server = yield* Effect.promise(() => devServer(armed.status.port, loaderSnippet));
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()));
      const address = server.address() as { port: number };
      host = NodeChildProcess.spawn(
        executable,
        [NodePath.join(state, "receipt.json"), `http://127.0.0.1:${address.port}/taskpane.html`],
        { stdio: ["pipe", "inherit", "inherit"] },
      );
      // Only this captured fixture process is stopped.
      yield* Effect.addFinalizer(() => Effect.sync(() => host?.kill()));
      const connected = yield* service.probe(actor, { action: "arm", waitForClientMs: 15000 });
      const client = connected.status.clients.find((entry) => entry.connected);
      NodeAssert.ok(
        client,
        "The probe in real WebKit reaches Cinderdeck through the dev-server proxy",
      );
      yield* Effect.sleep("1500 millis");
      const loaded = yield* service.probe(actor, { action: "read", after: 0, limit: 500 });
      const kinds = new Set(loaded.events.map((event) => event.kind));
      for (const kind of ["probe", "ready", "navigation", "resource"] as const)
        NodeAssert.ok(
          kinds.has(kind),
          `Page load reports ${kind} events: ${[...kinds].join(", ")}`,
        );
      NodeAssert.match(loaded.status.clients[0]?.office ?? "", /Excel Mac 16\.90/);
      const session = yield* service.attach(actor, {
        endpoint: "mac://local",
        targetId: "mac:1:1",
      });
      const started = yield* service.benchmark(actor, {
        action: "start",
        sessionId: session.sessionId,
        name: "Fixture validation",
        iterations: 3,
        warmup: 1,
        settleMs: 300,
        steps: [
          { label: "Validate", action: "press", ref: "e1" },
          { label: "Load data", action: "press", ref: "e2", until: { measure: "load" } },
        ],
        waitMs: 55000,
      });
      const result = yield* service.benchmark(actor, {
        action: "get",
        runId: started.report!.id,
        waitMs: 55000,
        includeSamples: true,
      });
      const report = result.report!;
      NodeAssert.equal(report.state, "completed", JSON.stringify(report));
      const validate = report.steps.find((step) => step.label === "Validate")!;
      const load = report.steps.find((step) => step.label === "Load data")!;
      NodeAssert.equal(validate.samples, 3);
      NodeAssert.equal(validate.timedOut, 0);
      NodeAssert.equal(validate.syncs.p50, 2, "Two context.sync round trips per validation");
      NodeAssert.equal(validate.requests.p50, 1, "One fetch per validation");
      NodeAssert.ok(
        validate.duration.p50 >= 200 && validate.duration.p50 < 1500,
        `Validate ${validate.duration.p50} ms`,
      );
      NodeAssert.ok(validate.measures.some((measure) => measure.name === "validate"));
      NodeAssert.ok(
        load.duration.p50 >= 80 && load.duration.p50 < 1500,
        `Load ${load.duration.p50} ms`,
      );
      NodeAssert.ok(load.measures.some((measure) => measure.name === "load"));
      NodeAssert.ok(
        report.warnings.some((warning) => warning.startsWith("Repaint timing")),
        "Unavailable native metrics are reported, not invented",
      );
      NodeAssert.ok(!report.warnings.some((warning) => warning.startsWith("No add-in probe")));
      const all = yield* service.probe(actor, { action: "read", after: 0, limit: 500 });
      NodeAssert.ok(!JSON.stringify(all).includes("secret"), "Query strings never leave the page");
      const syncs = all.events.filter((event) => event.kind === "sync");
      NodeAssert.ok(
        syncs.some((event) => event.count === 12),
        "Batched action counts are reported",
      );
      return { report, events: all.events.length, kinds: [...kinds] };
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(Layer.succeed(ExternalDebugTransport, transport)),
          Layer.provide(
            Layer.succeed(ExcelPerformanceOptions, {
              probePort: 0,
              reportsDirectory: NodePath.join(state, "reports"),
            }),
          ),
        ),
      ),
    ),
  ),
);
const receipt = {
  passed: true,
  realWebKit: true,
  officeSimulated: true,
  nativeCaptureExcluded: true,
  events: outcome.events,
  loadKinds: outcome.kinds,
  steps: outcome.report.steps.map((step) => ({
    label: step.label,
    durationP50: step.duration.p50,
    durationP95: step.duration.p95,
    syncs: step.syncs.p50,
    syncTime: step.syncTime.p50,
    requests: step.requests.p50,
    requestTime: step.requestTime.p50,
    measures: step.measures.map((measure) => `${measure.name} p50 ${measure.p50} ms`),
  })),
  warnings: outcome.report.warnings,
};
NodeFS.writeFileSync(
  NodePath.join(state, "excel-performance-acceptance.json"),
  JSON.stringify(receipt, null, 2),
);
console.log(JSON.stringify(receipt, null, 2));
console.log(`Excel performance acceptance passed. Evidence: ${state}`);
