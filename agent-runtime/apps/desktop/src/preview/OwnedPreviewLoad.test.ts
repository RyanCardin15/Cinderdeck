import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import type { WebContents } from "electron";
import type { OwnedPreviewTarget } from "@cinderdeck/contracts/deckhand/ownedPreviewRpc";
import { describe, expect, it } from "vite-plus/test";
import { artifactURL, reloadOwnedPreview } from "./OwnedPreviewLoad.ts";
const body = "<!doctype html><p>actual declared build</p>";
const url = "http://127.0.0.1:44123/";
const binding = {
  serviceURL: url,
  artifactPath: "/",
  artifactSHA256: NodeCrypto.createHash("sha256").update(body).digest("hex"),
};
const target: OwnedPreviewTarget = {
  tabID: "tab",
  webContentsID: 7,
  frameID: "frame",
  documentID: "old",
  targetID: "target",
  url,
  observedAt: "2026-10-04T00:00:00Z",
};
function fixture(
  mode: "success" | "old" | "wrong" | "navigate" | "missing" | "cached" = "success",
) {
  const wc = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
    id: number;
    getURL: () => string;
    reloadIgnoringCache: () => void;
    debugger: NodeEvents.EventEmitter & {
      sendCommand: (method: string, params?: unknown) => Promise<any>;
    };
  };
  wc.id = 7;
  wc.getURL = () => url;
  const commands: Array<[string, unknown]> = [];
  wc.debugger = Object.assign(new NodeEvents.EventEmitter(), {
    sendCommand: async (method: string, params?: unknown) => {
      commands.push([method, params]);
      if (method === "Page.getFrameTree")
        return {
          frameTree: { frame: { id: "frame", url, loaderId: mode === "old" ? "old" : "fresh" } },
        };
      if (method === "Network.getResponseBody")
        return { body: mode === "wrong" ? "stale bytes" : body, base64Encoded: false };
      if (method === "Page.reload") throw new Error("Guest CDP reload targets the embedder");
      return {};
    },
  });
  wc.reloadIgnoringCache = () => {
    wc.emit("did-start-navigation", { isMainFrame: true, url });
    if (mode === "navigate")
      wc.emit("did-start-navigation", { isMainFrame: true, url: url + "elsewhere" });
    if (mode !== "missing") {
      wc.debugger.emit("message", {}, "Network.responseReceived", {
        requestId: "request",
        loaderId: "fresh",
        frameId: "frame",
        response: { url, status: 200, fromDiskCache: mode === "cached" },
      });
      wc.debugger.emit("message", {}, "Network.loadingFinished", {
        requestId: "request",
        encodedDataLength: body.length,
      });
    }
    wc.emit("did-finish-load");
  };
  return { wc: wc as unknown as WebContents, emitter: wc, commands };
}
describe("owned preview fresh artifact consumption", () => {
  it("binds actual fresh response bytes and document then refuses further navigation while restoring settings", async () => {
    const f = fixture();
    const loaded = await reloadOwnedPreview(f.wc, target, binding, 50);
    expect(loaded.documentID).toBe("fresh");
    expect(loaded.consumedArtifactSHA256).toBe(binding.artifactSHA256);
    expect(loaded.invalidation()).toBeNull();
    f.emitter.emit("did-start-navigation", { isMainFrame: true, url });
    expect(loaded.invalidation()).toMatch(/navigated/);
    await loaded.restore();
    expect(f.commands).toContainEqual(["Network.setBypassServiceWorker", { bypass: false }]);
    expect(f.commands).toContainEqual(["Network.setCacheDisabled", { cacheDisabled: false }]);
    expect(f.emitter.listenerCount("did-start-navigation")).toBe(0);
  });
  it.each(["old", "wrong", "navigate", "missing", "cached"] as const)(
    "refuses %s load and restores manager debugger settings",
    async (mode) => {
      const f = fixture(mode);
      await expect(reloadOwnedPreview(f.wc, target, binding, 25)).rejects.toThrow();
      expect(f.commands).toContainEqual(["Network.setBypassServiceWorker", { bypass: false }]);
      expect(f.commands).toContainEqual(["Network.setCacheDisabled", { cacheDisabled: false }]);
      expect(f.emitter.listenerCount("did-start-navigation")).toBe(0);
    },
  );
  it("does not reload an external artifact or a switched preview", async () => {
    expect(() => artifactURL({ ...binding, artifactPath: "http://other.example/x" })).toThrow();
    const f = fixture();
    await expect(
      reloadOwnedPreview(f.wc, { ...target, webContentsID: 99 }, binding),
    ).rejects.toThrow();
    expect(f.commands).toHaveLength(0);
  });
});
