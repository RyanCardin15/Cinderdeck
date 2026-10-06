import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceOverview } from "../deckhand/WorkspaceOverview";
import { AgentsOverview } from "../deckhand/AgentsOverview";
export type { WorkspaceSearch } from "../deckhand/workspaceNavigation";
import { validateWorkspaceSearch } from "../deckhand/workspaceNavigation";
export const Route = createFileRoute("/_chat/workspaces")({
  validateSearch: validateWorkspaceSearch,
  component: WorkspaceRoute,
});
function WorkspaceRoute() {
  const search = Route.useSearch();
  return search.tab === "agents" && !search.workspace && !search.context ? (
    <AgentsOverview />
  ) : (
    <WorkspaceOverview />
  );
}
