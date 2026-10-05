// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ProjectId, ThreadId } from "@cinderdeck/contracts";
import type {
  ContextPullRequestsPage,
  IntegrationView,
  ContextPullRequest,
} from "@cinderdeck/contracts/deckhand/rpc";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
const transport = vi.hoisted(() => ({
  phase: "connected",
  targets: [] as unknown[],
  navigate: vi.fn<(options: { search: unknown; replace?: boolean }) => Promise<void>>(),
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: transport.phase } }),
}));
vi.mock("../env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => transport.navigate,
  Link: ({ children, search }: { children: ReactNode; search: object }) => (
    <a href={JSON.stringify(search)}>{children}</a>
  ),
}));
vi.mock("../components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/ui/button", () => ({
  Button: ({ children, variant, size, ...props }: Record<string, unknown>) => {
    void variant;
    void size;
    return <button {...props}>{children as ReactNode}</button>;
  },
}));
vi.mock("../components/pullRequest/PullRequestDetailPanel", () => ({
  PullRequestDetailPanel: ({ reference }: { reference: object }) => (
    <div data-detail>{JSON.stringify(reference)}</div>
  ),
}));
vi.mock("../state/pullRequests", () => ({
  usePullRequestList: (targets: unknown[]) => {
    transport.targets = targets;
    return {
      data: {
        entries: [
          {
            host: "github.com",
            repository: "owner/app",
            number: 99,
            title: "Unrelated hosting row",
          },
        ],
      },
      error: null,
      refresh: vi.fn(),
    };
  },
}));
const native = Atom.make<AsyncResult.AsyncResult<IntegrationView, Error>>(AsyncResult.initial());
const pages = new Map<
  number,
  Atom.Writable<AsyncResult.AsyncResult<ContextPullRequestsPage, Error>>
>();
vi.mock("./state", () => ({ workspaceView: () => native }));
vi.mock("./contextPullRequestState", () => ({
  contextPullRequestsView: ({ input }: { input: { offset: number } }) => {
    if (!pages.has(input.offset))
      pages.set(
        input.offset,
        Atom.make<AsyncResult.AsyncResult<ContextPullRequestsPage, Error>>(AsyncResult.initial()),
      );
    return pages.get(input.offset)!;
  },
}));
import { ContextPullRequests } from "./ContextPullRequests";
import {
  connectedPullRequestSearch,
  type ConnectedPullRequestSearch,
} from "./contextPullRequestScope";
const scope = connectedPullRequestSearch(
  EnvironmentId.make("computer"),
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
      workspace: {
        name: "Workspace",
        issues: [],
        definitionChanged: false,
        lane: { name: "Feature lane", sourceStackID: "base" },
      },
    },
  ],
} as unknown as IntegrationView;
const item: ContextPullRequest = {
  projectId: ProjectId.make("api"),
  threadId: ThreadId.make("old-thread"),
  link: {
    host: "github.com",
    repository: "owner/app",
    number: 1,
    url: "https://github.com/owner/app/pull/1",
    source: "manual",
    linkedAt: "2026-10-04T00:00:00Z",
    snapshot: null,
    stack: null,
  },
};
const page: ContextPullRequestsPage = {
  installationID: "installation",
  workspaceID: "lane",
  generation: 7,
  items: [item],
  offset: 0,
  total: 51,
  nextOffset: 50,
};
let currentScope: ConnectedPullRequestSearch = scope;
let embedded = false;
const embeddedNavigation = vi.fn(async (next: ConnectedPullRequestSearch) => {
  currentScope = next;
  await render();
});
let root: Root;
let element: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
const render = () =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <ContextPullRequests
          scope={{ ...currentScope }}
          embedded={embedded}
          {...(embedded ? { onNavigate: embeddedNavigation } : {})}
        />
      </RegistryContext.Provider>,
    ),
  );
