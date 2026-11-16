import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import { McpSchema, McpServer } from "effect/ai";
import * as ComputerUse from "../../../deckhand/ComputerUse.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Exposure from "../../McpToolExposure.ts";
import { liveThreadsLayer } from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("computer-registration");
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("computer-test"),
  requestNamespace: "test",
  thread: {
    threadId,
    providerSessionId: "test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const screenshot = { data: "aW1n", mimeType: "image/jpeg" as const, width: 800, height: 500 };
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "computer-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "computer-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

it.effect(
  "registers all native tools and delivers image-bearing results through the real MCP boundary",
  () => {
    const actors: string[] = [];
    const service = Layer.mock(ComputerUse.ComputerUse)({
      getAppState: (actor, input) =>
        Effect.sync(() => {
          actors.push(actor.threadId);
          return {
            app: input.app,
            name: "Fixture",
            text: "1 text field",
            diff: false,
            screenshot: input.includeScreenshot === false ? null : screenshot,
          };
        }),
      script: () =>
        Effect.succeed({
          ok: false,
          output: "element_missing: Read fresh state",
          screenshots: [screenshot],
        }),
    });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      expect(server.tools.filter(({ tool }) => tool.name.startsWith("computer_"))).toHaveLength(13);
      const call = (name: string, args: object) =>
        server
          .callTool({ name, arguments: args })
          .pipe(
            Effect.provideService(Invocation.McpInvocationContext, scope),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
      const state = yield* call("computer_get_app_state", { app: "test.fixture" });
      expect(state.isError).toBe(false);
      expect(state.content.map((item) => item.type)).toEqual(["text", "image"]);
      expect(JSON.stringify(state.structuredContent)).not.toContain("aW1n");
      const text = yield* call("computer_get_app_state", {
        app: "test.fixture",
        includeScreenshot: false,
      });
      expect(text.content.map((item) => item.type)).toEqual(["text"]);
      const script = yield* call("computer_script", { code: "write('fixture')" });
      expect(script.isError).toBe(true);
      expect(script.content.map((item) => item.type)).toEqual(["text", "image"]);
      expect(actors).toEqual([threadId, threadId]);
      const outside = yield* Effect.exit(
        server
          .callTool({ name: "computer_get_app_state", arguments: { app: "test.fixture" } })
          .pipe(
            Effect.provideService(Invocation.McpInvocationContext, { ...scope, thread: undefined }),
            Effect.provideService(McpSchema.McpServerClient, client),
          ),
      );
      expect(Exit.isFailure(outside)).toBe(true);
      expect(actors).toHaveLength(2);
    }).pipe(
      Effect.provide(
        McpHttpServer.layerComputerToolkit.pipe(
          Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
          Layer.provide(service),
          Layer.provide(liveThreadsLayer),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    );
  },
);

it.effect("keeps discovery and batching direct while individual actions remain searchable", () =>
  Effect.gen(function* () {
    const exposure = Exposure.make(
      () => [{ name: "computer_click", description: "Click a Mac app element" }],
      () => Effect.void,
    );
    expect(exposure.isListed("one", "computer_list_apps")).toBe(true);
    expect(exposure.isListed("one", "computer_script")).toBe(true);
    expect(exposure.isListed("one", "computer_click")).toBe(false);
    yield* exposure.search("one", "computer click");
    expect(exposure.isListed("one", "computer_click")).toBe(true);
    expect(exposure.isListed("two", "computer_click")).toBe(false);
  }),
);
