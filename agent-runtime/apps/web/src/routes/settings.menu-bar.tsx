import { createFileRoute } from "@tanstack/react-router";
import { NativeSettingsPage } from "../deckhand/NativeSettings";
export const Route = createFileRoute("/settings/menu-bar")({
  component: () => <NativeSettingsPage path="/settings/menu-bar" />,
});
