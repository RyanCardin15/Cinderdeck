// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView, ManagedContextView } from "@cinderdeck/contracts/deckhand/rpc";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { WorkspaceSearch } from "./workspaceNavigation";
import { readSidebarPreferences, sidebarPreferenceKey } from "./workspaceSidebarPreferences";

const boundary = vi.hoisted(() => ({
  navigate: vi.fn(),
  requests: [] as string[],
  pages: [] as { workspace: string; offset: number }[],
  launcher: vi.fn(),
}));
vi.mock("./SessionLauncher", () => ({
  SessionLauncher: (props: { onOpened: () => void }) => {
    boundary.launcher(props);
    return <button onClick={props.onOpened}>Finish opening session</button>;
  },
}));
vi.mock("../components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => boundary.navigate,
  Link: ({ search, children, ...props }: { search: WorkspaceSearch; children: ReactNode }) => (
    <a
      {...props}
      href="/workspaces"
      onClick={(event) => {
        event.preventDefault();
        boundary.navigate(search);
      }}
    >
      {children}
    </a>
  ),
}));
const native = Atom.make<AsyncResult.AsyncResult<IntegrationView, Error>>(AsyncResult.initial());
const activity = Atom.make<AsyncResult.AsyncResult<readonly ManagedContextView[], Error>>(
  AsyncResult.initial(),
);
const scopedAtoms = new Map<string, typeof native>();
vi.mock("./state", () => ({
  managedContextsView: () => activity,
  workspaceView: ({
    input,
  }: {
    input: { selectedWorkspaceID?: string; workspacePage?: { offset: number } };
  }) => {
    if (input.selectedWorkspaceID) {
      boundary.requests.push(input.selectedWorkspaceID);
      boundary.pages.push({
        workspace: input.selectedWorkspaceID,
        offset: input.workspacePage?.offset ?? 0,
      });
    }
    return scopedAtoms.get(input.selectedWorkspaceID ?? "") ?? native;
  },
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: "connected" } }),
  useEnvironments: () => ({ environments: [{ environmentId: "computer" }] }),
  usePrimaryEnvironmentId: () => "computer",
}));
import { NativeWorkspaceTools } from "./NativeWorkspaceTools";
import { WorkspaceBranchesButton } from "./WorkspaceSettingsButton";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { ProductWorkspaces } from "./ProductWorkspaces";
type Resource = IntegrationView["resources"][number];
const resource = (id: string, source?: string): Resource => ({
  workspaceID: id,
  generation: 3,
  revision: "revision",
  available: true,
  workspace: {
    id,
    name: id,
    file: `/fixture/${id}`,
    state: "ready",
    definitionChanged: false,
    issues: [],
    services: [],
    repos: [
      {
        id: "app",
        path: `/fixture/${id}`,
        branch: "main",
        dirty: false,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      },
    ],
    ...(source
      ? {
          lane: {
            name: id,
            sourceStackID: source,
            directory: `/fixture/${id}`,
            createdAt: "2026-10-05T00:00:00Z",
            ports: {},
          },
        }
      : {}),
  },
});
const alpha = resource("alpha");
const beta = resource("beta");
const laneA = resource("lane-a", "alpha");
const laneB = resource("lane-b", "alpha");
const laneC = resource("lane-c", "beta");
const resources = [alpha, beta, laneA, laneB, laneC];
const view: IntegrationView = {
  state: "connected",
  observedAt: "2026-10-05T00:00:00Z",
  error: null,
  hello: {
    protocolVersion: 1,
    installationID: "install",
    executionHostID: "host",
    channel: "development",
    runtimeEpoch: "epoch",
    capabilities: [],
    maximumFrameBytes: 4194304,
    maximumPageSize: 100,
    maximumWaitMs: 30000,
  },
  resources,
  activity: [],
  total: 5,
  nextOffset: null,
};
const environmentId = EnvironmentId.make("computer");
const key = sidebarPreferenceKey(environmentId, "install");
let container: HTMLDivElement;
let root: Root;
let registry: AtomRegistry.AtomRegistry;
const render = async (
  search: WorkspaceSearch = { workspace: "alpha", context: "alpha" },
  rows = resources,
  executionEnvironment = environmentId,
) =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <WorkspaceSidebar
          environmentId={executionEnvironment}
          installationID="install"
          resources={rows}
          search={{ environment: environmentId, expectedInstallationID: "install", ...search }}
        />
      </RegistryContext.Provider>,
    ),
  );
