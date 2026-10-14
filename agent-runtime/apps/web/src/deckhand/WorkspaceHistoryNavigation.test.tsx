// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import { ThreadContextView } from "@cinderdeck/contracts/deckhand/rpc";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: unknown) => atom }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: new Map() }));
vi.mock("./state", () => ({ workspaceView: () => null }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isSuccess: false }),
}));
vi.mock("./useAgentObservation", () => ({ useAgentObservation: () => ({ stale: false }) }));
vi.mock("./ProductNavigation", () => ({
  ProductNavigation: ({ workspaceSearch }: { workspaceSearch?: unknown }) => (
    <nav aria-label="Sessions" data-search={JSON.stringify(workspaceSearch)} />
  ),
}));
vi.mock("./WorkspaceSidebar", () => ({ WorkspaceSidebar: () => null }));
vi.mock("./WorkspaceSettingsButton", () => ({
  WorkspaceSettingsButton: () => null,
  WorkspaceBranchesButton: () => null,
}));
vi.mock("./SessionLauncher", () => ({ SessionLauncher: () => null }));
vi.mock("./SessionList", () => ({ SessionList: () => null }));
vi.mock("./WorkspaceSections", () => ({ WorkspaceSections: () => null }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, search }: { children: ReactNode; search?: unknown }) => (
    <a href="#fixture" data-search={JSON.stringify(search)}>
      {children}
    </a>
  ),
}));
import { ConnectedWorkspaceShell } from "./ConnectedWorkspaceShell";
const context = Schema.decodeSync(ThreadContextView)({
  workspace: {
    id: "workspace",
    environmentId: "native-installation",
    backend: "cinderdeck",
    ownerId: "primary-workspace",
    generation: 1,
    revision: 1,
    name: "Payment",
    state: "active",
  },
  checkout: {
    id: "checkout",
    workspaceId: "workspace",
    workspaceGeneration: 1,
    nativeGeneration: 7,
    environmentId: "native-installation",
    backend: "cinderdeck",
    kind: "lane",
    laneId: "review-lane",
    state: "ready",
    repositories: [],
    revision: 1,
  },
  feature: {
    id: "feature",
    workspaceId: "workspace",
    title: "Payment retry feature",
    objective: "Make retries clear",
    status: "active",
    revision: 1,
    createdAt: "2026-10-04T10:00:00Z",
    updatedAt: "2026-10-04T10:00:00Z",
  },
  session: {
    id: "session",
    threadId: "thread",
    providerSessionId: null,
    providerInstanceId: "codex-work",
    featureId: "feature",
    checkoutId: "checkout",
    role: "writer",
    desiredAccess: "write",
    execution: "waiting_approval",
    connection: "connected",
    capabilities: {
      nativeResume: true,
      interrupt: false,
      steering: false,
      approvals: true,
      questions: false,
      enforcedReadOnly: false,
      imageInput: false,
      videoInput: false,
      managed: true,
    },
    lastSequence: 0,
  },
  native: null,
  nativeConnection: "unavailable",
  sessions: [],
});
const threadRef = {
  environmentId: EnvironmentId.make("remote-computer"),
  threadId: ThreadId.make("thread"),
};

let root: Root;
let container: HTMLDivElement;
const render = async (value: ThreadContextView) =>
  act(async () =>
    root.render(
      <ConnectedWorkspaceShell context={value} threadRef={threadRef}>
        <p>Conversation</p>
      </ConnectedWorkspaceShell>,
    ),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("keeps a legacy checkout conversation mounted with source workspace navigation", async () => {
  await render({ ...context, checkout: { ...context.checkout, laneName: "Release polish" } });
  const navigator = container.querySelector('[aria-label="Sessions"]')!;
  expect(JSON.parse(navigator.getAttribute("data-search")!)).toEqual({
    environment: "remote-computer",
    workspace: "primary-workspace",
    context: "review-lane",
    tab: "agents",
    expectedGeneration: 7,
    expectedInstallationID: "native-installation",
  });
  expect(container.querySelector("header")).toBeNull();
  expect(container.textContent).toBe("Conversation");
  await render({ ...context, nativeConnection: "unavailable" });
  expect(container.textContent).toBe("Conversation");
  expect(container.querySelector('[data-connected-context="true"]')).not.toBeNull();
});
