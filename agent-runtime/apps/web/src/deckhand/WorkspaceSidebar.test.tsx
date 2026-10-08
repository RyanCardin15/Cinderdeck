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
  contextMenu: vi.fn(),
  submit: vi.fn(),
  inspect: vi.fn(),
  recent: vi.fn(),
  uuid: vi.fn(),
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({ contextMenu: { show: boundary.contextMenu } }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: "submit" | "inspect" | "recent") => boundary[command],
}));
vi.mock("../lib/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/runtime")>();
  return { ...actual, runtime: { ...actual.runtime, runPromise: boundary.uuid } };
});
vi.mock("./SessionLauncher", () => ({
  SessionLauncher: (props: { onOpened: () => void }) => {
    boundary.launcher(props);
    return <button onClick={props.onOpened}>Finish opening session</button>;
  },
}));
vi.mock("../components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
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
  submitOperation: "submit",
  inspectOperation: "inspect",
  recentOperations: "recent",
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
import { WorkspaceBranchesButton, WorkspaceDeleteButton } from "./WorkspaceSettingsButton";
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
it("opens deletion confirmation for the exact local workspace and suppresses repeat requests", async () => {
  let finish!: (accepted: boolean) => void;
  const openNativeTool = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { isNativeHost: () => true, openNativeTool },
  });
  try {
    const renderDelete = (computer: string, enabled: boolean) =>
      act(async () =>
        root.render(
          <WorkspaceDeleteButton
            environmentId={computer}
            workspaceID="beta"
            label="Delete workspace beta"
            enabled={enabled}
            showLabel
          />,
        ),
      );
    await renderDelete(environmentId, true);
    await act(async () => {
      button("Delete workspace beta").click();
      button("Delete workspace beta").click();
    });
    expect(openNativeTool).toHaveBeenCalledTimes(1);
    expect(openNativeTool).toHaveBeenCalledWith({
      surface: "workspace-editor",
      workspaceID: "beta",
      mode: "delete",
    });
    expect(button("Delete workspace beta").disabled).toBe(true);
    await act(async () => finish(true));
    expect(button("Delete workspace beta").disabled).toBe(false);
    await renderDelete(environmentId, false);
    button("Delete workspace beta").click();
    await renderDelete("remote", true);
    button("Delete workspace beta").click();
    expect(button("Delete workspace beta").disabled).toBe(true);
    expect(openNativeTool).toHaveBeenCalledTimes(1);
  } finally {
    delete window.desktopBridge;
  }
});

it("header deletion targets the primary workspace and never deletes a source from its lane header", async () => {
  const openNativeTool = vi.fn(async () => true);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { isNativeHost: () => true, openNativeTool },
  });
  try {
    const renderTools = (workspaceID: string) =>
      act(async () =>
        root.render(
          <NativeWorkspaceTools
            environmentId={environmentId}
            workspaceID={workspaceID}
            sourceWorkspaceID="alpha"
            enabled
            header
          />,
        ),
      );
    await renderTools("alpha");
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((item) => item.textContent?.includes("Delete workspace"))!
        .click(),
    );
    expect(openNativeTool).toHaveBeenCalledWith({
      surface: "workspace-editor",
      workspaceID: "alpha",
      mode: "delete",
    });
    await renderTools("lane-a");
    expect(
      [...container.querySelectorAll("button")].some((item) =>
        item.textContent?.includes("Delete workspace"),
      ),
    ).toBe(false);
  } finally {
    delete window.desktopBridge;
  }
});
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  boundary.navigate.mockClear();
  boundary.launcher.mockClear();
  boundary.contextMenu.mockReset().mockResolvedValue("delete-lane");
  boundary.uuid.mockReset().mockResolvedValue("delete-key");
  boundary.recent.mockReset().mockResolvedValue({ _tag: "Success", value: [] });
  boundary.inspect.mockReset().mockResolvedValue({ _tag: "Failure" });
  boundary.submit.mockReset().mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: {
      id: "receipt",
      operationKey: input.operationKey,
      argumentHash: "a".repeat(64),
      workspaceID: input.workspaceID,
      generation: input.generation,
      method: input.method,
      state: "succeeded",
      createdAt: view.observedAt,
      updatedAt: view.observedAt,
      result: { released: input.workspaceID },
    },
  }));
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

const removalCapabilities = [
  "operations.receipts",
  "operations.lane.release",
  "operations.lane.remove",
];
const rightClickLane = async (id: string) =>
  act(async () => {
    container.querySelector(`[data-workspace-id="${id}"] a`)!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 24,
        clientY: 48,
      }),
    );
  });
const clickText = async (text: string) =>
  act(async () => {
    [...container.querySelectorAll("button")].find((item) => item.textContent === text)!.click();
  });