const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const workspaceIDs = () =>
  [...container.querySelectorAll("nav > [data-workspace-id]")].map((row) =>
    row.getAttribute("data-workspace-id"),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  boundary.navigate.mockClear();
  boundary.launcher.mockClear();
  boundary.requests = [];
  boundary.pages = [];
  scopedAtoms.clear();
  localStorage.clear();
  registry = AtomRegistry.make();
  registry.mount(native);
  registry.set(native, AsyncResult.success(view));
  registry.mount(activity);
  registry.set(activity, AsyncResult.success([]));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("selects in place and expands multiple workspaces independently without reopening a collapsed selection", async () => {
  await render();
  expect(workspaceIDs()).toEqual(["alpha", "beta"]);
  await act(async () => {
    button("Expand lanes for alpha").click();
  });
  await act(async () => {
    button("Expand lanes for beta").click();
  });
  expect(container.textContent).toContain("lane-a");
  expect(container.textContent).toContain("lane-c");
  expect(boundary.requests).toContain("beta");
  await act(async () => {
    button("Collapse lanes for alpha").click();
  });
  await render({ workspace: "beta", context: "lane-c", tab: "agents" }, [
    beta,
    laneC,
    alpha,
    laneA,
    laneB,
  ]);
  expect(workspaceIDs()).toEqual(["alpha", "beta"]);
  expect(button("Expand lanes for alpha").getAttribute("aria-expanded")).toBe("false");
  expect(container.textContent).not.toContain("lane-a");
  expect(container.textContent).toContain("lane-c");
  await act(async () => {
    container.querySelector<HTMLAnchorElement>('[data-workspace-id="alpha"] a')!.click();
  });
  expect(boundary.navigate).toHaveBeenCalledWith({
    environment: environmentId,
    workspace: "alpha",
    context: "alpha",
    tab: "agents",
    expectedInstallationID: "install",
    expectedGeneration: 3,
  });
  expect(workspaceIDs()).toEqual(["alpha", "beta"]);
});

it("identifies a scheduled reviewer before agent status exists and retains it when selected or offline", async () => {
  const reviewer = resource("review/0123456789abcdef01234567", "alpha");
  const ordinary = resource("review/payments", "alpha");
  const rows = [alpha, reviewer, ordinary];
  registry.set(native, AsyncResult.success({ ...view, resources: rows }));
  await render({ workspace: "alpha", context: reviewer.workspaceID }, rows);
  await act(async () => button("Expand lanes for alpha").click());
  const reviewerRow = () =>
    container.querySelector(`[data-workspace-id="${reviewer.workspaceID}"] [data-reviewer]`)!;
  expect(reviewerRow().getAttribute("data-reviewer")).toBe("true");
  expect(reviewerRow().getAttribute("data-current")).toBe("true");
  expect(reviewerRow().textContent).toContain("Reviewer");
  expect(
    container
      .querySelector('[data-workspace-id="review/payments"] [data-reviewer]')
      ?.getAttribute("data-reviewer"),
  ).toBe("false");
  await act(async () =>
    registry.set(native, AsyncResult.failure(Cause.fail(new Error("Offline")))),
  );
  expect(reviewerRow().getAttribute("data-reviewer")).toBe("true");
  expect(reviewerRow().textContent).toContain("Reviewer");
  expect(button(`New session in ${reviewer.workspaceID}`).disabled).toBe(true);
});

it("retains favorites, manual order, and collapse state after remount without moving a favorite", async () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      order: { workspaces: ["beta", "alpha"], "lanes:alpha": ["lane-b", "lane-a"] },
      favorites: [],
      expanded: { alpha: true, beta: false },
    }),
  );
  await render();
  expect(workspaceIDs()).toEqual(["beta", "alpha"]);
  const laneIDs = [
    ...container.querySelectorAll('[data-workspace-id="alpha"] [data-workspace-id]'),
  ].map((row) => row.getAttribute("data-workspace-id"));
  expect(laneIDs).toEqual(["lane-b", "lane-a"]);
  await act(async () => {
    button("Favorite alpha").click();
  });
  await act(async () => {
    button("Favorite lane-b").click();
  });
  expect(workspaceIDs()).toEqual(["beta", "alpha"]);
  await act(async () => root.render(null));
  await render({ workspace: "beta", context: "beta" });
  expect(button("Unfavorite alpha").getAttribute("aria-pressed")).toBe("true");
  expect(button("Unfavorite lane-b").getAttribute("aria-pressed")).toBe("true");
  expect(button("Expand lanes for beta").getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    button("Unfavorite alpha").click();
  });
  expect(readSidebarPreferences(key).favorites).toEqual(["lane-b"]);
});

