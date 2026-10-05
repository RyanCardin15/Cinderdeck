// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import type { IntegrationView, OperationRecord } from "@t3tools/contracts/deckhand/rpc";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  view: null as IntegrationView | null,
  environments: [
    { environmentId: "computer", label: "My computer", connection: { phase: "connected" } },
  ],
  refresh: vi.fn(),
  recent: vi.fn(),
  inspect: vi.fn(),
  subscription: vi.fn(),
}));
vi.mock("./state", () => ({
  workspaceView: (input: unknown) => {
    mocks.subscription(input);
    return "view";
  },
  refreshWorkspaces: "refresh",
  recentOperations: "recent",
  inspectOperation: "inspect",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    mocks.view === null ? AsyncResult.initial() : AsyncResult.success(mocks.view),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: "refresh" | "recent" | "inspect") => mocks[command],
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments }),
  usePrimaryEnvironmentId: () => "computer",
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    search,
    children,
    ...props
  }: {
    to: string;
    search?: {
      environment: string;
      workspace: string;
      context: string;
      expectedInstallationID: string;
      expectedGeneration: number;
    };
    children: React.ReactNode;
  }) => (
    <a
      href={`${to}${search ? `?environment=${search.environment}&workspace=${search.workspace}&context=${search.context}&expectedInstallationID=${search.expectedInstallationID}&expectedGeneration=${search.expectedGeneration}` : ""}`}
      {...props}
    >
      {children}
    </a>
  ),
}));

import { CinderdeckConnectionPanel } from "./CinderdeckConnectionPanel";

