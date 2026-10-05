// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId } from "@cinderdeck/contracts";
import type { ManagedSessionView } from "@cinderdeck/contracts/deckhand/rpc";
import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const transport = vi.hoisted(() => ({ phase: "connected" }));
const controls = vi.hoisted(() => ({
  show: vi.fn(),
  confirm: vi.fn(),
  navigate: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  unread: vi.fn(),
  pin: vi.fn(),
  unpin: vi.fn(),
  shell: { runtime: null, pinnedAt: null as string | null },
}));
vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: controls.show },
    dialogs: { confirm: controls.confirm },
  }),
}));
vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    deleteThread: controls.delete,
    archiveThread: controls.archive,
    unarchiveThread: controls.restore,
    markThreadUnread: controls.unread,
    pinThread: controls.pin,
    confirmAndUnpinThread: controls.unpin,
  }),
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: object) => unknown) =>
    select({ confirmThreadArchive: true, confirmThreadDelete: true }),
}));
vi.mock("../state/entities", () => ({
  useThreadShell: () => null,
  readThreadShell: () => controls.shell,
  readEnvironmentSupportsPinning: () => true,
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { updateMetadata: {} } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => controls.update }));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: transport.phase } }),
}));
vi.mock("./ExternalSessionList", () => ({ ExternalSessionList: () => null }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => controls.navigate,
  Link: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props} href="#conversation">
      {children}
    </a>
  ),
}));
const queries = new Map<
  string,
  Atom.Writable<AsyncResult.AsyncResult<ReadonlyArray<ManagedSessionView>, Error>>
>();
vi.mock("./state", () => ({
  managedSessionsView: (target: object) => {
    const key = JSON.stringify(target);
    if (!queries.has(key))
      queries.set(
        key,
        Atom.make<AsyncResult.AsyncResult<ReadonlyArray<ManagedSessionView>, Error>>(
          AsyncResult.initial(),
        ),
      );
    return queries.get(key)!;
  },
}));
import { SessionList } from "./SessionList";

const environmentId = EnvironmentId.make("computer");
const session = {
  title: "Current review",
  source: "current",
  archived: false,
  binding: {
    id: "saved-session",
    threadId: "thread",
    providerInstanceId: "codex",
    role: "reviewer",
    execution: "working",
    connection: "connected",
  },
} as ManagedSessionView;
let root: Root;
let element: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
const target = (generation: number, offset = 0) => ({
  environmentId,
  input: {
    installationID: "installation",
    workspaceID: "lane",
    generation,
    limit: 20,
    ...(offset ? { offset } : {}),
  },
});
const resultAtom = (generation = 3, offset = 0) =>
  queries.get(JSON.stringify(target(generation, offset)))!;
const render = async (generation = 3, presentation: "default" | "workspace" = "default") =>
  act(async () => {
    root.render(
      <RegistryContext.Provider value={registry}>
        <SessionList
          environmentId={environmentId}
          installationID="installation"
          workspaceID="lane"
          generation={generation}
          presentation={presentation}
          providers={[{ instanceId: "codex", displayName: "Configured Codex" }]}
        />
      </RegistryContext.Provider>,
    );
  });
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  transport.phase = "connected";
  vi.clearAllMocks();
  controls.show.mockResolvedValue(null);
  controls.confirm.mockResolvedValue(true);
  for (const command of [
    controls.delete,
    controls.archive,
    controls.restore,
    controls.update,
    controls.pin,
    controls.unpin,
  ])
    command.mockResolvedValue({ _tag: "Success", value: undefined });
  controls.shell.pinnedAt = null;
  queries.clear();
  registry = AtomRegistry.make({ defaultIdleTTL: 400 });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});

