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
  inspect: vi.fn(),
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows the selected workspace page count instead of unrelated catalog contexts", async () => {
  boundary.search = { workspace: "other", context: "other" };
  registry.set(
    nativeAtom,
    AsyncResult.success({
      ...view,
      workspaceContexts: {
        workspaceID: "other",
        resources: [other],
        total: 1,
        laneCount: 0,
        offset: 0,
        nextOffset: null,
      },
    }),
  );
  await render();
  const footer = container.querySelector('nav[aria-label="Selected workspace context pages"]');
  expect(footer?.textContent).toContain("Workspace contexts 1–1 of 1");
  expect(container.textContent).not.toContain("Contexts 1–3 of 3");
  expect(footer?.querySelectorAll("button:disabled")).toHaveLength(2);
});

it("keeps scoped and catalog paging independent for a workspace with off-page lanes", async () => {
  boundary.search = { workspace: "primary", context: "lane" };
  registry.set(
    nativeAtom,
    AsyncResult.success({
      ...view,
      total: 500,
      nextOffset: 48,
      workspaceContexts: {
        workspaceID: "primary",
        resources: [primary, lane],
        total: 61,
        laneCount: 60,
        offset: 0,
        nextOffset: 50,
      },
    }),
  );
  await render();
  expect(
    container.querySelector('nav[aria-label="Selected workspace context pages"]')?.textContent,
  ).toContain("Workspace contexts 1–2 of 61");
  expect(container.querySelector("footer")?.textContent).toContain(
    "All workspace contexts 1–3 of 500",
  );
  expect(button("Next contexts").disabled).toBe(false);
  await act(async () => button("Next contexts").click());
  expect(boundary.mutation).not.toHaveBeenCalled();
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
  expect(container.querySelector('aside[aria-label="Selected context"]')).toBeNull();
  expect(
    [...container.querySelectorAll("button")].some(
      (item) => item.textContent === "Start services" || item.textContent === "Stop services",
    ),
  ).toBe(false);
  expect(button("Launch selected agent").disabled).toBe(false);
  expect(boundary.mutation).not.toHaveBeenCalled();
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
  expect(container.querySelector('aside[aria-label="Selected context"]')).toBeNull();
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
  await changeSelect("Activity", "attention");
  expect(container.textContent).toContain("Agent state is last observed");
  expect(container.querySelectorAll("article[aria-label]").length).toBeGreaterThan(0);
  expect(container.textContent).not.toContain("No contexts need attention");
});

it("keeps a departed workspace selected when its recovered lane creation completes in flight", async () => {
  vi.useFakeTimers();
  boundary.search = { environment: "computer", workspace: "primary", tab: "agents" };
  const receipt = {
    operationID: "native-operation",
    method: "lane.create",
    state: "pending",
    result: null,
  };
  boundary.recent.mockResolvedValue({
    _tag: "Success",
    value: [
      {
        input: {
          operationKey: "saved-create",
          installationID: "installation",
          workspaceID: "primary",
        },
        receipt,
        refused: false,
      },
    ],
  });
  let complete!: (value: unknown) => void;
  boundary.inspect.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  await render();
  expect(container.textContent).toContain("Recovered a previously submitted operation");
  await act(async () => vi.advanceTimersByTime(800));
  expect(boundary.inspect).toHaveBeenCalledWith({
    environmentId,
    input: { operationKey: "saved-create" },
  });
  await changeSelect("Workspace", "other");
  await render();
  expect(container.textContent).toContain("Saved sessions for other");
  boundary.navigate.mockClear();
  await act(async () =>
    complete({
      _tag: "Success",
      value: { ...receipt, state: "succeeded", result: { createdWorkspaceID: "created-lane" } },
    }),
  );
  expect(boundary.navigate).not.toHaveBeenCalled();
  expect(boundary.search).toEqual({
    environment: environmentId,
    workspace: "other",
    tab: "agents",
  });
  expect(container.textContent).toContain("Saved sessions for other");
  const url = await follow("Open created lane");
  expect(url.pathname).toBe("/workspaces");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    environment: "computer",
    workspace: "primary",
    context: "created-lane",
    expectedInstallationID: "installation",
    tab: "agents",
  });
  expect(boundary.mutation).not.toHaveBeenCalled();
});

it("opens the selected lane's pull requests with original pins and a scoped return", async () => {
  boundary.search = {
    environment: "computer",
    workspace: "primary",
    context: "lane",
    tab: "agents",
  };
  await render();
  const url = await follow("Pull requests");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    involvement: "all",
    state: "all",
    environmentId: "computer",
    deckhandWorkspace: "primary",
    deckhandContext: "lane",
    deckhandInstallationID: "installation",
    deckhandGeneration: "7",
    deckhandTab: "agents",
  });
});
it("keeps a replaced lane's original PR scope instead of linking its replacement", async () => {
  boundary.search = {
    environment: "computer",
    workspace: "primary",
    context: "lane",
    expectedInstallationID: "installation",
    expectedGeneration: 6,
    tab: "agents",
  };
  await render();
  const url = await follow("Pull requests");
  expect(url.searchParams.get("deckhandGeneration")).toBe("6");
  expect(url.searchParams.get("deckhandInstallationID")).toBe("installation");
  expect(url.searchParams.get("deckhandContext")).toBe("lane");
});

