// @effect-diagnostics nodeBuiltinImport:off - validates Main encoder bytes on a temporary file.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  handler: null as
    | null
    | ((event: { sender: { id: number }; senderFrame: unknown }, raw: unknown) => unknown),
  window: null as null | {
    webContents: { id: number; mainFrame: unknown; send: (channel: string, data?: string) => void };
  },
  firstFrames: 0,
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (_channel: string, handler: typeof state.handler) => {
      state.handler = handler;
    },
    removeHandler: () => {
      state.handler = null;
    },
  },
  BrowserWindow: class {
    webContents = {
      id: 7,
      mainFrame: { id: 1 },
      setWindowOpenHandler: () => undefined,
      session: { setPermissionRequestHandler: () => undefined },
      on: () => undefined,
      send: (_channel: string, _data?: string) => undefined,
    };
    constructor() {
      state.window = this;
    }
    on() {
      return this;
    }
    isDestroyed() {
      return false;
    }
    destroy() {}
    async loadURL() {
      await state.handler?.(
        { sender: { id: 7 }, senderFrame: this.webContents.mainFrame },
        { kind: "ready", mimeType: "video/mp4" },
      );
    }
  },
}));
import { acceptsEncoderSender, createOwnedPreviewEncoder } from "./OwnedPreviewEncoder.ts";
const event = () => ({ sender: { id: 7 }, senderFrame: state.window!.webContents.mainFrame });
describe("Private owned encoder", () => {
  it("writes and hashes only chunks from its exact hidden window and main frame", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "deckhand-encoder-test-"),
    );
    const output = NodePath.join(directory, "capture.video");
    const encoder = await createOwnedPreviewEncoder({
      preload: "/fixture/encoder.cjs",
      outputPath: output,
      onFirstFrame: async () => {
        state.firstFrames++;
      },
    });
    try {
      expect(
        acceptsEncoderSender(state.window!, {
          sender: { id: 8 },
          senderFrame: state.window!.webContents.mainFrame,
        }),
      ).toBe(false);
      expect(
        acceptsEncoderSender(state.window!, { sender: { id: 7 }, senderFrame: { id: 1 } }),
      ).toBe(false);
      expect(() =>
        state.handler?.(
          { sender: { id: 8 }, senderFrame: state.window!.webContents.mainFrame },
          { kind: "chunk", index: 0, data: new Uint8Array([99]) },
        ),
      ).toThrow("Untrusted encoder sender");
      encoder.frame("actual-main-cdp-frame");
      await state.handler?.(event(), { kind: "first_frame" });
      const bytes = new Uint8Array([1, 2, 3, 4]);
      await state.handler?.(event(), { kind: "chunk", index: 0, data: bytes });
      const finished = encoder.finish();
      await state.handler?.(event(), { kind: "finished", frameCount: 1 });
      const result = await finished;
      expect(result.sha256).toBe(NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
      expect(result.size).toBe(4);
      expect(result.frameCount).toBe(1);
      expect(await NodeFSP.readFile(output)).toEqual(Buffer.from(bytes));
      expect(state.firstFrames).toBe(1);
    } finally {
      await encoder.destroy();
      await NodeFSP.rm(directory, { recursive: true });
    }
  });
  it("rejects reordered output without producing an encoded-video receipt", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "deckhand-encoder-test-"),
    );
    const encoder = await createOwnedPreviewEncoder({
      preload: "/fixture/encoder.cjs",
      outputPath: NodePath.join(directory, "capture.video"),
      onFirstFrame: async () => undefined,
    });
    try {
      await expect(
        state.handler?.(event(), { kind: "chunk", index: 1, data: new Uint8Array([1]) }),
      ).rejects.toThrow("chunk refused");
      await expect(encoder.finish()).rejects.toThrow("encoder failed");
    } finally {
      await encoder.destroy();
      await NodeFSP.rm(directory, { recursive: true });
    }
  });
});
