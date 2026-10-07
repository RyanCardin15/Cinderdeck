import { createFileRoute } from "@tanstack/react-router";
import { NativeSettingsPage } from "../deckhand/NativeSettings";
export const Route = createFileRoute("/settings/permissions")({
  component: () => <NativeSettingsPage path="/settings/permissions" />,
});
