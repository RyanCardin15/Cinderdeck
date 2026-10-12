// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Schema from "effect/Schema";
import { ManagedSessionsInput } from "@cinderdeck/contracts/deckhand/rpc";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@cinderdeck/contracts";
import type { ManagedSessionView, IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import type { SessionShell } from "./sessionWorkspaceRows";

const boundary = vi.hoisted(() => ({
  result: null as unknown,
  threads: [] as SessionShell[],
  requests: [] as { offset: number }[],
  menu: vi.fn(),
  connected: true,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => boundary.result }));
vi.mock("./state", () => ({
  managedSessionsView: ({ input }: { input: { offset: number } }) => {
    boundary.requests.push(input);
    return null;
  },
  threadContextView: () => null,
}));
vi.mock("../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../state/entities", () => ({
  useProjects: () => [{ environmentId: "local", id: "project", workspaceRoot: "/fixture/app" }],
  useThreadShells: () => boundary.threads,
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({
    connection: { phase: boundary.connected ? "connected" : "disconnected" },
  }),
}));
vi.mock("../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [], error: null }),
}));
vi.mock("./useSessionActions", () => ({
  useSessionActions: () => ({ showMenu: boundary.menu, renameDialog: null }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    params,
    children,
    ...props
  }: {
    params: { threadId: string };
    children: React.ReactNode;
  }) => (
    <a {...props} href={`/sessions/${params.threadId}`}>
      {children}
    </a>
  ),
}));
import { WorkspaceSessions } from "./WorkspaceSessions";
const environmentId = EnvironmentId.make("local");
const resource: IntegrationView["resources"][number] = {
  workspaceID: "app",
  generation: 1,
  revision: "one",
  available: true,
  workspace: {
    id: "app",
    name: "App",
    file: "/fixture/app.toml",
    root: "/fixture/app",
    state: "ready",
    definitionChanged: false,
    issues: [],
    services: [],
    repos: [],
  },
};
const saved = (id: string): ManagedSessionView =>
  ({
    binding: { threadId: id, providerInstanceId: "codex", execution: "idle" },
    title: id,
    archived: false,
    source: "current",
  }) as ManagedSessionView;
const ordinary: SessionShell = {
  environmentId,
  projectId: ProjectId.make("project"),
  id: ThreadId.make("ordinary"),
  title: "Ordinary conversation",
  providerInstanceId: ProviderInstanceId.make("codex"),
  updatedAt: "2026-10-12T12:00:00Z",
  pinnedAt: null,
  archivedAt: null,
  deletedAt: null,
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
let root: Root;
let container: HTMLDivElement;
const render = async () =>
  act(async () =>
    root.render(
      <WorkspaceSessions
        environmentId={environmentId}
        installationID="installation"
        resource={resource}
        resources={[resource]}
        selectedThreadId="ordinary"
        compact
      />,
    ),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  boundary.result = AsyncResult.success([saved("history")]);
  boundary.threads = [ordinary];
  boundary.requests = [];
  boundary.connected = true;
  boundary.menu.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("opens ordinary sessions alongside saved checkout history and retains selection offline", async () => {
  await render();
  expect(
    container.querySelector('a[href="/sessions/ordinary"]')?.getAttribute("aria-current"),
  ).toBe("page");
  expect(container.querySelector('a[href="/sessions/history"]')).not.toBeNull();
  boundary.connected = false;
  await render();
  const link = container.querySelector('a[href="/sessions/ordinary"]')!;
  await act(async () =>
    link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  expect(boundary.menu).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Ordinary conversation" }),
    expect.anything(),
    false,
  );
});
it("loads older saved sessions without replacing the earlier page or duplicating ordinary threads", async () => {
  boundary.result = AsyncResult.success(
    Array.from({ length: 20 }, (_, index) => saved(`saved-${index}`)),
  );
  await render();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Show older sessions")!
      .click(),
  );
  expect(boundary.requests.at(-1)?.offset).toBe(20);
  boundary.result = AsyncResult.success([saved("older"), saved("ordinary")]);
  await render();
  expect(container.querySelector('a[href="/sessions/saved-0"]')).not.toBeNull();
  expect(container.querySelector('a[href="/sessions/older"]')).not.toBeNull();
  expect(container.querySelectorAll('a[href="/sessions/ordinary"]')).toHaveLength(1);
});
