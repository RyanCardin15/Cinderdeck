import {
  ProviderDriverKind,
  ProviderInstanceId,
  type AcpRegistrySettings,
  type ServerSettings,
} from "@t3tools/contracts";

const ACP_REGISTRY = ProviderDriverKind.make("acpRegistry");

/** Local executables are explicit so startup never installs a registry distribution. */
export function seedFreshCinderdeckCliProviders(settings: ServerSettings): ServerSettings {
  return {
    ...settings,
    providerInstances: {
      [ProviderInstanceId.make("cursor_cli")]: {
        driver: ACP_REGISTRY,
        displayName: "Cursor CLI",
        enabled: true,
        config: { agentId: "cursor", commandPath: "agent", authMethodId: "cursor_login" },
      },
      [ProviderInstanceId.make("copilot_cli")]: {
        driver: ACP_REGISTRY,
        displayName: "Copilot CLI",
        enabled: true,
        config: { agentId: "github-copilot-cli", commandPath: "copilot" },
      },
      // Explicit settings always win, including deliberately disabled instances.
      ...settings.providerInstances,
    },
  };
}

/** Only known first-party local CLIs may warm an empty catalogue during readiness. */
export function isCinderdeckLocalCli(settings: AcpRegistrySettings): boolean {
  return (
    settings.commandPath.trim().length > 0 &&
    (settings.agentId === "cursor" || settings.agentId === "github-copilot-cli")
  );
}
