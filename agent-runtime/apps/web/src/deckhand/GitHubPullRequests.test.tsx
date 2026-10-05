// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  GitHubWorkspaceFilters,
  GitHubWorkspaceInput,
  GitHubWorkspacePreferences,
  GitHubWorkspaceResult,
} from "@cinderdeck/contracts/deckhand/gitHubWorkspace";
const boundary = vi.hoisted(() => ({
  command: vi.fn(),
  phase: "connected" as "connected" | "connecting",
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => boundary.command }));
vi.mock("./gitHubWorkspaceState", () => ({ gitHubWorkspaceRequest: {} }));
vi.mock("../state/environments", () => ({
  usePrimaryEnvironmentId: () => "local",
  useEnvironments: () => ({
    environments: [
      { environmentId: "local", label: "This Mac", connection: { phase: boundary.phase } },
    ],
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
vi.mock("./NativeToolsSettings", () => ({
  NativeToolsMenu: () => null,
  NativeGitHubSettingsButton: () => <button>Configure GitHub account</button>,
}));
import { GitHubPullRequestInspector } from "./GitHubPullRequestInspector";
import { GitHubPullRequests } from "./GitHubPullRequests";
let root: Root;
let container: HTMLDivElement;
let preferences: GitHubWorkspacePreferences;
const filters: GitHubWorkspaceFilters = {
  repository: null,
  organization: null,
  state: "open",
  role: "anyone",
  sort: "updated",
  text: "label:bug",
  label: "",
  advanced: true,
};
const repository = {
  id: "r-1",
  nameWithOwner: "team/app",
  isPrivate: true,
  isArchived: false,
  viewerHasStarred: true,
  url: "https://github.com/team/app",
};
const request = {
  id: "pr-7",
  number: 7,
  title: "Repair login",
  url: "https://github.com/team/app/pull/7",
  state: "OPEN",
  isDraft: false,
  author: { login: "alex" },
  repository: { nameWithOwner: "team/app" },
  updatedAt: "2026-10-05T12:00:00Z",
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  labels: { nodes: [] },
  commits: { nodes: [] },
};
beforeEach(() => {
  boundary.phase = "connected";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  preferences = {
    account: "reviewer",
    hostname: "github.com",
    selectedViewID: "bugs",
    filters: { ...filters },
    query: "label:bug",
    views: [
      {
        id: "active",
        name: "Active",
        builtIn: true,
        filters: { ...filters, text: "", advanced: false },
        query: "is:open",
      },
      {
        id: "bugs",
        name: "Bug reviews",
        builtIn: false,
        filters: { ...filters },
        query: "label:bug",
      },
    ],
  };
  boundary.command.mockImplementation(async ({ input }: { input: GitHubWorkspaceInput }) => {
    const identity = { account: "reviewer", hostname: "github.com" };
    let value;
    switch (input.action) {
      case "preferences":
        value = { kind: "preferences", preferences };
        break;
      case "workspace":
        preferences = { ...preferences, filters: input.filters, selectedViewID: input.id };
        value = { kind: "preferences", preferences };
        break;
      case "upsert":
        preferences = {
          ...preferences,
          selectedViewID: input.id,
          filters: input.filters,
          views: [
            ...preferences.views,
            {
              id: input.id,
              name: input.name,
              builtIn: false,
              filters: input.filters,
              query: input.filters.text,
            },
          ],
        };
        value = { kind: "preferences", preferences };
        break;
      case "repositories":
        value = {
          kind: "repositories",
          ...identity,
          page: {
            nodes: input.after
              ? [{ ...repository, id: "r-2", nameWithOwner: "team/api", viewerHasStarred: false }]
              : [repository],
            pageInfo: { hasNextPage: !input.after, ...(input.after ? {} : { endCursor: "next" }) },
          },
        };
        break;
      case "organizations":
        value = {
          kind: "organizations",
          ...identity,
          page: { nodes: [{ login: "team" }], pageInfo: { hasNextPage: false } },
        };
        break;
      case "search":
        value = {
          kind: "search",
          ...identity,
          requests: [request],
          count: 1,
          pageInfo: { hasNextPage: false },
        };
        break;
      case "star":
        value = {
          kind: "star",
          ...identity,
          repositoryID: input.repository.id,
          starred: input.starred,
        };
        break;
      default:
        throw new Error(`Unexpected action ${input.action}`);
    }
    return { _tag: "Success", value };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
async function mount() {
  await act(async () => root.render(<GitHubPullRequests />));
  await act(async () => vi.advanceTimersByTime(350));
}
function button(label: string) {
  const item = [...document.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  if (!item) throw new Error(`Missing button ${label}`);
  return item;
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("restores native custom queries and loads paginated organizations/favorites without asking for workspaces", async () => {
  await mount();
  expect(container.textContent).toContain("Bug reviews");
  expect(container.textContent).toContain("Favorites");
  expect(container.textContent).toContain("Other repositories");
  expect(
    (container.querySelector('[aria-label="Search pull requests"]') as HTMLInputElement).value,
  ).toBe("label:bug");
  expect(container.querySelectorAll('[aria-label="GitHub repositories"] section')).toHaveLength(2);
  expect(container.textContent).toContain("Repair login");
  expect(boundary.command.mock.calls.map(([call]) => call.input.action)).not.toContain(
    "workspaces",
  );
  await act(async () => button("Show only starred repositories").click());
  expect(container.textContent).not.toContain("Other repositories");
  expect(container.textContent).toContain("Favorites");
  await act(async () => button("Unstar team/app on GitHub").click());
  expect(container.textContent).toContain("Star repositories to keep them here.");
});
it("writes edited query filters into the original account preferences and restores them on remount", async () => {
  await mount();
  await type(
    container.querySelector('[aria-label="Search pull requests"]') as HTMLInputElement,
    "is:open review-requested:@me",
  );
  await act(async () => vi.advanceTimersByTime(350));
  expect(preferences.filters.text).toBe("is:open review-requested:@me");
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
  expect(
    (container.querySelector('[aria-label="Search pull requests"]') as HTMLInputElement).value,
  ).toBe("is:open review-requested:@me");
});
it("saves a new tab into the shared view store and selects it", async () => {
  await mount();
  await act(async () => button("New saved view").click());
  await type(
    document.querySelector('[role="dialog"] input') as HTMLInputElement,
    "My review queue",
  );
  await act(async () => button("Save view").click());
  expect(preferences.views.at(-1)?.name).toBe("My review queue");
  expect(preferences.selectedViewID).toBe(preferences.views.at(-1)?.id);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain("My review queue");
});

it("loads file previews and discards pagination from an older revision", async () => {
  const identity = { account: "reviewer", hostname: "github.com" };
  const file = {
    filename: "first.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "+new",
  };
  let finishOldPage: ((value: GitHubWorkspaceResult) => void) | undefined;
  const run = vi.fn(async (input: GitHubWorkspaceInput): Promise<GitHubWorkspaceResult> => {
    if (input.action === "detail")
      return {
        kind: "detail",
        ...identity,
        detail: {
          id: request.id,
          body: "Description",
          headRefName: "feature",
          baseRefName: "main",
          headRefOid: "abcdef",
          state: "OPEN",
          isDraft: false,
          author: { login: "alex" },
          mergeable: "MERGEABLE",
          reviews: { nodes: [] },
          comments: { nodes: [] },
        },
      };
    if (input.action === "files") {
      if (input.page === 2)
        return new Promise((resolve) => {
          finishOldPage = resolve;
        });
      return {
        kind: "files",
        ...identity,
        files: Array.from({ length: 100 }, (_, i) => ({ ...file, filename: `file-${i}.ts` })),
      };
    }
    throw new Error("Unexpected inspector request");
  });
  const render = (refreshToken: number) => (
    <GitHubPullRequestInspector
      request={request}
      identity={identity}
      run={run}
      onClose={() => {}}
      onReviewed={() => {}}
      refreshToken={refreshToken}
    />
  );
  await act(async () => root.render(render(0)));
  await act(async () => button("Files (1)").click());
  expect(container.textContent).toContain("file-0.ts");
  expect(container.textContent).not.toContain("Loading files…");
  await act(async () => button("Load more files").click());
  await act(async () => root.render(render(1)));
  await act(async () =>
    finishOldPage!({ kind: "files", ...identity, files: [{ ...file, filename: "stale.ts" }] }),
  );
  expect(container.textContent).not.toContain("stale.ts");
  expect(container.textContent).toContain("file-0.ts");
});

it("waits for the execution computer before restoring account views", async () => {
  boundary.phase = "connecting";
  await mount();
  expect(boundary.command).not.toHaveBeenCalled();
  boundary.phase = "connected";
  await mount();
  expect(container.textContent).toContain("Repair login");
  expect(container.textContent).toContain("Bug reviews");
});

it("keeps a newly saved view selected when an older query write is queued", async () => {
  await mount();
  const original = boundary.command.getMockImplementation()!;
  let finishSave!: () => void;
  const pendingSave = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  boundary.command.mockImplementation(async (target) => {
    if (target.input.action === "upsert") await pendingSave;
    return original(target);
  });
  await type(
    container.querySelector('[aria-label="Search pull requests"]') as HTMLInputElement,
    "is:open label:urgent",
  );
  await act(async () => button("New saved view").click());
  await type(document.querySelector('[role="dialog"] input') as HTMLInputElement, "Urgent reviews");
  await act(async () => button("Save view").click());
  await act(async () => vi.advanceTimersByTime(350));
  await act(async () => finishSave());
  await act(async () => vi.advanceTimersByTime(350));
  expect(preferences.selectedViewID).toBe(preferences.views.at(-1)?.id);
  expect(preferences.filters.text).toBe("is:open label:urgent");
  expect(button("Urgent reviews").getAttribute("aria-current")).toBe("page");
});
