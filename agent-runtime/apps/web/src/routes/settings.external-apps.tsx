import { createFileRoute } from "@tanstack/react-router";
import { ExternalAppsSettings } from "../components/settings/ExternalAppsSettings";

export const Route = createFileRoute("/settings/external-apps")({
  component: ExternalAppsSettings,
});
