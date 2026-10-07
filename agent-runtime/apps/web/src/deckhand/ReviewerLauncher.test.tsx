// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import * as Rpc from "@cinderdeck/contracts/deckhand/rpc";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
const commands = vi.hoisted(() => ({
  preview: vi.fn(),
  launch: vi.fn(),
  options: vi.fn(),
  inspect: vi.fn(),
  inspectQueue: vi.fn(),
  cancel: vi.fn(),
  stop: vi.fn(),
  navigate: vi.fn(),
  defaultModel: null as import("@cinderdeck/contracts").ModelSelection | null,
}));
vi.mock("./state", () => ({
  previewReviewer: "preview",
  scheduleReviewer: "launch",
  inspectReviewerQueue: "inspectQueue",
  cancelReviewerQueue: "cancel",
  stopReviewerSource: "stop",
  sessionLaunchOptions: "options",
  inspectSessionCreation: "inspect",
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: keyof typeof commands) => commands[command],
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => commands.navigate,
}));
vi.mock("../hooks/useSettings", () => ({
  useEnvironmentSettings: () => ({
    ...DEFAULT_SERVER_SETTINGS,
    defaultModelSelection: commands.defaultModel,
  }),
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: "config" }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("../state/entities", () => ({ readProjects: () => [] }));
vi.mock("../components/chat/TraitsPicker", () => ({ TraitsPicker: () => null }));
vi.mock("../lib/runtime", () => ({ runtime: { runPromise: async () => "review-operation" } }));
import { ReviewerLauncher } from "./ReviewerLauncher";
const preview = Schema.decodeSync(Rpc.ReviewerLaunchPreview)({
  installationID: "installation",
  workspaceID: "workspace",
  generation: 2,
  revision: "reviewed-base",
  repositoryID: "frontend",
  title: "Retry",
  reviewerContext: {
    featureId: "feature",
    sourceCheckoutId: "checkout",
    sourceWorkspaceID: "lane",
    sourceGeneration: 7,
    sourceRevision: "source-head",
    repositories: [
      {
        repositoryID: "frontend",
        sourcePhysicalId: "physical",
        repositoryPhysicalId: "repo",
        commit: "a".repeat(40),
      },
    ],
  },
});
const threadRef = { environmentId: EnvironmentId.make("host"), threadId: ThreadId.make("writer") };
let container: HTMLDivElement;
let root: Root;
const render = async () => {
  await act(async () => {
    root.render(
      <ReviewerLauncher threadRef={threadRef} providerSessionId="provider-writer" enabled />,
    );
  });
  await click("Schedule isolated review");
};
const click = async (text: string) => {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (item) => item.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  commands.defaultModel = null;
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  commands.options.mockResolvedValue({
    _tag: "Success",
    value: [
      { instanceId: "codex", label: "Codex", models: [{ id: "gpt-test", label: "Test model" }] },
    ],
  });
  commands.inspectQueue.mockResolvedValue({ _tag: "Success", value: null });
  commands.preview.mockResolvedValue({ _tag: "Success", value: preview });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("inspects actual heads, persists request before dispatch, and opens the accepted isolated reviewer", async () => {
  commands.launch.mockImplementation(async ({ input }) => {
    expect(JSON.parse(localStorage.getItem("deckhand:reviewer:host:writer")!)).toEqual(input);
    return {
      _tag: "Success",
      value: {
        operationKey: input.operationKey,
        state: "accepted",
        creation: { threadID: "reviewer" },
      },
    };
  });
  await render();
  expect(commands.preview).not.toHaveBeenCalled();
  expect(commands.launch).not.toHaveBeenCalled();
  await click("Inspect committed revision");
  expect(document.body.textContent).toContain("a".repeat(40));
  expect(commands.launch).not.toHaveBeenCalled();
  await click("Schedule reviewer");
  expect(commands.launch).toHaveBeenCalledTimes(1);
  const body = commands.launch.mock.calls[0]![0].input;
  expect(body.preview.reviewerContext.featureId).toBe("feature");
  expect(body.preview.reviewerContext.sourceCheckoutId).toBe("checkout");
  expect(document.body.textContent).toContain("Open reviewer conversation");
  expect(commands.navigate).toHaveBeenCalledTimes(1);
});
it("prefills the chosen model and reasoning, and saves the workspace skill with the review", async () => {
  commands.defaultModel = {
    instanceId: "codex" as import("@cinderdeck/contracts").ProviderInstanceId,
    model: "gpt-test",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
  commands.preview.mockResolvedValue({
    _tag: "Success",
    value: {
      ...preview,
      codeReviewSkill: {
        path: "/fixture/.cinderdeck/skills/code-review/SKILL.md",
        content: "Inspect transactional boundaries.",
        configured: true,
      },
    },
  });
  commands.launch.mockResolvedValue({
    _tag: "Success",
    value: { state: "accepted", creation: { threadID: "reviewer" } },
  });
  await render();
  await click("Inspect committed revision");
  expect(document.body.textContent).toContain("Inspect transactional boundaries.");
  await click("Schedule reviewer");
  const request = commands.launch.mock.calls[0]![0].input;
  expect(request.modelSelection).toEqual(commands.defaultModel);
  expect(request.preview.codeReviewSkill.content).toBe("Inspect transactional boundaries.");
});
it("describes a fresh inspection failure without referring to a nonexistent saved request", async () => {
  commands.preview.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Rpc.DeckhandRpcError({ reason: "stale_context" })),
  });
  await render();
  await click("Inspect committed revision");
  expect(document.body.textContent).toContain("Refresh the workspace connection");
  expect(document.body.textContent).not.toContain("saved request");
  expect(commands.launch).not.toHaveBeenCalled();
});
it("reloads an uncertain request without launching and continues the exact original revision", async () => {
  commands.launch.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Rpc.DeckhandRpcError({ reason: "unknown" })),
  });
  await render();
  await click("Inspect committed revision");
  await click("Schedule reviewer");
  const original = commands.launch.mock.calls[0]![0].input;
  await act(async () => root.unmount());
  root = createRoot(container);
  commands.launch.mockClear();
  commands.preview.mockClear();
  await render();
  expect(commands.launch).not.toHaveBeenCalled();
  expect(commands.preview).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Continue saved review");
  expect(document.body.textContent).not.toContain("Start another review");
  await click("Continue saved review");
  expect(commands.launch.mock.calls[0]![0].input).toEqual(original);
});
it("retains one queued request without stopping its writer and allows cancellation", async () => {
  const waiting = {
    state: "queued",
    detail: "Review scheduled.",
    creation: null,
  };
  commands.launch.mockResolvedValue({ _tag: "Success", value: waiting });
  commands.inspectQueue.mockResolvedValue({ _tag: "Success", value: waiting });
  commands.cancel.mockResolvedValue({
    _tag: "Success",
    value: { ...waiting, state: "cancelled", detail: "Review cancelled." },
  });
  await render();
  await click("Inspect committed revision");
  await click("Schedule reviewer");
  expect(document.body.textContent).not.toContain("Start another review");
  expect(commands.stop).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("Stop writer");
  await click("Cancel scheduled review");
  expect(commands.cancel.mock.calls[0]![0].input.operationKey).toBe("review-operation");
  await click("Start another review");
  expect(localStorage.getItem("deckhand:reviewer:host:writer")).toBeNull();
});
it("keeps unknown outcomes on their original key and does not offer a new review", async () => {
  commands.launch.mockResolvedValue({
    _tag: "Success",
    value: {
      state: "unknown_outcome",
      detail: "Native result uncertain",
      creation: { laneID: "partial" },
    },
  });
  await render();
  await click("Inspect committed revision");
  await click("Schedule reviewer");
  expect(document.body.textContent).not.toContain("Start another review");
  expect(localStorage.getItem("deckhand:reviewer:host:writer")).not.toBeNull();
});
it("opens the reviewer once when queued creation is accepted after submission", async () => {
  commands.launch.mockResolvedValue({
    _tag: "Success",
    value: { state: "queued", creation: null },
  });
  commands.inspectQueue.mockResolvedValue({
    _tag: "Success",
    value: { state: "queued", creation: null },
  });
  await render();
  await click("Inspect committed revision");
  vi.useFakeTimers();
  try {
    await click("Schedule reviewer");
    expect(commands.navigate).not.toHaveBeenCalled();
    commands.inspectQueue.mockResolvedValue({
      _tag: "Success",
      value: { state: "accepted", creation: { threadID: "reviewer" } },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(commands.navigate).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(commands.navigate).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it("does not migrate a saved direct review into a second queued creation", async () => {
  localStorage.setItem(
    "deckhand:reviewer:host:writer",
    JSON.stringify({
      operationKey: "legacy",
      preview,
      modelSelection: { instanceId: "codex", model: "gpt-test" },
      runtimeMode: "approval-required",
      objective: "Review",
    }),
  );
  commands.inspect.mockResolvedValue({
    _tag: "Success",
    value: {
      state: "failed",
      laneID: null,
      launch: null,
      receipt: { state: "failed", result: null, error: { code: "invalid_params" } },
    },
  });
  await render();
  const continuation = Array.from(document.body.querySelectorAll("button")).find(
    (item) => item.textContent === "Continue saved review",
  );
  expect(continuation?.disabled).toBe(true);
  await click("Check saved result");
  await click("Start another review");
  expect(commands.launch).not.toHaveBeenCalled();
});