const openMenu = async (action: string | null, keyboard = false) => {
  controls.show.mockResolvedValueOnce(action);
  const row = element.querySelector("a")!;
  await act(async () =>
    row.dispatchEvent(
      keyboard
        ? new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            key: "F10",
            shiftKey: true,
          })
        : new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: 45,
            clientY: 60,
          }),
    ),
  );
};
it("deletes the clicked conversation in its execution environment after confirmation", async () => {
  await render();
  await act(async () => registry.set(resultAtom(), AsyncResult.success([session])));
  await openMenu("delete");
  expect(controls.confirm).toHaveBeenCalledWith(expect.stringContaining("Current review"), {
    variant: "destructive",
  });
  expect(controls.delete).toHaveBeenCalledWith({ environmentId, threadId: "thread" });
  expect(controls.navigate).not.toHaveBeenCalled();
  controls.confirm.mockResolvedValueOnce(false);
  await openMenu("delete");
  expect(controls.delete).toHaveBeenCalledTimes(1);
});
it("supports keyboard menus, archiving and restoring the same saved session", async () => {
  await render();
  await act(async () => registry.set(resultAtom(), AsyncResult.success([session])));
  await openMenu("archive", true);
  expect(controls.archive).toHaveBeenCalledWith({ environmentId, threadId: "thread" });
  await act(async () =>
    registry.set(resultAtom(), AsyncResult.success([{ ...session, archived: true }])),
  );
  await openMenu("unarchive");
  expect(controls.restore).toHaveBeenCalledWith({ environmentId, threadId: "thread" });
});
it("keeps disconnected rows navigable and prevents stale destructive actions", async () => {
  await render();
  await act(async () => registry.set(resultAtom(), AsyncResult.success([session])));
  transport.phase = "reconnecting";
  await render();
  await openMenu("delete");
  expect(controls.delete).not.toHaveBeenCalled();
  expect(controls.confirm).not.toHaveBeenCalled();
  await openMenu("open");
  expect(controls.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ params: expect.any(Object) }),
  );
});
it("renames without leaving the roster and sends the trimmed title to the exact thread", async () => {
  await render();
  await act(async () => registry.set(resultAtom(), AsyncResult.success([session])));
  await openMenu("rename");
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')!;
  expect(input.value).toBe("Current review");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "  Renamed review  ",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(controls.update).toHaveBeenCalledWith({
    environmentId,
    input: { threadId: "thread", title: "Renamed review" },
  });
  expect(controls.navigate).not.toHaveBeenCalled();
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  element.remove();
  vi.unstubAllGlobals();
});
it.each(["default", "workspace"] as const)(
  "%s roster retains navigation but requires a fresh session value after transport recovery",
  async (presentation) => {
    await render(3, presentation);
    await act(async () => registry.set(resultAtom(), AsyncResult.success([session])));
    expect(element.textContent).toContain("Working · Agent connected");
    expect(element.textContent).toContain("Configured Codex");
    transport.phase = "reconnecting";
    await render(3, presentation);
    expect(element.textContent).toContain("Current review");
    expect(element.textContent).toContain("Last observed · Agent not connected");
    expect(element.textContent).not.toContain("Working · Agent connected");
    expect(element.querySelector("a")).not.toBeNull();
    transport.phase = "connected";
    await render(3, presentation);
    expect(element.textContent).not.toContain("Working · Agent connected");
    await act(async () => registry.set(resultAtom(), AsyncResult.success([{ ...session }])));
    expect(element.textContent).toContain("Working · Agent connected");
    expect(element.textContent).not.toContain("Last observed");
  },
);
it("clears a departed generation and cannot show its late session response", async () => {
  await render();
  await act(async () => registry.set(resultAtom(), AsyncResult.success([session])));
  await render(4);
  expect(element.textContent).toContain("Loading sessions");
  expect(element.textContent).not.toContain("Current review");
  await act(async () => registry.set(resultAtom(3), AsyncResult.success([session])));
  expect(element.textContent).not.toContain("Current review");
  await act(async () => registry.set(resultAtom(4), AsyncResult.success([])));
  expect(element.textContent).toContain("No managed sessions in this context yet");
});
it("settles initial failures as unavailable and preserves historical rows after a failed refresh", async () => {
  await render();
  await act(async () =>
    registry.set(resultAtom(), AsyncResult.failure(Cause.fail(new Error("refused")))),
  );
  expect(element.textContent).toContain("Session state is unavailable");
  expect(element.textContent).not.toContain("Loading sessions");
  await act(async () => registry.set(resultAtom(), AsyncResult.success([session])));
  await act(async () =>
    registry.set(
      resultAtom(),
      AsyncResult.failureWithPrevious(Cause.fail(new Error("refused")), {
        previous: Option.some(registry.get(resultAtom())),
      }),
    ),
  );
  expect(element.textContent).toContain("Current review");
  expect(element.textContent).toContain("Unknown · Agent not connected");
  expect(element.textContent).not.toContain("Working · Agent connected");
});
it("presents current agent connection states plainly and keeps stale execution historical", async () => {
  await render();
  const labels = {
    connected: "Interrupted · Agent connected",
    reconnecting: "Interrupted · Agent connecting",
    unavailable: "Interrupted · Agent not connected",
    stale: "Last observed · Agent not connected",
  } as const;
  for (const connection of Object.keys(labels) as Array<keyof typeof labels>) {
    await act(async () =>
      registry.set(
        resultAtom(),
        AsyncResult.success([
          {
            ...session,
            binding: { ...session.binding, execution: "interrupted", connection },
          },
        ]),
      ),
    );
    expect(element.textContent).toContain(labels[connection]);
    expect(element.textContent).not.toContain("· unavailable");
    if (connection === "stale") expect(element.textContent).not.toContain("Interrupted");
  }
});

