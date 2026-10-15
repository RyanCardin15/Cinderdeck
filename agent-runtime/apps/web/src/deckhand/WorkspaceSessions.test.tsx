// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncResult } from "effect/unstable/reactivity";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@cinderdeck/contracts";
import type { ManagedSessionView, IntegrationView } from "@cinderdeck/contracts/deckhand/rpc";
import type { SessionShell } from "./sessionWorkspaceRows";

const boundary = vi.hoisted(() => ({
  result: null as unknown,
  threads: [] as SessionShell[],
  requests: [] as { offset: number }[],
  menu: vi.fn(),
  connected: true,
  archiveThreads: [] as OrchestrationV2ThreadShell[],
  archiveRequests: [] as EnvironmentId[][],
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
  useArchivedThreadSnapshots: (ids: EnvironmentId[]) => {
    boundary.archiveRequests.push(ids);
    return {
      snapshots: ids.length
        ? [{ environmentId: ids[0], snapshot: { projects: [], threads: boundary.archiveThreads } }]
        : [],
      error: null,
    };
  },
}));
vi.mock("./useSessionActions", () => ({
  useSessionActions: () => ({ showMenu: boundary.menu, renameDialog: null }),
}));
vi.mock("../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@cinderdeck/contracts/settings");
  return {
    useClientSettings: (selector: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      selector(DEFAULT_CLIENT_SETTINGS),
  };
});
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
import { sessionOrderGroup } from "./workspaceSessionTree";
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
  lineage: {
    rootThreadId: ThreadId.make("ordinary"),
    parentThreadId: null,
    relationshipToParent: null,
  },
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
const child = (id: string, parent = "ordinary"): SessionShell => ({
  ...ordinary,
  id: ThreadId.make(id),
  title: id,
  createdAt: "2026-10-14T12:00:00Z",
  lineage: {
    rootThreadId: ordinary.id,
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "subagent",
  },
});
const archivedShell: OrchestrationV2ThreadShell = {
  id: ordinary.id,
  projectId: ordinary.projectId,
  title: "Archived main",
  providerInstanceId: ordinary.providerInstanceId,
  modelSelection: { instanceId: ordinary.providerInstanceId, model: "fixture-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: ordinary.lineage,
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: DateTime.makeUnsafe(ordinary.createdAt),
  updatedAt: DateTime.makeUnsafe(ordinary.updatedAt),
  archivedAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z"),
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
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
  boundary.archiveThreads = [];
  boundary.archiveRequests = [];
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const rootSessionIDs = () =>
  [...container.querySelectorAll("nav > ul > li")].map((branch) =>
    branch.querySelector("[data-session-id]")!.getAttribute("data-session-id"),
  );
const childSessionIDs = (parent: string) => {
  const branch = container.querySelector(`[data-session-id="${parent}"]`)!.closest("li")!;
  return [...branch.querySelectorAll(":scope > ul > li")].map((child) =>
    child.querySelector("[data-session-id]")!.getAttribute("data-session-id"),
  );
};
const keyDown = async (target: EventTarget, code: string) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true }));
  });
function mockSessionGeometry() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const branch = this.closest("li");
    const siblings = [...(branch?.parentElement?.children ?? [])].filter(
      (child) => child.tagName === "LI",
    );
    const top = branch ? siblings.indexOf(branch) * 100 : 0;
    return {
      left: 0,
      right: 200,
      top,
      bottom: top + 40,
      width: 200,
      height: 40,
      x: 0,
      y: top,
      toJSON: () => ({}),
    };
  });
}