it("loads and pages an unselected workspace's lanes while retaining the selected off-page lane", async () => {
  const betaAtom = Atom.make<AsyncResult.AsyncResult<IntegrationView, Error>>(
    AsyncResult.initial(),
  );
  scopedAtoms.set("beta", betaAtom);
  registry.mount(betaAtom);
  registry.set(
    betaAtom,
    AsyncResult.success({
      ...view,
      resources: [alpha],
      workspaceContexts: {
        workspaceID: "beta",
        resources: [beta, laneC],
        total: 61,
        laneCount: 60,
        offset: 0,
        nextOffset: 50,
      },
    }),
  );
  await render({ workspace: "alpha", context: "alpha" }, [alpha, beta]);
  await act(async () => button("Expand lanes for beta").click());
  expect(container.querySelector('[data-workspace-id="beta"]')?.textContent).toContain("lane-c");
  expect(container.querySelector('[data-workspace-id="beta"]')?.textContent).not.toContain(
    "lane-a",
  );
  await act(async () => button("Next lanes for beta").click());
  expect(boundary.pages).toContainEqual({ workspace: "beta", offset: 50 });
  const laneD = resource("lane-d", "beta");
  await act(async () =>
    registry.set(
      betaAtom,
      AsyncResult.success({
        ...view,
        resources: [alpha],
        workspaceContexts: {
          workspaceID: "beta",
          resources: [laneD],
          total: 61,
          laneCount: 60,
          offset: 50,
          nextOffset: null,
        },
      }),
    ),
  );
  await render({ workspace: "beta", context: "lane-c" });
  expect(container.querySelector('[data-workspace-id="beta"]')?.textContent).toContain("lane-c");
  expect(container.querySelector('[data-workspace-id="beta"]')?.textContent).toContain("lane-d");
  expect(workspaceIDs()).toEqual(["alpha", "beta"]);
  expect(boundary.navigate).not.toHaveBeenCalled();
});

it("keeps controls usable for this session when preference storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage disabled");
  });
  await render();
  await act(async () => button("Favorite beta").click());
  expect(button("Unfavorite beta").getAttribute("aria-pressed")).toBe("true");
  await act(async () => button("Expand lanes for beta").click());
  expect(button("Collapse lanes for beta").getAttribute("aria-expanded")).toBe("true");
  expect(button("Unfavorite beta").getAttribute("aria-pressed")).toBe("true");
});

it("saves workspace and lane moves through the keyboard drag handles", async () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const row = this.closest("[data-workspace-id]");
    const peers = row?.parentElement?.querySelectorAll(":scope > [data-workspace-id]");
    const index = peers ? [...peers].indexOf(row!) : 0;
    const top = index * 40;
    return {
      x: 0,
      y: top,
      top,
      bottom: top + 36,
      left: 0,
      right: 240,
      width: 240,
      height: 36,
      toJSON: () => ({}),
    };
  });
  await render();
  const press = async (element: HTMLElement, code: string) =>
    act(async () => {
      element.dispatchEvent(
        new KeyboardEvent("keydown", { code, key: code === "Space" ? " " : code, bubbles: true }),
      );
    });
  const drag = button("Reorder alpha");
  drag.focus();
  await press(drag, "Space");
  await press(drag, "ArrowDown");
  await press(drag, "Space");
  expect(workspaceIDs()).toEqual(["beta", "alpha"]);
  await act(async () => {
    button("Expand lanes for alpha").click();
  });
  const laneDrag = button("Reorder lane-a");
  laneDrag.focus();
  await press(laneDrag, "Space");
  await press(laneDrag, "ArrowDown");
  await press(laneDrag, "Space");
  expect(readSidebarPreferences(key).order["lanes:alpha"]).toEqual(["lane-b", "lane-a"]);
  expect(boundary.navigate).not.toHaveBeenCalled();
});

