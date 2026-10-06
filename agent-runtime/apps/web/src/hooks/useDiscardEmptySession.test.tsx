// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@cinderdeck/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const controls = vi.hoisted(() => ({
  discard: vi.fn(),
  supports: true,
  started: false,
  draft: false,
  pending: {} as Record<string, boolean>,
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => controls.discard }));
vi.mock("../state/threads", () => ({ threadEnvironment: { delete: {} } }));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsEmptyThreadDiscard: () => controls.supports,
  readThreadShell: () => ({
    latestRun: null,
    latestUserMessageAt: controls.started ? "2026-10-06T00:00:00Z" : null,
    runtime: null,
  }),
}));
vi.mock("../composerDraftStore", () => ({
  composerDraftHasUserContent: (draft: boolean) => draft,
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: () => controls.draft,
      getDraftIdByRef: () => null,
      backgroundSubmissionThreadKeys: controls.pending,
    }),
  },
}));
import { preserveSessionOnSubmission, useDiscardEmptySession } from "./useDiscardEmptySession";

const ref = {
  environmentId: EnvironmentId.make("computer-a"),
  threadId: ThreadId.make("empty-chat"),
};
let root: Root;
let container: HTMLDivElement;
function View({ target }: { target: ScopedThreadRef | null }) {
  useDiscardEmptySession(target);
  return null;
}
const render = async (target: ScopedThreadRef | null = ref) => {
  await act(async () =>
    root.render(
      <StrictMode>
        <View target={target} />
      </StrictMode>,
    ),
  );
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  controls.discard.mockReset().mockResolvedValue({ _tag: "Success" });
  controls.supports = true;
  controls.started = false;
  controls.draft = false;
  controls.pending = {};
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it("discards on departure, never on StrictMode mount or same-thread rerender", async () => {
  await render();
  await render({ ...ref });
  expect(controls.discard).not.toHaveBeenCalled();
  await render(null);
  expect(controls.discard).toHaveBeenCalledExactlyOnceWith({
    environmentId: ref.environmentId,
    input: { threadId: ref.threadId, onlyIfUnused: true },
  });
});

it("cleans up the old computer's chat when switching to a different environment", async () => {
  await render();
  await render({ ...ref, environmentId: EnvironmentId.make("computer-b") });
  expect(controls.discard).toHaveBeenCalledExactlyOnceWith({
    environmentId: ref.environmentId,
    input: { threadId: ref.threadId, onlyIfUnused: true },
  });
});

it("preserves a send before history arrives even if the composer has already cleared", async () => {
  await render();
  preserveSessionOnSubmission(ref);
  await render(null);
  expect(controls.discard).not.toHaveBeenCalled();
});

it.each(["draft", "started"] as const)("preserves %s content on departure", async (kind) => {
  await render();
  controls[kind] = true;
  await render(null);
  expect(controls.discard).not.toHaveBeenCalled();
});

it("keeps older servers safe by refusing an unsupported guarded delete", async () => {
  controls.supports = false;
  await render();
  await render(null);
  expect(controls.discard).not.toHaveBeenCalled();
});

it("discards an unused chat when the route unmounts entirely", async () => {
  await render();
  await act(async () => root.unmount());
  expect(controls.discard).toHaveBeenCalledOnce();
});
