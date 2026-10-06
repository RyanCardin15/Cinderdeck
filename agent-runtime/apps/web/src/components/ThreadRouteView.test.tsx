// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
} from "@cinderdeck/client-runtime/state/threads";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { makeThreadFixture, makeThreadProjectionFixture } from "../test-fixtures";
import type { Thread } from "../types";
const boundary = vi.hoisted(() => ({ navigate: vi.fn(), observe: vi.fn(), clearDrops: vi.fn() }));
const ref = {
  environmentId: EnvironmentId.make("execution-computer"),
  threadId: ThreadId.make("accepted-thread"),
};
const shellAtom = Atom.make<Thread | null>(null);
const detailAtom = Atom.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
const emptyAtom = Atom.make(EMPTY_ENVIRONMENT_THREAD_STATE);
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => boundary.navigate }));
vi.mock("../hooks/useDiscardEmptySession", () => ({ useDiscardEmptySession: vi.fn() }));
vi.mock("./ChatView", () => ({
  default: ({ environmentId, threadId }: { environmentId: string; threadId: string }) => (
    <p data-testid="chat">
      Conversation {environmentId}/{threadId}
    </p>
  ),
}));
vi.mock("./ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => useAtomValue(shellAtom),
  useThreadRefs: () => [{ environmentId: "execution-computer", threadId: "older-thread" }],
  useEnvironmentThreadRefs: () => [
    { environmentId: "execution-computer", threadId: "older-thread" },
  ],
}));
vi.mock("../state/threads", () => ({
  useEnvironmentThread: (environmentId: string | null, threadId: string | null) => {
    boundary.observe(environmentId, threadId);
    return useAtomValue(environmentId && threadId ? detailAtom : emptyAtom);
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { snapshot: Option.some({}) }, error: null }),
}));
vi.mock("../state/shell", () => ({ environmentShell: { stateAtom: () => null } }));
vi.mock("../composerDraftStore", () => ({
  useBackgroundDraftSubmissionPending: () => false,
  useComposerDraftStore: (select: (store: unknown) => unknown) =>
    select({
      getDraftSession: () => null,
      getDraftThreadByRef: () => null,
      getDraftIdByRef: () => null,
      hasDraftThreadsInEnvironment: () => false,
    }),
  markPromotedDraftThreadByRef: vi.fn(),
  finalizePromotedDraftThreadByRef: vi.fn(),
}));
vi.mock("../sidebarPendingFileDropStore", () => ({
  useSidebarPendingFileDropStore: {
    getState: () => ({ clearPendingFileDropsForThread: boundary.clearDrops }),
  },
}));
import { ThreadRouteView } from "./ThreadRouteView";
let root: Root;
let registry: AtomRegistry.AtomRegistry;
let container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});
const render = async () => {
  await act(async () =>
    root.render(
      <RegistryContext value={registry}>
        <ThreadRouteView target={{ kind: "server", threadRef: ref }} />
      </RegistryContext>,
    ),
  );
};
it("retains an accepted conversation route while its independent shell catches up", async () => {
  await render();
  expect(container.textContent).toContain("Waiting for this conversation");
  expect(boundary.observe).toHaveBeenCalledWith(ref.environmentId, ref.threadId);
  expect(boundary.navigate).not.toHaveBeenCalled();
  expect(boundary.clearDrops).not.toHaveBeenCalled();
  await act(async () =>
    registry.set(detailAtom, {
      ...EMPTY_ENVIRONMENT_THREAD_STATE,
      status: "live",
      data: Option.some(makeThreadProjectionFixture()),
    }),
  );
  expect(boundary.navigate).not.toHaveBeenCalled();
  await act(async () =>
    registry.set(
      shellAtom,
      makeThreadFixture({ id: ref.threadId, environmentId: ref.environmentId }),
    ),
  );
  expect(container.querySelector('[data-testid="chat"]')?.textContent).toBe(
    `Conversation ${ref.environmentId}/${ref.threadId}`,
  );
  expect(boundary.observe).toHaveBeenLastCalledWith(null, null);
  expect(boundary.navigate).not.toHaveBeenCalled();
  expect(boundary.clearDrops).not.toHaveBeenCalled();
});
it("keeps transient and authorization lookup failures visible without creating a default draft", async () => {
  registry.set(detailAtom, {
    ...EMPTY_ENVIRONMENT_THREAD_STATE,
    error: Option.some("This computer is unavailable."),
  });
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "This computer is unavailable.",
  );
  expect(boundary.navigate).not.toHaveBeenCalled();
  expect(boundary.clearDrops).not.toHaveBeenCalled();
  await act(async () =>
    registry.set(detailAtom, {
      ...EMPTY_ENVIRONMENT_THREAD_STATE,
      error: Option.some("Access to this conversation was refused."),
    }),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Access to this conversation was refused.",
  );
  expect(boundary.navigate).not.toHaveBeenCalled();
});
it("redirects only when the exact thread observation confirms absence", async () => {
  await render();
  expect(boundary.navigate).not.toHaveBeenCalled();
  await act(async () =>
    registry.set(detailAtom, { ...EMPTY_ENVIRONMENT_THREAD_STATE, status: "deleted" }),
  );
  expect(boundary.clearDrops).toHaveBeenCalledWith(ref);
  expect(boundary.navigate).toHaveBeenCalledWith({ to: "/", replace: true });
});
