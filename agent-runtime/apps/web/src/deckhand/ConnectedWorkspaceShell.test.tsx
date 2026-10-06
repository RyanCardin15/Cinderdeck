// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import { ThreadContextView } from "@cinderdeck/contracts/deckhand/rpc";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const mounts = vi.hoisted(() => ({ navigation: 0, conversation: 0 }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, isSuccess: false }),
}));
vi.mock("./state", () => ({ workspaceView: () => null }));
vi.mock("./useAgentObservation", () => ({ useAgentObservation: () => ({ stale: false }) }));
vi.mock("./ProductNavigation", () => ({
  ProductNavigation: () => {
    useEffect(() => {
      mounts.navigation++;
    }, []);
    return (
      <aside aria-label="Cinderdeck navigation">
        <button>Workspace</button>
      </aside>
    );
  },
}));
vi.mock("./WorkspaceSettingsButton", () => ({
  WorkspaceSettingsButton: ({ enabled }: { enabled: boolean }) => (
    <button disabled={!enabled}>Settings</button>
  ),
  WorkspaceBranchesButton: () => null,
}));
vi.mock("./SessionLauncher", () => ({ SessionLauncher: () => null }));
vi.mock("./SessionList", () => ({
  SessionList: ({ workspaceID }: { workspaceID: string }) => <p>Sessions: {workspaceID}</p>,
}));
vi.mock("./WorkspaceSections", () => ({ WorkspaceSections: () => <nav>Workspace sections</nav> }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, search }: { children: ReactNode; search?: unknown }) => (
    <a href="#fixture" data-search={JSON.stringify(search)}>
      {children}
    </a>
  ),
}));
import { ConnectedWorkspaceShell } from "./ConnectedWorkspaceShell";
import { useNavigationSnapshot } from "./useNavigationSnapshot";
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
function Conversation() {
  useEffect(() => {
    mounts.conversation++;
  }, []);
  return <textarea aria-label="Message" defaultValue="Unsent message" />;
}
function Harness({
  value,
  pending = false,
  environmentId = threadRef.environmentId,
}: {
  value: ThreadContextView | null;
  pending?: boolean;
  environmentId?: typeof threadRef.environmentId;
}) {
  const snapshot = useNavigationSnapshot(environmentId, value, pending);
  return (
    <ConnectedWorkspaceShell
      context={snapshot.value}
      threadRef={{ ...threadRef, environmentId }}
      stale={snapshot.retained}
      fallbackSidebar={<p>All sessions</p>}
    >
      <Conversation />
    </ConnectedWorkspaceShell>
  );
}
const render = async (
  value: ThreadContextView | null,
  pending = false,
  environmentId = threadRef.environmentId,
) =>
  act(async () =>
    root.render(<Harness value={value} pending={pending} environmentId={environmentId} />),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mounts.navigation = 0;
  mounts.conversation = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("keeps navigation, conversation DOM, focus and draft mounted through context resolution and session switches", async () => {
  await render(null, true);
  const navigation = container.querySelector("aside");
  const input = container.querySelector("textarea")!;
  input.value = "Keep my unsent edit";
  input.focus();
  await render(context);
  await render(null, true);
  expect(container.textContent).toContain("Sessions: review-lane");
  expect(container.querySelector<HTMLButtonElement>("button:disabled")?.textContent).toBe(
    "Settings",
  );
  await render({ ...context, checkout: { ...context.checkout, laneId: "another-lane" } });
  expect(container.textContent).toContain("Sessions: another-lane");
  await render(null);
  expect(container.textContent).toContain("All sessions");
  expect(container.querySelector("aside")).toBe(navigation);
  expect(container.querySelector("textarea")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("Keep my unsent edit");
  expect(mounts).toEqual({ navigation: 1, conversation: 1 });
});
it("clears retained context on errors, resolved absence, or a different computer", async () => {
  await render(context);
  await render(null, true, EnvironmentId.make("other-computer"));
  expect(container.textContent).not.toContain("Sessions: review-lane");
  await render(context);
  await render(null, false);
  expect(container.textContent).toContain("All sessions");
  await render(null, true);
  expect(container.textContent).not.toContain("Sessions: review-lane");
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
