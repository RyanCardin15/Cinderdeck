import { describe, expect, it } from "vite-plus/test";
import { servicesWorkspaceSearch, validateServicesSearch } from "./servicesNavigation";
import { EnvironmentId } from "@t3tools/contracts";
import type { IntegrationView } from "@t3tools/contracts/deckhand/rpc";
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

describe("services return navigation", () => {
  const environment = EnvironmentId.make("computer");
  const lane = {
    workspaceID: "lane",
    generation: 7,
    workspace: { lane: { sourceStackID: "primary" } },
  } as IntegrationView["resources"][number];
  it("returns to the lane inside its parent workspace without carrying a task run", () => {
    expect(
      servicesWorkspaceSearch(
        environment,
        {
          workspace: "lane",
          expectedGeneration: 7,
          expectedInstallationID: "saved",
        },
        lane,
        "current",
      ),
    ).toEqual({
      environment,
      workspace: "primary",
      context: "lane",
      expectedGeneration: 7,
      expectedInstallationID: "saved",
    });
  });
  it("retains stale saved pins so returning cannot silently accept a replacement", () => {
    const search = servicesWorkspaceSearch(
      environment,
      {
        workspace: "lane",
        expectedGeneration: 6,
        expectedInstallationID: "old",
      },
      lane,
      "new",
    );
    expect(savedWorkspaceMatches(search, "new", 7)).toBe(false);
    expect(search.context).toBe("lane");
    expect(servicesWorkspaceSearch(environment, search, undefined, "new").context).toBe("primary");
  });
  it("keeps primary or unavailable context identity without guessing another workspace", () => {
    expect(
      servicesWorkspaceSearch(
        environment,
        { workspace: "missing", expectedGeneration: 2 },
        undefined,
        "saved",
      ),
    ).toEqual({
      environment,
      workspace: "missing",
      context: "missing",
      expectedGeneration: 2,
      expectedInstallationID: "saved",
    });
    expect(servicesWorkspaceSearch(environment, {}, undefined, "saved")).toEqual({ environment });
    expect(
      servicesWorkspaceSearch(
        environment,
        {},
        { ...lane, workspaceID: "primary", workspace: null },
        "saved",
      ).context,
    ).toBe("primary");
  });
});
