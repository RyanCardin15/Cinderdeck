// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import { ThreadContextView } from "@cinderdeck/contracts/deckhand/rpc";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
vi.mock("@effect/atom-react", () => ({ useAtomValue: (atom: unknown) => atom }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: new Map() }));
vi.mock("./state", () => ({ workspaceView: () => AsyncResult.initial() }));
vi.mock("./useAgentObservation", () => ({ useAgentObservation: () => ({ stale: false }) }));
vi.mock("./ProductNavigation", () => ({ ProductNavigation: () => null }));
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
it("returns a removed lane's workspace breadcrumb to all saved conversations", async () => {
  await render({ ...context, checkout: { ...context.checkout, laneName: "Release polish" } });
  const breadcrumb = [...container.querySelectorAll("header a")].find(
    (link) => link.textContent === "Payment",
  )!;
  expect(JSON.parse(breadcrumb.getAttribute("data-search")!)).toEqual({
    environment: "remote-computer",
    workspace: "primary-workspace",
    tab: "agents",
    expectedInstallationID: "native-installation",
  });
  expect(container.querySelector("header strong")?.textContent).toBe("Release polish");
});
