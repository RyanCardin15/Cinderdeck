// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
    search,
    onClick,
    children,
    ...props
  }: {
    params?: { threadId: string };
    search?: Record<string, string | number>;
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLAnchorElement>;
  }) => (
    <a
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
      href={
        params
          ? `/sessions/${params.threadId}`
          : `/workspaces?${new URLSearchParams(Object.entries(search ?? {}).map(([key, value]) => [key, String(value)]))}`
      }
    >
      {children}
    </a>
  ),
}));
import { WorkspaceSessions } from "./WorkspaceSessions";
import { readSidebarPreferences, sidebarPreferenceKey } from "./workspaceSidebarPreferences";
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
  createdAt: "2026-10-12T12:00:00Z",
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
let host: HTMLDivElement;
const render = async (options: Partial<Parameters<typeof WorkspaceSessions>[0]> = {}) =>
  act(async () =>
    root.render(
      <WorkspaceSessions
        environmentId={environmentId}
        installationID="installation"
        resource={resource}
        resources={[resource]}
        selectedThreadId="ordinary"
        compact
        {...options}
      />,
    ),
  );
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  boundary.result = AsyncResult.success([saved("history")]);
  boundary.threads = [ordinary];
  boundary.requests = [];
  boundary.connected = true;
  boundary.menu.mockReset();
  container = document.createElement("div");
  host = document.createElement("div");
  host.append(container);
  document.body.append(host);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
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
    expect.objectContaining({ onHighlight: expect.any(Function) }),
  );
});
it("loads older saved sessions without replacing the earlier page or duplicating ordinary threads", async () => {
  boundary.result = AsyncResult.success(
    Array.from({ length: 20 }, (_, index) => saved(`saved-${index}`)),
  );
  await render({ compact: false });
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Show older sessions")!
      .click(),
  );
  expect(boundary.requests.at(-1)?.offset).toBe(20);
  boundary.result = AsyncResult.success([saved("older"), saved("ordinary")]);
  await render({ compact: false });
  expect(container.querySelector('a[href="/sessions/saved-0"]')).not.toBeNull();
  expect(container.querySelector('a[href="/sessions/older"]')).not.toBeNull();
  expect(container.querySelectorAll('a[href="/sessions/ordinary"]')).toHaveLength(1);
});

it("shows the ten newest starts and opens the exact workspace session view for more", async () => {
  boundary.result = AsyncResult.success([]);
  boundary.threads = Array.from({ length: 12 }, (_, index) => ({
    ...ordinary,
    id: ThreadId.make(`thread-${index}`),
    createdAt: new Date(Date.UTC(2026, 9, index + 1)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 9, 20 - index)).toISOString(),
    pinnedAt: index === 0 ? "2026-10-14T00:00:00Z" : null,
  }));
  const onNavigate = vi.fn();
  await render({ onNavigate });
  const links = [...container.querySelectorAll("nav a")];
  expect(links).toHaveLength(10);
  expect(links[0]?.getAttribute("href")).toBe("/sessions/thread-11");
  expect(links[9]?.getAttribute("href")).toBe("/sessions/thread-2");
  expect(container.textContent).not.toContain("Show older sessions");
  const more = [...container.querySelectorAll("a")].find(
    (link) => link.textContent === "Show more",
  )!;
  const target = new URL(more.href);
  expect(Object.fromEntries(target.searchParams)).toEqual({
    environment: "local",
    expectedInstallationID: "installation",
    workspace: "app",
    context: "app",
    expectedGeneration: "1",
    tab: "agents",
  });
  await act(async () =>
    more.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })),
  );
  expect(onNavigate).toHaveBeenCalledOnce();
  await render({ compact: false });
  expect(container.querySelectorAll("nav a")).toHaveLength(12);
  expect(container.querySelector('input[aria-label="Search sessions"]')).not.toBeNull();
});

it("offers more for paged history and hides it when all ten sessions fit", async () => {
  boundary.threads = [];
  boundary.result = AsyncResult.success(Array.from({ length: 10 }, (_, i) => saved(`saved-${i}`)));
  await render();
  expect(container.textContent).not.toContain("Show more");
  boundary.result = AsyncResult.success(
    Array.from({ length: 20 }, (_, i) => ({ ...saved(`saved-${i}`), archived: i > 8 })),
  );
  await render();
  expect(container.querySelectorAll("nav a")).toHaveLength(9);
  expect(container.textContent).toContain("Show more");
});

it("highlights via the session menu, persists across remounts and clears to default", async () => {
  boundary.connected = false;
  boundary.menu.mockImplementation((_session, _position, _enabled, appearance) =>
    appearance.onHighlight(),
  );
  const parentMenu = vi.fn();
  host.addEventListener("contextmenu", parentMenu);
  await render();
  const openPicker = async () =>
    act(async () => {
      container
        .querySelector('a[href="/sessions/ordinary"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
  await openPicker();
  expect(parentMenu).not.toHaveBeenCalled();
  await act(async () =>
    (document.querySelector('button[aria-label="Blue"]') as HTMLButtonElement).click(),
  );
  const key = sidebarPreferenceKey("local", "installation");
  expect(readSidebarPreferences(key).sessionColors).toEqual({ ordinary: "#579de5" });
  expect(container.querySelector('a[href="/sessions/ordinary"]')?.getAttribute("style")).toContain(
    "#579de5",
  );
  await act(async () => root.render(null));
  await render();
  expect(
    container.querySelector('a[href="/sessions/ordinary"]')?.getAttribute("data-highlighted"),
  ).toBe("true");
  await openPicker();
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Use default"))!
      .click(),
  );
  expect(readSidebarPreferences(key).sessionColors).toEqual({});
  expect(
    container.querySelector('a[href="/sessions/ordinary"]')?.getAttribute("data-highlighted"),
  ).toBe("false");
});

it("opens highlight controls from the keyboard without triggering workspace menus", async () => {
  boundary.menu.mockImplementation((_session, _position, _enabled, appearance) =>
    appearance.onHighlight(),
  );
  const parentKey = vi.fn();
  host.addEventListener("keydown", parentKey);
  await render();
  await act(async () =>
    container.querySelector('a[href="/sessions/ordinary"]')!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(parentKey).not.toHaveBeenCalled();
  expect(
    document.querySelector('[aria-label="Highlight color for Ordinary conversation"]'),
  ).not.toBeNull();
});
