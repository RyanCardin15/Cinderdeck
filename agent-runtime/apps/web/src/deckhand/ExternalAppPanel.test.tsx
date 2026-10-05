// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@cinderdeck/contracts";
import { scopeThreadRef } from "@cinderdeck/client-runtime/environment";
import type { DebugSession, DebugTarget } from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import { EXCEL_EXTERNAL_APP } from "@cinderdeck/contracts/deckhand/externalAppPreferences";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Request = { environmentId: string; input: Record<string, unknown> };
const mocks = vi.hoisted(() => ({
  discover: vi.fn<(request: Request) => Promise<unknown>>(),
  attach: vi.fn<(request: Request) => Promise<unknown>>(),
  sessions: vi.fn<(request: Request) => Promise<unknown>>(),
  detach: vi.fn<(request: Request) => Promise<unknown>>(),
  read: vi.fn<(request: Request) => Promise<unknown>>(),
  run: vi.fn<(request: Request) => Promise<unknown>>(),
  settings: { externalAppProfiles: [] as (typeof EXCEL_EXTERNAL_APP)[] },
  listeners: new Set<() => void>(),
}));
vi.mock("./externalDebugState", () => ({
  discoverDebugTargets: "discover",
  attachDebugTarget: "attach",
  listDebugSessions: "sessions",
  detachDebugSession: "detach",
  readDebugSession: "read",
  runDebugCommand: "run",
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (name: "discover" | "attach" | "sessions" | "detach" | "read" | "run") =>
    mocks[name],
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "local", label: "Test Mac" }] }),
}));
vi.mock("@cinderdeck/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cinderdeck/client-runtime/state/runtime")>()),
  squashAtomCommandFailure: (failure: { cause: unknown }) => failure.cause,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock("../hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePrimarySettingsAvailable: () => true,
    useClearScopedSettings: () => () => {},
    useProjectSettingsOverride: () => undefined,
    useClientSettings: () =>
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => {
            mocks.listeners.delete(listener);
          };
        },
        () => mocks.settings,
      ),
    useUpdateClientSettings: () => (patch: typeof mocks.settings) => {
      mocks.settings = { ...mocks.settings, ...patch };
      for (const listener of mocks.listeners) listener();
    },
  };
});
import { ExternalAppPanel } from "./ExternalAppPanel";
import { ExternalAppsSettings } from "../components/settings/ExternalAppsSettings";
import { externalAppBindingKey, useExternalAppSessions } from "./externalAppSessions";

const ref = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-a"));
const other = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("thread-b"));
const app: DebugTarget = {
  id: "mac:10:1",
  app: "Excel",
  title: "Workbook",
  url: "com.microsoft.Excel",
  type: "mac-window",
};
const inspector: DebugTarget = { ...app, id: "mac:10:2", title: "Web Inspector" };
const session = (target: DebugTarget): DebugSession => ({
  sessionId: `session-${target.id}`,
  endpoint: "mac://local",
  target,
  state: "connected",
  paused: false,
});
const success = <T,>(value: T) => ({ _tag: "Success", value });
let root: Root, element: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.settings = { externalAppProfiles: [{ ...EXCEL_EXTERNAL_APP, enabled: true }] };
  for (const key of ["discover", "attach", "sessions", "detach", "read", "run"] as const)
    mocks[key].mockReset();
  mocks.discover.mockResolvedValue(success([app, inspector]));
  mocks.sessions.mockResolvedValue(success([]));
  mocks.attach.mockImplementation(async ({ input }) =>
    success(session(input.targetId === app.id ? app : inspector)),
  );
  mocks.detach.mockResolvedValue(success(undefined));
  mocks.run.mockResolvedValue(success({ text: "{}" }));
  mocks.read.mockImplementation(async ({ input }) =>
    success({
      session: session(input.sessionId === session(app).sessionId ? app : inspector),
      events: [],
      nextSequence: 0,
      dropped: 0,
      image: "aGVsbG8=",
      imageUnavailable: false,
      imageSequence: 1,
      callFrames: [],
    }),
  );
  useExternalAppSessions.setState({ bindings: {} });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const panel = async (threadRef: ScopedThreadRef = ref, visible = true) =>
  act(async () =>
    root.render(<ExternalAppPanel threadRef={threadRef} profileId="excel" visible={visible} />),
  );
