import {
  ProviderDriverKind,
  EMPTY_PROVIDER_MCP_PREFERENCES,
  type ProviderMcpServer,
} from "@cinderdeck/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveMcpPreferences,
  mcpEmptyHint,
  mcpSignInHint,
  describeMcpToolCount,
  mcpPreferencesPatchValue,
  presentMcpServer,
  setMcpServerEnabled,
  setMcpToolsEnabled,
} from "./ProviderMcpSection.logic";

const server: ProviderMcpServer = {
  name: "linear",
  status: "connected",
  tools: [
    { name: "create_issue" },
    { name: "delete_issue", destructive: true },
    { name: "list_issues", readOnly: true },
    { name: "archive", disabledByProvider: true },
  ],
};

describe("MCP preferences", () => {
  it("round-trips a server toggle back to the provider defaults", () => {
    const off = setMcpServerEnabled(EMPTY_PROVIDER_MCP_PREFERENCES, "linear", false);
    expect(off.disabledServers).toEqual(["linear"]);
    expect(presentMcpServer(server, off, "Codex")).toMatchObject({ label: "Off", turnedOff: true });
    expect(describeMcpToolCount(server, off)).toBe("0 of 4 tools");

    const on = setMcpServerEnabled(off, "linear", true);
    expect(mcpPreferencesPatchValue(on)).toBeNull();
  });

  it("toggles tools individually and in bulk without touching other tools", () => {
    const oneOff = setMcpToolsEnabled(
      EMPTY_PROVIDER_MCP_PREFERENCES,
      "linear",
      ["delete_issue"],
      false,
    );
    expect(describeMcpToolCount(server, oneOff)).toBe("2 of 4 tools");

    const allOff = setMcpToolsEnabled(oneOff, "linear", ["create_issue", "delete_issue"], false);
    expect(allOff.disabledTools).toEqual({ linear: ["create_issue", "delete_issue"] });

    const restored = setMcpToolsEnabled(allOff, "linear", ["create_issue", "delete_issue"], true);
    expect(restored.disabledTools).toEqual({});
    expect(mcpPreferencesPatchValue(restored)).toBeNull();
  });

  it("cannot turn on a server the provider's own config turned off", () => {
    expect(
      presentMcpServer({ ...server, status: "disabled" }, EMPTY_PROVIDER_MCP_PREFERENCES, "Codex"),
    ).toEqual({ label: "Off in Codex config", tone: "muted", toggleable: false, turnedOff: false });
  });
});

describe("CLI inventory controls", () => {
  it("ignores stored overrides for inspection-only providers", () => {
    const preferences = { disabledServers: ["linear"], disabledTools: { linear: ["list_issues"] } };
    expect(effectiveMcpPreferences(preferences, false)).toEqual(EMPTY_PROVIDER_MCP_PREFERENCES);
    expect(effectiveMcpPreferences(preferences, true)).toBe(preferences);
    expect(effectiveMcpPreferences(preferences, undefined)).toBe(preferences);
  });
  it("gives CLI-specific setup and sign-in guidance with quoted Cursor names", () => {
    expect(mcpEmptyHint(ProviderDriverKind.make("acpRegistry"), "cursor")).toContain(
      "~/.cursor/mcp.json",
    );
    expect(mcpEmptyHint(ProviderDriverKind.make("acpRegistry"), "github-copilot-cli")).toContain(
      "copilot mcp add",
    );
    expect(mcpSignInHint(ProviderDriverKind.make("acpRegistry"), "team docs", "cursor")).toContain(
      "agent mcp login 'team docs'",
    );
    expect(
      mcpSignInHint(ProviderDriverKind.make("acpRegistry"), "docs", "github-copilot-cli"),
    ).toContain("/mcp");
  });
});
