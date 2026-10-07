import { createFileRoute } from "@tanstack/react-router";
import { NativeSettingsPage } from "../deckhand/NativeSettings";
export const Route = createFileRoute("/settings/updates")({
  component: () => <NativeSettingsPage path="/settings/updates" />,
});
