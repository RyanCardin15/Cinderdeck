// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@cinderdeck/contracts";
import type { IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
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
const scopedAtoms = new Map<string, typeof native>();
vi.mock("./state", () => ({
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
  useEnvironments: () => ({ environments: [{ environmentId: "computer" }] }),
  usePrimaryEnvironmentId: () => "computer",
}));
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
) =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <WorkspaceSidebar
          environmentId={environmentId}
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
  registry.set(native, AsyncResult.success(view));
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
    tab: "services",
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

it("prevents new sessions from stale catalogs, unavailable lanes, and changed definitions", async () => {
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
  expect(button("New session in beta").disabled).toBe(true);
  await act(async () => button("Expand lanes for alpha").click());
  expect(button("New session in lane-a").disabled).toBe(true);
});
