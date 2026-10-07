import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@cinderdeck/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@cinderdeck/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderEnvironmentOptions,
  buildProviderSettingsInstanceRows,
  classifyProviderEnvironmentAccess,
  isProviderSettingsEnvironmentAvailable,
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";

describe("provider settings instance list", () => {
  const defaultIds = ["codex", "claudeAgent", "cursor", "grok", "opencode", "antigravity", "pi"];

  it("shows every built-in provider on a fresh environment without installed or authenticated snapshots", () => {
    const rows = buildProviderSettingsInstanceRows(DEFAULT_SERVER_SETTINGS);

    expect(rows.map((row) => row.instanceId)).toEqual(defaultIds);
    expect(rows.every((row) => row.isDefault && !row.isDirty)).toBe(true);
    const antigravity = rows.find((row) => row.driver === "antigravity")!;
    expect(resolveProviderInstanceEnabled(antigravity.instance)).toBe(false);
    // Moving enabled to the envelope must let the setup switch turn it on.
    expect(resolveProviderInstanceEnabled({ ...antigravity.instance, enabled: true })).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("keeps all providers visible after every default slot is explicitly disabled", () => {
    const providerInstances = Object.fromEntries(
      defaultIds.map((id) => [
        id,
        { driver: ProviderDriverKind.make(id), enabled: false, config: {} },
      ]),
    );
    const rows = buildProviderSettingsInstanceRows({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances,
    });

    expect(rows.map((row) => row.instanceId)).toEqual(defaultIds);
    expect(rows.every((row) => !resolveProviderInstanceEnabled(row.instance))).toBe(true);
  });

  it("preserves explicit configuration, custom instances, registry agents, and unknown drivers", () => {
    const antigravity = ProviderInstanceId.make("antigravity");
    const customId = ProviderInstanceId.make("antigravity_work");
    const registryId = ProviderInstanceId.make("cursor_cli");
    const forkId = ProviderInstanceId.make("fork_agent");
    const providerInstances = {
      [customId]: {
        driver: ProviderDriverKind.make("antigravity"),
        displayName: "Work account",
        enabled: false,
        config: { binaryPath: "/test/bin/agy" },
      },
      [antigravity]: {
        driver: ProviderDriverKind.make("antigravity"),
        enabled: false,
        config: { binaryPath: "/test/bin/personal-agy" },
      },
      [registryId]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        enabled: false,
        config: { agentId: "cursor", commandPath: "agent" },
      },
      [forkId]: { driver: ProviderDriverKind.make("forkDriver"), enabled: false, config: {} },
    };
    const rows = buildProviderSettingsInstanceRows({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances,
    });

    expect(rows.map((row) => row.instanceId)).toEqual([
      ...defaultIds.slice(0, 6),
      customId,
      "pi",
      registryId,
      forkId,
    ]);
    const defaultRow = rows.find((row) => row.instanceId === antigravity)!;
    expect(defaultRow.instance).toBe(providerInstances[antigravity]);
    expect(defaultRow).toMatchObject({ isDefault: true, isDirty: true });
    for (const instanceId of [customId, registryId, forkId]) {
      const row = rows.find((candidate) => candidate.instanceId === instanceId)!;
      expect(row.instance).toBe(providerInstances[instanceId]);
      expect(row.isDefault).toBe(false);
    }
  });

  it("keeps disabled providers visible after resetting their configuration to defaults", () => {
    const rows = buildProviderSettingsInstanceRows({
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        antigravity: {
          ...DEFAULT_SERVER_SETTINGS.providers.antigravity,
          binaryPath: "/test/bin/agy",
        },
      },
    });
    expect(rows.find((row) => row.driver === "antigravity")).toMatchObject({ isDirty: true });

    const resetRows = buildProviderSettingsInstanceRows(DEFAULT_SERVER_SETTINGS);
    expect(resetRows.find((row) => row.driver === "antigravity")).toMatchObject({ isDirty: false });
    expect(resetRows.map((row) => row.instanceId)).toEqual(rows.map((row) => row.instanceId));
  });

  it("preserves custom instances when an older environment lacks their driver's legacy slot", () => {
    const { antigravity: _unsupported, ...providers } = DEFAULT_SERVER_SETTINGS.providers;
    const customId = ProviderInstanceId.make("antigravity_work");
    const rows = buildProviderSettingsInstanceRows({
      providers: providers as ServerSettings["providers"],
      providerInstances: {
        [customId]: { driver: ProviderDriverKind.make("antigravity"), enabled: false, config: {} },
      },
    });

    expect(rows.some((row) => row.instanceId === "antigravity")).toBe(false);
    expect(rows.find((row) => row.instanceId === customId)).toMatchObject({ isDefault: false });
  });
});

