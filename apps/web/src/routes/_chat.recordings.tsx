import { createFileRoute } from "@tanstack/react-router";
import { RecordingsPage } from "../deckhand/Recordings";
import { validateRecordingsSearch } from "../deckhand/recordingNavigation";
export const Route = createFileRoute("/_chat/recordings")({
  validateSearch: validateRecordingsSearch,
  component: RecordingsPage,
});
