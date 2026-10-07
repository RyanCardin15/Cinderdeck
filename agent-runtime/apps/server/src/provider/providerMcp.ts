/**
 * MCP server inventory and tool preferences shared by provider drivers.
 *
 * Each provider reports its MCP servers in its own shape; the functions here
 * normalize them to `ProviderMcpServer` and turn the user's
 * `ProviderMcpPreferences` into the provider's session-start overrides. The
 * provider's own configuration files are never written.
 */
import {
  EMPTY_PROVIDER_MCP_PREFERENCES,
  type ProviderInstanceId,
  type ProviderMcpPreferences,
  type ProviderMcpServer,
  type ProviderMcpServerAuth,
  type ProviderMcpServerStatus,
  type ProviderMcpTool,
} from "@cinderdeck/contracts";
import * as Effect from "effect/Effect";
import type * as Types from "effect/Types";

import { APP_MCP_SERVER_NAME } from "../mcp/McpProviderSession.ts";
import type { ServerSettingsService } from "../serverSettings.ts";

/** Listing connects to every server, and remote ones can be slow to answer. */
export const MCP_LIST_TIMEOUT = "45 seconds";

/** Reads one instance's preferences; a settings failure falls back to "nothing disabled". */
export type ReadProviderMcpPreferences = Effect.Effect<ProviderMcpPreferences>;

export const readNoProviderMcpPreferences: ReadProviderMcpPreferences = Effect.succeed(
  EMPTY_PROVIDER_MCP_PREFERENCES,
);

export function makeReadProviderMcpPreferences(
  serverSettings: Pick<ServerSettingsService["Service"], "getSettings">,
  instanceId: ProviderInstanceId,
): ReadProviderMcpPreferences {
  return serverSettings.getSettings.pipe(
    Effect.map(
      (settings) => settings.providerMcpPreferences[instanceId] ?? EMPTY_PROVIDER_MCP_PREFERENCES,
    ),
    Effect.orElseSucceed(() => EMPTY_PROVIDER_MCP_PREFERENCES),
  );
}

/** Cinderdeck injects its own server into every session; it is not the user's to manage. */
export function isCinderdeckMcpServerName(name: string): boolean {
  return (
    name === APP_MCP_SERVER_NAME ||
    name.startsWith(`${APP_MCP_SERVER_NAME}-`) ||
    name === "t3-code" ||
    name.startsWith("t3-code-")
  );
}

const MAX_ERROR_LENGTH = 280;

/**
 * Provider errors can embed Rust type paths and repeat the same failure for
 * every retry. Keep the first readable sentence so a row stays scannable.
 */
export function summarizeMcpError(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const text = raw
    .replaceAll(/\s*\[[^\]]*::[^\]]*\]/g, "")
    .split(/,\s+when\s+/)[0]!
    .replaceAll(/\s+/g, " ")
    .trim();
  if (text.length === 0) return undefined;
  return text.length > MAX_ERROR_LENGTH
    ? `${text.slice(0, MAX_ERROR_LENGTH - 1).trimEnd()}…`
    : text;
}

const AUTH_ERROR_PATTERN = /\b(401|403|unauthori[sz]ed|forbidden|oauth|log ?in|re-?authenticat)/i;

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sortServers(servers: ReadonlyArray<ProviderMcpServer>): ReadonlyArray<ProviderMcpServer> {
  return [...servers].sort((left, right) => left.name.localeCompare(right.name));
}