const ready = async () => {
  await render();
  await act(async () => {
    registry.set(native, AsyncResult.success(view));
    registry.set(pages.get(0)!, AsyncResult.success(page));
  });
};
const choose = () =>
  act(async () => (element.querySelector("button[aria-pressed]") as HTMLButtonElement).click());
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  transport.phase = "connected";
  transport.targets = [];
  currentScope = scope;
  embedded = false;
  embeddedNavigation.mockClear();
  transport.navigate.mockReset();
  transport.navigate.mockImplementation(async ({ search }) => {
    currentScope = search as ConnectedPullRequestSearch;
    await render();
  });
  pages.clear();
  registry = AtomRegistry.make();
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  registry.dispose();
});
it("shows only canonical linked rows and opens the existing detail view with exact host/project identity", async () => {
  await ready();
  expect(element.textContent).toContain("owner/app #1");
  expect(element.textContent).not.toContain("Unrelated hosting row");
  expect(transport.targets).toEqual([
    { environmentId: "computer", input: { projectIds: ["api"], state: "all", limit: 50 } },
  ]);
  await choose();
  expect(element.querySelector("[data-detail]")?.textContent).toContain('"projectId":"api"');
  expect(JSON.parse(element.querySelector("a")!.getAttribute("href")!)).toEqual({
    environment: "computer",
    workspace: "base",
    context: "lane",
    expectedInstallationID: "installation",
    expectedGeneration: 7,
    tab: "agents",
  });
});
it("keeps cached rows and detail fenced until both native scope and link metadata are fresh after reconnect", async () => {
  await ready();
  await choose();
  expect(element.querySelector("[data-detail]")).not.toBeNull();
  transport.phase = "reconnecting";
  await render();
  expect(element.querySelector("[data-detail]")).toBeNull();
  expect(transport.targets).toEqual([]);
  transport.phase = "connected";
  await render();
  expect(element.textContent).toContain("Context unavailable");
  await act(async () => registry.set(native, AsyncResult.success({ ...view })));
  expect(element.querySelector("[data-detail]")).toBeNull();
  await act(async () => registry.set(pages.get(0)!, AsyncResult.success({ ...page })));
  expect(element.querySelector("[data-detail]")).not.toBeNull();
});
it("pages old links without holding the previous page as current or issuing a global hosting query", async () => {
  await ready();
  await choose();
  const next = [...element.querySelectorAll("button")].find(
    (button) => button.textContent === "Next",
  )!;
  await act(async () => next.click());
  expect(pages.has(50)).toBe(true);
  expect(element.querySelector("[data-detail]")).toBeNull();
  expect(transport.targets).toEqual([]);
  await act(async () =>
    registry.set(
      pages.get(50)!,
      AsyncResult.success({
        ...page,
        offset: 50,
        nextOffset: null,
        items: [{ ...item, link: { ...item.link, number: 2 } }],
      }),
    ),
  );
  expect(element.textContent).toContain("owner/app #2");
  expect(element.textContent).not.toContain("owner/app #1");
});
it("restores the selected PR after leaving and returning to its saved URL, and refuses an unlinked canonical selection", async () => {
  await ready();
  await choose();
  const savedSearch = currentScope;
  expect(savedSearch).toMatchObject({
    selectedHost: "github.com",
    repository: "owner/app",
    number: 1,
    deckhandContext: "lane",
    deckhandGeneration: 7,
  });
  await act(async () => root.unmount());
  root = createRoot(element);
  await render();
  await act(async () => {
    registry.set(native, AsyncResult.success({ ...view }));
    registry.set(pages.get(0)!, AsyncResult.success({ ...page }));
  });
  expect(element.querySelector("[data-detail]")?.textContent).toContain('"number":1');
  currentScope = { ...savedSearch, selectedHost: "enterprise.example" };
  await render();
  expect(element.querySelector("[data-detail]")).toBeNull();
  expect(element.textContent).toContain("Saved pull request unavailable");
});
it("reports a replaced native generation explicitly and refuses cached metadata or global fallback", async () => {
  await ready();
  await choose();
  await act(async () => {
    registry.set(
      native,
      AsyncResult.success({
        ...view,
        selectedResources: [{ ...view.selectedResources![0]!, generation: 8 }],
      }),
    );
    registry.set(pages.get(0)!, AsyncResult.failure(Cause.fail(new Error("source_unavailable"))));
  });
  expect(element.textContent).toContain("Saved context changed");
  expect(element.querySelector("[data-detail]")).toBeNull();
  expect(transport.targets).toEqual([]);
});

it("opens and pages pull request details inside the workspace without navigating to the global page", async () => {
  embedded = true;
  await ready();
  expect(element.querySelector("a")).toBeNull();
  await choose();
  expect(element.querySelector("[data-detail]")?.textContent).toContain('"projectId":"api"');
  expect(embeddedNavigation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      selectedHost: "github.com",
      repository: "owner/app",
      number: 1,
      deckhandContext: "lane",
      deckhandGeneration: 7,
    }),
  );
  const next = [...element.querySelectorAll("button")].find(
    (button) => button.textContent === "Next",
  )!;
  await act(async () => next.click());
  expect(pages.has(50)).toBe(true);
  expect(element.querySelector("[data-detail]")).toBeNull();
  expect(transport.navigate).not.toHaveBeenCalled();
});
