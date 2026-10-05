import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceOverview } from "../deckhand/WorkspaceOverview";
export type { WorkspaceSearch } from "../deckhand/workspaceNavigation";
import { validateWorkspaceSearch } from "../deckhand/workspaceNavigation";
export const Route = createFileRoute("/_chat/workspaces")({
  validateSearch: validateWorkspaceSearch,
  component: WorkspaceOverview,
});
