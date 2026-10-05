import type { EnvironmentId } from "@cinderdeck/contracts";
import type { WorkspaceSearch } from "./workspaceNavigation";
import type { IntegrationView, OperationRecord } from "@cinderdeck/contracts/deckhand/rpc";

export interface ConnectedWorkspaceSelection {
  readonly environmentId: EnvironmentId;
  readonly baseWorkspaceID: string;
  readonly contextID: string;
  readonly expectedInstallationID: string;
  readonly expectedGeneration: number;
}

export function presentCinderdeckConnection(
  view: Pick<IntegrationView, "state"> | null,
  nativeHost = false,
) {
  if (view === null)
    return {
      title: nativeHost ? "Loading workspaces" : "Checking Cinderdeck",
      detail: "Reading the connection on this execution computer.",
    };
  const states: Record<IntegrationView["state"], { title: string; detail: string }> = {
    connecting: {
      title: nativeHost ? "Loading workspaces" : "Connecting to Cinderdeck",
      detail: nativeHost
        ? "Checking this application's workspace inventory and identity."
        : "Discovering the same-host Cinderdeck installation and checking its identity.",
    },
    connected: {
      title: nativeHost ? "Workspaces ready" : "Cinderdeck connected",
      detail:
        "Cinderdeck manages these workspaces, lanes, services and recordings alongside your agents.",
    },
    reconnecting: {
      title: "Reconnecting to Cinderdeck",
      detail:
        "The last workspace snapshot is retained. Wait for a fresh connection before choosing a workspace.",
    },
    unavailable: {
      title: nativeHost ? "Workspace connection unavailable" : "Cinderdeck unavailable",
      detail: nativeHost
        ? "The workspace connection is unavailable. Check it again before choosing a workspace."
        : "Open Cinderdeck on this execution computer, then check the connection again. You can continue with code projects.",
    },
    incompatible: {
      title: "Cinderdeck needs attention",
      detail:
        "The installation could not provide a compatible response. Update Cinderdeck, then check again.",
    },
    identity_changed: {
      title: "Connection identity changed",
      detail:
        "This is a different installation or execution host. The saved workspace snapshot is unavailable until the identity is verified again.",
    },
    unauthorized: {
      title: "Connection refused",
      detail:
        "The local integration socket could not be trusted. Check Cinderdeck’s integration setup on this execution computer.",
    },
    unsupported: {
      title: "Cinderdeck requires macOS",
      detail:
        "Connect a macOS execution computer running Cinderdeck, or continue with code projects on this computer.",
    },
  };
  return states[view.state];
}

export function canChooseConnectedWorkspace(
  view: IntegrationView | null,
  resource: IntegrationView["resources"][number] | undefined,
): boolean {
  return (
    view?.state === "connected" &&
    view.hello !== null &&
    view.hello.capabilities.includes("projection.snapshot") &&
    resource !== undefined &&
    resource.available &&
    resource.workspace != null
  );
}

export function unresolvedIntegrationOperations(records: ReadonlyArray<OperationRecord>) {
  return records.filter(
    (record) =>
      !record.refused &&
      (record.receipt === null ||
        ["pending", "running", "unknown_outcome"].includes(record.receipt.state)),
  );
}

export const CINDERDECK_CAPABILITIES = [
  { key: "projection.snapshot", label: "Workspace inventory" },
  { key: "operations.lane.create", label: "Create lanes" },
  { key: "operations.services", label: "Service controls" },
  { key: "runs.library", label: "Tasks and workflows" },
  { key: "recordings.library", label: "Recording library" },
  { key: "checkout.reservations", label: "Writer coordination" },
] as const;

export function connectedWorkspaceDestination(
  environmentId: EnvironmentId,
  installationID: string,
  resource: IntegrationView["resources"][number],
  expectedGeneration = resource.generation,
): ConnectedWorkspaceSelection | null {
  if (!resource.workspace) return null;
  const baseWorkspaceID = resource.workspace.lane?.sourceStackID ?? resource.workspaceID;
  if (!baseWorkspaceID.trim()) return null;
  return {
    environmentId,
    baseWorkspaceID,
    contextID: resource.workspaceID,
    expectedInstallationID: installationID,
    expectedGeneration,
  };
}

export function connectedWorkspaceSearch(selection: ConnectedWorkspaceSelection): WorkspaceSearch {
  return {
    tab: "services",
    environment: selection.environmentId,
    workspace: selection.baseWorkspaceID,
    context: selection.contextID,
    expectedInstallationID: selection.expectedInstallationID,
    expectedGeneration: selection.expectedGeneration,
  };
}
