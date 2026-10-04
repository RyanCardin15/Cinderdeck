import { validateWorkspaceSearch } from "./workspaceNavigation";
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
