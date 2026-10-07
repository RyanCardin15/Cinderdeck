// @effect-diagnostics globalTimers:off - bounded hidden Electron encoder handshake lifecycle.
// @effect-diagnostics nodeBuiltinImport:off - bounded encoder output remains exclusively Main-owned.
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
const MAX_OWNED_CAPTURE_BYTES = 268435456;
const RESULT = "deckhand:owned-encoder:result";
export interface OwnedEncodedVideo {
  path: string;
  mimeType: "video/mp4" | "video/webm";
  sha256: string;
  size: number;
  frameCount: number;
}
export function acceptsEncoderSender(
  window: { webContents: { id: number; mainFrame: unknown } },
  event: { sender: { id: number }; senderFrame?: unknown },
): boolean {
  return (
    event.sender.id === window.webContents.id && event.senderFrame === window.webContents.mainFrame
  );
}
export const OWNED_ENCODER_HTML = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; img-src data:; style-src 'unsafe-inline'"><canvas></canvas><script>
(async () => {
  const bridge = window.deckhandOwnedEncoder, canvas = document.querySelector('canvas'), context = canvas.getContext('2d', { alpha: false });
  const formats = ['video/mp4;codecs=avc1.42001E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const selected = formats.find(value => MediaRecorder.isTypeSupported(value));
  if (!context || !selected) throw new Error('No video encoder');
  const stream = canvas.captureStream(0), track = stream.getVideoTracks()[0];
  const recorder = new MediaRecorder(stream, { mimeType: selected, videoBitsPerSecond: 4000000 });
  let sequence = 0, pending = Promise.resolve(), frameCount = 0, stopped = false, stopRequested = false;
  let latestImage = null, frameTimer = null;
  const paint = () => {
    if (!latestImage || stopped || recorder.state !== 'recording') return;
    context.drawImage(latestImage,0,0,canvas.width,canvas.height); track.requestFrame();
  };
  recorder.ondataavailable = event => {
    if (!event.data.size) return;
    const index = sequence++;
    pending = pending.then(async () => bridge.report({kind:'chunk',index,data:new Uint8Array(await event.data.arrayBuffer())}));
  };
  recorder.onstop = () => {
    if (frameTimer !== null) { clearInterval(frameTimer); frameTimer = null; }
    pending.then(() => bridge.report({kind:'finished',frameCount})).catch(() => bridge.report({kind:'failed'}));
    stream.getTracks().forEach(value => value.stop());
  };
  let drawing = Promise.resolve(), queuedFrames = 0;
  bridge.onFrame(data => {
    if (stopRequested || stopped || queuedFrames >= 3) return;
    queuedFrames++;
    drawing = drawing.then(async () => {
      const image = new Image(); image.src = 'data:image/jpeg;base64,' + data; await image.decode();
      if (stopped) return;
      if (!frameCount) { canvas.width = image.width; canvas.height = image.height; recorder.start(1000); }
      latestImage = image; paint(); frameCount++;
      // CDP emits frames when the browser paints. Repaint its last actual decoded
      // image at a bounded 10fps so a static scene retains elapsed video time.
      // These repeats do not count as additional browser frames in the proof.
      if (frameTimer === null) frameTimer = setInterval(paint, 100);
      if (frameCount === 1) await bridge.report({kind:'first_frame'});
    }).catch(() => bridge.report({kind:'failed'})).finally(() => { queuedFrames--; });
  });
  bridge.onStop(() => {
    if (stopRequested) return;
    stopRequested = true;
    if (frameTimer !== null) { clearInterval(frameTimer); frameTimer = null; }
    drawing.then(() => {
      if (recorder.state === 'inactive') { stopped = true; bridge.report({kind:'failed'}); }
      else { paint(); stopped = true; recorder.stop(); }
    }).catch(() => bridge.report({kind:'failed'}));
  });
  await bridge.report({kind:'ready',mimeType: selected.startsWith('video/mp4') ? 'video/mp4' : 'video/webm'});
})().catch(() => window.deckhandOwnedEncoder.report({kind:'failed'}));
</script>`;
export async function createOwnedPreviewEncoder(input: {
  preload: string;
  outputPath: string;
  onFirstFrame: () => Promise<void>;
}) {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      preload: input.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: `deckhand-owned-encoder-${NodeCrypto.randomUUID()}`,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-frame-navigate", (event) => event.preventDefault());
  let mimeType: "video/mp4" | "video/webm" = "video/webm",
    nextChunk = 0,
    size = 0,
    framesSent = 0,
    stopping = false;
  const digest = NodeCrypto.createHash("sha256");
  const file = await NodeFSP.open(input.outputPath, "wx", 0o600);
  let rejectResult!: (cause: unknown) => void, resolveResult!: (value: OwnedEncodedVideo) => void;
  const result = new Promise<OwnedEncodedVideo>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Attach a rejection observer immediately; finish still receives the original failure.
  void result.catch(() => undefined);
  let resolveReady!: () => void, rejectReady!: (cause: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const fail = (message: string) => {
    const error = new Error(message);
    rejectReady(error);
    rejectResult(error);
  };
  window.webContents.on("render-process-gone", () => fail("Owned encoder process exited"));
  window.on("closed", () => {
    if (!stopping) fail("Owned encoder window closed");
  });
  let tail = Promise.resolve();
  ipcMain.handle(RESULT, (event, raw: unknown) => {
    if (!acceptsEncoderSender(window, event)) throw new Error("Untrusted encoder sender");
    if (typeof raw !== "object" || raw === null) throw new Error("Invalid encoder payload");
    const value = raw as Record<string, unknown>;
    tail = tail
      .then(async () => {
        if (
          value.kind === "ready" &&
          (value.mimeType === "video/mp4" || value.mimeType === "video/webm")
        ) {
          mimeType = value.mimeType;
          resolveReady();
          return;
        }
        if (value.kind === "first_frame") {
          await input.onFirstFrame();
          return;
        }
        if (value.kind === "chunk") {
          if (
            value.index !== nextChunk ||
            !(value.data instanceof Uint8Array) ||
            !value.data.length ||
            value.data.length > 8 * 1024 * 1024 ||
            size + value.data.length > MAX_OWNED_CAPTURE_BYTES
          )
            throw new Error("Owned encoder chunk refused");
          nextChunk++;
          size += value.data.length;
          digest.update(value.data);
          await file.writeFile(value.data);
          return;
        }
        if (
          value.kind === "finished" &&
          typeof value.frameCount === "number" &&
          Number.isSafeInteger(value.frameCount) &&
          value.frameCount > 0 &&
          value.frameCount <= framesSent &&
          size > 0
        ) {
          await file.sync();
          await file.close();
          resolveResult({
            path: input.outputPath,
            mimeType,
            sha256: digest.digest("hex"),
            size,
            frameCount: value.frameCount,
          });
          return;
        }
        throw new Error("Owned encoder failed");
      })
      .catch((error) => {
        fail("Owned encoder failed");
        throw error;
      });
    return tail;
  });
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    readyTimer = setTimeout(() => fail("Owned encoder readiness timed out"), 30000);
    await Promise.all([
      window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OWNED_ENCODER_HTML)}`),
      ready,
    ]);
    clearTimeout(readyTimer);
  } catch (error) {
    if (readyTimer) clearTimeout(readyTimer);
    ipcMain.removeHandler(RESULT);
    window.destroy();
    await file.close();
    throw error;
  }
  return {
    frame: (data: string) => {
      if (!stopping && !window.isDestroyed()) {
        framesSent++;
        window.webContents.send("deckhand:owned-encoder:frame", data);
      }
    },
    finish: async () => {
      stopping = true;
      window.webContents.send("deckhand:owned-encoder:stop");
      return await result;
    },
    destroy: async () => {
      stopping = true;
      ipcMain.removeHandler(RESULT);
      if (!window.isDestroyed()) window.destroy();
      await file.close().catch(() => undefined);
    },
  };
}
