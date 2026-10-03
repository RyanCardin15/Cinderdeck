import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceOverview } from "../deckhand/WorkspaceOverview";
export const Route = createFileRoute("/_chat/workspaces")({ component: WorkspaceOverview });