function button(name: string) {
  const node = [...element.querySelectorAll<HTMLElement>("button,[role=switch]")].find(
    (n) => n.textContent?.trim() === name || n.getAttribute("aria-label") === name,
  );
  if (!node) throw new Error(`Missing ${name}`);
  return node;
}
const click = async (name: string) => act(async () => button(name).click());
async function change(label: string, value: string) {
  const node = element.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
      "value",
    )!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function pick() {
  await panel();
  await click("Find windows");
  await change("Application window", app.id);
  await change("Web Inspector window", inspector.id);
}
const tick = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(1200);
  });

it("reveals configuration only after enabling Excel and supports a custom app", async () => {
  mocks.settings = { externalAppProfiles: [EXCEL_EXTERNAL_APP] };
  await act(async () => root.render(<ExternalAppsSettings />));
  expect(element.querySelector('[aria-label="Application filter for Excel"]')).toBeNull();
  await click("Enable Excel");
  expect(
    element.querySelector<HTMLInputElement>('[aria-label="Application filter for Excel"]')?.value,
  ).toBe("com.microsoft.Excel");
  await click("Inspector for Excel");
  expect(element.querySelector('[aria-label="Inspector filter for Excel"]')).toBeNull();
  await click("Add Mac app");
  await change("Name for My Mac app", "My host");
  await change("Application filter for My host", "com.example.host");
  expect(mocks.settings.externalAppProfiles[1]).toMatchObject({
    name: "My host",
    applicationFilter: "com.example.host",
    enabled: true,
  });
  await click("Remove app");
  expect(mocks.settings.externalAppProfiles).toHaveLength(1);
});
it("attaches both windows to the thread, polls only the visible view, and stops when hidden", async () => {
  await pick();
  await click("Connect selected windows");
  expect(mocks.attach.mock.calls.map(([r]) => r.input)).toEqual([
    { endpoint: "mac://local", targetId: app.id, threadId: ref.threadId },
    { endpoint: "mac://local", targetId: inspector.id, threadId: ref.threadId },
  ]);
  expect(
    mocks.read.mock.calls.every(
      ([r]) => r.input.threadId === ref.threadId && r.input.sessionId === session(app).sessionId,
    ),
  ).toBe(true);
  await click("Inspector");
  const before = mocks.read.mock.calls.length;
  await tick();
  expect(
    mocks.read.mock.calls
      .slice(before)
      .every(([r]) => r.input.sessionId === session(inspector).sessionId),
  ).toBe(true);
  await click("Both");
  const both = mocks.read.mock.calls.length;
  await tick();
  expect(new Set(mocks.read.mock.calls.slice(both).map(([r]) => r.input.sessionId)).size).toBe(2);
  await panel(ref, false);
  const stopped = mocks.read.mock.calls.length;
  await tick();
  expect(mocks.read).toHaveBeenCalledTimes(stopped);
  await panel(ref, true);
  await click("Disconnect Excel");
  expect(mocks.detach.mock.calls.map(([r]) => r.input)).toEqual([
    { sessionId: session(app).sessionId, threadId: ref.threadId },
    { sessionId: session(inspector).sessionId, threadId: ref.threadId },
  ]);
  expect(element.textContent).toContain("Connect Excel");
});
it("retains each thread's connection across switching and resumes its own view", async () => {
  await pick();
  await click("Connect selected windows");
  await panel(other);
  expect(element.textContent).toContain("Connect Excel");
  expect(mocks.detach).not.toHaveBeenCalled();
  await panel(ref);
  expect(element.querySelector("img")).not.toBeNull();
  expect(
    useExternalAppSessions.getState().bindings[externalAppBindingKey(ref, "excel")]?.sessions,
  ).toHaveLength(2);
  expect(
    useExternalAppSessions.getState().bindings[externalAppBindingKey(other, "excel")],
  ).toBeUndefined();
});
it("disabling Excel releases its capture on the correct Mac without disturbing a different app", async () => {
  useExternalAppSessions
    .getState()
    .bind({ threadRef: ref, profileId: "excel", sessions: [session(app)] });
  useExternalAppSessions
    .getState()
    .bind({ threadRef: other, profileId: "custom", sessions: [session(inspector)] });
  await act(async () => root.render(<ExternalAppsSettings />));
  await click("Enable Excel");
  expect(mocks.detach.mock.calls.map(([r]) => r)).toEqual([
    {
      environmentId: "local",
      input: { threadId: ref.threadId, sessionId: session(app).sessionId },
    },
  ]);
  expect(
    useExternalAppSessions.getState().bindings[externalAppBindingKey(other, "custom")],
  ).toBeDefined();
  expect(element.querySelector('[aria-label="Application filter for Excel"]')).toBeNull();
});
it.each(["disabled", "closed"])("cleans up a late attachment when its app is %s", async (mode) => {
  let resolve!: (value: unknown) => void;
  mocks.attach.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await pick();
  await click("Connect selected windows");
  if (mode === "closed") await act(async () => root.render(<div>Closed</div>));
  else {
    mocks.settings = { externalAppProfiles: [EXCEL_EXTERNAL_APP] };
    await panel();
  }
  await act(async () => resolve(success(session(app))));
  expect(mocks.attach).toHaveBeenCalledTimes(1);
  expect(mocks.detach).toHaveBeenCalledWith({
    environmentId: "local",
    input: { threadId: ref.threadId, sessionId: session(app).sessionId },
  });
  expect(useExternalAppSessions.getState().bindings).toEqual({});
});
it("rolls back the app capture when the Inspector cannot attach", async () => {
  mocks.attach
    .mockImplementationOnce(async () => success(session(app)))
    .mockResolvedValueOnce({ _tag: "Failure", cause: new Error("Inspector unavailable") });
  await pick();
  await click("Connect selected windows");
  expect(element.querySelector('[role="alert"]')?.textContent).toContain("Inspector unavailable");
  expect(mocks.detach).toHaveBeenCalledWith({
    environmentId: "local",
    input: { threadId: ref.threadId, sessionId: session(app).sessionId },
  });
  expect(useExternalAppSessions.getState().bindings).toEqual({});
});