it("reorders main groups with the keyboard, saves on drop, and restores in the full session view", async () => {
  boundary.result = AsyncResult.success([]);
  boundary.threads = [
    ordinary,
    { ...ordinary, id: ThreadId.make("second"), title: "Second" },
    child("Inspector"),
  ];
  mockSessionGeometry();
  const onNavigate = vi.fn();
  await render({ onNavigate });
  expect(rootSessionIDs()).toEqual(["ordinary", "second"]);
  const handle = container.querySelector(
    'button[aria-label="Reorder session Ordinary conversation"]',
  ) as HTMLButtonElement;
  handle.focus();
  await keyDown(handle, "Space");
  await keyDown(document, "ArrowDown");
  await keyDown(document, "Space");
  expect(rootSessionIDs()).toEqual(["second", "ordinary"]);
  expect(childSessionIDs("ordinary")).toEqual(["Inspector"]);
  expect(onNavigate).not.toHaveBeenCalled();
  expect(
    readSidebarPreferences(sidebarPreferenceKey("local", "installation")).order[
      sessionOrderGroup("app")
    ],
  ).toEqual(["second", "ordinary"]);
  await act(async () => root.render(null));
  await render({ compact: false });
  expect(rootSessionIDs()).toEqual(["second", "ordinary"]);
  await render({ installationID: "another-installation" });
  expect(rootSessionIDs()).toEqual(["ordinary", "second"]);
});

it("drags sub-agents within their parent, preserves other groups, and cancels without saving", async () => {
  boundary.result = AsyncResult.success([]);
  boundary.threads = [
    ordinary,
    child("Inspector"),
    child("Verifier"),
    child("Nested", "Inspector"),
  ];
  mockSessionGeometry();
  await render();
  expect(childSessionIDs("ordinary")).toEqual(["Inspector", "Verifier"]);
  const handle = container.querySelector(
    'button[aria-label="Reorder sub-agent Inspector"]',
  ) as HTMLButtonElement;
  // React's pointer handler expects isPrimary; jsdom has no native PointerEvent.
  const pointer = (type: string, y: number) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 10,
      clientY: y,
    });
    Object.defineProperty(event, "isPrimary", { value: true });
    return event;
  };
  await act(async () => handle.dispatchEvent(pointer("pointerdown", 20)));
  await act(async () => document.dispatchEvent(pointer("pointermove", 30)));
  await act(async () => document.dispatchEvent(pointer("pointermove", 120)));
  await act(async () => document.dispatchEvent(pointer("pointerup", 120)));
  expect(childSessionIDs("ordinary")).toEqual(["Verifier", "Inspector"]);
  expect(childSessionIDs("Inspector")).toEqual(["Nested"]);
  const order = readSidebarPreferences(sidebarPreferenceKey("local", "installation")).order;
  expect(order[sessionOrderGroup("app", "ordinary")]).toEqual(["Verifier", "Inspector"]);
  expect(order[sessionOrderGroup("app")]).toBeUndefined();
  handle.focus();
  await keyDown(handle, "Space");
  await keyDown(document, "ArrowUp");
  await keyDown(document, "Escape");
  expect(childSessionIDs("ordinary")).toEqual(["Verifier", "Inspector"]);
  expect(readSidebarPreferences(sidebarPreferenceKey("local", "installation")).order).toEqual(
    order,
  );
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

it("nests and collapses sub-agents while preserving their navigation and independent colors", async () => {
  boundary.result = AsyncResult.success([]);
  boundary.threads = [ordinary, child("Inspector"), child("Verifier", "Inspector")];
  boundary.menu.mockImplementation((_session, _position, _enabled, appearance) =>
    appearance.onHighlight(),
  );
  const onNavigate = vi.fn();
  await render({ onNavigate });
  const main = container.querySelector('[data-session-id="ordinary"]')!.closest("li")!;
  const inspector = main.querySelector('ul [data-session-id="Inspector"]')!;
  expect(inspector.closest("li")!.querySelector('ul [data-session-id="Verifier"]')).not.toBeNull();
  expect(inspector.textContent).toContain("Sub-agent");
  const toggle = main.querySelector("button")!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(main.querySelector("ul")!.hidden).toBe(true);
  expect(onNavigate).not.toHaveBeenCalled();
  await act(async () => toggle.click());
  const link = inspector.querySelector("a")!;
  await act(async () => link.click());
  expect(onNavigate).toHaveBeenCalledOnce();
  await act(async () =>
    link.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })),
  );
  expect(boundary.menu).toHaveBeenCalledWith(
    expect.objectContaining({ binding: { threadId: "Inspector" } }),
    expect.anything(),
    true,
    expect.anything(),
  );
  await act(async () =>
    (document.querySelector('button[aria-label="Blue"]') as HTMLButtonElement).click(),
  );
  expect(
    readSidebarPreferences(sidebarPreferenceKey("local", "installation")).sessionColors,
  ).toEqual({ Inspector: "#579de5" });
  expect(main.querySelector('a[href="/sessions/ordinary"]')?.getAttribute("data-highlighted")).toBe(
    "false",
  );
  await act(async () => root.render(null));
  await render({ selectedThreadId: "Inspector" });
  expect(container.querySelector('a[href="/sessions/Inspector"]')?.getAttribute("style")).toContain(
    "#579de5",
  );
  expect(
    container.querySelector('a[href="/sessions/Inspector"]')?.getAttribute("aria-current"),
  ).toBe("page");
});

