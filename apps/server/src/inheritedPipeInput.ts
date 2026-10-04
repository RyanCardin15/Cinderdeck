// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

/** The returned POSIX pipe reader owns fd; undefined leaves ownership with the caller. */
export function openInheritedPipeInput(
  fd: number,
  platform: NodeJS.Platform,
): NodeStream.Readable | undefined {
  // Windows inherited handles retain the existing file-stream path. On POSIX,
  // fs.ReadStream can leave a blocking read in libuv's worker pool after destroy;
  // process exit then waits for the still-open parent writer to publish again.
  if (platform === "win32") return undefined;
  const descriptor = NodeFS.fstatSync(fd);
  if (!descriptor.isFIFO() && !descriptor.isSocket()) return undefined;
  return new NodeNet.Socket({ fd, readable: true, writable: false });
}
