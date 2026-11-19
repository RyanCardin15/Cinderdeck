// @effect-diagnostics nodeBuiltinImport:off -- Exercise the actual desktop file-open boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { parsePromptCapture, readPromptCapture } from "./capturePrompt.ts";

describe("native capture prompt", () => {
  const requestID = "a1b2c3d4-e5f6-4a12-8b34-56789abcdef0";
  const message = (capturePath: string) => ({ type: "capture-prompt", requestID, capturePath });

  it("projects only a capture name and MIME type to the renderer", () => {
    expect(parsePromptCapture(message("/tmp/synthetic/Screen Recording.MOV"))?.preview).toEqual({
      id: requestID,
      name: "Screen Recording.MOV",
      mimeType: "video/quicktime",
    });
    expect(parsePromptCapture(message("capture.png"))).toBeNull();
    expect(parsePromptCapture(message("/tmp/capture.txt"))).toBeNull();
    expect(
      parsePromptCapture({ ...message("/tmp/capture.png"), requestID: "unscoped" }),
    ).toBeNull();
  });

  it("reads the granted regular file and rejects directory, symlink, and oversized replacements", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "capture-prompt-"));
    try {
      const source = NodePath.join(root, "capture.png");
      const link = NodePath.join(root, "link.png");
      const directory = NodePath.join(root, "folder.png");
      const recording = NodePath.join(root, "large.mov");
      await NodeFSP.writeFile(source, new Uint8Array([1, 2, 3]));
      await NodeFSP.writeFile(recording, "");
      await NodeFSP.truncate(recording, 51 * 1024 ** 2);
      await NodeFSP.mkdir(directory);
      await NodeFSP.symlink(source, link);
      expect(Array.from(await readPromptCapture(parsePromptCapture(message(source))!))).toEqual([
        1, 2, 3,
      ]);
      await expect(readPromptCapture(parsePromptCapture(message(link))!)).rejects.toThrow(
        "could not be opened",
      );
      await expect(readPromptCapture(parsePromptCapture(message(directory))!)).rejects.toThrow(
        "unavailable",
      );
      await expect(readPromptCapture(parsePromptCapture(message(recording))!)).rejects.toThrow(
        "50 MB attachment limit",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
