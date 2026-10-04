// @effect-diagnostics globalTimers:off - bounded Electron/CDP Promise lifecycle timeout, cleared on every exit.
// @effect-diagnostics nodeBuiltinImport:off - Main hashes the actual CDP response consumed by its document.
import * as NodeCrypto from "node:crypto";
import type {
  OwnedPreviewBinding,
  OwnedPreviewTarget,
} from "@t3tools/contracts/deckhand/ownedPreviewRpc";
import type { WebContents } from "electron";

export const artifactURL = (binding: OwnedPreviewBinding): string => {
  const base = new URL(binding.serviceURL);
  const artifact = new URL(binding.artifactPath, base);
  if (
    base.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    artifact.origin !== base.origin ||
    artifact.username ||
    artifact.password ||
    artifact.hash
  )
    throw new Error("Invalid owned artifact URL");
  return artifact.href;
};

/** Keep bypass and target guards for the entire capture; never detach the manager's debugger. */
export async function reloadOwnedPreview(
  wc: WebContents,
  before: OwnedPreviewTarget,
  binding: OwnedPreviewBinding,
  timeoutMs = 30000,
) {
  const expectedURL = artifactURL(binding);
  if (
    new URL(before.url).origin !== new URL(binding.serviceURL).origin ||
    wc.getURL() !== before.url ||
    wc.id !== before.webContentsID
  )
    throw new Error("Preview is not the declared owned service");
  let invalidation: string | null = null;
  let navigations = 0;
  let loaded = false;
  let freshDocument: string | undefined;
  let artifact: { sha256: string; loaderID: string; frameID: string } | undefined;
  const responses = new Map<string, { loaderID: string; frameID: string }>();
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  // A lifecycle event can fail while enabling CDP; preserve that failure without an unhandled rejection.
  void ready.catch(() => {});
  const refuse = (reason: string) => {
    invalidation ??= reason;
    reject(new Error(reason));
  };
  const complete = () => {
    if (invalidation) return;
    if (loaded && artifact && freshDocument) {
      if (artifact.loaderID !== freshDocument || artifact.frameID !== before.frameID)
        return refuse("Artifact belongs to a different document");
      if (artifact.sha256 !== binding.artifactSHA256)
        return refuse("Loaded artifact differs from the declared build");
      resolve();
    }
  };
  const navigate = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!event.isMainFrame) return;
    navigations++;
    if (navigations !== 1 || event.url !== before.url || loaded)
      refuse("Preview navigated away from the pinned document");
  };
  const destroyed = () => refuse("Preview target was destroyed");
  const processGone = () => refuse("Preview renderer exited");
  const detached = () => refuse("Preview debugger detached");
  const load = () => {
    void wc.debugger.sendCommand("Page.getFrameTree").then(
      (tree) => {
        const frame = tree?.frameTree?.frame;
        if (
          navigations !== 1 ||
          frame?.id !== before.frameID ||
          frame?.url !== before.url ||
          !frame?.loaderId ||
          frame.loaderId === before.documentID ||
          wc.getURL() !== before.url
        )
          return refuse("Fresh pinned document could not be established");
        freshDocument = frame.loaderId;
        loaded = true;
        complete();
      },
      () => refuse("Fresh document unavailable"),
    );
  };
  const message = (_event: Electron.Event, method: string, params: Record<string, any>) => {
    if (method === "Network.responseReceived" && params.response?.url === expectedURL) {
      if (
        params.response.status !== 200 ||
        params.response.fromServiceWorker ||
        params.response.fromDiskCache
      )
        return refuse("Declared artifact did not load freshly");
      if (params.frameId === before.frameID)
        responses.set(params.requestId, { loaderID: params.loaderId, frameID: params.frameId });
    }
    if (method === "Network.loadingFailed" && responses.has(params.requestId))
      refuse("Declared artifact response failed");
    if (method === "Network.loadingFinished" && responses.has(params.requestId)) {
      const response = responses.get(params.requestId)!;
      responses.delete(params.requestId);
      if (!(params.encodedDataLength >= 0) || params.encodedDataLength > 33554432)
        return refuse("Artifact response exceeds capture limit");
      void wc.debugger.sendCommand("Network.getResponseBody", { requestId: params.requestId }).then(
        (body) => {
          if (typeof body?.body !== "string" || body.body.length > 44739244)
            return refuse("Artifact body unavailable or too large");
          const bytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
          if (bytes.length > 33554432) return refuse("Artifact body exceeds capture limit");
          const next = {
            ...response,
            sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
          };
          if (artifact) return refuse("Declared artifact loaded more than once");
          artifact = next;
          complete();
        },
        () => refuse("Actual loaded artifact body unavailable"),
      );
    }
  };
  wc.on("did-start-navigation", navigate);
  wc.on("did-finish-load", load);
  wc.on("destroyed", destroyed);
  wc.on("render-process-gone", processGone);
  wc.debugger.on("detach", detached);
  wc.debugger.on("message", message);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    if (timer) clearTimeout(timer);
    wc.off("did-start-navigation", navigate);
    wc.off("did-finish-load", load);
    wc.off("destroyed", destroyed);
    wc.off("render-process-gone", processGone);
    wc.debugger.off("detach", detached);
    wc.debugger.off("message", message);
    await Promise.allSettled([
      wc.debugger.sendCommand("Network.setCacheDisabled", { cacheDisabled: false }),
      wc.debugger.sendCommand("Network.setBypassServiceWorker", { bypass: false }),
    ]);
  };
  try {
    await wc.debugger.sendCommand("Page.enable");
    await wc.debugger.sendCommand("Network.enable");
    await wc.debugger.sendCommand("Network.setCacheDisabled", { cacheDisabled: true });
    await wc.debugger.sendCommand("Network.setBypassServiceWorker", { bypass: true });
    timer = setTimeout(
      () => refuse("Declared artifact was not observed in a fresh document"),
      timeoutMs,
    );
    // A guest debugger's Page.reload can reload its embedder in Electron.
    // Reload the exact verified guest, keeping CDP solely for response evidence.
    wc.reloadIgnoringCache();
    await ready;
    if (timer) clearTimeout(timer);
    // Response collection ends once the exact load is established; lifecycle guards remain.
    wc.debugger.off("message", message);
    wc.off("did-finish-load", load);
    return {
      documentID: freshDocument!,
      consumedArtifactSHA256: artifact!.sha256,
      consumedArtifactURL: expectedURL,
      invalidation: () => invalidation,
      restore,
    };
  } catch (error) {
    await restore();
    throw error;
  }
}
