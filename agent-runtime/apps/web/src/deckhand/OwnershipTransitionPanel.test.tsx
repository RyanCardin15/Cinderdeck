// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import type * as C from "@cinderdeck/contracts/deckhand/ownershipRpc";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({
  preview: vi.fn(),
  submit: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
}));
const selection = vi.hoisted(() => ({
  environments: [] as unknown[],
  threads: [] as unknown[],
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    state: "connected",
    hello: { installationID: "installation" },
    resources: [
      {
        workspaceID: "base",
        generation: 1,
        revision: "revision",
        available: true,
        workspace: { name: "Existing workspace", lane: null },
      },
    ],
    nextOffset: null,
  }),
}));
vi.mock("effect/unstable/reactivity", () => ({
  AsyncResult: { value: (value: unknown) => ({ _id: "Option", _tag: "Some", value }) },
}));
vi.mock("./state", () => ({ workspaceView: () => null }));
vi.mock("./ownershipState", () => ({
  ownershipPreview: "preview",
  ownershipSubmit: "submit",
  ownershipGet: "get",
  ownershipList: "list",
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (tag: keyof typeof commands) => commands[tag],
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: selection.environments }),
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../state/entities", () => ({ useThreadShells: () => selection.threads }));
vi.mock("../lib/utils", () => ({ randomUUID: () => "stable-intent" }));
import { OwnershipTransitionForm, OwnershipTransitionPanel } from "./OwnershipTransitionPanel";
const preview: C.OwnershipPreview = {
  intent: {
    operationKey: "stable-intent",
    threadId: ThreadId.make("thread"),
    direction: "adopt",
    installationID: "installation",
    workspaceID: "base",
    generation: 1,
    revision: "revision",
  },
  checkout: {
    physicalId: "physical",
    repositoryPhysicalId: "repo",
    root: "/fixture/worktree",
    commonDirectory: "/fixture/.git",
    gitDirectory: "/fixture/.git/worktrees/existing",
    branch: "existing",
    commit: "abc",
    remotes: [],
  },
  affectedThreads: [{ threadId: ThreadId.make("thread"), title: "Retained conversation" }],
  sourceCheckoutIDs: [],
  blockers: [],
};
const pending: C.OwnershipRecord = {
  id: "ownership-receipt",
  operationKey: "stable-intent",
  threadId: ThreadId.make("thread"),
  direction: "adopt",
  state: "unknown_outcome",
  original: preview,
  createdAt: "now",
  updatedAt: "now",
  nativeOperationID: "native",
  targetCheckoutID: null,
  detail: "Recover the original receipt before starting work.",
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  selection.environments = [];
  selection.threads = [];
  commands.list.mockResolvedValue({
    _tag: "Success",
    value: { items: [], total: 0, nextOffset: null },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("uses the settings computer for worktree management and only lists its conversations", async () => {
  selection.environments = [
    { environmentId: "computer", connection: { phase: "connected" } },
    { environmentId: "remote", connection: { phase: "connected" } },
  ];
  selection.threads = [
    {
      id: "local-thread",
      title: "Local conversation",
      environmentId: "computer",
      worktreePath: "/fixture/local",
      deletedAt: null,
    },
    {
      id: "remote-thread",
      title: "Remote conversation",
      environmentId: "remote",
      worktreePath: "/fixture/remote",
      deletedAt: null,
    },
  ];
  await act(async () =>
    root.render(<OwnershipTransitionPanel environmentId={EnvironmentId.make("remote")} embedded />),
  );
  expect(container.querySelectorAll("select")).toHaveLength(1);
  expect(container.textContent).toContain("Remote conversation");
  expect(container.textContent).not.toContain("Local conversation");
  expect(commands.list).not.toHaveBeenCalled();
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = "remote-thread";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(commands.list).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { threadId: "remote-thread", offset: 0, limit: 20 },
  });
  expect(commands.preview).not.toHaveBeenCalled();
  expect(commands.submit).not.toHaveBeenCalled();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = async () => {
  await act(async () =>
    root.render(
      <OwnershipTransitionForm
        environmentID={EnvironmentId.make("computer")}
        threadID={ThreadId.make("thread")}
      />,
    ),
  );
};
const click = async (text: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
const choose = async () => {
  const select = container.querySelectorAll("select")[1]!;
  await act(async () => {
    select.value = "base";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
it("requires deliberate preview and confirmation, then recovers the same uncertain receipt without resubmitting", async () => {
  commands.preview.mockResolvedValue({ _tag: "Success", value: preview });
  commands.submit.mockResolvedValue({ _tag: "Success", value: pending });
  commands.get.mockResolvedValue({
    _tag: "Success",
    value: {
      ...pending,
      state: "completed",
      targetCheckoutID: "effective",
      detail: "Original conversations retained.",
    },
  });
  await render();
  expect(commands.preview).not.toHaveBeenCalled();
  expect(commands.submit).not.toHaveBeenCalled();
  await choose();
  await click("Preview ownership change");
  expect(container.textContent).toContain("Retained conversation");
  expect(container.textContent).toContain("starts no agent, service or setup task");
  expect(commands.submit).not.toHaveBeenCalled();
  await click("Adopt worktree");
  expect(commands.submit).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("unknown outcome");
  expect(container.querySelectorAll("select")[0]!.disabled).toBe(true);
  await click("Recover this receipt");
  expect(commands.get).toHaveBeenCalledWith({
    environmentId: "computer",
    input: { id: "ownership-receipt" },
  });
  expect(commands.submit).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Ownership completed");
});
it("shows the authoritative stopped-work blocker and never offers a mutation", async () => {
  commands.preview.mockResolvedValue({
    _tag: "Success",
    value: { ...preview, blockers: ["Stop the existing provider first."] },
  });
  await render();
  await choose();
  await click("Preview ownership change");
  expect(container.textContent).toContain("Stop the existing provider first.");
  expect(
    Array.from(container.querySelectorAll("button")).some(
      (item) => item.textContent === "Adopt worktree",
    ),
  ).toBe(false);
  expect(commands.submit).not.toHaveBeenCalled();
});
