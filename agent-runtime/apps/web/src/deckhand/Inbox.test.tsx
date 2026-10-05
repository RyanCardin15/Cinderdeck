// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AttentionItem, AttentionPage } from "@t3tools/contracts/deckhand/attentionRpc";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  change: vi.fn(),
  connected: true,
  links: [] as Array<{ to: string; search?: unknown; params?: unknown }>,
}));
vi.mock("../state/entities", () => ({
  useThreadShells: () => [],
  useAllEnvironmentShellsBootstrapped: () => true,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "computer",
        label: "My computer",
        connection: { phase: mocks.connected ? "connected" : "disconnected" },
      },
    ],
  }),
}));
vi.mock("./ProductNavigation", () => ({ ProductNavigation: () => <nav>Deckhand</nav> }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => AsyncResult.initial() }));
vi.mock("./state", () => ({ workspaceView: () => null }));
vi.mock("./attentionState", () => ({ attentionList: "list", attentionChange: "change" }));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: "list" | "change") => mocks[command],
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    search,
    params,
  }: {
    children: ReactNode;
    to: string;
    search?: unknown;
    params?: unknown;
  }) => {
    mocks.links.push({ to, ...(search ? { search } : {}), ...(params ? { params } : {}) });
    return <a>{children}</a>;
  },
}));
import { Inbox } from "./Inbox";
const item: AttentionItem = {
  id: "cause",
  scopeKey: "thread:writer",
  causeVersion: "request1",
  kind: "input",
  title: "Your input is needed",
  detail: "Open the original question.",
  severity: "info",
  target: { kind: "thread", threadId: ThreadId.make("writer") },
  observedAt: "2026-10-03T00:00:00.000Z",
  state: "active",
  revision: 3,
  canSnooze: false,
  freshness: "current",
  read: false,
  snoozedUntil: null,
  dispositionRevision: 2,
};
let page: AttentionPage;
let container: HTMLDivElement;
let root: Root;
const render = () =>
  act(async () => {
    root.render(<Inbox />);
  });
const button = (text: string) =>
  Array.from(container.querySelectorAll("button")).find((value) => value.textContent === text)!;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connected = true;
  mocks.links = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  page = {
    items: [{ ...item }],
    total: 1,
    nextOffset: null,
    warnings: [],
    observedAt: item.observedAt,
  };
  mocks.list.mockImplementation(async () => ({ _tag: "Success", value: page }));
  mocks.change.mockResolvedValue({ _tag: "Failure" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("read uses exact cause/version and never answers or snoozes a blocking request", async () => {
  await render();
  expect(button("Mark read")).toBeDefined();
  expect(button("Snooze for 1 hour")).toBeUndefined();
  await act(async () => button("Mark read").click());
  expect(mocks.change).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("computer"),
    input: {
      id: "cause",
      causeVersion: "request1",
      revision: 3,
      dispositionRevision: 2,
      action: "read",
    },
  });
  expect(container.textContent).toContain("This cause changed");
  expect(mocks.links).toContainEqual({
    to: "/$environmentId/$threadId",
    params: { environmentId: "computer", threadId: "writer" },
  });
});
it("disconnect retains last observed items and disables preferences while keeping recovery navigation", async () => {
  await render();
  mocks.connected = false;
  await render();
  expect(container.textContent).toContain("Current state is unavailable");
  expect(container.textContent).toContain("Last observed · input");
  expect(button("Mark read").disabled).toBe(true);
  expect(mocks.change).not.toHaveBeenCalled();
});
it("native failures and blocked reviewers navigate their original execution computer and lane", async () => {
  page = {
    ...page,
    items: [
      {
        ...item,
        kind: "run_failure",
        canSnooze: true,
        target: {
          kind: "runs",
          runID: "failed-run",
          context: { installationID: "native", workspaceID: "lane", generation: 7 },
        },
      },
      {
        ...item,
        id: "review",
        kind: "review_blocked",
        target: {
          kind: "review",
          operationKey: "queued-review",
          threadId: null,
          baseWorkspaceID: "base",
          context: { installationID: "native", workspaceID: "original-lane", generation: 4 },
        },
      },
    ],
  };
  await render();
  expect(mocks.links).toContainEqual({
    to: "/services",
    search: {
      environment: "computer",
      workspace: "lane",
      run: "failed-run",
      expectedGeneration: 7,
      expectedInstallationID: "native",
    },
  });
  expect(mocks.links).toContainEqual({
    to: "/workspaces",
    search: {
      environment: "computer",
      workspace: "base",
      context: "original-lane",
      expectedGeneration: 4,
      expectedInstallationID: "native",
    },
  });
  expect(container.textContent).toContain("Workspace generation 4");
});
