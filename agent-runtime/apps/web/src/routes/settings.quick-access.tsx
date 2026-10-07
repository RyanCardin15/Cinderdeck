import { createFileRoute } from "@tanstack/react-router";
import { NativeSettingsPage } from "../deckhand/NativeSettings";
export const Route = createFileRoute("/settings/quick-access")({
  component: () => <NativeSettingsPage path="/settings/quick-access" />,
});
