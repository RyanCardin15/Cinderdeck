import { createFileRoute } from "@tanstack/react-router";
import { WorkspacesSettings } from "../components/settings/WorkspacesSettings";

export const Route = createFileRoute("/settings/workspaces")({ component: WorkspacesSettings });
