import { createFileRoute } from "@tanstack/react-router";
import { NativeSettingsPage } from "../deckhand/NativeSettings";
export const Route = createFileRoute("/settings/recording")({
  component: () => <NativeSettingsPage path="/settings/recording" />,
});
