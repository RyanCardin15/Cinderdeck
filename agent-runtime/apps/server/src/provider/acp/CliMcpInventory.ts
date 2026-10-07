// Provider wire replies are decoded at this boundary; never return raw configs or errors to clients.
// @effect-diagnostics preferSchemaOverJson:off
import type {
  AcpRegistrySettings,
  ProviderMcpPreferences,
  ProviderMcpServer,
} from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProcessRunner } from "../../processRunner.ts";
import { isCinderdeckMcpServerName } from "../providerMcp.ts";
import { listCopilotMcpServers } from "./CopilotMcpInventory.ts";

export class CliMcpInventoryError extends Schema.TaggedError<CliMcpInventoryError>()(
  "CliMcpInventoryError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export function cliMcpKind(
  settings: Pick<AcpRegistrySettings, "agentId">,
): "cursor" | "copilot" | undefined {
  return settings.agentId === "cursor"
    ? "cursor"
    : settings.agentId === "github-copilot-cli"
      ? "copilot"
      : undefined;
}

/** Copilot accepts these session-only flags in ACP mode as well as interactive mode. */
export function copilotMcpPreferenceArgs(preferences: ProviderMcpPreferences): string[] {
  const args: string[] = [];
  const disabled = new Set(preferences.disabledServers);
  for (const name of disabled) {
    if (!isCinderdeckMcpServerName(name)) args.push(`--disable-mcp-server=${name}`);
  }
  for (const [name, tools] of Object.entries(preferences.disabledTools)) {
    if (disabled.has(name) || isCinderdeckMcpServerName(name)) continue;
    for (const tool of new Set(tools)) {
      // Permission tokens have a grammar. Refuse ambiguous names instead of widening a deny rule.
      if (/[()*\r\n]/u.test(name) || /[()*\r\n]/u.test(tool))
        throw new Error(
          "Copilot cannot apply an MCP tool preference with an ambiguous permission token.",
        );
      args.push(`--deny-tool=${name}(${tool})`);
    }
  }
  return args;
}

function cleanOutput(text: string): string {
  // oxlint-disable-next-line no-control-regex -- Strip terminal ANSI color sequences.
  return text.replaceAll(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").replaceAll("\r", "");
}

/** Cursor's non-TTY listing is one `name: state` line per server; names may contain colons. */
export function cursorMcpServersFromOutput(output: string): ProviderMcpServer[] {
  const text = cleanOutput(output).trim();
  if (text.startsWith("No MCP servers configured")) return [];
  const servers: ProviderMcpServer[] = [];
  let recognized = false;
  for (const line of text.split("\n")) {
    const match =
      /^(.*): (ready|connected|disconnected|requires_authentication|loading|disabled|not loaded \(needs approval\)|Error:.*)$/u.exec(
        line.trim(),
      );
    if (!match || !match[1]?.trim()) continue;
    recognized = true;
    const name = match[1].trim();
    if (isCinderdeckMcpServerName(name)) continue;
    const state = match[2];
    const status =
      state === "ready" || state === "connected"
        ? "connected"
        : state === "requires_authentication"
          ? "needsAuth"
          : state === "disabled"
            ? "disabled"
            : state === "loading" || state === "not loaded (needs approval)"
              ? "pending"
              : "failed";
    servers.push({
      name,
      status,
      tools: [],
      ...(status === "needsAuth" ? { auth: "notLoggedIn" as const } : {}),
      ...(state === "not loaded (needs approval)"
        ? {
            approvalRequired: true,
            error:
              "Approve this server with `agent mcp enable` in the provider's CLI, then refresh.",
          }
        : {}),
      ...(status === "failed"
        ? { error: "Cursor could not connect to this MCP server. Check it with `agent mcp list`." }
        : {}),
    });
  }
  if (!recognized) {
    throw new CliMcpInventoryError({
      detail: "Cursor returned an unrecognized MCP listing. Check the installed CLI version.",
    });
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

export function cursorMcpToolsFromOutput(output: string): ProviderMcpServer["tools"] {
  const text = cleanOutput(output).trim();
  if (text.startsWith("No tools available for ")) return [];
  const count = /^Tools for .* \((\d+)\):$/mu.exec(text);
  if (!count)
    throw new CliMcpInventoryError({ detail: "Cursor returned an unrecognized MCP tool listing." });
  const tools = text.split("\n").flatMap((line) => {
    const match = /^- (.+?) \(.*\)$/u.exec(line.trim());
    return match?.[1] ? [{ name: match[1] }] : [];
  });
  if (tools.length !== Number(count[1]))
    throw new CliMcpInventoryError({ detail: "Cursor returned an incomplete MCP tool listing." });
  return tools;
}

export const listCliMcpServers = (input: {
  readonly kind: "cursor" | "copilot";
  readonly command: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) =>
  Effect.gen(function* () {
    if (input.kind === "copilot") return yield* listCopilotMcpServers(input);
    const runner = yield* ProcessRunner;
    const run = (args: ReadonlyArray<string>) =>
      runner
        .run({
          command: input.command,
          args,
          cwd: input.cwd,
          env: { ...input.environment, NO_COLOR: "1", NO_OPEN_BROWSER: "1" },
          timeout: "20 seconds",
          maxOutputBytes: 4 * 1024 * 1024,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CliMcpInventoryError({
                detail:
                  "Cursor could not list its MCP servers. Check the installed CLI and configuration.",
                cause,
              }),
          ),
        );
    const listing = yield* run(["mcp", "list"]);
    if (listing.code !== 0)
      return yield* new CliMcpInventoryError({
        detail: "Cursor could not list its MCP servers. Check the installed CLI and configuration.",
      });
    const servers = yield* Effect.try({
      try: () => cursorMcpServersFromOutput(listing.stdout),
      catch: (cause) =>
        new CliMcpInventoryError({ detail: "Cursor returned an unrecognized MCP listing.", cause }),
    });
    return yield* Effect.forEach(
      servers,
      (server) => {
        if (server.status !== "connected") return Effect.succeed(server);
        return run(["mcp", "list-tools", server.name]).pipe(
          Effect.flatMap((result) =>
            result.code !== 0
              ? Effect.fail(new CliMcpInventoryError({ detail: "Could not list tools." }))
              : Effect.try({
                  try: () => cursorMcpToolsFromOutput(result.stdout),
                  catch: (cause) =>
                    new CliMcpInventoryError({ detail: "Could not parse tools.", cause }),
                }),
          ),
          Effect.map((tools): ProviderMcpServer => ({ ...server, tools })),
          Effect.orElseSucceed((): ProviderMcpServer => ({
            ...server,
            error:
              "Connected, but Cursor could not list this server's tools. Check it with `agent mcp list-tools`, then refresh.",
          })),
        );
      },
      { concurrency: 3 },
    );
  }).pipe(Effect.timeout("45 seconds"));

/** Registry integrations use this outside the generic ACP protocol implementation. */
export function cliMcpSessionArgs(
  settings: Pick<AcpRegistrySettings, "agentId">,
  preferences: ProviderMcpPreferences,
): string[] {
  return cliMcpKind(settings) === "copilot" ? copilotMcpPreferenceArgs(preferences) : [];
}
