// @effect-diagnostics nodeBuiltinImport:off -- Read the single capture granted by the native parent.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { PROVIDER_SEND_TURN_MAX_FILE_BYTES, type CapturePromptSource } from "@cinderdeck/contracts";

const mimeByExtension = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
]);

export interface PromptCaptureGrant {
  readonly path: string;
  readonly preview: CapturePromptSource;
}

export function parsePromptCapture(input: Record<string, unknown>): PromptCaptureGrant | null {
  const { requestID, capturePath } = input;
  if (
    input.type !== "capture-prompt" ||
    typeof requestID !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestID) ||
    typeof capturePath !== "string" ||
    !NodePath.isAbsolute(capturePath) ||
    capturePath.length > 4_096 ||
    capturePath.includes("\0") ||
    !Object.keys(input).every((key) => ["type", "requestID", "capturePath"].includes(key))
  ) {
    return null;
  }
  const mimeType = mimeByExtension.get(NodePath.extname(capturePath).toLowerCase());
  if (!mimeType) return null;
  return {
    path: capturePath,
    preview: { id: requestID, name: NodePath.basename(capturePath), mimeType },
  };
}

export async function readPromptCapture(grant: PromptCaptureGrant): Promise<Uint8Array> {
  const isImage = grant.preview.mimeType.startsWith("image/");
  // The renderer can compress a large screenshot before its normal image upload.
  const maxBytes = PROVIDER_SEND_TURN_MAX_FILE_BYTES;
  const tooLarge = isImage
    ? "This screenshot is too large to open. Export a smaller screenshot and try again."
    : `This recording exceeds the ${maxBytes / 1024 ** 2} MB attachment limit. Trim it in the video editor and try again.`;
  const file = await NodeFSP.open(
    grant.path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  ).catch(() => {
    throw new Error("The selected capture could not be opened. Check that the file still exists.");
  });
  try {
    const { size } = await file.stat().then((stat) => {
      if (!stat.isFile() || stat.size === 0)
        throw new Error("The selected capture is unavailable.");
      return stat;
    });
    if (size > maxBytes) throw new Error(tooLarge);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
      if (!bytesRead) throw new Error("The selected capture changed while it was being opened.");
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await file.close();
  }
}