it.each([false, true])(
  "right-click deletes the clicked remote lane even when broken=%s without selecting it",
  async (broken) => {
    const rows = resources.map((row) =>
      broken && row.workspaceID === "lane-b"
        ? {
            ...row,
            available: false,
            workspace: {
              ...row.workspace!,
              definitionChanged: true,
              issues: ["Lane creation did not finish"],
            },
          }
        : row,
    );
    registry.set(
      native,
      AsyncResult.success({
        ...view,
        resources: rows,
        hello: { ...view.hello!, capabilities: removalCapabilities },
      }),
    );
    localStorage.setItem(
      sidebarPreferenceKey(EnvironmentId.make("remote"), "install"),
      JSON.stringify({
        favorites: ["lane-a", "lane-b"],
        order: { "lanes:alpha": ["lane-b", "lane-a"] },
        expanded: { alpha: true },
        colors: { "lane-a": "#579de5", "lane-b": "#e47880" },
      }),
    );
    await render({ workspace: "beta", context: "beta" }, rows, EnvironmentId.make("remote"));
    await rightClickLane("lane-b");
    expect(boundary.contextMenu).toHaveBeenCalledWith(
      [
        { id: "highlight-color", label: "Highlight color…", icon: "palette" },
        {
          id: "delete-lane",
          label: "Delete lane…",
          destructive: true,
          icon: "trash",
          separatorBefore: true,
          disabled: false,
        },
      ],
      { x: 24, y: 48 },
    );
    expect(container.textContent).toContain("Remove lane “lane-b”?");
    expect(boundary.submit).not.toHaveBeenCalled();
    expect(boundary.navigate).not.toHaveBeenCalled();
    await clickText("Remove lane");
    expect(boundary.submit).toHaveBeenCalledTimes(1);
    expect(boundary.submit).toHaveBeenCalledWith({
      environmentId: "remote",
      input: {
        operationKey: "delete-key",
        installationID: "install",
        workspaceID: "lane-b",
        generation: 3,
        revision: "revision",
        method: "lane.release",
        arguments: { workspace: "lane-b" },
      },
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(boundary.navigate).not.toHaveBeenCalled();
    expect(
      readSidebarPreferences(sidebarPreferenceKey(EnvironmentId.make("remote"), "install"))
        .favorites,
    ).toEqual(["lane-a"]);
    expect(
      readSidebarPreferences(sidebarPreferenceKey(EnvironmentId.make("remote"), "install")).colors,
    ).toEqual({ "lane-a": "#579de5" });
  },
);

it("returns to the source workspace only after the selected lane was removed", async () => {
  registry.set(
    native,
    AsyncResult.success({ ...view, hello: { ...view.hello!, capabilities: removalCapabilities } }),
  );
  await render({ workspace: "alpha", context: "lane-a", tab: "services" });
  await act(async () => button("Expand lanes for alpha").click());
  await rightClickLane("lane-a");
  expect(boundary.navigate).not.toHaveBeenCalled();
  await clickText("Remove lane");
  expect(boundary.navigate).toHaveBeenCalledWith({
    to: "/workspaces",
    search: {
      environment: environmentId,
      expectedInstallationID: "install",
      expectedGeneration: 3,
      workspace: "alpha",
      context: "alpha",
      tab: "services",
    },
  });
});

it("cancel sends no deletion and a lost reply keeps the saved lane request available", async () => {
  registry.set(
    native,
    AsyncResult.success({ ...view, hello: { ...view.hello!, capabilities: removalCapabilities } }),
  );
  await render();
  await act(async () => button("Expand lanes for alpha").click());
  await rightClickLane("lane-b");
  await clickText("Cancel");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(boundary.submit).not.toHaveBeenCalled();
  await rightClickLane("lane-b");
  boundary.submit.mockResolvedValue({ _tag: "Failure" });
  await clickText("Remove lane");
  expect(container.textContent).toContain("Lane removal outcome unknown");
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(boundary.navigate).not.toHaveBeenCalled();
  expect(boundary.submit).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(localStorage.getItem('deckhand.lane-lifecycle:["computer","install","lane-b"]')!)
      .input.workspaceID,
  ).toBe("lane-b");
});

it("blocks deletion on stale connections but permits changed lanes and never offers it on a source row", async () => {
  await render();
  await act(async () => button("Expand lanes for alpha").click());
  await rightClickLane("lane-a");
  expect(boundary.contextMenu.mock.lastCall?.[0][1].disabled).toBe(true);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () =>
    registry.set(
      native,
      AsyncResult.success({
        ...view,
        state: "unavailable",
        hello: { ...view.hello!, capabilities: removalCapabilities },
      }),
    ),
  );
  await rightClickLane("lane-a");
  expect(boundary.contextMenu.mock.lastCall?.[0][1].disabled).toBe(true);
  await act(async () =>
    registry.set(
      native,
      AsyncResult.success({
        ...view,
        hello: { ...view.hello!, capabilities: removalCapabilities },
        resources: [
          alpha,
          { ...laneA, workspace: { ...laneA.workspace!, definitionChanged: true } },
        ],
      }),
    ),
  );
  await rightClickLane("lane-a");
  expect(boundary.contextMenu.mock.lastCall?.[0][1].disabled).toBe(false);
  await clickText("Cancel");
  await rightClickLane("alpha");
  expect(boundary.contextMenu.mock.lastCall?.[0]).toEqual([
    { id: "highlight-color", label: "Highlight color…", icon: "palette" },
  ]);
  expect(boundary.submit).not.toHaveBeenCalled();
});

