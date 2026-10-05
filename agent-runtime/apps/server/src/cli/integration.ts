import { Tool } from "effect/unstable/ai";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, Command } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";
import { runAcpMcpCliFastPath } from "../mcp/AcpMcpStdioBridge.ts";
import { DeckhandToolkit } from "../mcp/toolkits/deckhand/tools.ts";
class InvalidIntegrationTool extends CliError.UserError {
  override get message() {
    return "Choose a Deckhand integration tool from `deckhand integration tools`.";
  }
}
const tools = Command.make("tools").pipe(
  Command.withDescription(
    "List provider-scoped Deckhand integration tools and their JSON schemas.",
  ),
  Command.withHandler(() =>
    Console.log(
      JSON.stringify(
        Object.values(DeckhandToolkit.tools).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: Tool.getJsonSchema(tool),
        })),
        null,
        2,
      ),
    ),
  ),
);
const call = Command.make("call", {
  tool: Argument.String("tool"),
  argumentsJson: Argument.String("arguments-json"),
}).pipe(
  Command.withDescription(
    "Call a Deckhand tool using this agent terminal's injected T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION. Explicit mutation tool calls may change local services/runs, prepare evidence, register reported external sessions, or run a pinned verification build/check/capture attempt. An active writer can refuse verification reservation; uncertain actions must be inspected, never replayed. Never put credentials in arguments.",
  ),
  Command.withHandler(({ tool, argumentsJson }) =>
    Object.hasOwn(DeckhandToolkit.tools, tool)
      ? Effect.promise(() => runAcpMcpCliFastPath("acp-mcp-call", [tool, argumentsJson]))
      : Effect.fail(new InvalidIntegrationTool({ cause: "unknown_tool" })),
  ),
);
export const integrationCommand = Command.make("integration").pipe(
  Command.withDescription(
    "Inspect and explicitly control the current provider session's managed Cinderdeck lane through Deckhand's authenticated MCP service.",
  ),
  Command.withSubcommands([tools, call]),
);
