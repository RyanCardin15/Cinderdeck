import { createFileRoute } from "@tanstack/react-router";
import { NativeSettingsPage } from "../deckhand/NativeSettings";
export const Route = createFileRoute("/settings/annotations")({
  component: () => <NativeSettingsPage path="/settings/annotations" />,
});
