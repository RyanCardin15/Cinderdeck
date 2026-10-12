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
  projects: [] as { environmentId: string; id: string; workspaceRoot: string }[],
  threads: [] as { environmentId: string; id: string; projectId: string }[],
}));
vi.mock("../state/entities", () => ({
  useProjects: () => boundary.projects,
  useThreadShells: () => boundary.threads,
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
  useParams: () => ({ threadId: "current" }),
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
vi.mock("./WorkspaceSessions", () => ({
  WorkspaceSessions: ({ resource }: { resource: { workspaceID: string } }) => (
    <div data-session-workspace={resource.workspaceID}>
      <a href={`/session/${resource.workspaceID}`}>Session in {resource.workspaceID}</a>
    </div>
  ),
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
  boundary.projects = [];
  boundary.threads = [];
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

it("keeps controls usable for this session when preference storage is unavailable", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage disabled");
  });
  await render();
  await act(async () => button("Favorite beta").click());
  expect(button("Unfavorite beta").getAttribute("aria-pressed")).toBe("true");
  await act(async () => button("Expand sessions for beta").click());
  expect(button("Collapse sessions for beta").getAttribute("aria-expanded")).toBe("true");
  expect(button("Unfavorite beta").getAttribute("aria-pressed")).toBe("true");
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

it("shows sessions directly under each workspace and never renders lane rows or creation controls", async () => {
  await render();
  expect(container.querySelector('[data-session-workspace="alpha"]')).not.toBeNull();
  expect(container.querySelector('[data-workspace-id="lane-a"]')).toBeNull();
  expect(container.querySelector('[aria-label="Create lane in alpha"]')).toBeNull();
  await act(async () => button("Expand sessions for beta").click());
  expect(container.querySelector('[data-session-workspace="beta"]')).not.toBeNull();
  await act(async () => button("Collapse sessions for alpha").click());
  expect(container.querySelector('[data-session-workspace="alpha"]')).toBeNull();
  expect(container.querySelector('[data-session-workspace="beta"]')).not.toBeNull();
});
it("expands and highlights an ordinary session's workspace without a native binding", async () => {
  boundary.projects = [{ environmentId, id: "ordinary-project", workspaceRoot: "/fixture/beta/" }];
  boundary.threads = [{ environmentId, id: "current", projectId: "ordinary-project" }];
  await render({});
  expect(button("Collapse sessions for beta").getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector('[data-workspace-id="beta"] [data-current="true"]')).not.toBeNull();
  expect(container.querySelector('[data-session-workspace="beta"]')).not.toBeNull();
});
it("preserves workspace order, favorites and collapsed sessions across remounts", async () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      order: { workspaces: ["beta", "alpha"] },
      favorites: ["alpha"],
      expanded: { alpha: false, beta: true },
    }),
  );
  await render();
  expect(workspaceIDs()).toEqual(["beta", "alpha"]);
  expect(button("Unfavorite alpha").getAttribute("aria-pressed")).toBe("true");
  expect(container.querySelector('[data-session-workspace="alpha"]')).toBeNull();
  await act(async () => root.render(null));
  await render();
  expect(button("Expand sessions for alpha").getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector('[data-session-workspace="beta"]')).not.toBeNull();
});
it("opens a new session in the clicked workspace without changing another row's selection", async () => {
  await render();
  await act(async () => button("New session in beta").click());
  expect(boundary.launcher).toHaveBeenCalledWith(
    expect.objectContaining({ resource: beta, autoOpen: true }),
  );
  expect(boundary.navigate).not.toHaveBeenCalled();
  expect(container.querySelector('[data-session-workspace="beta"]')).toBeNull();
});
