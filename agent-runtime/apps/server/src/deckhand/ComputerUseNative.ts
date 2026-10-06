// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
// Native boundary: bounded JSONL with the bundled computer-use helper.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import { HostProcessPlatform } from "@cinderdeck/shared/hostProcess";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type * as NodeStream from "node:stream";
import { ComputerUseError } from "@cinderdeck/contracts/deckhand/computerUse";

export type ComputerUseCall = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<Record<string, unknown>>;

const HELPER = "deckhand-mac-computer-use";
const reasons = new Set<string>([
  "accessibility_permission",
  "screen_permission",
  "post_event_permission",
  "app_missing",
  "app_blocked",
  "window_missing",
  "element_stale",
  "element_missing",
  "unsupported_action",
  "invalid_input",
  "screen_locked",
  "not_settable",
  "text_not_found",
  "launch_failed",
]);
const fail = (reason: ComputerUseError["reason"], detail?: string) =>
  new ComputerUseError({ reason, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function computerUseHelperPath(): string {
  const candidates = [
    NodePath.join(NodePath.dirname(process.execPath), `native/${HELPER}`),
    ...(process.argv[1]
      ? [NodePath.join(NodePath.dirname(process.argv[1]), `native/${HELPER}`)]
      : []),
    NodeURL.fileURLToPath(new NodeURL.URL(`./native/${HELPER}`, import.meta.url)),
    NodeURL.fileURLToPath(
      new NodeURL.URL(`../../../../.deckhand/native/${HELPER}`, import.meta.url),
    ),
  ];
  for (const path of candidates) {
    const unpacked = path.replace("app.asar/", "app.asar.unpacked/");
    if (NodeFS.existsSync(unpacked)) return unpacked;
  }
  throw fail("native_unavailable");
}

/**
 * Starts the helper on first use and keeps it while calls continue; it exits
 * after five idle minutes. Only the captured child is ever terminated.
 */
export function makeNativeComputerUse(
  options: {
    readonly platform?: NodeJS.Platform;
    readonly helperPath?: () => string;
    readonly idleMs?: number;
  } = {},
): ComputerUseCall & { dispose: () => void } {
  let child:
    | NodeChildProcess.ChildProcessByStdio<NodeStream.Writable, NodeStream.Readable, null>
    | undefined;
  let ready: Promise<void> | undefined;
  let sequence = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: ComputerUseError) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const stop = (reason: ComputerUseError) => {
    const current = child;
    child = undefined;
    ready = undefined;
    if (idleTimer) clearTimeout(idleTimer);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(reason);
    }
    pending.clear();
    if (current) {
      current.stdin.end();
      current.kill();
    }
  };
  const scheduleIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (pending.size > 0) return;
    idleTimer = setTimeout(() => stop(fail("unavailable", "idle")), 5 * 60_000);
    idleTimer.unref();
  };

  const start = () => {
    const spawned = NodeChildProcess.spawn(
      (options.helperPath ?? computerUseHelperPath)(),
      ["--serve"],
      {
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    child = spawned;
    let buffer = "";
    return new Promise<void>((resolve, reject) => {
      const startup = setTimeout(() => {
        reject(fail("timeout", "helper startup"));
        stop(fail("timeout"));
      }, 10_000);
      spawned.once("error", () => {
        clearTimeout(startup);
        reject(fail("native_unavailable"));
        if (child === spawned) stop(fail("native_unavailable"));
      });
      spawned.once("exit", () => {
        clearTimeout(startup);
        reject(fail("unavailable", "helper exited"));
        if (child === spawned) stop(fail("unavailable", "helper exited"));
      });
      spawned.stdin.on("error", () => {
        if (child === spawned) stop(fail("unavailable", "helper stdin closed"));
      });
      spawned.stdout.setEncoding("utf8");
      spawned.stdout.on("data", (chunk: string) => {
        if (child !== spawned) return;
        buffer += chunk;
        if (buffer.length > 12_000_000) {
          stop(fail("unavailable", "response too large"));
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let message: Record<string, unknown>;
          try {
            message = record(JSON.parse(line));
          } catch {
            continue;
          }
          if (message.ready) {
            clearTimeout(startup);
            resolve();
            continue;
          }
          if (typeof message.id !== "number") continue;
          const request = pending.get(message.id);
          if (!request) continue;
          clearTimeout(request.timer);
          pending.delete(message.id);
          if (typeof message.error === "string") {
            const detail = typeof message.detail === "string" ? message.detail : undefined;
            request.reject(
              reasons.has(message.error)
                ? fail(message.error as ComputerUseError["reason"], detail)
                : fail("unavailable", detail),
            );
          } else request.resolve(record(message.result));
          scheduleIdle();
        }
      });
    });
  };

  const call: ComputerUseCall = async (method, params = {}, timeoutMs = 15_000) => {
    if ((options.platform ?? HostProcessPlatform.defaultValue()) !== "darwin")
      throw fail("native_unavailable");
    if (pending.size >= 64) throw fail("busy");
    if (!ready) ready = start();
    await ready;
    if (pending.size >= 64) throw fail("busy");
    const current = child;
    if (!current) throw fail("unavailable");
    if (idleTimer) clearTimeout(idleTimer);
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Do not leave timed-out requests queued to act later in the helper.
        stop(fail("timeout"));
      }, timeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      current.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error) stop(fail("unavailable"));
      });
    });
  };
  return Object.assign(call, { dispose: () => stop(fail("unavailable", "service closed")) });
}
