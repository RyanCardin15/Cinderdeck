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

const boundary = vi.hoisted(() => ({
  search: {} as WorkspaceSearch,
  phase: "connected",
  navigate: vi.fn(),
  recent: vi.fn(),
  inspect: vi.fn(),
  recordings: vi.fn(),
  mutation: vi.fn(),
  nativeTool: vi.fn(async () => true),
}));
const environmentId = EnvironmentId.make("computer");
const environment = () => ({
  environmentId,
  label: "Execution computer",
  connection: { phase: boundary.phase },
});
vi.mock("../state/environments", () => ({
  useEnvironment: () => environment(),
  useEnvironments: () => ({ environments: [environment()] }),
  usePrimaryEnvironmentId: () => environmentId,
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => boundary.search,
  useNavigate: () => boundary.navigate,
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
    className?: string;
  }) => (
    <a
      {...props}
      href={`${to}${search ? `?${new URLSearchParams(Object.entries(search).map(([key, value]) => [key, String(value)]))}` : ""}`}
      onClick={(event) => {
        event.preventDefault();
        boundary.navigate({ to, search: search ?? {} });
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: vi.fn() } }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "recent"
      ? boundary.recent
      : command === "recordings"
        ? boundary.recordings
        : command === "inspect"
          ? boundary.inspect
          : boundary.mutation,
}));
const nativeAtom = Atom.make<AsyncResult.AsyncResult<IntegrationView, Error>>(
  AsyncResult.initial(),
);
const summaryAtom = Atom.make<AsyncResult.AsyncResult<ReadonlyArray<ManagedContextView>, Error>>(
  AsyncResult.initial(),
);
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()) };
});
vi.mock("./state", () => ({
  workspaceView: () => nativeAtom,
  managedContextsView: () => summaryAtom,
  refreshWorkspaces: "refresh",
  submitOperation: "submit",
  inspectOperation: "inspect",
  recentOperations: "recent",
}));
vi.mock("./recordingState", () => ({ recordingOverview: "recordings" }));
vi.mock("./RecordingThumbnail", () => ({ RecordingThumbnail: () => null }));
vi.mock("./ProductNavigation", () => ({
  ProductNavigation: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
}));
vi.mock("./WorkspaceSessions", () => ({
  WorkspaceSessions: ({ workspaceID, scope }: { workspaceID: string; scope?: string }) => (
    <p data-session-scope={scope}>Saved sessions</p>
  ),
}));
vi.mock("./useSessionActions", () => ({
  useSessionActions: () => ({ showMenu: vi.fn(), renameDialog: null }),
}));
vi.mock("./WorkspaceSidebar", () => ({ WorkspaceSidebar: () => <nav>Workspace tree</nav> }));
vi.mock("./NativeWorkspaceTools", () => ({ NativeWorkspaceTools: () => null }));
vi.mock("./SessionLauncher", () => ({
  SessionLauncher: ({ enabled, creation }: { enabled: boolean; creation?: unknown }) =>
    creation ? null : <button disabled={!enabled}>Launch selected agent</button>,
}));
vi.mock("./ServicesRuns", () => ({
  ServicesRuns: ({ context }: { context: { workspaceID: string } }) => (
    <p>services for {context.workspaceID}</p>
  ),
}));
vi.mock("./Recordings", () => ({
  Recordings: ({ context }: { context: { workspaceID: string } }) => (
    <p>recordings for {context.workspaceID}</p>
  ),
}));
vi.mock("./ContextPullRequests", () => ({
  ContextPullRequests: ({ scope }: { scope: { deckhandContext: string } }) => (
    <p>pull-requests for {scope.deckhandContext}</p>
  ),
}));
import { WorkspaceOverview } from "./WorkspaceOverview";

