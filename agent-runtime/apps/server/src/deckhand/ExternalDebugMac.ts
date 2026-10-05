// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics preferSchemaOverJson:off
// Native window boundary: bounded JSONL with a bundled, signed ScreenCaptureKit helper.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as C from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import {
  array,
  record,
  string,
  redactDebugText,
  type DebugPeer,
  type DebugTransport,
} from "./ExternalDebugCDP.ts";

const fail = (reason: C.ExternalDebugError["reason"]) => new C.ExternalDebugError({ reason });
function failure(value: unknown) {
  switch (value) {
    case "screen_permission":
    case "accessibility_permission":
    case "target_missing":
    case "invalid_command":
    case "app_missing":
      return fail(value);
    default:
      return fail("unavailable");
  }
}
export function macHelperPath(): string {
  const candidates = [
    new NodeURL.URL("./native/deckhand-mac-external-debug", import.meta.url),
    new NodeURL.URL("../../../../.deckhand/native/deckhand-mac-external-debug", import.meta.url),
  ].map((url) => NodeURL.fileURLToPath(url));
  if (process.argv[1])
    candidates.unshift(
      NodePath.join(NodePath.dirname(process.argv[1]), "native/deckhand-mac-external-debug"),
    );
  // A single-executable server may have a command name in argv[1].
  candidates.unshift(
    NodePath.join(NodePath.dirname(process.execPath), "native/deckhand-mac-external-debug"),
  );
  for (const path of candidates) {
    const unpacked = path.replace("app.asar/", "app.asar.unpacked/");
    if (NodeFS.existsSync(unpacked)) return unpacked;
  }
  throw fail("native_unavailable");
}
type Link = {
  event: (method: string, params: Record<string, unknown>) => void;
  disconnected: () => void;
};
type Broker = {
  ready: Promise<void>;
  call: DebugPeer["call"];
  links: Map<string, Link>;
  idle: () => void;
};
let broker: Broker | undefined;
function startBroker(): Broker {
  // A single long-lived capture client owns discovery and all streams. Exiting
  // a separate discovery process can interrupt existing ScreenCaptureKit clients.
  const child = NodeChildProcess.spawn(macHelperPath(), ["--serve"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  let sequence = 0,
    closed = false,
    buffer = "";
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const links = new Map<string, Link>();
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: C.ExternalDebugError) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let readyResolve: () => void = () => {},
    readyReject: (error: C.ExternalDebugError) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const stop = (reason: C.ExternalDebugError) => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (broker === instance) broker = undefined;
    child.stdin.end();
    // Only this captured spawn is terminated, never a discovered host process.
    child.kill();
    readyReject(reason);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(reason);
    }
    pending.clear();
    for (const link of links.values()) link.disconnected();
    links.clear();
  };
  const idle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!closed && links.size === 0 && pending.size === 0) {
      idleTimer = setTimeout(() => stop(fail("disconnected")), 2000);
      idleTimer.unref();
    }
  };
  const instance: Broker = {
    ready,
    links,
    idle,
    call: (method, params = {}) => {
      if (closed) return Promise.reject(fail("disconnected"));
      if (pending.size >= 16) return Promise.reject(fail("busy"));
      if (idleTimer) clearTimeout(idleTimer);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => stop(fail("timeout")), 10000);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
          if (error) stop(fail("disconnected"));
        });
      });
    },
  };
  child.once("error", () => stop(fail("native_unavailable")));
  child.once("exit", () => stop(fail("disconnected")));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1_500_000) {
      stop(fail("too_large"));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = record(JSON.parse(line));
        if (message.ready) readyResolve();
        else if (message.method === "Native.disconnected") {
          const params = record(message.params),
            targetId = string(params.targetId),
            link = links.get(targetId);
          links.delete(targetId);
          link?.event("Native.disconnected", params);
          link?.disconnected();
          void instance.call("Native.detach", { targetId }).catch(() => {});
        } else if (typeof message.id === "number") {
          const request = pending.get(message.id);
          if (!request) continue;
          clearTimeout(request.timer);
          pending.delete(message.id);
          if (message.error) request.reject(failure(message.error));
          else request.resolve(record(message.result));
          idle();
        } else if (message.error) stop(failure(message.error));
      } catch {
        stop(fail("disconnected"));
      }
    }
  });
  const startup = setTimeout(() => stop(fail("timeout")), 10000);
  void ready.then(
    () => {
      clearTimeout(startup);
      idle();
    },
    () => clearTimeout(startup),
  );
  return instance;
}
async function getBroker() {
  const value = (broker ??= startBroker());
  await value.ready;
  return value;
}
export const macWindowTransport: DebugTransport = {
  open: async (bundleId) => {
    const connection = await getBroker();
    await connection.call("Native.open", { bundleId });
  },
  discover: async () => {
    const connection = await getBroker();
    const value = await connection.call("Native.list");
    return array(value.targets)
      .slice(0, 200)
      .flatMap((raw) => {
        const row = record(raw),
          id = string(row.id);
        if (!/^mac:\d+:\d+$/.test(id)) return [];
        return [
          {
            id,
            title: redactDebugText(string(row.title), 300),
            app: redactDebugText(string(row.app), 300),
            url: redactDebugText(string(row.bundle), 300),
            type: "mac-window",
            socketURL: "",
          },
        ];
      });
  },
  connect: async (target, event, disconnected) => {
    if (!/^mac:\d+:\d+$/.test(target.id)) throw fail("invalid_command");
    const connection = await getBroker();
    if (connection.links.has(target.id)) throw fail("busy");
    let closed = false;
    const notify = () => {
      if (!closed) {
        closed = true;
        disconnected();
      }
    };
    const link: Link = { event, disconnected: notify };
    connection.links.set(target.id, link);
    try {
      await connection.call("Native.attach", { targetId: target.id });
    } catch (cause) {
      connection.links.delete(target.id);
      connection.idle();
      throw cause;
    }
    return {
      call: (method, params = {}) =>
        closed
          ? Promise.reject(fail("disconnected"))
          : connection.call(method, { ...params, targetId: target.id }),
      close: () => {
        if (closed) return;
        notify();
        connection.links.delete(target.id);
        void connection
          .call("Native.detach", { targetId: target.id })
          .catch(() => {})
          .finally(connection.idle);
      },
    };
  },
};