const firstPage = () =>
  Array.from({ length: 20 }, (_, index) => ({
    ...session,
    title: `Saved agent ${index + 1}`,
    binding: { ...session.binding, id: `saved-session-${index}` as typeof session.binding.id },
  }));
const clickPage = async (label: string) => {
  const button = [...element.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  )!;
  expect(button).toBeDefined();
  await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
};
it("opens older agents in the exact context and resets paging after a generation change", async () => {
  await render();
  await act(async () => registry.set(resultAtom(), AsyncResult.success(firstPage())));
  await clickPage("Next sessions");
  expect(element.textContent).toContain("Loading sessions");
  expect(element.textContent).not.toContain("Saved agent 1");
  const older = { ...session, title: "Original saved reviewer" };
  await act(async () => registry.set(resultAtom(3, 20), AsyncResult.success([older])));
  expect(element.textContent).toContain("Original saved reviewer");
  expect(element.textContent).toContain("Sessions 21–21 in this context");
  await render(4);
  expect(element.textContent).not.toContain("Original saved reviewer");
  expect(queries.has(JSON.stringify(target(4)))).toBe(true);
  expect(queries.has(JSON.stringify(target(4, 20)))).toBe(false);
  await act(async () => registry.set(resultAtom(3, 20), AsyncResult.success([older])));
  expect(element.textContent).not.toContain("Original saved reviewer");
});
it("keeps an empty older page recoverable and refuses silently repeated legacy pages", async () => {
  await render();
  const newest = firstPage();
  await act(async () => registry.set(resultAtom(), AsyncResult.success(newest)));
  await clickPage("Next sessions");
  await act(async () => registry.set(resultAtom(3, 20), AsyncResult.success([])));
  expect(element.textContent).toContain("No older sessions on this page");
  expect(element.textContent).not.toContain("No managed sessions in this context yet");
  await clickPage("Previous sessions");
  await clickPage("Next sessions");
  await act(async () => registry.set(resultAtom(3, 20), AsyncResult.success([...newest])));
  expect(element.textContent).toContain("Older-session paging could not be confirmed");
  expect(element.textContent).not.toContain("Sessions 21–40");
  expect(
    [...element.querySelectorAll("button")].find((item) => item.textContent === "Next sessions")
      ?.disabled,
  ).toBe(true);
});
