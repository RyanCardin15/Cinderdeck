// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Rpc from "@t3tools/contracts/deckhand/rpc";
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
}));
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
};
const click = async (text: string) => {
  const button = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === text,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
};
beforeEach(() => {
  vi.clearAllMocks();
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
  expect(container.textContent).toContain("a".repeat(40));
  expect(commands.launch).not.toHaveBeenCalled();
  await click("Schedule reviewer");
  expect(commands.launch).toHaveBeenCalledTimes(1);
  const body = commands.launch.mock.calls[0]![0].input;
  expect(body.preview.reviewerContext.featureId).toBe("feature");
  expect(body.preview.reviewerContext.sourceCheckoutId).toBe("checkout");
  expect(container.textContent).toContain("Open reviewer conversation");
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
  expect(container.textContent).toContain("Continue saved review");
  expect(container.textContent).not.toContain("Start another review");
  await click("Continue saved review");
  expect(commands.launch.mock.calls[0]![0].input).toEqual(original);
});
it("retains one queued request, stops only its exact writer, and allows safe cancellation", async () => {
  const waiting = {
    state: "waiting_writer",
    detail: "Waiting for the writer process to release its reservation.",
    creation: null,
  };
  commands.launch.mockResolvedValue({ _tag: "Success", value: waiting });
  commands.inspectQueue.mockResolvedValue({ _tag: "Success", value: waiting });
  commands.stop.mockResolvedValue({
    _tag: "Success",
    value: { state: "released", detail: "Writer stopped; transcript preserved." },
  });
  commands.cancel.mockResolvedValue({
    _tag: "Success",
    value: { ...waiting, state: "cancelled", detail: "Review cancelled." },
  });
  await render();
  await click("Inspect committed revision");
  await click("Schedule reviewer");
  expect(container.textContent).not.toContain("Start another review");
  await click("Stop writer and release review");
  expect(commands.stop).toHaveBeenCalledWith({
    environmentId: "host",
    input: { threadId: "writer", providerSessionId: "provider-writer" },
  });
  expect(container.textContent).toContain("transcript preserved");
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
  expect(container.textContent).not.toContain("Start another review");
  expect(localStorage.getItem("deckhand:reviewer:host:writer")).not.toBeNull();
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
      receipt: { state: "failed", result: null, error: { code: "checkout_reserved" } },
    },
  });
  await render();
  const continuation = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === "Continue saved review",
  );
  expect(continuation?.disabled).toBe(true);
  await click("Check saved result");
  await click("Start another review");
  expect(commands.launch).not.toHaveBeenCalled();
});
