import { expect, it } from "vite-plus/test";
import { recordingContextForSearch, validateRecordingsSearch } from "./recordingNavigation";
import { savedWorkspaceMatches } from "./workspaceNavigation";

it("preserves saved evidence identity and its selected execution computer", () => {
  const search = validateRecordingsSearch({
    environment: "remote-computer",
    workspace: "lane",
    recording: "recording",
    expectedInstallationID: "original-installation",
    expectedGeneration: "7",
  });
  expect(search).toEqual({
    environment: "remote-computer",
    workspace: "lane",
    recording: "recording",
    expectedInstallationID: "original-installation",
    expectedGeneration: 7,
  });
  expect(
    recordingContextForSearch(search, {
      installationID: "replacement-installation",
      workspaceID: "lane",
      generation: 8,
    }),
  ).toEqual({ installationID: "original-installation", workspaceID: "lane", generation: 7 });
  expect(savedWorkspaceMatches(search, "replacement-installation", 8)).toBe(false);
  expect(recordingContextForSearch(search, null)?.generation).toBe(7);
});
it("rejects malformed pins and pins lacking a workspace instead of dropping them", () => {
  for (const pin of [0, -1, 1.5, "bad", null])
    expect(() =>
      validateRecordingsSearch({ workspace: "lane", expectedGeneration: pin }),
    ).toThrow();
  expect(() => validateRecordingsSearch({ expectedInstallationID: "installation" })).toThrow();
  expect(() =>
    validateRecordingsSearch({ workspace: "lane", expectedInstallationID: "" }),
  ).toThrow();
});
it("uses current scope only when no saved pin overrides it", () => {
  const current = { installationID: "installation", workspaceID: "lane", generation: 9 };
  expect(
    recordingContextForSearch(validateRecordingsSearch({ workspace: "lane" }), current),
  ).toEqual(current);
  expect(recordingContextForSearch(validateRecordingsSearch({}), null)).toBeNull();
  expect(
    validateRecordingsSearch({
      workspace: "lane",
      recording: "recording",
      tab: "agents",
      context: "other",
    }),
  ).toEqual({ workspace: "lane", recording: "recording" });
});