it.each(["missing", "lane"])(
  "keeps original lifecycle recovery visible when its child cannot own scope %s",
  async (context) => {
    boundary.search = {
      environment: "computer",
      workspace: "primary",
      context,
      expectedInstallationID: "installation",
      expectedGeneration: context === "lane" ? 6 : 7,
    };
    boundary.recent.mockResolvedValue({
      _tag: "Success",
      value: [
        {
          input: {
            operationKey: "saved-lifecycle",
            method: "lane.setup",
            installationID: "installation",
            workspaceID: context,
          },
          receipt: { method: "lane.setup", state: "unknown_outcome", result: null },
          refused: false,
        },
      ],
    });
    await render();
    expect(container.textContent).toContain("Recovered a previously submitted operation");
    expect(button("Check operation")).toBeDefined();
    expect(boundary.mutation).not.toHaveBeenCalled();
  },
);
it("recovers a delegated lifecycle request when leaving its named-lane inspector", async () => {
  boundary.search = { environment: "computer", workspace: "primary", context: "lane" };
  const receipt = { method: "lane.setup", state: "unknown_outcome", result: null };
  boundary.recent.mockResolvedValue({
    _tag: "Success",
    value: [
      {
        input: {
          operationKey: "saved-lifecycle",
          method: "lane.setup",
          installationID: "installation",
          workspaceID: "lane",
        },
        receipt,
        refused: false,
      },
    ],
  });
  registry.set(
    nativeAtom,
    AsyncResult.success({
      ...view,
      hello: {
        ...view.hello!,
        capabilities: [...view.hello!.capabilities, "operations.receipts", "operations.lane.setup"],
      },
    }),
  );
  await render();
  expect(container.textContent).not.toContain("Recovered a previously submitted operation");
  await changeSelect("Workspace", "other");
  await render();
  expect(container.textContent).toContain("Recovered a previously submitted operation");
  expect(button("Check operation")).toBeDefined();
  expect(boundary.mutation).not.toHaveBeenCalled();
});

it("checks a new scope's journal even while retaining a terminal operation", async () => {
  boundary.search = { environment: "computer", workspace: "primary", tab: "agents" };
  const original = {
    input: {
      operationKey: "saved-original",
      installationID: "installation",
      workspaceID: "primary",
    },
    receipt: { method: "services.start", state: "unknown_outcome", result: null },
    refused: false,
  };
  boundary.recent.mockResolvedValue({ _tag: "Success", value: [original] });
  boundary.inspect.mockResolvedValue({
    _tag: "Success",
    value: { ...original.receipt, state: "succeeded" },
  });
  await render();
  await act(async () => button("Check operation").click());
  expect(container.textContent).toContain("services.start: succeeded");
  let complete!: (value: unknown) => void;
  boundary.recent.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  boundary.recent.mockClear();
  await changeSelect("Workspace", "other");
  await render();
  expect(boundary.recent).toHaveBeenCalledWith({ environmentId, input: {} });
  expect(button("New lane").disabled).toBe(true);
  await act(async () =>
    complete({
      _tag: "Success",
      value: [
        {
          ...original,
          input: { ...original.input, operationKey: "saved-new-scope", workspaceID: "other" },
        },
      ],
    }),
  );
  expect(button("New lane").disabled).toBe(true);
  boundary.inspect.mockClear();
  await act(async () => button("Check operation").click());
  expect(boundary.inspect).toHaveBeenCalledWith({
    environmentId,
    input: { operationKey: "saved-new-scope" },
  });
  expect(boundary.mutation).not.toHaveBeenCalled();
});

it("reviews multiple workspace folders and submits the selected lane launch options", async () => {
  boundary.search = { workspace: "primary", context: "primary" };
  const repo = primary.workspace!.repos[0]!;
  const configured = {
    ...primary,
    workspace: {
      ...primary.workspace!,
      repos: [
        repo,
        { ...repo, id: "api", path: "/fixture/api" },
        { ...repo, id: "docs", path: "/fixture/docs", branch: "" },
      ],
    },
  };
  registry.set(nativeAtom, AsyncResult.success({ ...view, resources: [configured, lane, other] }));
  boundary.mutation.mockResolvedValue({
    _tag: "Success",
    value: {
      operationID: "configured-create",
      method: "lane.create",
      state: "failed",
      result: null,
    },
  });
  await render();
  await act(async () => button("New lane").click());
  const folders = container.querySelector('ul[aria-label="Workspace folders for this lane"]')!;
  expect(folders.textContent).toContain("/fixture/api");
  expect(folders.textContent).toContain("/fixture/docs");
  const change = async (id: string, value: string) => {
    const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await change("dh-branch", "feature/suite");
  await change("dh-lane-from", "origin/main");
  for (const name of ["Run workspace setup", "Start services after creation"]) {
    const checkbox = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.trim() === name)!
      .querySelector<HTMLInputElement>("input")!;
    await act(async () => checkbox.click());
  }
  await act(async () => button("Create lane").click());
  expect(boundary.mutation).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        method: "lane.create",
        arguments: {
          workspace: "primary",
          branch: "feature/suite",
          from: "origin/main",
          setup: true,
          start: true,
        },
      }),
    }),
  );
});
