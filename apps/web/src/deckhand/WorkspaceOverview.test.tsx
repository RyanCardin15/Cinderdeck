// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import type { IntegrationView, ManagedContextView } from "@t3tools/contracts/deckhand/rpc";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { WorkspaceSearch } from "./workspaceNavigation";

const boundary = vi.hoisted(() => ({
  search: {} as WorkspaceSearch,
  phase: "connected",
  navigate: vi.fn(),
  recent: vi.fn(),
  recordings: vi.fn(),
  mutation: vi.fn(),
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
vi.mock("./SessionList", () => ({
  SessionList: ({ workspaceID }: { workspaceID: string }) => (
    <p>Saved sessions for {workspaceID}</p>
  ),
}));
vi.mock("./SessionLauncher", () => ({
  SessionLauncher: ({ enabled, creation }: { enabled: boolean; creation?: unknown }) =>
    creation ? null : <button disabled={!enabled}>Launch selected agent</button>,
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
    services: [],
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
      "operations.lane.create.managedWriter",
      "operations.receipts.wait",
      "checkout.reservations",
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
  vi.unstubAllGlobals();
});

it("selects Primary checkout by default despite existing lanes and opens its pinned Agents view", async () => {
  await render();
  expect(container.querySelector('aside[aria-label="Selected context"] h2')?.textContent).toBe(
    "Primary checkout",
  );
  expect(
    container
      .querySelector('article[aria-label="Primary checkout"] button')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    container
      .querySelector('article[aria-label="Retry lane"] button')
      ?.getAttribute("aria-pressed"),
  ).toBe("false");
  const url = await follow("Agents");
  expect(url.pathname).toBe("/workspaces");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    environment: "computer",
    workspace: "primary",
    context: "primary",
    expectedGeneration: "3",
    expectedInstallationID: "installation",
    tab: "agents",
  });
  await render();
  expect(
    container.querySelector('section[aria-label="Agents in selected context"]')?.textContent,
  ).toContain("Saved sessions for primary");
});
it("preserves Agents while changing workspace and checkout, with selected-lane service and recording pins", async () => {
  boundary.search = { environment: "computer", workspace: "primary", tab: "agents" };
  await render();
  await changeSelect("Context", "lane");
  await render();
  expect(boundary.search).toEqual({
    environment: environmentId,
    workspace: "primary",
    context: "lane",
    tab: "agents",
  });
  expect(
    container.querySelector('section[aria-label="Agents in selected context"]')?.textContent,
  ).toContain("Saved sessions for lane");
  for (const name of ["Services", "Recordings"]) {
    const url = await follow(name);
    expect(url.pathname).toBe(`/${name.toLowerCase()}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      environment: "computer",
      workspace: "lane",
      expectedGeneration: "7",
      expectedInstallationID: "installation",
    });
    boundary.search = {
      environment: "computer",
      workspace: "primary",
      context: "lane",
      tab: "agents",
    };
    await render();
  }
  await changeSelect("Workspace", "other");
  await render();
  expect(boundary.search).toEqual({
    environment: environmentId,
    workspace: "other",
    tab: "agents",
  });
  expect(
    container.querySelector('section[aria-label="Agents in selected context"]')?.textContent,
  ).toContain("Saved sessions for other");
});
it("retains navigation but fences all write controls through reconnect until fresh native context arrives", async () => {
  await render();
  for (const name of ["Launch selected agent", "New lane", "Start services", "Stop services"])
    expect(button(name).disabled).toBe(false);
  boundary.phase = "reconnecting";
  await render();
  expect(container.textContent).toContain("Showing last observed workspace and agent details");
  for (const name of ["Launch selected agent", "New lane", "Start services", "Stop services"])
    expect(button(name).disabled).toBe(true);
  boundary.phase = "connected";
  await render();
  for (const name of ["Launch selected agent", "New lane", "Start services", "Stop services"])
    expect(button(name).disabled).toBe(true);
  await act(async () => registry.set(summaryAtom, AsyncResult.success([...summaries])));
  expect(button("New lane").disabled).toBe(true);
  await act(async () => registry.set(nativeAtom, AsyncResult.success({ ...view })));
  for (const name of ["Launch selected agent", "New lane", "Start services", "Stop services"])
    expect(button(name).disabled).toBe(false);
  expect(boundary.mutation).not.toHaveBeenCalled();
});
it("refuses a replaced saved lane without retargeting its agent or service actions", async () => {
  boundary.search = {
    environment: "computer",
    workspace: "primary",
    context: "lane",
    expectedInstallationID: "installation",
    expectedGeneration: 6,
    tab: "agents",
  };
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "earlier lane or Cinderdeck installation",
  );
  expect(container.querySelector('aside[aria-label="Selected context"] h2')?.textContent).toBe(
    "Choose a context",
  );
  expect(container.textContent).not.toContain("Saved sessions for lane");
  expect(
    [...container.querySelectorAll("button")].some(
      (item) => item.textContent === "Launch selected agent",
    ),
  ).toBe(false);
  expect(button("New lane").disabled).toBe(true);
  expect(boundary.mutation).not.toHaveBeenCalled();
});
it("settles an initial agent-summary refusal without a permanent spinner or false attention clearance", async () => {
  registry.set(summaryAtom, AsyncResult.failure(Cause.fail(new Error("summary unavailable"))));
  await render();
  expect(container.textContent).toContain("Agents unavailable");
  expect(container.textContent).not.toContain("Loading agents");
  await act(async () => button("Needs attention").click());
  expect(container.textContent).toContain("Agent attention could not be verified");
  expect(container.textContent).not.toContain("No contexts need attention");
});
