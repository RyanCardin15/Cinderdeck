import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  ContextPullRequest,
  ContextPullRequestsPage,
  IntegrationView,
} from "@t3tools/contracts/deckhand/rpc";
import {
  connectedPullRequestSearch,
  contextPullRequestNavigation,
  contextPullRequestSelection,
  contextPullRequestReturn,
  contextPullRequestState,
  contextPullRequestTargets,
  validateConnectedPullRequestSearch,
  contextPullRequestKey,
} from "./contextPullRequestScope";
const environmentId = EnvironmentId.make("computer");
const scope = connectedPullRequestSearch(
  environmentId,
  { workspaceID: "base", contextID: "lane", installationID: "installation", generation: 7 },
  "agents",
);
const view = {
  state: "connected",
  hello: { installationID: "installation" },
  resources: [],
  selectedResources: [
    {
      workspaceID: "lane",
      generation: 7,
      available: true,
      workspace: { issues: [], definitionChanged: false, lane: { sourceStackID: "base" } },
    },
  ],
} as unknown as IntegrationView;
const page = {
  installationID: "installation",
  workspaceID: "lane",
  generation: 7,
  offset: 0,
  total: 0,
  nextOffset: null,
  items: [],
} as ContextPullRequestsPage;
const item = (projectId: string): ContextPullRequest => ({
  projectId: ProjectId.make(projectId),
  threadId: ThreadId.make("thread"),
  link: {
    host: "github.com",
    repository: "Owner/Repo",
    number: 1,
    url: "https://github.com/Owner/Repo/pull/1",
    source: "manual",
    linkedAt: "2026-10-04T00:00:00Z",
    snapshot: null,
    stack: null,
  },
});
describe("saved context PR scope", () => {
  it("round-trips exact base/lane, execution computer and native pins without global fallback", () => {
    expect(validateConnectedPullRequestSearch({ ...scope, deckhandGeneration: "7" })).toEqual(
      scope,
    );
    expect(contextPullRequestReturn(scope)).toEqual({
      environment: "computer",
      workspace: "base",
      context: "lane",
      expectedInstallationID: "installation",
      expectedGeneration: 7,
      tab: "agents",
    });
    expect(() => validateConnectedPullRequestSearch({ deckhandContext: "lane" })).toThrow();
    expect(() => validateConnectedPullRequestSearch({ ...scope, deckhandGeneration: 0 })).toThrow();
    expect(validateConnectedPullRequestSearch({ environmentId: "computer" })).toEqual({});
  });
  it("refuses wrong source workspace, replaced installation/generation, stale connection and mismatched metadata", () => {
    expect(contextPullRequestState(scope, view, page, false)).toBe("ready");
    expect(
      contextPullRequestState({ ...scope, deckhandWorkspace: "other" }, view, page, false),
    ).toBe("changed");
    expect(
      contextPullRequestState({ ...scope, deckhandInstallationID: "new" }, view, page, false),
    ).toBe("changed");
    expect(contextPullRequestState({ ...scope, deckhandGeneration: 8 }, view, page, false)).toBe(
      "changed",
    );
    expect(contextPullRequestState(scope, { ...view, state: "reconnecting" }, page, false)).toBe(
      "unavailable",
    );
    expect(contextPullRequestState(scope, view, { ...page, workspaceID: "other" }, false)).toBe(
      "changed",
    );
    expect(contextPullRequestState(scope, null, null, false)).toBe("loading");
    expect(contextPullRequestState(scope, view, page, true)).toBe("unavailable");
  });
  it("groups every project from the exact loaded links and sends no global query for an empty scope", () => {
    expect(
      contextPullRequestTargets(environmentId, [item("api"), item("frontend"), item("api")]),
    ).toEqual([
      { environmentId, input: { projectIds: ["api", "frontend"], state: "all", limit: 50 } },
    ]);
    expect(contextPullRequestTargets(environmentId, [])).toEqual([]);
  });
  it("restores selection only from the saved exact scope page and clears it on page navigation", () => {
    const selected = contextPullRequestNavigation(scope, 50, item("api"));
    expect(
      validateConnectedPullRequestSearch({ ...selected, deckhandOffset: "50", number: "1" }),
    ).toEqual(selected);
    expect(contextPullRequestSelection(selected, [item("api")])).toEqual(item("api"));
    expect(
      contextPullRequestSelection({ ...selected, selectedHost: "enterprise.example" }, [
        item("api"),
      ]),
    ).toBeNull();
    expect(contextPullRequestSelection(selected, [])).toBeNull();
    expect(contextPullRequestNavigation(selected, 0)).toEqual(scope);
    expect(() => validateConnectedPullRequestSearch({ ...selected, deckhandOffset: -1 })).toThrow();
    expect(() => validateConnectedPullRequestSearch({ ...selected, number: true })).toThrow();
    expect(() =>
      validateConnectedPullRequestSearch({ ...selected, selectedHost: undefined }),
    ).toThrow();
  });
  it("keeps host, canonical repository and number in identity rather than matching branch names", () => {
    expect(contextPullRequestKey(item("api").link)).toBe(
      contextPullRequestKey({ ...item("api").link, repository: "owner/repo" }),
    );
    expect(contextPullRequestKey(item("api").link)).not.toBe(
      contextPullRequestKey({ ...item("api").link, host: "enterprise.example" }),
    );
  });
});
