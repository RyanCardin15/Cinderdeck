import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  // Execute the shipped extension with MCP disabled; this path needs no Typebox.
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: RequestHook) => handlers.set(name, handler) },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

describe("Pi Cinderdeck MCP identity", () => {
  it("registers a Cinderdeck-prefixed tool while keeping the authenticated wire call unprefixed", async () => {
    const tools = new Map<
      string,
      {
        execute: (
          id: string,
          params: object,
          signal: AbortSignal,
        ) => Promise<{ details: { server: string; tool: string }; content: unknown }>;
      }
    >();
    const calls: Array<{ url: string; authorization: string; method: string; params: unknown }> =
      [];
    const source = NodeModule.stripTypeScriptTypes(
      PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
        "export default async function",
        "async function",
      ),
    );
    await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
      process: {
        env: { T3_MCP_URL: "http://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "fixture-token" },
      },
      AbortSignal,
      Type: { Unsafe: (schema: unknown) => schema },
      pi: {
        on: () => undefined,
        registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool),
      },
      fetch: async (url: string, input: { headers: Record<string, string>; body: string }) => {
        const frame = JSON.parse(input.body) as { method: string; params: unknown; id?: number };
        calls.push({
          url,
          authorization: input.headers.authorization!,
          method: frame.method,
          params: frame.params,
        });
        const result =
          frame.method === "tools/list"
            ? {
                tools: [
                  { name: "deckhand_context_pull_requests", inputSchema: { type: "object" } },
                ],
              }
            : frame.method === "tools/call"
              ? { content: [{ type: "text", text: "linked history" }] }
              : {};
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }), {
          headers: { "content-type": "application/json", "mcp-session-id": "fixture-session" },
        });
      },
    });
    const tool = tools.get("mcp__deckhand__deckhand_context_pull_requests");
    assert.isDefined(tool);
    const result = await tool!.execute("call", { offset: 0 }, new AbortController().signal);
    assert.equal(result.details.server, "deckhand");
    assert.equal(result.details.tool, "deckhand_context_pull_requests");
    assert.deepEqual(calls.at(-1), {
      url: "http://fixture.invalid/mcp",
      authorization: "Bearer fixture-token",
      method: "tools/call",
      params: { name: "deckhand_context_pull_requests", arguments: { offset: 0 } },
    });
  });
});