it("offers the native workspace tree on app-wide views with exact checkout pins", async () => {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <ProductWorkspaces search={{ environment: "computer" }} />
      </RegistryContext.Provider>,
    ),
  );
  expect(workspaceIDs()).toEqual(["alpha", "beta"]);
  const link = [...container.querySelectorAll("a")].find((item) => item.textContent === "beta")!;
  await act(async () => link.click());
  expect(boundary.navigate).toHaveBeenLastCalledWith({
    environment: "computer",
    workspace: "beta",
    context: "beta",
    tab: "agents",
    expectedInstallationID: "install",
    expectedGeneration: 3,
  });
});

it("does not substitute the local catalog for an unavailable remote computer", async () => {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <ProductWorkspaces search={{ environment: "missing" }} />
      </RegistryContext.Provider>,
    ),
  );
  expect(container.textContent).toContain("Computer unavailable");
  expect(workspaceIDs()).toEqual([]);
});

it("opens sessions in the clicked workspace and lane without selecting or expanding another row", async () => {
  await render({ workspace: "beta", context: "beta", tab: "services" });
  expect(boundary.launcher).not.toHaveBeenCalled();
  await act(async () => button("New session in alpha").click());
  expect(boundary.launcher).toHaveBeenLastCalledWith(
    expect.objectContaining({
      environmentId,
      installationID: "install",
      resource: alpha,
      enabled: true,
      autoOpen: true,
    }),
  );
  expect(button("Expand lanes for alpha").getAttribute("aria-expanded")).toBe("false");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((item) => item.textContent === "Finish opening session")!
      .click(),
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => button("Expand lanes for alpha").click());
  await act(async () => button("New session in lane-b").click());
  expect(boundary.launcher).toHaveBeenLastCalledWith(
    expect.objectContaining({
      environmentId,
      installationID: "install",
      resource: laneB,
      enabled: true,
      autoOpen: true,
    }),
  );
  expect(boundary.navigate).not.toHaveBeenCalled();
  expect(readSidebarPreferences(key).favorites).toEqual([]);
});

it("prevents new sessions from stale catalogs and unavailable lanes while allowing changed service settings", async () => {
  await act(async () =>
    registry.set(native, AsyncResult.success({ ...view, state: "unavailable" })),
  );
  await render();
  expect(button("New session in alpha").disabled).toBe(true);
  await act(async () => button("New session in alpha").click());
  expect(boundary.launcher).not.toHaveBeenCalled();
  await act(async () =>
    registry.set(
      native,
      AsyncResult.success({
        ...view,
        resources: [
          alpha,
          { ...beta, workspace: { ...beta.workspace!, definitionChanged: true } },
          { ...laneA, available: false },
        ],
      }),
    ),
  );
  await render();
  expect(button("New session in alpha").disabled).toBe(false);
  expect(button("New session in beta").disabled).toBe(false);
  await act(async () => button("Expand lanes for alpha").click());
  expect(button("New session in lane-a").disabled).toBe(true);
});

it("opens exact workspace settings beside plus/star, and lane settings target their source", async () => {
  const openNativeTool = vi.fn(async () => true);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { isNativeHost: () => true, openNativeTool },
  });
  try {
    await render();
    await act(async () => {
      button("Workspace settings for beta").click();
    });
    expect(openNativeTool).toHaveBeenLastCalledWith({
      surface: "workspace-editor",
      workspaceID: "beta",
    });
    expect(boundary.launcher).not.toHaveBeenCalled();
    await act(async () => {
      button("Expand lanes for alpha").click();
    });
    await act(async () => {
      button("Source workspace settings for lane-a").click();
    });
    expect(openNativeTool).toHaveBeenLastCalledWith({
      surface: "workspace-editor",
      workspaceID: "alpha",
    });
    expect(readSidebarPreferences(key).favorites).toEqual([]);
  } finally {
    delete window.desktopBridge;
  }
});

