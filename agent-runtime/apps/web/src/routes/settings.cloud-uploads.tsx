import { createFileRoute } from "@tanstack/react-router";
import { NativeSettingsPage } from "../deckhand/NativeSettings";
export const Route = createFileRoute("/settings/cloud-uploads")({
  component: () => <NativeSettingsPage path="/settings/cloud-uploads" />,
});
