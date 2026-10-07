import { createFileRoute } from "@tanstack/react-router";
import { WorkspacesSettings } from "../components/settings/WorkspacesSettings";

export const Route = createFileRoute("/settings/workspaces")({
  validateSearch: (
    raw: Record<string, unknown>,
  ): { workspace?: string; workspaceAction?: "delete" | "configuration" } => ({
    ...(typeof raw.workspace === "string" && raw.workspace.length <= 512
      ? { workspace: raw.workspace }
      : {}),
    ...(raw.workspaceAction === "delete" || raw.workspaceAction === "configuration"
      ? { workspaceAction: raw.workspaceAction }
      : {}),
  }),
  component: WorkspaceSettingsRoute,
});
function WorkspaceSettingsRoute() {
  const search = Route.useSearch();
  return (
    <WorkspacesSettings
      workspace={search.workspace}
      deleting={search.workspaceAction === "delete"}
      configuration={search.workspaceAction === "configuration"}
    />
  );
}
