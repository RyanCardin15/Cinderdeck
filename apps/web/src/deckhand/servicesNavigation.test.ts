import { describe, expect, it } from "vite-plus/test";
import { validateServicesSearch } from "./servicesNavigation";
import { savedWorkspaceMatches } from "./workspaceNavigation";
describe("saved run navigation", () => {
  it("preserves the exact computer, workspace, run and authority pins", () => {
    const search = validateServicesSearch({
      environment: "computer",
      workspace: "lane",
      run: "old-run",
      expectedGeneration: "3",
      expectedInstallationID: "original",
    });
    expect(search).toEqual({
      environment: "computer",
      workspace: "lane",
      run: "old-run",
      expectedGeneration: 3,
      expectedInstallationID: "original",
    });
    expect(savedWorkspaceMatches(search, "replacement", 3)).toBe(false);
    expect(savedWorkspaceMatches(search, "original", 4)).toBe(false);
    expect(savedWorkspaceMatches(search, "original", 3)).toBe(true);
  });
  it("refuses context-only or malformed pinned links rather than opening an arbitrary workspace", () => {
    expect(() =>
      validateServicesSearch({ context: "lane", run: "old-run", expectedGeneration: 3 }),
    ).toThrow();
    expect(() =>
      validateServicesSearch({ workspace: "lane", expectedGeneration: "invalid" }),
    ).toThrow();
  });
});
