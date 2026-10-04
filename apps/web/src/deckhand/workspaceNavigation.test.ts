import { describe, expect, it } from "vite-plus/test";
import type { IntegrationView } from "@t3tools/contracts/deckhand/rpc";
import {
  overviewPageSelection,
  overviewResources,
  overviewWorkspaceContexts,
  savedWorkspaceMatches,
  validateWorkspaceSearch,
} from "./workspaceNavigation";
describe("saved workspace navigation", () => {
  it("requires the saved lane generation and installation to match before exposing it", () => {
    const search = validateWorkspaceSearch({
      workspace: "payment",
      context: "lane",
      expectedGeneration: "3",
      expectedInstallationID: "original",
    });
    expect(savedWorkspaceMatches(search, "original", 3)).toBe(true);
    expect(savedWorkspaceMatches(search, "original", 4)).toBe(false);
    expect(savedWorkspaceMatches(search, "replacement", 3)).toBe(false);
    expect(savedWorkspaceMatches(search, "original", undefined)).toBe(false);
  });
  it("refuses malformed saved links rather than removing their identity protection", () => {
    for (const expectedGeneration of ["3x", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateWorkspaceSearch({ workspace: "payment", expectedGeneration })).toThrow();
    }
    expect(() =>
      validateWorkspaceSearch({ workspace: "payment", expectedInstallationID: "" }),
    ).toThrow();
    expect(() => validateWorkspaceSearch({ expectedGeneration: 3 })).toThrow();
  });
  it("keeps deliberate ordinary navigation available without a saved identity", () => {
    expect(
      savedWorkspaceMatches(
        validateWorkspaceSearch({ workspace: "payment", context: "lane" }),
        "new",
        9,
      ),
    ).toBe(true);
  });
});

describe("paged workspace selection", () => {
  const resource = (workspaceID: string, generation = 7) => ({
    workspaceID,
    generation,
    revision: "rev",
    available: true,
  });
  const view = (
    resources: IntegrationView["resources"],
    selectedResources: IntegrationView["resources"],
  ): IntegrationView => ({
    state: "connected",
    hello: null,
    observedAt: null,
    error: null,
    resources,
    selectedResources,
    activity: [],
    total: 600,
    nextOffset: 98,
  });
  it("reserves detail slots and preserves primary or lane selection outside any catalog page", () => {
    const search = {
      workspace: "primary",
      context: "lane",
      expectedGeneration: 7,
      expectedInstallationID: "installation",
    };
    expect(overviewPageSelection(search, 196)).toEqual({
      offset: 196,
      limit: 48,
      workspacePage: { offset: 0, limit: 50 },
      selectedWorkspaceID: "primary",
      selectedContextID: "lane",
    });
    for (const offset of [0, 196, 490]) {
      const page = Array.from({ length: 98 }, (_, index) => resource(`page-${offset + index}`));
      const merged = overviewResources(view(page, [resource("primary"), resource("lane")]));
      expect(merged).toHaveLength(100);
      expect(merged.find((item) => item.workspaceID === search.workspace)?.generation).toBe(7);
      expect(merged.find((item) => item.workspaceID === search.context)?.generation).toBe(7);
      expect(savedWorkspaceMatches(search, "installation", merged[1]?.generation)).toBe(true);
    }
    expect(overviewPageSelection({}, 100)).toEqual({
      offset: 100,
      limit: 48,
      workspacePage: { offset: 0, limit: 50 },
    });
    expect(
      overviewPageSelection({ workspace: "primary", context: "primary" }, 98).selectedContextID,
    ).toBe("primary");
  });
  it("deduplicates a selected row already on the page and refuses removed or replaced context pins", () => {
    const search = {
      workspace: "primary",
      context: "lane",
      expectedGeneration: 7,
      expectedInstallationID: "installation",
    };
    const samePage = overviewResources(
      view([resource("lane"), resource("another")], [resource("primary"), resource("lane")]),
    );
    expect(samePage.map((item) => item.workspaceID)).toEqual(["primary", "lane", "another"]);
    const removed = overviewResources(view([resource("another")], [resource("primary")]));
    expect(removed.find((item) => item.workspaceID === search.context)).toBeUndefined();
    expect(savedWorkspaceMatches(search, "installation", undefined)).toBe(false);
    const replaced = overviewResources(view([], [resource("primary"), resource("lane", 8)]));
    expect(savedWorkspaceMatches(search, "installation", replaced[1]?.generation)).toBe(false);
    expect(savedWorkspaceMatches(search, "other-installation", 7)).toBe(false);
    expect(overviewResources(null)).toEqual([]);
  });
});

describe("selected workspace scoped pages", () => {
  it("shows off-page lanes and keeps an explicit lane pin while scoped/global pages move independently", () => {
    const primary = { workspaceID: "primary", generation: 7, revision: "rev", available: true };
    const lane = (workspaceID: string) => ({
      ...primary,
      workspaceID,
      workspace: {
        id: workspaceID,
        name: workspaceID,
        file: "/fixture",
        state: "stopped",
        definitionChanged: false,
        issues: [],
        services: [],
        repos: [],
        lane: {
          sourceStackID: "primary",
          name: workspaceID,
          createdAt: "now",
          directory: "/fixture",
          ports: {},
        },
      },
    });
    const scoped: IntegrationView = {
      state: "connected",
      hello: null,
      observedAt: null,
      error: null,
      resources: [{ ...primary, workspaceID: "unrelated" }],
      selectedResources: [primary, lane("pinned")],
      workspaceContexts: {
        workspaceID: "primary",
        resources: [lane("page-51"), lane("page-52")],
        total: 61,
        laneCount: 60,
        offset: 50,
        nextOffset: null,
      },
      activity: [],
      total: 600,
      nextOffset: 48,
    };
    expect(overviewWorkspaceContexts(scoped, "primary").map((item) => item.workspaceID)).toEqual([
      "primary",
      "pinned",
      "page-51",
      "page-52",
    ]);
    expect(overviewWorkspaceContexts(scoped, "missing")).toEqual([]);
    expect(overviewResources(scoped)).toHaveLength(5);
    expect(overviewPageSelection({ workspace: "primary", context: "pinned" }, 480, 50)).toEqual({
      offset: 480,
      limit: 48,
      workspacePage: { offset: 50, limit: 50 },
      selectedWorkspaceID: "primary",
      selectedContextID: "pinned",
    });
    expect(
      savedWorkspaceMatches(
        { expectedGeneration: 7, expectedInstallationID: "installation" },
        "installation",
        overviewWorkspaceContexts(scoped, "primary")[1]?.generation,
      ),
    ).toBe(true);
    expect(overviewWorkspaceContexts(null, "primary")).toEqual([]);
  });
});