it("clears an unavailable native frame, blocks controls, and requests a fresh frame on recovery", async () => {
  await pick();
  await click("Connect selected windows");
  expect(element.querySelector("img")).not.toBeNull();
  mocks.read.mockResolvedValue({ _tag: "Failure", cause: new Error("Connection unavailable") });
  await tick();
  expect(element.querySelector("img")).toBeNull();
  expect(element.textContent).toContain("unavailable");
  expect(element.querySelector<HTMLInputElement>("input[type=checkbox]:disabled")).not.toBeNull();
  mocks.read.mockResolvedValue(
    success({
      session: session(app),
      events: [],
      nextSequence: 0,
      dropped: 0,
      image: "ZnJlc2g=",
      imageUnavailable: false,
      imageSequence: 2,
      callFrames: [],
    }),
  );
  const recoveryRead = mocks.read.mock.calls.length;
  await tick();
  expect(mocks.read.mock.calls[recoveryRead]?.[0].input.afterImage).toBeUndefined();
  expect(element.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,ZnJlc2g=");
});

it("reopens the agent's existing app and Inspector without creating duplicate attachments", async () => {
  mocks.sessions.mockResolvedValue(success([session(app), session(inspector)]));
  await panel();
  await click("View Workbook");
  expect(mocks.attach).not.toHaveBeenCalled();
  expect(
    useExternalAppSessions.getState().bindings[externalAppBindingKey(ref, "excel")]?.sessions,
  ).toEqual([session(app), session(inspector)]);
});
it("does not reuse an attachment owned by another profile in the same conversation", async () => {
  useExternalAppSessions
    .getState()
    .bind({ threadRef: ref, profileId: "custom", sessions: [session(app)] });
  mocks.sessions.mockResolvedValue(success([session(app)]));
  await pick();
  await click("Connect selected windows");
  expect(element.querySelector('[role="alert"]')?.textContent).toContain(
    "another external app tab",
  );
  expect(mocks.attach).not.toHaveBeenCalled();
  expect(mocks.detach).not.toHaveBeenCalled();
  expect(
    useExternalAppSessions.getState().bindings[externalAppBindingKey(ref, "custom")]?.sessions,
  ).toEqual([session(app)]);
});

it("gates native input, translates image coordinates, and revokes input when viewing stops", async () => {
  await pick();
  await click("Connect selected windows");
  const image = element.querySelector("img")!;
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
    left: 10,
    top: 20,
    width: 400,
    height: 200,
  } as DOMRect);
  const imagePress = (type: "mousedown" | "mouseup") =>
    act(async () =>
      image.dispatchEvent(
        new MouseEvent(type, { bubbles: true, clientX: 110, clientY: 120 }),
      ),
    );
  await imagePress("mousedown");
  await imagePress("mouseup");
  expect(mocks.run).not.toHaveBeenCalled();
  await act(async () =>
    element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[1]!.click(),
  );
  await imagePress("mousedown");
  expect(mocks.run).not.toHaveBeenCalled();
  await imagePress("mouseup");
  expect(mocks.run.mock.calls.at(-1)?.[0].input).toMatchObject({
    sessionId: session(app).sessionId,
    threadId: ref.threadId,
    action: "click",
    x: 0.25,
    y: 0.5,
  });
  await change("Text for Application", "test note");
  await click("Send text");
  expect(mocks.run.mock.calls.at(-1)?.[0].input).toMatchObject({
    action: "type",
    text: "test note",
    threadId: ref.threadId,
  });
  await act(async () =>
    element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[0]!.click(),
  );
  expect(element.querySelector("img")).toBeNull();
  expect(element.querySelectorAll<HTMLInputElement>("input[type=checkbox]")[1]!.checked).toBe(
    false,
  );
  const reads = mocks.read.mock.calls.length;
  await tick();
  expect(mocks.read).toHaveBeenCalledTimes(reads);
});
it("does not overlap native reads while a frame request is pending", async () => {
  await pick();
  await click("Connect selected windows");
  let finish!: (value: unknown) => void;
  mocks.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const before = mocks.read.mock.calls.length;
  await tick();
  await tick();
  expect(mocks.read).toHaveBeenCalledTimes(before + 1);
  await act(async () =>
    finish(
      success({
        session: session(app),
        events: [],
        nextSequence: 0,
        dropped: 0,
        image: "bmV3",
        imageUnavailable: false,
        imageSequence: 2,
        callFrames: [],
      }),
    ),
  );
  expect(element.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,bmV3");
});


it("expands inside the app and collapses when the session panel is hidden", async () => {
  await pick();
  await click("Connect selected windows");
  await click("Inspector");
  await click("Expand Web Inspector");
  const expanded = document.body.querySelector('section[data-expanded="true"]');
  expect(expanded).not.toBeNull();
  expect(element.contains(expanded)).toBe(false);
  const collapse = expanded!.querySelector<HTMLButtonElement>('[aria-label="Collapse Web Inspector"]')!;
  await act(async () => collapse.click());
  expect(document.body.querySelector('section[data-expanded="true"]')).toBeNull();
  await click("Expand Web Inspector");
  await panel(ref, false);
  expect(document.body.querySelector('section[data-expanded="true"]')).toBeNull();
});