const environmentId = EnvironmentId.make("computer");
const resource: IntegrationView["resources"][number] = {
  workspaceID: "alpha",
  generation: 1,
  revision: "r1",
  available: true,
  workspace: {
    id: "alpha",
    name: "Alpha workspace",
    file: "/fixture/workspace.toml",
    state: "ready",
    definitionChanged: false,
    issues: [],
    services: [],
    repos: [],
  },
};
const connected: IntegrationView = {
  state: "connected",
  hello: {
    installationID: "native-installation",
    executionHostID: "native-host",
    protocolVersion: 1,
    channel: "development",
    runtimeEpoch: "epoch",
    capabilities: ["projection.snapshot", "operations.receipts"],
    maximumFrameBytes: 65536,
    maximumPageSize: 100,
    maximumWaitMs: 30000,
  },
  observedAt: "2026-10-03T22:00:00Z",
  error: null,
  resources: [resource],
  total: 1,
  nextOffset: null,
  activity: [],
};
const pending: OperationRecord = {
  input: {
    operationKey: "original-operation",
    installationID: "native-installation",
    workspaceID: "alpha",
    generation: 1,
    revision: "r1",
    method: "services.start",
    arguments: {},
  },
  receipt: null,
  createdAt: "2026-10-03T22:00:00Z",
  refused: false,
  error: null,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.view = connected;
  mocks.environments = [
    { environmentId: "computer", label: "My computer", connection: { phase: "connected" } },
  ];
  mocks.refresh.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.recent.mockResolvedValue({ _tag: "Success", value: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (props: Parameters<typeof CinderdeckConnectionPanel>[0] = {}) =>
  act(async () => root.render(<CinderdeckConnectionPanel {...props} />));
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((element) => element.textContent?.includes(text))!;
const chooseWorkspace = () =>
  act(async () => {
    container.querySelector<HTMLInputElement>("input[type=radio]")!.click();
  });

it("requires a deliberate workspace choice and returns the exact computer/workspace", async () => {
  const onChoose = vi.fn().mockResolvedValue(true);
  await render({ onChoose });
  expect(button("Open selected workspace").disabled).toBe(true);
  expect(container.textContent).toContain("native-installation");
  expect(container.textContent).toContain("native-host");
  expect(onChoose).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
  await chooseWorkspace();
  await act(async () => button("Open selected workspace").click());
  expect(onChoose).toHaveBeenCalledWith({
    environmentId,
    baseWorkspaceID: "alpha",
    contextID: "alpha",
    expectedInstallationID: "native-installation",
    expectedGeneration: 1,
  });
});

it("keeps an unavailable requested execution computer explicit without querying the primary", async () => {
  await render({ initialEnvironmentId: EnvironmentId.make("missing") });
  expect(container.textContent).toContain("Execution computer unavailable");
  expect(mocks.subscription).not.toHaveBeenCalled();
  expect(mocks.recent).not.toHaveBeenCalled();
});

it("refuses stale snapshots and invalidates a selection after installation identity changes", async () => {
  const onChoose = vi.fn();
  await render({ onChoose: (selection) => onChoose(selection) });
  await chooseWorkspace();
  mocks.view = { ...connected, state: "reconnecting" };
  await render({ onChoose: (selection) => onChoose(selection) });
  expect(button("Open selected workspace").disabled).toBe(true);
  mocks.view = {
    ...connected,
    hello: { ...connected.hello!, installationID: "different-installation" },
  };
  await render({ onChoose: (selection) => onChoose(selection) });
  expect(button("Open selected workspace").disabled).toBe(true);
  expect(container.textContent).toContain("selected workspace changed");
  expect(onChoose).not.toHaveBeenCalled();
});

it("links only the deliberately selected workspace from settings", async () => {
  await render();
  expect(
    [...container.querySelectorAll("a")].some((link) =>
      link.textContent?.includes("Open selected workspace"),
    ),
  ).toBe(false);
  await chooseWorkspace();
  expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(
    "/workspaces?environment=computer&workspace=alpha&context=alpha&expectedInstallationID=native-installation&expectedGeneration=1",
  );
});

it("checks pending operations using the original key without submitting a replacement", async () => {
  mocks.recent.mockResolvedValue({ _tag: "Success", value: [pending] });
  mocks.inspect.mockResolvedValue({
    _tag: "Success",
    value: {
      id: "receipt",
      operationKey: "original-operation",
      argumentHash: "a".repeat(64),
      workspaceID: "alpha",
      generation: 1,
      method: "services.start",
      state: "succeeded",
      createdAt: pending.createdAt,
      updatedAt: pending.createdAt,
    },
  });
  await render();
  expect(container.textContent).toContain("original-operation");
  await act(async () => button("Check status").click());
  expect(mocks.inspect).toHaveBeenCalledWith({
    environmentId,
    input: { operationKey: "original-operation" },
  });
  expect(container.textContent).toContain("Operation status: succeeded");
  expect(mocks.refresh).not.toHaveBeenCalled();
});

it("retains workspace choice when onboarding completion fails", async () => {
  const onChoose = vi.fn().mockResolvedValue(false);
  await render({ onChoose });
  await chooseWorkspace();
  await act(async () => button("Open selected workspace").click());
  expect(container.textContent).toContain("workspace selection is retained");
  expect(button("Open selected workspace").disabled).toBe(false);
});

it("does not offer workspace choice without the actual snapshot capability", async () => {
  mocks.view = { ...connected, hello: { ...connected.hello!, capabilities: [] } };
  const onChoose = vi.fn();
  await render({ onChoose });
  expect(container.querySelector<HTMLInputElement>("input[type=radio]")?.disabled).toBe(true);
  expect(button("Open selected workspace").disabled).toBe(true);
  expect(onChoose).not.toHaveBeenCalled();
});

it("lets a connection recheck recover a failed receipt listing", async () => {
  mocks.recent
    .mockResolvedValueOnce({ _tag: "Failure" })
    .mockResolvedValue({ _tag: "Success", value: [pending] });
  await render();
  expect(container.textContent).toContain("Saved operations could not be loaded");
  await act(async () => button("Check connection").click());
  expect(mocks.refresh).toHaveBeenCalledWith({ environmentId, input: {} });
  expect(container.textContent).not.toContain("Saved operations could not be loaded");
  expect(container.textContent).toContain("original-operation");
});

it("opens a chosen lane under its source workspace and retains original generation for recovery", async () => {
  const lane = {
    ...resource,
    workspaceID: "lane-api",
    generation: 4,
    workspace: {
      ...resource.workspace!,
      id: "lane-api",
      lane: {
        sourceStackID: "alpha",
        name: "verify/api",
        createdAt: pending.createdAt,
        directory: "/fixture/lane",
        ports: {},
      },
    },
  };
  mocks.view = { ...connected, resources: [lane] };
  mocks.recent.mockResolvedValue({
    _tag: "Success",
    value: [{ ...pending, input: { ...pending.input, workspaceID: "lane-api", generation: 3 } }],
  });
  const onChoose = vi.fn().mockResolvedValue(true);
  await render({ onChoose });
  await chooseWorkspace();
  await act(async () => button("Open selected workspace").click());
  expect(onChoose).toHaveBeenCalledWith({
    environmentId,
    baseWorkspaceID: "alpha",
    contextID: "lane-api",
    expectedInstallationID: "native-installation",
    expectedGeneration: 4,
  });
  const recovery = [...container.querySelectorAll("a")].find((link) =>
    link.textContent?.includes("Review workspace"),
  );
  expect(recovery?.getAttribute("href")).toBe(
    "/workspaces?environment=computer&workspace=alpha&context=lane-api&expectedInstallationID=native-installation&expectedGeneration=3",
  );
});
