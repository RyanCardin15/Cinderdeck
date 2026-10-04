import { createFileRoute } from "@tanstack/react-router";
import { RecordingsPage } from "../deckhand/Recordings";
export const Route = createFileRoute("/_chat/recordings")({
  validateSearch: (
    value: Record<string, unknown>,
  ): { workspace?: string; recording?: string; environment?: string } => ({
    ...(typeof value.environment === "string" && value.environment.length <= 160
      ? { environment: value.environment }
      : {}),
    ...(typeof value.workspace === "string" && value.workspace.length <= 160
      ? { workspace: value.workspace }
      : {}),
    ...(typeof value.recording === "string" && value.recording.length <= 160
      ? { recording: value.recording }
      : {}),
  }),
  component: RecordingsPage,
});
