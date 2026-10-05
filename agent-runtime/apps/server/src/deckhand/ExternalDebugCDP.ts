// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalTimersInEffect:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalFetchInEffect:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalDateInEffect:off
// @effect-diagnostics cryptoRandomUUID:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
// Native CDP boundary: transient bounded state, deadlines, and scoped resource cleanup.
import * as C from "@cinderdeck/contracts/deckhand/externalDebugRpc";

export const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const string = (value: unknown) => (typeof value === "string" ? value : "");
export const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
export const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const fail = (reason: C.ExternalDebugError["reason"]) => new C.ExternalDebugError({ reason });

export function debugEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw fail("invalid_endpoint");
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  if (
    url.protocol === "mac:" &&
    url.hostname === "local" &&
    !url.port &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    ["", "/"].includes(url.pathname)
  ) {
    url.pathname = "/";
    return url;
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw fail("invalid_endpoint");
  return url;
}
export function debugURL(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    // data/blob URLs can contain an entire document or opaque credential.
    return ["http:", "https:", "file:"].includes(url.protocol)
      ? url.href.slice(0, 2048)
      : url.protocol;
  } catch {
    return "";
  }
}
export function redactDebugText(raw: string, limit = 8192): string {
  return raw
    .slice(0, limit * 2)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => debugURL(url))
    .replace(/\bBearer\s+[^\s"',;}]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(
      /((?:access_token|refresh_token|id_token|authorization|client_secret|password|cookie)["']?\s*[:=]\s*)["']?[^\s,;}"']+/gi,
      "$1[redacted]",
    )
    .slice(0, limit);
}

export function sanitizeDebugValue(value: unknown, depth = 0): unknown {
  if (depth > 10) return "(nested value omitted)";
  if (typeof value === "string") return redactDebugText(value, 180000);
  if (Array.isArray(value))
    return value.slice(0, 1000).map((v) => sanitizeDebugValue(v, depth + 1));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 1000)
        .map(([key, v]) => [
          key,
          /^(access_token|refresh_token|id_token|authorization|client_secret|password|cookie)$/i.test(
            key,
          )
            ? "[redacted]"
            : sanitizeDebugValue(v, depth + 1),
        ]),
    );
  return value;
}

export interface CDPTarget extends C.DebugTarget {
  readonly socketURL: string;
}
export interface DebugPeer {
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}
export interface DebugTransport {
  discover(endpoint: string): Promise<CDPTarget[]>;
  connect(
    target: CDPTarget,
    event: (method: string, params: Record<string, unknown>) => void,
    disconnected: () => void,
  ): Promise<DebugPeer>;
}

async function discover(raw: string): Promise<CDPTarget[]> {
  const endpoint = debugEndpoint(raw);
  const response = await fetch(new URL("json/list", endpoint), {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  });
  if (!response.ok || !response.body) throw fail("unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512000) throw fail("too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(json) || json.length > 200) throw fail("too_large");
  return json.flatMap((item) => {
    const row = record(item);
    const type = string(row.type),
      id = string(row.id);
    if (!["page", "webview", "iframe"].includes(type) || !id || id.length > 240) return [];
    let socket: URL;
    try {
      socket = new URL(string(row.webSocketDebuggerUrl));
    } catch {
      return [];
    }
    if (
      !["ws:", "wss:"].includes(socket.protocol) ||
      socket.search ||
      socket.hash ||
      socket.username ||
      socket.password ||
      !/^\/devtools\/(page|browser)\/[^/]+$/.test(socket.pathname)
    )
      return [];
    // A remote runtime advertises its own localhost. Always route through the
    // explicitly selected tunnel authority, never a discovered host or port.
    const local = new URL(endpoint);
    local.protocol = "ws:";
    local.pathname = socket.pathname;
    return [
      {
        id,
        title: redactDebugText(string(row.title), 300),
        url: debugURL(string(row.url)),
        type,
        socketURL: local.href,
      },
    ];
  });
}

class CDPPeer implements DebugPeer {
  private sequence = 0;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: C.ExternalDebugError) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private socket: WebSocket;
  private event: (method: string, params: Record<string, unknown>) => void;
  private disconnected: () => void;
  private constructor(
    socket: WebSocket,
    event: (method: string, params: Record<string, unknown>) => void,
    disconnected: () => void,
  ) {
    this.socket = socket;
    this.event = event;
    this.disconnected = disconnected;
    socket.addEventListener("message", (message) => {
      if (typeof message.data !== "string" || message.data.length > 2_000_000) {
        this.stop("too_large");
        return;
      }
      try {
        const value = record(JSON.parse(message.data));
        const id = number(value.id);
        if (id) {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          clearTimeout(entry.timer);
          if (value.error) entry.reject(fail("unsupported"));
          else entry.resolve(record(value.result));
        } else if (typeof value.method === "string") this.event(value.method, record(value.params));
      } catch {
        this.stop("disconnected");
      }
    });
    socket.addEventListener("close", () => this.stop("disconnected"));
    socket.addEventListener("error", () => this.stop("disconnected"));
  }
  static connect: DebugTransport["connect"] = (target, event, disconnected) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(target.socketURL);
      const timer = setTimeout(() => {
        socket.close();
        reject(fail("timeout"));
      }, 5000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new CDPPeer(socket, event, disconnected));
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(fail("unavailable"));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(fail("unavailable"));
        },
        { once: true },
      );
    });
  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(fail("disconnected"));
    if (this.pending.size >= 32) return Promise.reject(fail("busy"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail("timeout"));
      }, 8000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(fail("disconnected"));
      }
    });
  }
  private stop(reason: C.ExternalDebugError["reason"]) {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(fail(reason));
    }
    this.pending.clear();
    this.disconnected();
  }
  close() {
    this.stop("disconnected");
  }
}
export const nativeDebugTransport: DebugTransport = { discover, connect: CDPPeer.connect };
