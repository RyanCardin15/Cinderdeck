import { createFileRoute } from "@tanstack/react-router";
import { NativeSettingsPage } from "../deckhand/NativeSettings";
export const Route = createFileRoute("/settings/about")({
  component: () => <NativeSettingsPage path="/settings/about" />,
});
