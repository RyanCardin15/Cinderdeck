import { createFileRoute } from "@tanstack/react-router";
import { NativeSettingsPage } from "../deckhand/NativeSettings";
export const Route = createFileRoute("/settings/dictation")({
  component: () => <NativeSettingsPage path="/settings/dictation" />,
});
