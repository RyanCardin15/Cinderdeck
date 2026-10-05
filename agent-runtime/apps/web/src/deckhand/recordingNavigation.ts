import type { RecordingContext } from "@cinderdeck/contracts/deckhand/recordingsRpc";
import { validateWorkspaceSearch } from "./workspaceNavigation";

export function validateRecordingsSearch(value: Record<string, unknown>) {
  const { context: _context, tab: _tab, ...search } = validateWorkspaceSearch(value);
  if (
    (search.expectedGeneration !== undefined || search.expectedInstallationID !== undefined) &&
    !search.workspace
  )
    throw new Error("This saved recording link is missing its workspace identity.");
  return {
    ...search,
    ...(typeof value.recording === "string" && value.recording.length <= 160
      ? { recording: value.recording }
      : {}),
  };
}
export type RecordingsSearch = ReturnType<typeof validateRecordingsSearch>;

/** Never replace a saved evidence scope with a newly discovered installation or generation. */
export function recordingContextForSearch(
  search: RecordingsSearch,
  current: RecordingContext | null,
): RecordingContext | null {
  const installationID = search.expectedInstallationID ?? current?.installationID;
  const workspaceID = search.workspace ?? current?.workspaceID;
  const generation = search.expectedGeneration ?? current?.generation;
  return installationID && workspaceID && generation !== undefined
    ? { installationID, workspaceID, generation }
    : null;
}
