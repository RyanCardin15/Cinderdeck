// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  EXCEL_PROBE_EVENTS_PATH,
  EXCEL_PROBE_SCRIPT_PATH,
  ProbeStatus,
} from "@cinderdeck/contracts/deckhand/excelPerformance";
import { ProbeHub } from "./ExcelProbe.ts";
import { detectProbeSetup } from "./ExcelProbeSetup.ts";

const isProbeStatus = Schema.is(ProbeStatus);
const client = {
  id: "client-0001-page",
  page: "https://localhost:3000/taskpane.html?token=secret",
  title: "Contoso",
  office: "Excel Mac 16.90",
  pendingSyncs: 1,
  pendingRequests: 0,
  loadedAfter: 120,
};
const batch = (events: unknown[], extra: Record<string, unknown> = {}) => ({
  v: 1,
  sent: Date.now(),
  dropped: 0,
  client,
  events,
  ...extra,
});

describe("Excel add-in probe", () => {
  it("collects only for armed threads and normalizes untrusted page events", () => {
    const hub = new ProbeHub(0);
    const now = Date.now();
    const sync = { k: "sync", t0: now - 200, t1: now - 80, c: 12, ok: true, n: "run 1" };
    expect(hub.ingest(batch([sync]))).toEqual({ armed: false });
    expect(hub.status("thread-a").clients[0]).toMatchObject({
      page: "https://localhost:3000/taskpane.html",
      office: "Excel Mac 16.90",
      pendingSyncs: 1,
      connected: true,
    });
    hub.arm("thread-a");
    expect(
      hub.ingest(
        batch([
          sync,
          {
            k: "fetch",
            t0: now - 70,
            t1: now - 10,
            n: "https://graph.microsoft.com/v1.0/me?access_token=secret#x",
            x: "GET",
            s: 401,
            ok: false,
          },
          { k: "console", t: now, l: "error", x: "Failed with Bearer abc.def.ghi" },
          { k: "measure", t0: now - 300, t1: now - 50, n: "validate" },
          {
            k: "resource",
            t0: now - 900,
            t1: now - 600,
            n: "https://localhost:3000/taskpane.js",
            b: 512000,
            x: "script ttfb=20 download=280",
          },
          { k: "bogus", t: now },
          { k: "sync", t: 5 },
        ]),
      ),
    ).toEqual({ armed: true });
    const events = hub.read("thread-a", 0, 100);
    expect(events.map((event) => event.kind)).toEqual([
      "sync",
      "fetch",
      "console",
      "measure",
      "resource",
    ]);
    expect(events[1]).toMatchObject({
      name: "https://graph.microsoft.com/v1.0/me",
      status: 401,
      ok: false,
    });
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(JSON.stringify(events)).not.toContain("abc.def");
    expect(hub.read("thread-b", 0, 100)).toEqual([]);
    const status = hub.status("thread-a");
    expect(isProbeStatus(status)).toBe(true);
    expect(status.summary).toMatchObject({
      syncs: { count: 1, p50: 120 },
      requestFailures: 1,
      errors: 1,
      transferBytes: 512000,
      measures: [expect.objectContaining({ name: "validate", p50: 250 })],
    });
    expect(hub.read("thread-a", 3, 100, ["measure"]).map((event) => event.kind)).toEqual([
      "measure",
    ]);
    expect(() => hub.ingest({ client: { id: "x" }, events: [] })).toThrow();
    hub.disarm("thread-a");
    expect(hub.ingest(batch([sync]))).toEqual({ armed: false });
  });

  it("serves the probe on loopback and refuses cross-site posts without its header", async () => {
    const hub = new ProbeHub(0);
    try {
      await hub.ensureListening();
      const base = `http://127.0.0.1:${hub.listeningPort}`;
      const script = await fetch(base + EXCEL_PROBE_SCRIPT_PATH);
      expect(script.headers.get("content-type")).toContain("javascript");
      const source = await script.text();
      expect(source).toContain("__cinderdeckProbe");
      // The embedded probe must stay parseable browser JavaScript.
      expect(() => new Function(source)).not.toThrow();
      const body = JSON.stringify(batch([]));
      expect((await fetch(base + EXCEL_PROBE_EVENTS_PATH, { method: "POST", body })).status).toBe(
        403,
      );
      hub.arm("thread-a");
      const accepted = await fetch(base + EXCEL_PROBE_EVENTS_PATH, {
        method: "POST",
        body,
        headers: { "x-cinderdeck-probe": "1" },
      });
      expect(await accepted.json()).toEqual({ armed: true });
      expect(
        (
          await fetch(base + EXCEL_PROBE_EVENTS_PATH, {
            method: "POST",
            body: "x".repeat(600_000),
            headers: { "x-cinderdeck-probe": "1" },
          }).catch(() => ({ status: 413 }))
        ).status,
      ).toBe(413);
      expect(hub.activity()).toMatchObject({ clients: 1, pending: 1 });
    } finally {
      hub.close();
    }
  });

  it("detects a Yeoman Office webpack project and whether the hook is installed", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "addin-"));
    try {
      await NodeFSP.mkdir(NodePath.join(root, "src/taskpane"), { recursive: true });
      await NodeFSP.writeFile(
        NodePath.join(root, "package.json"),
        '{"devDependencies":{"webpack-dev-server":"^5.0.0","office-addin-debugging":"^5.0.0"}}',
      );
      await NodeFSP.writeFile(
        NodePath.join(root, "webpack.config.js"),
        'module.exports = { entry: { taskpane: ["./src/taskpane/taskpane.ts", "./src/taskpane/taskpane.html"] }, devServer: { port: 3000 } };',
      );
      await NodeFSP.writeFile(
        NodePath.join(root, "src/taskpane/taskpane.ts"),
        "Office.onReady(() => {});",
      );
      await NodeFSP.writeFile(NodePath.join(root, "manifest.xml"), "<OfficeApp/>");
      const fresh = await detectProbeSetup(root, 47823);
      expect(fresh).toMatchObject({
        bundler: "webpack",
        configFile: "webpack.config.js",
        entryFiles: ["src/taskpane/taskpane.ts"],
        manifests: ["manifest.xml"],
        proxyConfigured: false,
        loaderInstalled: false,
      });
      expect(fresh.proxySnippet).toContain('context: ["/__cinderdeck"]');
      expect(fresh.loaderSnippet).toContain('process.env.NODE_ENV !== "production"');
      await NodeFSP.appendFile(
        NodePath.join(root, "webpack.config.js"),
        "\n// /__cinderdeck proxy",
      );
      await NodeFSP.writeFile(
        NodePath.join(root, "src/taskpane/taskpane.ts"),
        fresh.loaderSnippet + "\nOffice.onReady(() => {});",
      );
      expect(await detectProbeSetup(root, 47823)).toMatchObject({
        proxyConfigured: true,
        loaderInstalled: true,
      });
      await expect(detectProbeSetup("relative/path", 47823)).rejects.toBeTruthy();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
