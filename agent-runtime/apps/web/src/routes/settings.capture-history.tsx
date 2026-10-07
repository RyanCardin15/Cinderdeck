import { createFileRoute } from "@tanstack/react-router";
import { NativeSettingsPage } from "../deckhand/NativeSettings";
export const Route = createFileRoute("/settings/capture-history")({
  component: () => <NativeSettingsPage path="/settings/capture-history" />,
});
