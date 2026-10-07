import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettingsPatch,
  type DesktopSnapShotState,
} from "@cinderdeck/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const effects = vi.hoisted(() => [] as (() => void)[]);
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => void) => effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("./SettingsScopeContext", () => ({ useOptionalSettingsScope: () => null }));
vi.mock("./SettingsScopeSentence", () => ({ SettingsScopeSentence: () => null }));
const bridge = vi.hoisted(() => ({
  getSnapShotState: vi.fn<() => Promise<DesktopSnapShotState>>(),
  setSnapShotShortcutSuppressed: vi.fn(),
  checkSnapShotShortcut: vi.fn(),
  setupSnapShot: vi.fn(),
  requestSnapShotPermissions: vi.fn().mockResolvedValue(undefined),
  onMenuAction: vi.fn(),
  onSnapShotEvent: vi.fn(() => () => undefined),
}));
const toastManager = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager }));
vi.mock("../../lib/desktopSnapShot", () => ({ getDesktopSnapShotBridge: () => bridge }));
const settingsStore = vi.hoisted(() => ({
  current: {} as typeof DEFAULT_CLIENT_SETTINGS,
  update: vi.fn<(patch: ClientSettingsPatch) => Promise<void>>(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => settingsStore.current,
  useUpdateClientSettings: () => settingsStore.update,
}));

import { SnapShotSettings } from "./SnapShotSettings";
import { SnapShotSetupDialog } from "./SnapShotSetupDialog";

let state: DesktopSnapShotState;
function render() {
  hooks.beginRender();
  return SnapShotSettings();
}
function renderWithEffects() {
  effects.length = 0;
  const tree = render();
  for (const effect of effects.splice(0)) effect();
  return tree;
}
function wizard(tree: ReturnType<typeof render>) {
  return visitElements(tree, (element) => element.type === SnapShotSetupDialog);
}
function button(tree: ReturnType<typeof render>, label: string) {
  const node = visitElements(
    tree,
    (element) => element.props.children === label && typeof element.props.onClick === "function",
  );
  if (!node) throw new Error(`Missing button: ${label}`);
  return node.props as { onClick: () => void };
}
async function finish(promise: Promise<unknown>) {
  await promise;
  await Promise.resolve();
}
async function mount() {
  render();
  for (const effect of effects.splice(0)) effect();
  await finish(bridge.getSnapShotState.mock.results[0]!.value);
  return render();
}
beforeEach(() => {
  hooks.reset();
  effects.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal("navigator", { platform: "Linux" });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  settingsStore.current = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: true };
  state = {
    mode: "direct",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: true,
    shortcutMessage: null,
    message: null,
  };
  bridge.getSnapShotState.mockImplementation(async () => state);
  bridge.setSnapShotShortcutSuppressed.mockResolvedValue(undefined);
  bridge.checkSnapShotShortcut.mockResolvedValue({ available: true, message: null });
  bridge.setupSnapShot.mockReset().mockResolvedValue(undefined);
  settingsStore.update.mockImplementation(async (patch) => {
    settingsStore.current = { ...settingsStore.current, ...patch };
    state = { ...state, shortcut: settingsStore.current.snapShotShortcut };
  });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps shortcut recording and saving inline", async () => {
  const tree = await mount();
  const recorder = (node: ReturnType<typeof render>) => {
    const control = visitElements(node, (element) => "data-keybinding-capture" in element.props);
    if (!control) throw new Error("Missing inline shortcut recorder");
    return control.props;
  };
  expect(
    visitElements(tree, (element) => element.props.id === "snap-shot-shortcut")?.props.status,
  ).toBe("Shortcut saved.");
  (recorder(tree).onClick as () => void)();
  await finish(bridge.setSnapShotShortcutSuppressed.mock.results.at(-1)!.value);
  (recorder(render()).onKeyDown as (event: object) => void)({
    key: "y",
    code: "KeyY",
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  await finish(bridge.checkSnapShotShortcut.mock.results[0]!.value);
  expect(recorder(render()).size).toBe("xs");
  expect(recorder(render())["aria-label"]).toBe("Record snapshot shortcut, currently Ctrl+Alt+Y");
  button(render(), "Save").onClick();
  await finish(settingsStore.update.mock.results[0]!.value);
  expect(settingsStore.update).toHaveBeenCalledWith({
    snapShotShortcut: expect.objectContaining({ key: "y", modKey: true, altKey: true }),
  });
  expect(wizard(render())).toBeNull();
});

function useSavedShortcut() {
  const shortcut = {
    key: "8",
    modKey: false,
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
  };
  settingsStore.current = { ...settingsStore.current, snapShotShortcut: shortcut };
  state = { ...state, shortcut, shortcutRegistered: true };
}

it("keeps the saved shortcut when recording is cancelled in setup", async () => {
  useSavedShortcut();
  const tree = await mount();
  button(tree, "Manage capture").onClick();
  await finish(bridge.getSnapShotState.mock.results[1]!.value);
  const shortcut = () => {
    const input = visitElements(
      wizard(render()),
      (element) => "data-keybinding-capture" in element.props,
    );
    if (!input) throw new Error("Missing setup shortcut recorder");
    return input.props;
  };
  expect(shortcut()["aria-label"]).toBe("Record snapshot shortcut, currently Ctrl+Alt+8");
  (shortcut().onClick as () => void)();
  await finish(bridge.setSnapShotShortcutSuppressed.mock.results.at(-1)!.value);
  expect(shortcut().children).toBe("Press shortcut…");
  (shortcut().onKeyDown as (event: object) => void)({
    key: "Escape",
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
  expect(shortcut()["aria-label"]).toBe("Record snapshot shortcut, currently Ctrl+Alt+8");
  expect(settingsStore.update).not.toHaveBeenCalled();
  expect(bridge.checkSnapShotShortcut).not.toHaveBeenCalled();
});

it("keeps a failed preference unchanged and reports the save error in a toast", async () => {
  useSavedShortcut();
  const flash = (tree: ReturnType<typeof render>) => {
    const control = visitElements(
      tree,
      (element) => element.props["aria-label"] === "Flash captured window",
    );
    if (!control) throw new Error("Missing flash control");
    return control.props as { onCheckedChange: (checked: boolean) => void; checked: boolean };
  };
  settingsStore.update.mockRejectedValueOnce(new Error("The settings file is read-only."));
  flash(await mount()).onCheckedChange(false);
  await finish(settingsStore.update.mock.results[0]!.value.catch(() => undefined));
  expect(flash(renderWithEffects()).checked).toBe(true);
  expect(toastManager.add).toHaveBeenCalledExactlyOnceWith({
    type: "error",
    title: "Couldn't save capture settings",
    description: "The settings file is read-only.",
  });
  flash(renderWithEffects()).onCheckedChange(false);
  await finish(settingsStore.update.mock.results[1]!.value);
  expect(flash(renderWithEffects()).checked).toBe(false);
  expect(toastManager.add).toHaveBeenCalledTimes(1);
});

it("keeps setup errors in the wizard and does not toast them after closing it", async () => {
  useSavedShortcut();
  button(await mount(), "Manage capture").onClick();
  await finish(bridge.getSnapShotState.mock.results[1]!.value);
  bridge.setupSnapShot.mockRejectedValueOnce(new Error("The desktop service disconnected."));
  const action = wizard(render())!.props.onAction as (action: "retry-shortcut") => Promise<void>;
  await action("retry-shortcut");
  const dialog = wizard(renderWithEffects())!;
  expect(dialog.props.error).toBe("The desktop service disconnected.");
  expect(toastManager.add).not.toHaveBeenCalled();
  await (dialog.props.onClose as (completed: boolean) => Promise<void>)(false);
  expect(wizard(renderWithEffects())).toBeNull();
  expect(toastManager.add).not.toHaveBeenCalled();
});

it.each([false, true])(
  "resumes macOS permission setup after restart and clears it on close, completed=%s",
  async (completed) => {
    const { readSnapShotSetupResume } = await import("../../lib/snapShotSetupResume");
    const values = new Map<string, string>();
    Object.assign(window, {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    settingsStore.current = { ...settingsStore.current, snapShotEnabled: false };
    state = {
      mode: "direct",
      shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
      shortcutRegistered: false,
      shortcutMessage: null,
      message: null,
      macPermissions: { screenRecording: false, accessibility: false },
    };
    const tree = await mount();
    const toggle = visitElements(
      tree,
      (element) => element.props["aria-label"] === "Enable snapshots",
    );
    (toggle!.props.onCheckedChange as (checked: boolean) => void)(true);
    await finish(bridge.getSnapShotState.mock.results[1]!.value);
    bridge.setupSnapShot.mockImplementationOnce(async () => {
      expect(readSnapShotSetupResume()).toEqual({ wasEnabled: false });
    });
    await (wizard(render())!.props.onAction as (action: string) => Promise<void>)(
      "allow-screen-recording",
    );

    hooks.reset();
    effects.length = 0;
    bridge.getSnapShotState.mockClear();
    state = { ...state, macPermissions: { screenRecording: true, accessibility: true } };
    const resumed = wizard(await mount());
    expect(resumed).not.toBeNull();
    expect(resumed!.props.initialStep).toBe("access");
    expect(resumed!.props.wasEnabled).toBe(false);
    await (resumed!.props.onClose as (completed: boolean) => Promise<void>)(completed);
    expect(wizard(render())).toBeNull();
    expect(readSnapShotSetupResume()).toBeNull();
  },
);

it("requires a successful macOS test capture before enabling and allows retry", async () => {
  settingsStore.current = { ...DEFAULT_CLIENT_SETTINGS, snapShotEnabled: false };
  state = {
    mode: "direct",
    shortcut: DEFAULT_CLIENT_SETTINGS.snapShotShortcut,
    shortcutRegistered: false,
    shortcutMessage: null,
    message: null,
    macPermissions: { screenRecording: true, accessibility: true },
  };
  const tree = await mount();
  const toggle = visitElements(
    tree,
    (element) => element.props["aria-label"] === "Enable snapshots",
  );
  (toggle!.props.onCheckedChange as (checked: boolean) => void)(true);
  await finish(bridge.getSnapShotState.mock.results[1]!.value);
  bridge.setupSnapShot.mockRejectedValueOnce(new Error("Capture was denied"));
  const enable = () => (wizard(render())!.props.onEnable as () => Promise<boolean>)();
  expect(await enable()).toBe(false);
  expect(wizard(render())!.props.error).toBe("Capture was denied");
  expect(settingsStore.current.snapShotEnabled).toBe(false);
  expect(await enable()).toBe(true);
  expect(bridge.setupSnapShot.mock.calls).toEqual([["test-mac-capture"], ["test-mac-capture"]]);
  expect(settingsStore.current.snapShotEnabled).toBe(true);
});