const resource = (id: string, source?: string): IntegrationView["resources"][number] => ({
  workspaceID: id,
  generation: source ? 7 : 3,
  revision: "source-revision",
  available: true,
  workspace: {
    id,
    name: id === "primary" ? "Project" : id === "other" ? "Other project" : "Retry lane",
    file: `/fixture/${id}.toml`,
    state: "ready",
    definitionChanged: false,
    issues: [],
    services:
      id === "other"
        ? []
        : [{ name: "web", phase: "stopped", status: "stopped", ready: false, dependsOn: [] }],
    repos: [
      {
        id: "app",
        path: `/fixture/${id}`,
        branch: source ? "fix/retry" : "main",
        dirty: false,
        changedFiles: 0,
        ahead: 0,
        behind: 0,
      },
    ],
    ...(source
      ? {
          lane: {
            sourceStackID: source,
            name: "Retry lane",
            directory: `/fixture/${id}`,
            createdAt: "2026-10-04T00:00:00Z",
            ports: {},
          },
        }
      : {}),
  },
});
const primary = resource("primary");
const lane = resource("lane", "primary");
const other = resource("other");
const view: IntegrationView = {
  state: "connected",
  hello: {
    protocolVersion: 1,
    installationID: "installation",
    executionHostID: "host",
    channel: "development",
    runtimeEpoch: "epoch",
    capabilities: [
      "operations.services",
      "operations.lane.create",
      "operations.lane.create.repositoryRefs",
      "operations.receipts.wait",
    ],
    maximumFrameBytes: 4194304,
    maximumPageSize: 100,
    maximumWaitMs: 30000,
  },
  observedAt: "2026-10-04T00:00:00Z",
  error: null,
  resources: [primary, lane, other],
  activity: [],
  total: 3,
  nextOffset: null,
};
const summaries: ReadonlyArray<ManagedContextView> = [primary, lane, other].map((item) => ({
  workspaceID: item.workspaceID,
  generation: item.generation,
  total: 0,
  sessions: [],
}));
let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
const render = async () =>
  act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <WorkspaceOverview />
      </RegistryContext.Provider>,
    ),
  );
const button = (name: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === name,
  );
  expect(found, name).toBeDefined();
  return found!;
};
const follow = async (name: string) => {
  const anchor = [...container.querySelectorAll("a")].find(
    (item) => item.textContent?.trim() === name,
  )!;
  expect(anchor, name).toBeDefined();
  const url = new URL(anchor.href, "http://test.local");
  await act(async () => anchor.click());
  return url;
};
const changeSelect = async (name: string, value: string) => {
  const control = [...container.querySelectorAll("label")]
    .find((item) => item.textContent?.trim().startsWith(name))!
    .querySelector("select")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(
      control,
      value,
    );
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { isNativeHost: () => true, openNativeTool: boundary.nativeTool },
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  boundary.search = {};
  boundary.phase = "connected";
  boundary.navigate.mockImplementation(async ({ search }: { search: WorkspaceSearch }) => {
    boundary.search = search;
  });
  boundary.recent.mockResolvedValue({ _tag: "Success", value: [] });
  boundary.recordings.mockResolvedValue({ _tag: "Success", value: [] });
  registry = AtomRegistry.make();
  registry.set(nativeAtom, AsyncResult.success(view));
  registry.set(summaryAtom, AsyncResult.success(summaries));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
  delete window.desktopBridge;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("opens a workspace's sessions directly without a checkout selector or lane actions", async () => {
  boundary.search = { workspace: "primary", tab: "agents" };
  await render();
  expect(container.textContent).toContain("Project");
  expect(container.textContent).toContain("Saved sessions");
  expect(container.textContent).not.toContain("Lane map");
  expect(container.textContent).not.toContain("New feature");
  expect(container.querySelectorAll("select")).toHaveLength(0);
});
it("resolves an old checkout link to the owning workspace's session list", async () => {
  boundary.search = { context: "lane", tab: "lane-map" };
  await render();
  expect(container.querySelector("h1")?.textContent).toBe("Project");
  expect(container.textContent).toContain("Saved sessions");
  expect(container.textContent).not.toContain("Retry lane");
});
it("retains saved sessions through native connection loss without enabling new native actions", async () => {
  boundary.search = { workspace: "primary", tab: "agents" };
  await render();
  await act(async () =>
    registry.set(nativeAtom, AsyncResult.success({ ...view, state: "unavailable" })),
  );
  expect(container.textContent).toContain("Saved sessions");
  expect(button("Launch selected agent").disabled).toBe(true);
  expect(container.textContent).toContain("Your saved sessions remain accessible");
});
it("keeps workspace services, tasks and recordings in their selected workspace", async () => {
  for (const tab of ["services", "tasks", "recordings"] as const) {
    boundary.search = { workspace: "primary", tab };
    await render();
    expect(container.textContent).toContain(`${tab === "tasks" ? "services" : tab} for primary`);
  }
});
it("shows a missing workspace without silently selecting another project", async () => {
  boundary.search = { workspace: "missing", tab: "agents" };
  await render();
  expect(container.textContent).toContain("Workspace unavailable");
  expect(container.textContent).not.toContain("Saved sessions");
});

it("retains the exact saved checkout for historical recording and run links", async () => {
  boundary.search = {
    workspace: "primary",
    context: "lane",
    tab: "recordings",
    expectedGeneration: 7,
  };
  await render();
  expect(container.querySelector("h1")?.textContent).toBe("Project");
  expect(container.textContent).toContain("recordings for lane");
  boundary.search = { ...boundary.search, expectedGeneration: 8 };
  await render();
  expect(container.textContent).toContain("Selected context unavailable");
  expect(container.textContent).not.toContain("recordings for lane");
});
