// A small bounded client for Copilot's official SDK wire protocol. No chat prompt is sent.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalTimers:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import type { ProviderMcpServer, ProviderMcpTool } from "@cinderdeck/contracts";
import { resolveSpawnCommand } from "@cinderdeck/shared/shell";
import * as Effect from "effect/Effect";
import { isCinderdeckMcpServerName } from "../providerMcp.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function copilotMcpServerFromWire(
  value: unknown,
  tools: ReadonlyArray<ProviderMcpTool>,
): ProviderMcpServer | undefined {
  const entry = record(value);
  if (typeof entry.name !== "string" || !entry.name.trim() || isCinderdeckMcpServerName(entry.name))
    return undefined;
  const state = entry.status;
  const status =
    state === "connected"
      ? "connected"
      : state === "needs-auth" ||
          state === "needsAuth" ||
          state === "needs_auth" ||
          state === "requires_authentication"
        ? "needsAuth"
        : state === "disabled"
          ? "disabled"
          : state === "pending" || state === "connecting"
            ? "pending"
            : "failed";
  let origin: string | undefined;
  if (typeof entry.url === "string") {
    try {
      origin = new URL(entry.url).host || undefined;
    } catch {
      /* Never expose a raw URL. */
    }
  }
  return {
    name: entry.name,
    status,
    tools,
    ...(typeof entry.displayName === "string" && entry.displayName.trim()
      ? { title: entry.displayName }
      : {}),
    ...(typeof entry.source === "string" ? { source: entry.source } : {}),
    ...(origin ? { origin } : {}),
    ...(status === "needsAuth" ? { auth: "notLoggedIn" as const } : {}),
    ...(status === "failed"
      ? {
          error:
            "Copilot could not connect to this MCP server. Check it with `/mcp` in Copilot CLI.",
        }
      : {}),
  };
}

export function copilotMcpToolsFromWire(value: unknown): ProviderMcpTool[] {
  const tools = record(value).tools;
  if (!Array.isArray(tools)) throw new Error("Copilot returned an invalid MCP tool listing.");
  return tools
    .flatMap((value) => {
      const tool = record(value);
      return typeof tool.name === "string" && tool.name.trim()
        ? [
            {
              name: tool.name,
              ...(typeof tool.description === "string" ? { description: tool.description } : {}),
            },
          ]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The only process stopped is this captured child; disposal deletes only the probe's session. */
async function probe(
  input: {
    command: string;
    args: ReadonlyArray<string>;
    shell: boolean;
    cwd: string;
    environment: NodeJS.ProcessEnv;
  },
  signal: AbortSignal,
): Promise<ReadonlyArray<ProviderMcpServer>> {
  const child = NodeChildProcess.spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: input.environment,
    shell: input.shell,
    stdio: "pipe",
    windowsHide: true,
  });
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  let terminalError: Error | undefined;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const fail = (error: Error) => {
    terminalError = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => {
      fail(new Error("Copilot MCP inventory process closed."));
      resolve();
    }),
  );
  child.on("error", () => fail(new Error("Could not start the Copilot MCP inventory process.")));
  child.stdin.on("error", () => fail(new Error("Could not write to Copilot.")));
  child.stderr.resume(); // Never send CLI logs or credentials to Settings.
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_BYTES)
        throw new Error("Copilot MCP reply exceeded the output limit.");
      for (;;) {
        const boundary = buffer.indexOf("\r\n\r\n");
        if (boundary === -1) break;
        const length = /^Content-Length: (\d+)$/imu.exec(
          buffer.subarray(0, boundary).toString("ascii"),
        );
        if (!length || Number(length[1]) > MAX_BYTES)
          throw new Error("Invalid Copilot MCP reply framing.");
        const size = Number(length[1]);
        if (buffer.length < boundary + 4 + size) break;
        const message = record(
          JSON.parse(buffer.subarray(boundary + 4, boundary + 4 + size).toString("utf8")),
        );
        buffer = buffer.subarray(boundary + 4 + size);
        if (typeof message.method === "string") {
          // Inventory never approves tools, sign-in, or elicitation requests.
          if (message.id !== undefined)
            write({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Unavailable during MCP inventory." },
            });
          continue;
        }
        if (typeof message.id !== "number") continue;
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error)
          waiter?.reject(
            new Error(
              "Copilot could not complete the MCP inventory request. Check its CLI version and configuration.",
            ),
          );
        else waiter?.resolve(message.result);
      }
    } catch {
      fail(new Error("Copilot returned an invalid MCP inventory reply."));
    }
  });
  function write(message: unknown) {
    const body = JSON.stringify(message);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
  function request(method: string, params: unknown, timeout = 20_000): Promise<unknown> {
    if (terminalError) return Promise.reject(terminalError);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Copilot MCP inventory timed out."));
      }, timeout);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      write({ jsonrpc: "2.0", id, method, params });
    });
  }
  const abort = () => {
    for (const waiter of pending.values()) waiter.reject(new Error("MCP inventory cancelled."));
    pending.clear();
  };
  signal.addEventListener("abort", abort, { once: true });
  let sessionId: string | undefined;
  try {
    if (signal.aborted) throw new Error("MCP inventory cancelled.");
    await request("ping", {});
    sessionId = NodeCrypto.randomUUID();
    const created = record(
      await request("session.create", {
        sessionId,
        clientName: "Cinderdeck MCP inventory",
        workingDirectory: input.cwd,
        tools: [],
        enableConfigDiscovery: true,
      }),
    );
    if (created.sessionId !== sessionId)
      throw new Error("Copilot did not create an MCP inventory session.");
    const listing = record(await request("session.mcp.list", { sessionId }));
    if (!Array.isArray(listing.servers))
      throw new Error("Copilot returned an invalid MCP server listing.");
    const servers: ProviderMcpServer[] = [];
    for (const entry of listing.servers) {
      const server = copilotMcpServerFromWire(entry, []);
      if (!server) continue;
      if (server.status !== "connected") {
        servers.push(server);
        continue;
      }
      try {
        const tools = copilotMcpToolsFromWire(
          await request("session.mcp.listTools", { sessionId, serverName: server.name }),
        );
        servers.push({
          ...server,
          tools: tools.map((tool) => ({
            ...tool,
            ...(/[()*\r\n]/u.test(server.name) || /[()*\r\n]/u.test(tool.name)
              ? { toggleable: false }
              : {}),
          })),
        });
      } catch {
        if (signal.aborted) throw new Error("MCP inventory cancelled.");
        servers.push({
          ...server,
          error:
            "Connected, but Copilot could not list this server's tools. Refresh or check it with `/mcp` in Copilot CLI.",
        });
      }
    }
    return servers.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    signal.removeEventListener("abort", abort);
    if (sessionId && !terminalError) {
      try {
        await request("session.destroy", { sessionId }, 2_000);
      } catch {
        /* Continue disposal. */
      }
      try {
        await request("session.delete", { sessionId }, 2_000);
      } catch {
        /* The child must still be stopped. */
      }
    }
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    await exited;
    clearTimeout(timer);
  }
}

export const listCopilotMcpServers = (input: {
  readonly command: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) =>
  Effect.gen(function* () {
    const resolved = yield* resolveSpawnCommand(
      input.command,
      ["--headless", "--stdio", "--no-auto-update", "--log-level", "none"],
      { env: input.environment, extendEnv: true },
    );
    return yield* Effect.tryPromise((signal) =>
      probe(
        {
          ...resolved,
          cwd: input.cwd,
          environment: { ...input.environment, NO_OPEN_BROWSER: "1" },
        },
        signal,
      ),
    );
  });
