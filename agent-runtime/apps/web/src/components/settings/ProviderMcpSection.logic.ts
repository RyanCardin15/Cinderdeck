import {
  EMPTY_PROVIDER_MCP_PREFERENCES,
  isProviderMcpPreferencesEmpty,
  type ProviderDriverKind,
  type ProviderMcpPreferences,
  type ProviderMcpServer,
} from "@cinderdeck/contracts";

export type McpStatusTone = "success" | "warning" | "error" | "muted" | "pending";

export interface McpServerPresentation {
  /** Short state shown next to the name. */
  readonly label: string;
  readonly tone: McpStatusTone;
  /** Whether the user can turn the server on or off from Cinderdeck. */
  readonly toggleable: boolean;
  /** Turned off here, regardless of what the provider reports. */
  readonly turnedOff: boolean;
}

export function presentMcpServer(
  server: ProviderMcpServer,
  preferences: ProviderMcpPreferences,
  providerLabel: string,
): McpServerPresentation {
  if (server.status === "disabled") {
    return {
      label: `Off in ${providerLabel} config`,
      tone: "muted",
      toggleable: false,
      turnedOff: false,
    };
  }
  if (preferences.disabledServers.includes(server.name)) {
    return { label: "Off", tone: "muted", toggleable: true, turnedOff: true };
  }
  switch (server.status) {
    case "connected":
      return {
        label: server.auth === "oauth" ? "Signed in" : "Connected",
        tone: "success",
        toggleable: true,
        turnedOff: false,
      };
    case "needsAuth":
      return { label: "Needs sign-in", tone: "warning", toggleable: true, turnedOff: false };
    case "pending":
      return {
        label: server.approvalRequired ? "Needs approval" : "Connecting",
        tone: "pending",
        toggleable: true,
        turnedOff: false,
      };
    case "failed":
      return { label: "Failed", tone: "error", toggleable: true, turnedOff: false };
  }
}

/** Tools the model can use from this server, given both providers' and the user's choices. */
export function countEnabledMcpTools(
  server: ProviderMcpServer,
  preferences: ProviderMcpPreferences,
): number {
  if (server.status === "disabled" || preferences.disabledServers.includes(server.name)) return 0;
  const disabled = new Set(preferences.disabledTools[server.name] ?? []);
  return server.tools.filter((tool) => !tool.disabledByProvider && !disabled.has(tool.name)).length;
}

export function describeMcpToolCount(
  server: ProviderMcpServer,
  preferences: ProviderMcpPreferences,
): string | null {
  const total = server.tools.length;
  if (total === 0) return null;
  const enabled = countEnabledMcpTools(server, preferences);
  const noun = total === 1 ? "tool" : "tools";
  return enabled === total ? `${total} ${noun}` : `${enabled} of ${total} ${noun}`;
}

function normalize(preferences: ProviderMcpPreferences): ProviderMcpPreferences {
  const disabledTools: Record<string, ReadonlyArray<string>> = {};
  for (const [server, tools] of Object.entries(preferences.disabledTools)) {
    const unique = Array.from(new Set(tools)).sort();
    if (unique.length > 0) disabledTools[server] = unique;
  }
  return {
    disabledServers: Array.from(new Set(preferences.disabledServers)).sort(),
    disabledTools,
  };
}

export function setMcpServerEnabled(
  preferences: ProviderMcpPreferences,
  serverName: string,
  enabled: boolean,
): ProviderMcpPreferences {
  const others = preferences.disabledServers.filter((name) => name !== serverName);
  return normalize({
    ...preferences,
    disabledServers: enabled ? others : [...others, serverName],
  });
}

/** Sets `toolNames` on or off together; other tools of the server keep their state. */
export function setMcpToolsEnabled(
  preferences: ProviderMcpPreferences,
  serverName: string,
  toolNames: ReadonlyArray<string>,
  enabled: boolean,
): ProviderMcpPreferences {
  const current = preferences.disabledTools[serverName] ?? [];
  const names = new Set(toolNames);
  const next = enabled ? current.filter((name) => !names.has(name)) : [...current, ...toolNames];
  return normalize({
    ...preferences,
    disabledTools: { ...preferences.disabledTools, [serverName]: next },
  });
}

/** The settings patch value: `null` restores the provider's defaults. */
export function mcpPreferencesPatchValue(
  preferences: ProviderMcpPreferences,
): ProviderMcpPreferences | null {
  return isProviderMcpPreferencesEmpty(preferences) ? null : normalize(preferences);
}

export function mcpPreferencesKey(preferences: ProviderMcpPreferences | undefined): string {
  return JSON.stringify(normalize(preferences ?? EMPTY_PROVIDER_MCP_PREFERENCES));
}

export function filterMcpTools<T extends { readonly name: string; readonly title?: string }>(
  tools: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return tools;
  return tools.filter(
    (tool) =>
      tool.name.toLowerCase().includes(needle) ||
      (tool.title?.toLowerCase().includes(needle) ?? false),
  );
}

/** Where a server that needs sign-in can be authenticated. */
export function mcpSignInHint(
  driver: ProviderDriverKind | undefined,
  serverName: string,
  agentId?: string,
): string {
  if (driver === "acpRegistry" && agentId === "cursor") {
    const quoted = "'" + serverName.replaceAll("'", "'\"'\"'") + "'";
    return `Run \`agent mcp login ${quoted}\` in a terminal, then refresh.`;
  }
  if (driver === "acpRegistry" && agentId === "github-copilot-cli") {
    return "Run `/mcp` in Copilot CLI and choose this server to sign in, then refresh.";
  }
  switch (driver) {
    case "codex":
      return `Run \`codex mcp login ${serverName}\` in a terminal, then refresh.`;
    case "claudeAgent":
      return "Run `/mcp` in Claude Code and choose this server to sign in, then refresh.";
    default:
      return "Sign in with the provider's own CLI, then refresh.";
  }
}

export function mcpEmptyHint(driver: ProviderDriverKind | undefined, agentId?: string): string {
  if (driver === "acpRegistry" && agentId === "cursor")
    return "Add one in `~/.cursor/mcp.json` or your project’s `.cursor/mcp.json`.";
  if (driver === "acpRegistry" && agentId === "github-copilot-cli")
    return "Add one with `copilot mcp add` or in `~/.copilot/mcp-config.json`.";
  switch (driver) {
    case "codex":
      return "Add one with `codex mcp add` or in `~/.codex/config.toml`.";
    case "claudeAgent":
      return "Add one with `claude mcp add`.";
    default:
      return "Add one in the provider's own configuration.";
  }
}

/** Ignore old stored overrides when a provider only supports inspection. */
export function effectiveMcpPreferences(
  preferences: ProviderMcpPreferences,
  supported: boolean | undefined,
): ProviderMcpPreferences {
  return supported === false ? EMPTY_PROVIDER_MCP_PREFERENCES : preferences;
}
