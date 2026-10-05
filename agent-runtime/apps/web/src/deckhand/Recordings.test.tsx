// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@t3tools/contracts";
import type { IntegrationView } from "@t3tools/contracts/deckhand/rpc";
import type { Recording } from "@t3tools/contracts/deckhand/recordingsRpc";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { RegistryContext } from "@effect/atom-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { RecordingsSearch } from "./recordingNavigation";
const boundary = vi.hoisted(() => ({
  search: {} as RecordingsSearch,
  view: null as IntegrationView | null,
  stale: false,
  navigate: vi.fn(),
  catalog: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  logs: vi.fn(),
  media: vi.fn(),
  windows: vi.fn(),
  start: vi.fn(),
  control: vi.fn(),
  mark: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useSearch: () => boundary.search,
  useNavigate: () => boundary.navigate,
  Link: ({
    to,
    search,
    children,
  }: {
    to: string;
    search?: Record<string, unknown>;
    children: ReactNode;
  }) => (
    <a
      href={to}
      onClick={(event) => {
        event.preventDefault();
        boundary.navigate({ to, search });
      }}
    >
      {children}
    </a>
  ),
}));
const nativeAtom = Atom.make<AsyncResult.AsyncResult<IntegrationView, Error>>(
  AsyncResult.initial(),
);
vi.mock("./state", () => ({
  workspaceView: (input: unknown) => {
    boundary.catalog(input);
    return nativeAtom;
  },
}));
vi.mock("./useAgentObservation", () => ({
  useAgentObservation: () => ({ stale: boundary.stale, reconnecting: boundary.stale }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "computer", label: "Execution computer" }],
  }),
  usePrimaryEnvironmentId: () => "computer",
  useEnvironmentHttpBaseUrl: () => "http://127.0.0.1:3773",
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof boundary) => boundary[command],
}));
vi.mock("./recordingState", () => ({
  listRecordings: "list",
  getRecording: "get",
  recordingLogs: "logs",
  recordingMedia: "media",
  recordingWindows: "windows",
  startRecording: "start",
  controlRecording: "control",
  markRecording: "mark",
}));
vi.mock("./RecordingThumbnail", () => ({ RecordingThumbnail: () => null }));
vi.mock("./ProductNavigation", () => ({ ProductNavigation: () => null }));
import { RecordingsPage } from "./Recordings";
const resource: IntegrationView["resources"][number] = {
  workspaceID: "lane",
  generation: 7,
  revision: "source",
  available: true,
  workspace: {
    id: "lane",
    name: "Retry lane",
    file: "/fixture/lane.toml",
    state: "ready",
    definitionChanged: false,
    issues: [],
    services: [],
    repos: [],
    lane: {
      sourceStackID: "primary",
      name: "Retry lane",
      directory: "/fixture/lane",
      createdAt: "2026-10-04T10:00:00Z",
      ports: {},
    },
  },
};
const view: IntegrationView = {
  state: "connected",
  hello: {
    protocolVersion: 1,
    installationID: "installation",
    executionHostID: "host",
    channel: "development",
    runtimeEpoch: "epoch",
    capabilities: [],
    maximumFrameBytes: 4194304,
    maximumPageSize: 100,
    maximumWaitMs: 30000,
  },
  observedAt: "2026-10-04T10:00:00Z",
  error: null,
  resources: [],
  selectedResources: [resource],
  activity: [],
  total: 608,
  nextOffset: 100,
};
const recording: Recording = {
  id: "recording",
  title: "Saved retry evidence",
  state: "ready",
  createdAt: "2026-10-04T10:00:00Z",
  duration: 15,
  actor: "original-owner",
  capture: "browser",
  primaryWorkspaceID: "lane",
  capturedWorkspaceIDs: ["lane"],
  capturedWorkspaceNames: ["Retry lane"],
  lineCount: 0,
  errorCount: 0,
  warningCount: 0,
  playable: true,
  paused: false,
  controlAllowed: false,
  detail: null,
  checkOutcome: "unverified",
  markers: [],
  repositories: [],
};
const success = <A,>(value: A) => ({ _tag: "Success", value });
let root: Root;
let registry: AtomRegistry.AtomRegistry;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  boundary.search = {
    environment: "computer",
    workspace: "lane",
    recording: "recording",
    expectedInstallationID: "installation",
    expectedGeneration: 7,
  };
  boundary.view = view;
  boundary.stale = false;
  boundary.list.mockResolvedValue(success([recording]));
  boundary.get.mockResolvedValue(success(recording));
  boundary.logs.mockResolvedValue(
    success({ repro: "recording", duration: 15, total: 0, returned: 0, lines: [] }),
  );
  boundary.media.mockResolvedValue(
    success({
      path: "/media/saved",
      expiresAt: "2026-10-04T11:00:00Z",
      mimeType: "video/mp4",
      size: 10,
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  registry = AtomRegistry.make();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});
const render = async () => {
  await act(async () => {
    registry.set(nativeAtom, AsyncResult.success(boundary.view!));
    root.render(
      <RegistryContext value={registry}>
        <RecordingsPage />
      </RegistryContext>,
    );
  });
};
const button = (label: string) => {
  const element = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(element, label).toBeDefined();
  return element!;
};
it("keeps loaded evidence and original navigation pins when its current lane is replaced", async () => {
  await render();
  expect(boundary.catalog).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("computer"),
    input: { offset: 0, limit: 100, selectedContextID: "lane" },
  });
  expect(container.querySelector("video")?.getAttribute("src")).toBe(
    "http://127.0.0.1:3773/media/saved",
  );
  boundary.view = { ...view, selectedResources: [{ ...resource, generation: 8 }] };
  await render();
  expect(container.textContent).toContain("different workspace identity");
  expect(container.textContent).toContain("Saved retry evidence");
  expect(container.querySelector("video")?.getAttribute("src")).toBe(
    "http://127.0.0.1:3773/media/saved",
  );
  expect(button("Record with Logs").disabled).toBe(true);
  const input = container.querySelector<HTMLInputElement>('[aria-label="Check label"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "New check",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(button("Pass").disabled).toBe(true);
  await act(async () => {
    button("Record with Logs").click();
    button("Pass").click();
  });
  expect(boundary.windows).not.toHaveBeenCalled();
  expect(boundary.start).not.toHaveBeenCalled();
  expect(boundary.mark).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLAnchorElement>('a[href="/workspaces"]')!.click(),
  );
  expect(boundary.navigate).toHaveBeenLastCalledWith({
    to: "/workspaces",
    search: {
      environment: "computer",
      workspace: "primary",
      context: "lane",
      expectedInstallationID: "installation",
      expectedGeneration: 7,
    },
  });
  const library = [...container.querySelectorAll("button")].find(
    (item) => item.querySelector("strong")?.textContent === "Saved retry evidence",
  )!;
  await act(async () => library.click());
  expect(boundary.navigate).toHaveBeenLastCalledWith({
    to: "/recordings",
    search: {
      environment: "computer",
      workspace: "lane",
      recording: "recording",
      expectedInstallationID: "installation",
      expectedGeneration: 7,
    },
  });
  await act(async () => button("Open current workspace").click());
  expect(boundary.navigate).toHaveBeenLastCalledWith({
    to: "/recordings",
    search: { environment: "computer", workspace: "lane" },
  });
});
it("disables cached active recording controls on transport loss without changing its read scope", async () => {
  const active = {
    ...recording,
    state: "recording" as const,
    playable: false,
    controlAllowed: true,
  };
  boundary.list.mockResolvedValue(success([active]));
  boundary.get.mockResolvedValue(success(active));
  await render();
  expect(button("Stop and save").disabled).toBe(false);
  boundary.stale = true;
  await render();
  expect(container.textContent).toContain("last observed evidence");
  expect(button("Stop and save").disabled).toBe(true);
  expect(button("Pause capture").disabled).toBe(true);
  await act(async () => {
    button("Stop and save").click();
    button("Pause capture").click();
  });
  expect(boundary.control).not.toHaveBeenCalled();
  expect(boundary.get).toHaveBeenCalledWith({
    environmentId: "computer",
    input: {
      installationID: "installation",
      workspaceID: "lane",
      generation: 7,
      recordingID: "recording",
    },
  });
});
