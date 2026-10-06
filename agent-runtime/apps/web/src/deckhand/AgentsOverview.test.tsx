// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EnvironmentThreadShell } from "@cinderdeck/client-runtime/state/shell";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
vi.mock("../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [], error: null, isLoading: false }),
}));
const mocks = vi.hoisted(() => ({
  threads: [] as EnvironmentThreadShell[],
  offset: 0,
  links: [] as unknown[],
  connected: true,
}));
vi.mock("../state/entities", () => ({
  useProjects: () => [],
  useThreadShells: () => mocks.threads,
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "local",
        label: "Mac",
        connection: { phase: mocks.connected ? "connected" : "disconnected" },
      },
      { environmentId: "remote", label: "Remote", connection: { phase: "connected" } },
    ],
  }),
}));
vi.mock("./ProductNavigation", () => ({ ProductNavigation: () => <nav>Navigation</nav> }));
vi.mock("./ExternalSessionList", () => ({ ExternalSessionList: () => null }));
vi.mock("./state", () => ({ workspaceView: (input: unknown) => input }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: ({
    environmentId,
    input: { offset },
  }: {
    environmentId: string;
    input: { offset: number };
  }) => {
    mocks.offset = offset;
    // Cache the snapshot identity so the catalog effect models a stable atom value.
    return snapshots[`${environmentId}:${offset}`];
  },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    ...props
  }: {
    children: ReactNode;
    to: string;
    params?: unknown;
    search?: unknown;
  }) => (
    <a
      {...props}
      href={to}
      onClick={(event) => {
        event.preventDefault();
        mocks.links.push({ to, params, search });
      }}
    >
      {children}
    </a>
  ),
}));
import { AgentsOverview } from "./AgentsOverview";
const snapshot = (id: string, nextOffset: number | null) =>
  AsyncResult.success({
    state: "connected",
    hello: { installationID: "native" },
    resources: [
      {
        workspaceID: id,
        generation: 1,
        available: true,
        revision: "v1",
        workspace: { name: id, root: `/fixture/${id}`, repos: [] },
      },
    ],
    nextOffset,
  });
const snapshots: Record<string, unknown> = {
  "local:0": snapshot("Alpha", 100),
  "local:100": snapshot("Beta", null),
  "remote:0": snapshot("Remote workspace", null),
};
const thread = (
  id: string,
  environmentId: string,
  title: string,
  extra: Partial<EnvironmentThreadShell> = {},
) =>
  ({
    id,
    environmentId,
    title,
    projectId: "project",
    worktreePath: environmentId === "local" ? "/fixture/Alpha" : "/fixture/Remote workspace",
    modelSelection: { model: "model" },
    runtime: null,
    updatedAt: "2026-10-06T00:00:00Z",
    ...extra,
  }) as EnvironmentThreadShell;
let container: HTMLDivElement;
let root: Root;
const render = () => act(async () => root.render(<AgentsOverview />));
const click = (label: string) =>
  act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click(),
  );
beforeEach(() => {
  mocks.connected = true;
  mocks.links = [];
  mocks.threads = [
    thread("same-id", "local", "Needs approval", { hasPendingApprovals: true }),
    thread("same-id", "remote", "Remote agent", {
      runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
    }),
    thread("old", "local", "Archived conversation", { archivedAt: "2026-10-05T00:00:00Z" }),
  ];
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
it("shows both computers and keeps earlier workspace pages while navigating the exact agent", async () => {
  await render();
  expect(container.textContent).toContain("Needs approval");
  expect(container.textContent).toContain("Remote agent");
  expect(container.textContent).not.toContain("Archived conversation");
  await click("Load more workspaces");
  expect(container.textContent).toContain("Alpha");
  expect(container.textContent).toContain("Beta");
  await act(async () =>
    [...container.querySelectorAll("a")]
      .find((link) => link.textContent?.includes("Remote agent"))!
      .click(),
  );
  expect(mocks.links).toContainEqual({
    to: "/$environmentId/$threadId",
    params: { environmentId: "remote", threadId: "same-id" },
    search: undefined,
  });
});
it("filters attention and restores archived agents on request, preserving disconnected status", async () => {
  await render();
  const select = container.querySelector<HTMLSelectElement>('select[aria-label="Agent status"]')!;
  await act(async () => {
    select.value = "attention";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(container.textContent).toContain("Needs approval");
  expect(container.textContent).not.toContain("Remote agent");
  await act(async () => {
    select.value = "all";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  });
  expect(container.textContent).toContain("Archived conversation");
  mocks.connected = false;
  await render();
  expect(container.textContent).toContain("Last observed · Approval needed");
});

const toggleWorkspace = (label: string) =>
  act(async () =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(),
  );

it("collapses inactive and empty workspaces and lets each workspace expand independently", async () => {
  mocks.threads = [thread("idle", "local", "Idle conversation")];
  await render();
  expect(container.textContent).not.toContain("Idle conversation");
  expect(
    container
      .querySelector('button[aria-label="Expand agents for Alpha"]')
      ?.getAttribute("aria-expanded"),
  ).toBe("false");
  await toggleWorkspace("Expand agents for Alpha");
  expect(container.textContent).toContain("Idle conversation");
  expect(
    container.querySelector('button[aria-label="Expand agents for Remote workspace"]'),
  ).not.toBeNull();
  await toggleWorkspace("Collapse agents for Alpha");
  expect(container.textContent).not.toContain("Idle conversation");
  await toggleWorkspace("Expand agents for Remote workspace");
  expect(container.textContent).toContain("No agents here yet.");
});

it("automatically shows only active agents and allows revealing other conversations", async () => {
  mocks.threads.push(thread("idle", "local", "Idle conversation"));
  await render();
  expect(container.textContent).toContain("Needs approval");
  expect(container.textContent).not.toContain("Idle conversation");
  await click("Show all 2 agents");
  expect(container.textContent).toContain("Idle conversation");
  await click("Show active agents only");
  expect(container.textContent).not.toContain("Idle conversation");
  await toggleWorkspace("Collapse agents for Alpha");
  mocks.threads = mocks.threads.map((item) => ({ ...item, updatedAt: "2026-10-06T01:00:00Z" }));
  await render();
  expect(container.textContent).not.toContain("Needs approval");
  expect(container.textContent).toContain("Remote agent");
});

it("opens when an agent becomes active and collapses after its activity ends", async () => {
  mocks.threads = [thread("changing", "local", "Changing agent")];
  await render();
  expect(container.textContent).not.toContain("Changing agent");
  mocks.threads = [
    thread("changing", "local", "Changing agent", {
      runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
    }),
  ];
  await render();
  expect(container.textContent).toContain("Changing agent");
  mocks.threads = [thread("changing", "local", "Changing agent")];
  await render();
  expect(container.textContent).not.toContain("Changing agent");
});

it("reveals idle search matches without requiring a workspace expansion", async () => {
  mocks.threads = [thread("idle", "local", "Find this conversation")];
  await render();
  const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Find this",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("Find this conversation");
  expect(container.querySelector('button[aria-label="Collapse agents for Alpha"]')).not.toBeNull();
});