const primaryId = EnvironmentId.make("primary");
const relayId = EnvironmentId.make("relay");
const sshId = EnvironmentId.make("ssh");

const environments = [
  { environmentId: sshId, label: "Zulu SSH" },
  { environmentId: relayId, label: "Alpha Relay" },
  { environmentId: primaryId, label: "This device" },
] as const;

describe("provider environment selection", () => {
  it("requires a connected environment with server config for searchable provider settings", () => {
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "connected",
        hasServerConfig: true,
      }),
    ).toBe(true);
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "reconnecting",
        hasServerConfig: true,
      }),
    ).toBe(false);
    expect(
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: "connected",
        hasServerConfig: false,
      }),
    ).toBe(false);
  });

  it("sorts the primary environment first and the rest by label", () => {
    expect(
      buildProviderEnvironmentOptions(environments, primaryId).map(
        (environment) => environment.environmentId,
      ),
    ).toEqual([primaryId, relayId, sshId]);
  });

  it("keeps a valid selection, then falls back to primary or the first environment", () => {
    const options = buildProviderEnvironmentOptions(environments, primaryId);

    expect(resolveSelectedProviderEnvironmentId(options, sshId, primaryId)).toBe(sshId);
    expect(
      resolveSelectedProviderEnvironmentId(
        options.filter((environment) => environment.environmentId !== sshId),
        sshId,
        primaryId,
      ),
    ).toBe(primaryId);
    expect(resolveSelectedProviderEnvironmentId(options.slice(1), primaryId, primaryId)).toBe(
      relayId,
    );
    expect(resolveSelectedProviderEnvironmentId([], null, primaryId)).toBeNull();
  });
});

describe("provider environment access", () => {
  it("allows connected environments with config and operate access", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "editable" });
  });

  it("waits for config before exposing controls", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: false,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "loading", reason: "config" });
  });

  it("waits for unresolved operate access instead of assuming it is editable", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "pending",
      }),
    ).toEqual({ kind: "loading", reason: "permissions" });
  });

  it("represents known missing operate access as read only", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "connected",
        hasServerConfig: true,
        operateAccess: "denied",
      }),
    ).toEqual({ kind: "read-only" });
  });

  it.each(["available", "offline", "connecting", "reconnecting"] as const)(
    "keeps %s environments unavailable",
    (connectionPhase) => {
      expect(
        classifyProviderEnvironmentAccess({
          connectionPhase,
          hasServerConfig: true,
          operateAccess: "granted",
        }),
      ).toEqual({ kind: "unavailable" });
    },
  );

  it("separates connection errors from other unavailable states", () => {
    expect(
      classifyProviderEnvironmentAccess({
        connectionPhase: "error",
        hasServerConfig: true,
        operateAccess: "granted",
      }),
    ).toEqual({ kind: "error" });
  });
});

describe("primary operate access", () => {
  const authenticated = {
    authenticated: true as const,
    scopes: [AuthOrchestrationOperateScope],
  };

  it("keeps cached session data authoritative while SWR revalidates", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: authenticated,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("reports pending only before any session has resolved", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("pending");
  });

  it("treats a failed session fetch as a transport problem, not a denial", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: true,
      }),
    ).toBe("granted");
  });

  it("denies unauthenticated sessions and sessions without the operate scope", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: null,
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("grants desktop bridge and remote environments without blocking on the primary session", () => {
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: true,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolvePrimaryOperateAccess({
        isPrimary: false,
        hasDesktopBridge: false,
        session: null,
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });
});

describe("remote operate access", () => {
  it("derives access from the environment session's granted scopes", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("reports pending before the first session resolve, then keeps cached data", () => {
    expect(resolveRemoteOperateAccess({ session: null, isPending: true, hasError: false })).toBe(
      "pending",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthOrchestrationOperateScope] },
        isPending: true,
        hasError: false,
      }),
    ).toBe("granted");
  });

  it("stays optimistic when the session fetch fails or an older server omits scopes", () => {
    // Transport failures and pre-scope-reporting servers are not permission
    // decisions; the environment RPC layer still rejects unauthorized writes.
    expect(resolveRemoteOperateAccess({ session: null, isPending: false, hasError: true })).toBe(
      "granted",
    );
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
  });
});