it("limits main sessions instead of sub-agents and reveals an older selected child", async () => {
  boundary.result = AsyncResult.success([]);
  boundary.threads = [
    ...Array.from({ length: 12 }, (_, index) => ({
      ...ordinary,
      id: ThreadId.make(`main-${index}`),
      createdAt: new Date(Date.UTC(2026, 9, index + 1)).toISOString(),
    })),
    ...Array.from({ length: 15 }, (_, index) => child(`child-${index}`, "main-11")),
    child("older-selected", "main-0"),
  ];
  await render({ selectedThreadId: undefined });
  expect(container.querySelectorAll("nav > ul > li")).toHaveLength(10);
  expect(container.querySelectorAll('nav a[href^="/sessions/child-"]')).toHaveLength(15);
  expect(container.querySelector('a[href="/sessions/main-2"]')).not.toBeNull();
  expect(container.querySelector('a[href="/sessions/main-0"]')).toBeNull();
  await render({ selectedThreadId: "older-selected" });
  const selected = container.querySelector('a[href="/sessions/older-selected"]')!;
  expect(selected.getAttribute("aria-current")).toBe("page");
  expect(selected.closest("ul")!.hidden).toBe(false);
  expect(container.querySelector('a[href="/sessions/main-0"]')).not.toBeNull();
});

it("opens ancestor groups when selection changes or search matches a nested child", async () => {
  boundary.result = AsyncResult.success([]);
  boundary.threads = [
    ordinary,
    child("Inspector"),
    child("Verifier", "Inspector"),
    child("Sibling"),
  ];
  await render({ compact: false });
  const main = container.querySelector('[data-session-id="ordinary"]')!.closest("li")!;
  const toggle = main.querySelector("button")!;
  await act(async () => toggle.click());
  await render({ compact: false, selectedThreadId: "Verifier" });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  await act(async () => toggle.click());
  const input = container.querySelector('input[aria-label="Search sessions"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Verifier",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelectorAll("nav a")).toHaveLength(3);
  expect(container.querySelector('a[href="/sessions/ordinary"]')).not.toBeNull();
  expect(container.querySelector('a[href="/sessions/Inspector"]')).not.toBeNull();
  expect(container.querySelector('a[href="/sessions/Sibling"]')).toBeNull();
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(main.querySelector("ul")!.hidden).toBe(false);
});

it("loads archived parents only when needed and retains them as context for active children", async () => {
  boundary.result = AsyncResult.success([]);
  await render({ compact: false });
  expect(boundary.archiveRequests.at(-1)).toEqual([]);
  boundary.archiveThreads = [
    archivedShell,
    {
      ...archivedShell,
      id: ThreadId.make("unrelated-archive"),
    },
  ];
  boundary.threads = [child("Active inspector")];
  await render({ compact: false, selectedThreadId: "Active inspector" });
  expect(boundary.archiveRequests.at(-1)).toEqual([environmentId]);
  const main = container.querySelector('[data-session-id="ordinary"]')!.closest("li")!;
  expect(main.textContent).toContain("Archived");
  expect(main.querySelector('ul a[href="/sessions/Active inspector"]')).not.toBeNull();
  expect(container.querySelector('a[href="/sessions/unrelated-archive"]')).toBeNull();
  await act(async () =>
    (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click(),
  );
  expect(container.querySelector('a[href="/sessions/unrelated-archive"]')).not.toBeNull();
});