it("does not send remote workspace settings to the local native host", async () => {
  const openNativeTool = vi.fn(async () => true);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { isNativeHost: () => true, openNativeTool },
  });
  try {
    await render({ workspace: "alpha" }, resources, EnvironmentId.make("remote"));
    expect(button("Workspace settings for alpha").disabled).toBe(true);
    button("Workspace settings for alpha").click();
    expect(openNativeTool).not.toHaveBeenCalled();
  } finally {
    delete window.desktopBridge;
  }
});

it("branch shortcut opens the exact lane picker and does not select its source checkout", async () => {
  const openNativeTool = vi.fn(async () => true);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { isNativeHost: () => true, openNativeTool },
  });
  try {
    await act(async () =>
      root.render(
        <WorkspaceBranchesButton
          environmentId={environmentId}
          workspaceID="lane-a"
          label="Switch branch in lane-a"
          enabled
          showLabel
        />,
      ),
    );
    await act(async () => button("Switch branch in lane-a").click());
    expect(openNativeTool).toHaveBeenCalledExactlyOnceWith({
      surface: "workspace-branches",
      workspaceID: "lane-a",
    });
  } finally {
    delete window.desktopBridge;
  }
});

it("workspace header tools also refuse remote IDs instead of opening a local workspace", async () => {
  const openNativeTool = vi.fn(async () => true);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { isNativeHost: () => true, openNativeTool },
  });
  try {
    await act(async () =>
      root.render(
        <NativeWorkspaceTools
          environmentId={EnvironmentId.make("remote")}
          workspaceID="alpha"
          sourceWorkspaceID="alpha"
          enabled
          header
        />,
      ),
    );
    expect(button("Workspace settings").disabled).toBe(true);
    const branchButton = [...container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Switch branch"),
    )!;
    expect(branchButton.disabled).toBe(true);
    await act(async () => {
      button("Workspace settings").click();
      branchButton.click();
    });
    expect(openNativeTool).not.toHaveBeenCalled();
  } finally {
    delete window.desktopBridge;
  }
});

it("shows workspace totals while collapsed, exact lane counts, and updates without showing stale counts", async () => {
  const summary = (workspaceID: string, running: number, review: number): ManagedContextView => ({
    workspaceID,
    generation: 3,
    total: running + review,
    sessions: [],
    agentActivity: { running, review, unavailable: false },
    workspaceAgentActivity: { running: 3, review: 2, unavailable: false },
  });
  await act(async () =>
    registry.set(
      activity,
      AsyncResult.success([
        summary("alpha", 1, 0),
        summary("lane-a", 2, 2),
        summary("lane-b", 0, 0),
      ]),
    ),
  );
  await render();
  expect(container.querySelector('[aria-label="alpha: 3 agents running"]')?.textContent).toBe("3");
  expect(container.querySelector('[aria-label="alpha: 2 agents need review"]')?.textContent).toBe(
    "2",
  );
  await act(async () => button("Expand lanes for alpha").click());
  expect(container.querySelector('[aria-label="lane-a: 2 agents running"]')?.textContent).toBe("2");
  expect(container.querySelector('[data-workspace-id="lane-b"] [aria-label*="review"]')).toBeNull();
  await act(async () =>
    registry.set(activity, AsyncResult.success([summary("alpha", 0, 0), summary("lane-a", 0, 1)])),
  );
  expect(container.querySelector('[aria-label="lane-a: 2 agents running"]')).toBeNull();
  expect(container.querySelector('[aria-label="lane-a: 1 agent needs review"]')).not.toBeNull();
  await act(async () =>
    registry.set(native, AsyncResult.success({ ...view, state: "unavailable" })),
  );
  expect(container.querySelector('[aria-label="alpha: 3 agents running"]')).toBeNull();
  expect(container.querySelector('[aria-label="lane-a: 1 agent needs review"]')).toBeNull();
});