function annotationFlag(annotations: unknown, key: string): boolean | undefined {
  if (typeof annotations !== "object" || annotations === null) return undefined;
  const value = (annotations as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function makeTool(input: {
  readonly name: string;
  readonly title?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly readOnly?: boolean | undefined;
  readonly destructive?: boolean | undefined;
}): ProviderMcpTool {
  const tool: Types.Mutable<ProviderMcpTool> = { name: input.name };
  const title = nonEmpty(input.title);
  const description = nonEmpty(input.description);
  if (title !== undefined && title !== input.name) tool.title = title;
  if (description !== undefined) tool.description = description;
  if (input.readOnly === true) tool.readOnly = true;
  if (input.destructive === true) tool.destructive = true;
  return tool;
}

// ── Codex ─────────────────────────────────────────────────────────────

export interface CodexMcpStatusEntry {
  readonly name: string;
  readonly authStatus: string;
  readonly runtimeStatus?: string | null;
  readonly httpOrigin?: string | null;
  readonly pluginId?: string | null;
  readonly serverInfo?: {
    readonly name: string;
    readonly title?: string | null;
    readonly version: string;
  } | null;
  readonly tools: {
    readonly [name: string]: {
      readonly name: string;
      readonly title?: string | null;
      readonly description?: string | null;
      readonly annotations?: unknown;
    };
  };
  readonly toolsError?: string | null;
}

/** The parts of a Codex `[mcp_servers.<name>]` table the inventory reads. */
export interface CodexMcpServerConfig {
  readonly enabled?: boolean;
  readonly disabled_tools?: ReadonlyArray<string>;
}

export function readCodexMcpServerConfigs(
  config: unknown,
): Readonly<Record<string, CodexMcpServerConfig>> {
  if (typeof config !== "object" || config === null) return {};
  const servers = (config as Record<string, unknown>).mcp_servers;
  if (typeof servers !== "object" || servers === null) return {};
  const result: Record<string, CodexMcpServerConfig> = {};
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const disabledTools = Array.isArray(record.disabled_tools)
      ? record.disabled_tools.filter((tool): tool is string => typeof tool === "string")
      : undefined;
    result[name] = {
      ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
      ...(disabledTools === undefined ? {} : { disabled_tools: disabledTools }),
    };
  }
  return result;
}

function codexAuth(authStatus: string): ProviderMcpServerAuth | undefined {
  switch (authStatus) {
    case "oAuth":
      return "oauth";
    case "bearerToken":
      return "bearerToken";
    case "notLoggedIn":
      return "notLoggedIn";
    default:
      return undefined;
  }
}

function codexStatus(
  entry: CodexMcpStatusEntry,
  config: CodexMcpServerConfig | undefined,
): ProviderMcpServerStatus {
  if (config?.enabled === false) return "disabled";
  switch (entry.runtimeStatus) {
    case "connected":
      return "connected";
    case "authenticationRequired":
      return "needsAuth";
    case "failed":
    case "cancelled":
      return "failed";
    case "disabled":
      return "disabled";
    case "starting":
    case "notStarted":
      return "pending";
  }
  // Without a thread, Codex leaves `runtimeStatus` empty; infer it from the
  // listing it just performed.
  if (entry.toolsError != null) {
    return entry.authStatus === "notLoggedIn" || AUTH_ERROR_PATTERN.test(entry.toolsError)
      ? "needsAuth"
      : "failed";
  }
  if (entry.authStatus === "notLoggedIn" && Object.keys(entry.tools).length === 0) {
    return "needsAuth";
  }
  return "connected";
}

export function codexMcpServersFromStatus(
  entries: ReadonlyArray<CodexMcpStatusEntry>,
  configs: Readonly<Record<string, CodexMcpServerConfig>>,
): ReadonlyArray<ProviderMcpServer> {
  return sortServers(
    entries
      .filter((entry) => !isCinderdeckMcpServerName(entry.name))
      .map((entry) => {
        const config = configs[entry.name];
        const status = codexStatus(entry, config);
        const reported = Object.values(entry.tools).map((tool) =>
          makeTool({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            readOnly: annotationFlag(tool.annotations, "readOnlyHint"),
            destructive: annotationFlag(tool.annotations, "destructiveHint"),
          }),
        );
        // Codex drops tools its own `disabled_tools` lists, so add them back
        // as locked rows rather than letting them vanish.
        const reportedNames = new Set(reported.map((tool) => tool.name));
        const providerDisabled = (config?.disabled_tools ?? [])
          .filter((name) => name.trim().length > 0 && !reportedNames.has(name))
          .map((name) => ({ name, disabledByProvider: true as const }));
        const server: Types.Mutable<ProviderMcpServer> = {
          name: entry.name,
          status,
          tools: [...reported, ...providerDisabled].sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
        };
        const title = nonEmpty(entry.serverInfo?.title);
        if (title !== undefined && title !== entry.name) server.title = title;
        const version = nonEmpty(entry.serverInfo?.version);
        if (version !== undefined) server.version = version;
        if (entry.pluginId != null) server.source = "plugin";
        const origin = nonEmpty(entry.httpOrigin);
        if (origin !== undefined) server.origin = origin.replace(/^https?:\/\//, "");
        const auth = codexAuth(entry.authStatus);
        if (auth !== undefined) server.auth = status === "needsAuth" ? "notLoggedIn" : auth;
        else if (status === "needsAuth") server.auth = "notLoggedIn";
        const error = status === "failed" || status === "needsAuth" ? entry.toolsError : undefined;
        const summary = summarizeMcpError(error);
        if (summary !== undefined) server.error = summary;
        return server;
      }),
  );
}

/**
 * Per-thread `mcp_servers` overrides. Codex merges these tables into the
 * user's config, so a partial entry only changes the keys it names. Arrays
 * replace rather than merge, which is why the user's own `disabled_tools`
 * are carried over.
 */
export function codexMcpServerOverrides(
  preferences: ProviderMcpPreferences,
  configs: Readonly<Record<string, CodexMcpServerConfig>>,
): Readonly<Record<string, { readonly enabled?: false; readonly disabled_tools?: string[] }>> {
  const overrides: Record<string, { enabled?: false; disabled_tools?: string[] }> = {};
  const disabledServers = new Set(preferences.disabledServers);
  for (const name of disabledServers) {
    if (isCinderdeckMcpServerName(name)) continue;
    overrides[name] = { enabled: false };
  }
  for (const [name, tools] of Object.entries(preferences.disabledTools)) {
    if (disabledServers.has(name) || isCinderdeckMcpServerName(name) || tools.length === 0) {
      continue;
    }
    overrides[name] = {
      disabled_tools: Array.from(new Set([...(configs[name]?.disabled_tools ?? []), ...tools])),
    };
  }
  return overrides;
}

// ── Claude ────────────────────────────────────────────────────────────

export interface ClaudeMcpStatusEntry {
  readonly name: string;
  readonly status: string;
  readonly serverInfo?: { readonly name: string; readonly version: string };
  readonly error?: string;
  readonly config?: unknown;
  readonly scope?: string;
  readonly source?: string;
  readonly tools?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly annotations?: {
      readonly readOnly?: boolean;
      readonly destructive?: boolean;
    };
  }>;
}

const CLAUDE_SOURCE_LABELS: Readonly<Record<string, string>> = {
  claudeai: "claude.ai",
};

function claudeStatus(status: string): ProviderMcpServerStatus {
  switch (status) {
    case "connected":
      return "connected";
    case "needs-auth":
      return "needsAuth";
    case "disabled":
      return "disabled";
    case "pending":
      return "pending";
    default:
      return "failed";
  }
}

function claudeOrigin(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const url = (config as Record<string, unknown>).url;
  if (typeof url !== "string") return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** Claude names an MCP tool `mcp__<server>__<tool>` after normalizing both parts. */
export function claudeMcpNameSegment(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

export function claudeMcpServersFromStatus(
  entries: ReadonlyArray<ClaudeMcpStatusEntry>,
): ReadonlyArray<ProviderMcpServer> {
  return sortServers(
    entries
      .filter((entry) => !isCinderdeckMcpServerName(entry.name) && entry.source !== "sdk")
      .map((entry) => {
        const status = claudeStatus(entry.status);
        const toolPrefix = `mcp__${claudeMcpNameSegment(entry.name)}__`;
        const server: Types.Mutable<ProviderMcpServer> = {
          name: entry.name,
          status,
          tools: (entry.tools ?? [])
            .map((tool) =>
              makeTool({
                name: tool.name.startsWith(toolPrefix)
                  ? tool.name.slice(toolPrefix.length)
                  : tool.name,
                description: tool.description,
                readOnly: tool.annotations?.readOnly,
                destructive: tool.annotations?.destructive,
              }),
            )
            .sort((left, right) => left.name.localeCompare(right.name)),
        };
        const version = nonEmpty(entry.serverInfo?.version);
        if (version !== undefined) server.version = version;
        const source = nonEmpty(entry.source ?? entry.scope);
        if (source !== undefined) server.source = CLAUDE_SOURCE_LABELS[source] ?? source;
        const origin = claudeOrigin(entry.config);
        if (origin !== undefined) server.origin = origin;
        if (status === "needsAuth") server.auth = "notLoggedIn";
        const summary = status === "failed" ? summarizeMcpError(entry.error) : undefined;
        if (summary !== undefined) server.error = summary;
        return server;
      }),
  );
}

/**
 * `disallowedTools` entries for the user's preferences. `mcp__<server>`
 * removes every tool of a server; `mcp__<server>__<tool>` removes one.
 */
export function claudeDisallowedMcpTools(
  preferences: ProviderMcpPreferences,
): ReadonlyArray<string> {
  const disabledServers = new Set(
    preferences.disabledServers.filter((name) => !isCinderdeckMcpServerName(name)),
  );
  const rules = [...disabledServers].map((name) => `mcp__${claudeMcpNameSegment(name)}`);
  for (const [name, tools] of Object.entries(preferences.disabledTools)) {
    if (disabledServers.has(name) || isCinderdeckMcpServerName(name)) continue;
    for (const tool of tools) {
      rules.push(`mcp__${claudeMcpNameSegment(name)}__${claudeMcpNameSegment(tool)}`);
    }
  }
  return Array.from(new Set(rules)).sort();
}
