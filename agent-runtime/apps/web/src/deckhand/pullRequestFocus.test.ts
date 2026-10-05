import { describe, expect, it } from "vite-plus/test";
import { pullRequestEvidenceFocused, updatePullRequestDetailFocus } from "./pullRequestFocus";
describe("Pull request evidence focus", () => {
  it("focuses verification only for the selected PR and restores browsing on other tabs", () => {
    const selected = updatePullRequestDetailFocus(null, "first-pr", "verification");
    expect(pullRequestEvidenceFocused(selected, "first-pr")).toBe(true);
    expect(pullRequestEvidenceFocused(selected, "other-pr")).toBe(false);
    expect(pullRequestEvidenceFocused(selected, null)).toBe(false);
    for (const tab of ["summary", "timeline", "code"] as const) {
      expect(
        pullRequestEvidenceFocused(
          updatePullRequestDetailFocus(selected, "first-pr", tab),
          "first-pr",
        ),
      ).toBe(false);
    }
  });
  it("keeps explicit browsing across repeated notifications and scopes it to one PR", () => {
    const browsing = { surfaceId: "first-pr", tab: "verification" as const, browsing: true };
    expect(updatePullRequestDetailFocus(browsing, "first-pr", "verification")).toBe(browsing);
    expect(pullRequestEvidenceFocused(browsing, "first-pr")).toBe(false);
    const next = updatePullRequestDetailFocus(browsing, "second-pr", "summary");
    expect(pullRequestEvidenceFocused(next, "second-pr")).toBe(false);
    expect(next?.browsing).toBe(false);
    const returned = updatePullRequestDetailFocus(next, "first-pr", "verification");
    expect(pullRequestEvidenceFocused(returned, "first-pr")).toBe(true);
  });
});
