import type { EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import { validateWorkspaceSearch, type WorkspaceSearch } from "./workspaceNavigation";

export function servicesWorkspaceSearch(
  environment: EnvironmentId,
  search: WorkspaceSearch,
  selected: IntegrationView["resources"][number] | undefined,
  installationID: string | undefined,
): WorkspaceSearch {
  const context = search.workspace ?? selected?.workspaceID;
  if (!context) return { environment };
  const installation = search.expectedInstallationID ?? installationID;
  const generation = search.expectedGeneration ?? selected?.generation;
  return {
    environment,
    ...(context ? { workspace: selected?.workspace?.lane?.sourceStackID ?? context, context } : {}),
    ...(installation ? { expectedInstallationID: installation } : {}),
    ...(generation ? { expectedGeneration: generation } : {}),
  };
}
export function validateServicesSearch(value: Record<string, unknown>) {
  const { context: _context, ...search } = validateWorkspaceSearch(value);
  if (
    (search.expectedGeneration !== undefined || search.expectedInstallationID !== undefined) &&
    !search.workspace
  ) {
    throw new Error("This saved run link is missing its workspace identity.");
  }
  return {
    ...search,
    ...(typeof value.run === "string" && value.run.length <= 160 ? { run: value.run } : {}),
  };
}
