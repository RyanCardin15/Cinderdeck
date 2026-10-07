// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { NativeSettingsSnapshot } from "@cinderdeck/contracts";
vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../components/settings/settingsLayout", () => ({
  useSettingsSearchTargetId: () => null,
  SettingsSection: ({ children, title }: { children: ReactNode; title: string }) => (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  ),
  SettingsRow: ({ title, control }: { title: string; control: ReactNode }) => (
    <div>
      {title}
      {control}
    </div>
  ),
  SettingsSearchTarget: ({ children, id }: { children: ReactNode; id: string }) => (
    <section id={id}>{children}</section>
  ),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    disabled: boolean;
    onCheckedChange: (value: boolean) => void;
  }) => (
    <input
      {...props}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));
import { NativeSettingsSection, nativeSettingsChanges } from "./NativeSettings";
import { isNativeSettingsHost } from "./nativeSettingsPresentation";

afterEach(() => {
  delete window.desktopBridge;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
const initial: NativeSettingsSnapshot = {
  category: "capture",
  fields: [{ id: "capture.screenshot.show_cursor", value: false }],
  status: {},
};
function mount(command: (input: unknown) => Promise<NativeSettingsSnapshot>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.desktopBridge = { isNativeHost: () => true, nativeSettings: command } as NonNullable<
    Window["desktopBridge"]
  >;
  const container = document.createElement("div");
  document.body.append(container);
  return { container, root: createRoot(container) };
}
function button(container: HTMLElement, text: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === text,
  )!;
}

it("edits inline and displays saved only after native confirmation", async () => {
  let confirm: (snapshot: NativeSettingsSnapshot) => void = () => undefined;
  const command = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
  const { container, root } = mount(command);
  try {
    await act(async () => root.render(<NativeSettingsSection category="capture" />));
    expect(command).toHaveBeenCalledWith({ category: "capture", action: "read" });
    await act(async () =>
      container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(),
    );
    await act(async () => button(container, "Save changes").click());
    expect(command).toHaveBeenLastCalledWith({
      category: "capture",
      action: "update",
      payload: { changes: { "capture.screenshot.show_cursor": { expected: false, value: true } } },
    });
    expect(container.textContent).not.toContain("Settings saved.");
    await act(async () =>
      confirm({ ...initial, fields: [{ id: "capture.screenshot.show_cursor", value: true }] }),
    );
    expect(container.textContent).toContain("Settings saved.");
    expect(container.textContent).not.toContain("unsaved");
  } finally {
    await act(async () => root.unmount());
  }
});
it("keeps edits after a native validation failure and supports discarding them", async () => {
  const command = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockRejectedValueOnce(new Error("Settings changed. Reload before saving."));
  const { container, root } = mount(command);
  try {
    await act(async () => root.render(<NativeSettingsSection category="capture" />));
    await act(async () =>
      container.querySelector<HTMLInputElement>("input[type=checkbox]")!.click(),
    );
    await act(async () => button(container, "Save changes").click());
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Settings changed");
    expect(container.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(true);
    expect(container.textContent).toContain("unsaved");
    await act(async () => button(container, "Discard").click());
    expect(container.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
it("includes observed shortcut companion values when saving a modifier change", () => {
  const snapshot: NativeSettingsSnapshot = {
    category: "shortcuts",
    status: {},
    fields: [
      { id: "shortcuts.global.area.key", value: "4" },
      { id: "shortcuts.global.area.modifiers", value: ["command", "shift"] },
      { id: "shortcuts.global.area.enabled", value: true },
    ],
  };
  expect(
    nativeSettingsChanges(snapshot, {
      "shortcuts.global.area.key": "4",
      "shortcuts.global.area.modifiers": ["control"],
      "shortcuts.global.area.enabled": true,
    }),
  ).toEqual({
    "shortcuts.global.area.key": { expected: "4", value: "4" },
    "shortcuts.global.area.modifiers": { expected: ["command", "shift"], value: ["control"] },
    "shortcuts.global.area.enabled": { expected: true, value: true },
  });
});
it("queries native host identity once per bridge, keeping search and rendering cheap", () => {
  const identity = vi.fn(() => true);
  window.desktopBridge = { isNativeHost: identity } as unknown as NonNullable<
    Window["desktopBridge"]
  >;
  for (let i = 0; i < 200; i++) expect(isNativeSettingsHost()).toBe(true);
  expect(identity).toHaveBeenCalledOnce();
});

it("saves compact shortcut controls with their observed companion values", async () => {
  const snapshot: NativeSettingsSnapshot = {
    category: "shortcuts",
    status: {},
    fields: [
      { id: "shortcuts.global.area.key", value: "4" },
      { id: "shortcuts.global.area.modifiers", value: ["command", "shift"] },
      { id: "shortcuts.global.area.enabled", value: true },
    ],
  };
  const command = vi.fn().mockResolvedValue(snapshot);
  const { container, root } = mount(command);
  try {
    await act(async () => root.render(<NativeSettingsSection category="shortcuts" />));
    await act(async () =>
      container.querySelector<HTMLInputElement>('[aria-label="Area · ⌃ Control"]')!.click(),
    );
    expect(container.textContent).toContain("1 unsaved change");
    await act(async () => button(container, "Save changes").click());
    expect(command).toHaveBeenLastCalledWith({
      category: "shortcuts",
      action: "update",
      payload: {
        changes: {
          "shortcuts.global.area.key": { expected: "4", value: "4" },
          "shortcuts.global.area.modifiers": {
            expected: ["command", "shift"],
            value: ["command", "shift", "control"],
          },
          "shortcuts.global.area.enabled": { expected: true, value: true },
        },
      },
    });
  } finally {
    await act(async () => root.unmount());
  }
});

it("keeps menu groups and the fixed updates entry in place while saving visibility", async () => {
  const snapshot: NativeSettingsSnapshot = {
    category: "menuBar",
    status: {},
    fields: [
      { id: "menu_bar.item_order", value: ["captureArea", "recordScreen", "checkForUpdates"] },
      { id: "menu_bar.hidden_items", value: [] },
    ],
  };
  const command = vi.fn().mockResolvedValue(snapshot);
  const { container, root } = mount(command);
  try {
    await act(async () => root.render(<NativeSettingsSection category="menuBar" />));
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Move Check for updates up"]')!
        .disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Move Area screenshot down"]')!
        .disabled,
    ).toBe(true);
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('[aria-label="Show Area screenshot in the menu bar"]')!
        .click(),
    );
    await act(async () => button(container, "Save changes").click());
    expect(command).toHaveBeenLastCalledWith({
      category: "menuBar",
      action: "update",
      payload: {
        changes: { "menu_bar.hidden_items": { expected: [], value: ["captureArea"] } },
      },
    });
  } finally {
    await act(async () => root.unmount());
  }
});