const highlightedRow = (id: string) =>
  container.querySelector<HTMLDivElement>(`[data-workspace-id="${id}"] [data-highlighted]`)!;
const chooseColor = async (name: string) =>
  act(async () => {
    document.body.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!.click();
  });

it("colors the clicked workspace and lane independently, persists on remount, and resets one row", async () => {
  boundary.contextMenu.mockResolvedValue("highlight-color");
  await render({ workspace: "beta", context: "beta" });
  await act(async () => button("Expand lanes for alpha").click());
  await act(async () => button("Favorite alpha").click());
  await rightClickLane("alpha");
  await chooseColor("Blue");
  await rightClickLane("lane-b");
  await chooseColor("Rose");
  expect(readSidebarPreferences(key).colors).toEqual({ alpha: "#579de5", "lane-b": "#e47880" });
  expect(highlightedRow("alpha").style.getPropertyValue("--sidebar-accent")).toBe("#579de5");
  expect(highlightedRow("lane-b").style.getPropertyValue("--sidebar-accent")).toBe("#e47880");
  expect(highlightedRow("lane-a").dataset.highlighted).toBe("false");
  expect(boundary.navigate).not.toHaveBeenCalled();
  expect(boundary.submit).not.toHaveBeenCalled();

  await act(async () => root.render(null));
  await render();
  expect(highlightedRow("lane-b").style.getPropertyValue("--sidebar-accent")).toBe("#e47880");
  await rightClickLane("lane-b");
  await act(async () => {
    [...document.body.querySelectorAll("button")]
      .find((item) => item.textContent === "Use default")!
      .click();
  });
  expect(readSidebarPreferences(key).colors).toEqual({ alpha: "#579de5" });
  expect(readSidebarPreferences(key).favorites).toEqual(["alpha"]);
  expect(readSidebarPreferences(key).expanded.alpha).toBe(true);
  expect(highlightedRow("lane-b").style.getPropertyValue("--sidebar-accent")).toBe("");

  await render(undefined, resources, EnvironmentId.make("remote"));
  expect(highlightedRow("alpha").dataset.highlighted).toBe("false");
  await render();
  expect(highlightedRow("alpha").style.getPropertyValue("--sidebar-accent")).toBe("#579de5");
});

it("opens colors from the keyboard while offline and saves a custom color without navigation", async () => {
  boundary.contextMenu.mockResolvedValue("highlight-color");
  registry.set(native, AsyncResult.success({ ...view, state: "unavailable" }));
  await render();
  await act(async () => {
    container.querySelector('[data-workspace-id="beta"] a')!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  const input = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="Custom highlight color for beta"]',
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "#123456",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(readSidebarPreferences(key).colors).toEqual({ beta: "#123456" });
  expect(boundary.navigate).not.toHaveBeenCalled();
  expect(boundary.submit).not.toHaveBeenCalled();
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect(document.body.querySelector('input[type="color"]')).toBeNull();
  expect(readSidebarPreferences(key).colors.beta).toBe("#123456");
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

it("shows a separate lane plus for empty and populated workspace dropdowns", async () => {
  const openNativeTool = vi.fn(async () => true);
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { isNativeHost: () => true, openNativeTool },
  });
  try {
    const emptyBetaRows = resources.filter((row) => row.workspaceID !== "lane-c");
    registry.set(
      native,
      AsyncResult.success({
        ...view,
        resources: emptyBetaRows,
        hello: { ...view.hello!, capabilities: ["operations.lane.create"] },
      }),
    );
    await render(undefined, emptyBetaRows);
    await act(async () => button("Expand lanes for beta").click());
    expect(container.textContent).toContain("No lanes");
    await act(async () => button("Create lane in beta").click());
    expect(openNativeTool).toHaveBeenLastCalledWith({
      surface: "workspace-lane-create",
      workspaceID: "beta",
    });
    await act(async () => button("Expand lanes for alpha").click());
    expect(button("Create lane in alpha").disabled).toBe(false);
    await act(async () => button("Create lane in alpha").click());
    expect(openNativeTool).toHaveBeenLastCalledWith({
      surface: "workspace-lane-create",
      workspaceID: "alpha",
    });
  } finally {
    delete window.desktopBridge;
  }
});
