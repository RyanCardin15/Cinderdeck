import { assert, describe, it } from "@effect/vitest";

import {
  claudeDisallowedMcpTools,
  claudeMcpServersFromStatus,
  codexMcpServerOverrides,
  codexMcpServersFromStatus,
  readCodexMcpServerConfigs,
  summarizeMcpError,
  type CodexMcpStatusEntry,
} from "./providerMcp.ts";

// Shapes recorded from `codex app-server` 0.160 `mcpServerStatus/list` with
// detail "toolsAndAuthOnly"; without a thread, `runtimeStatus` stays null.
const codexEntry = (overrides: Partial<CodexMcpStatusEntry> & { name: string }) =>
  ({
    authStatus: "unsupported",
    runtimeStatus: null,
    httpOrigin: null,
    pluginId: null,
    serverInfo: null,
    tools: {},
    toolsError: null,
    ...overrides,
  }) satisfies CodexMcpStatusEntry;

const CODEX_TRANSPORT_ERROR =
  "MCP startup failed: handshaking with MCP server failed: Send message error Transport [codex_rmcp_client::event_notification_transport::EventNotificationTransport<rmcp::transport::worker::WorkerTransport<rmcp::transport::streamable_http_client::StreamableHttpClientWorker<codex_rmcp_client::http_client_adapter::StreamableHttpClientAdapter>>>] error: Client error: HTTP request failed: error sending request for url (https://example.invalid/mcp), when send initialize request: Send message error Transport [codex_rmcp_client::x::Y] error";

describe("codexMcpServersFromStatus", () => {
  const configs = readCodexMcpServerConfigs({
    mcp_servers: {
      fake: { command: "node", enabled: true, disabled_tools: ["echo"] },
      off: { command: "node", enabled: false },
      remote: { url: "https://example.invalid/mcp", enabled: true },
    },
  });

  it("reports connection state, tools and the provider's own disabled tools", () => {
    const servers = codexMcpServersFromStatus(
      [
        codexEntry({
          name: "remote",
          authStatus: "unknown",
          httpOrigin: "https://example.invalid",
          toolsError: CODEX_TRANSPORT_ERROR,
        }),
        codexEntry({
          name: "fake",
          serverInfo: { name: "fake", title: null, version: "1.2.3" },
          tools: {
            read_thing: {
              name: "read_thing",
              description: "Reads a thing",
              annotations: { readOnlyHint: true },
            },
            delete_thing: {
              name: "delete_thing",
              description: "Deletes a thing",
              annotations: { destructiveHint: true },
            },
          },
        }),
        codexEntry({ name: "off" }),
        codexEntry({ name: "deckhand", serverInfo: { name: "deckhand", version: "1" } }),
      ],
      configs,
    );

    assert.deepEqual(servers, [
      {
        name: "fake",
        status: "connected",
        version: "1.2.3",
        tools: [
          { name: "delete_thing", description: "Deletes a thing", destructive: true },
          { name: "echo", disabledByProvider: true },
          { name: "read_thing", description: "Reads a thing", readOnly: true },
        ],
      },
      { name: "off", status: "disabled", tools: [] },
      {
        name: "remote",
        status: "failed",
        origin: "example.invalid",
        error:
          "MCP startup failed: handshaking with MCP server failed: Send message error Transport error: Client error: HTTP request failed: error sending request for url (https://example.invalid/mcp)",
        tools: [],
      },
    ]);
  });

  it("treats authorization failures and missing logins as needing sign-in", () => {
    const [unauthorized, notLoggedIn] = codexMcpServersFromStatus(
      [
        codexEntry({ name: "a", authStatus: "oAuth", toolsError: "HTTP 401 Unauthorized" }),
        codexEntry({ name: "b", authStatus: "notLoggedIn" }),
      ],
      {},
    );
    assert.equal(unauthorized?.status, "needsAuth");
    assert.equal(unauthorized?.auth, "notLoggedIn");
    assert.equal(notLoggedIn?.status, "needsAuth");
  });

  it("prefers the runtime status Codex reports for a thread", () => {
    const [server] = codexMcpServersFromStatus(
      [codexEntry({ name: "a", authStatus: "oAuth", runtimeStatus: "connected" })],
      {},
    );
    assert.equal(server?.status, "connected");
    assert.equal(server?.auth, "oauth");
  });
});

describe("codexMcpServerOverrides", () => {
  it("turns servers off and keeps the user's own disabled tools", () => {
    const overrides = codexMcpServerOverrides(
      {
        disabledServers: ["github", "deckhand"],
        disabledTools: { fake: ["delete_thing"], github: ["x"], empty: [] },
      },
      { fake: { disabled_tools: ["echo"] } },
    );
    assert.deepEqual(overrides, {
      github: { enabled: false },
      fake: { disabled_tools: ["echo", "delete_thing"] },
    });
  });
});

describe("claudeMcpServersFromStatus", () => {
  it("maps SDK status, scope and tools, hiding Cinderdeck's and SDK servers", () => {
    const servers = claudeMcpServersFromStatus([
      {
        name: "remote",
        status: "failed",
        error: "getaddrinfo ENOTFOUND example.invalid",
        config: { type: "http", url: "https://example.invalid/mcp" },
        scope: "user",
        source: "user",
      },
      {
        name: "Linear",
        status: "needs-auth",
        config: { type: "claudeai-proxy", url: "https://mcp.linear.app/sse", id: "x" },
        scope: "claudeai",
        source: "claudeai",
      },
      {
        name: "fake",
        status: "connected",
        serverInfo: { name: "fake", version: "1.2.3" },
        scope: "user",
        source: "user",
        tools: [
          { name: "read_thing", annotations: { readOnly: true } },
          { name: "mcp__fake__echo", annotations: {} },
        ],
      },
      { name: "deckhand", status: "connected", source: "sdk" },
      { name: "in-process", status: "connected", source: "sdk" },
    ]);

    assert.deepEqual(servers, [
      {
        name: "fake",
        status: "connected",
        version: "1.2.3",
        source: "user",
        tools: [{ name: "echo" }, { name: "read_thing", readOnly: true }],
      },
      {
        name: "Linear",
        status: "needsAuth",
        source: "claude.ai",
        origin: "mcp.linear.app",
        auth: "notLoggedIn",
        tools: [],
      },
      {
        name: "remote",
        status: "failed",
        source: "user",
        origin: "example.invalid",
        error: "getaddrinfo ENOTFOUND example.invalid",
        tools: [],
      },
    ]);
  });
});

describe("claudeDisallowedMcpTools", () => {
  it("removes whole servers and single tools using Claude's tool names", () => {
    assert.deepEqual(
      claudeDisallowedMcpTools({
        disabledServers: ["claude.ai Gmail", "deckhand"],
        disabledTools: { "claude.ai Gmail": ["send"], fake: ["delete_thing", "echo"] },
      }),
      ["mcp__claude_ai_Gmail", "mcp__fake__delete_thing", "mcp__fake__echo"],
    );
  });
});

describe("summarizeMcpError", () => {
  it("bounds long errors", () => {
    const summary = summarizeMcpError("x".repeat(1_000));
    assert.equal(summary?.length, 280);
    assert.isTrue(summary?.endsWith("…"));
    assert.equal(summarizeMcpError("   "), undefined);
  });
});
