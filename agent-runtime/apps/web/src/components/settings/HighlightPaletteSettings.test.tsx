// @vitest-environment jsdom
import { act, cloneElement, useRef, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@cinderdeck/contracts/settings";

const boundary = vi.hoisted(() => ({ saved: null as ClientSettings | null }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => boundary.saved,
      setClientSettings: async (settings: ClientSettings) => {
        boundary.saved = settings;
      },
    },
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsRow: ({ children, resetAction }: { children: ReactNode; resetAction: ReactNode }) => (
    <div>
      {resetAction}
      {children}
    </div>
  ),
  SettingResetButton: ({ onClick }: { onClick: () => void }) => (
    <button onClick={onClick}>Reset highlights</button>
  ),
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children, ...props }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, props, children),
  TooltipPopup: () => null,
}));

import { HighlightPaletteSettings } from "./HighlightPaletteSettings";
import { SidebarColorPicker } from "../../deckhand/SidebarColorPicker";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
  useClientSettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";

let root: Root;
let container: HTMLDivElement;
const choose = vi.fn();
function Fixture() {
  const colors = useClientSettings((settings) => settings.sidebarHighlightColors);
  const update = useUpdateClientSettings();
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <div ref={anchor}>
      <HighlightPaletteSettings
        colors={colors}
        onChange={(sidebarHighlightColors) => void update({ sidebarHighlightColors })}
      />
      <SidebarColorPicker
        open
        onOpenChange={() => {}}
        anchor={anchor}
        label="Workspace"
        color="#123456"
        onChange={choose}
      />
      <SidebarColorPicker
        open
        onOpenChange={() => {}}
        anchor={anchor}
        label="Sub-agent"
        color={undefined}
        onChange={choose}
      />
    </div>
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __resetClientSettingsPersistenceForTests();
  boundary.saved = { ...DEFAULT_CLIENT_SETTINGS };
  choose.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it("persists an edited slot, updates both pickers, survives hydration, and resets presets independently of row colors", async () => {
  await act(async () => root.render(<Fixture />));
  const inputs = container.querySelectorAll('input[aria-label^="Highlight color "]');
  expect(inputs).toHaveLength(10);
  const input = inputs[5]!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "#123456",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(boundary.saved?.sidebarHighlightColors[5]).toBe("#123456");
  expect(boundary.saved?.sidebarHighlightColors).toHaveLength(10);
  const swatches = container.querySelectorAll('button[aria-label="Highlight 6"]');
  expect(swatches).toHaveLength(2);
  expect(swatches[0]!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => (swatches[1] as HTMLButtonElement).click());
  expect(choose).toHaveBeenLastCalledWith("#123456");
  await act(async () => root.render(null));
  __resetClientSettingsPersistenceForTests();
  await ensureClientSettingsHydrated();
  await act(async () => root.render(<Fixture />));
  expect(
    (container.querySelector('input[aria-label="Highlight color 6"]') as HTMLInputElement).value,
  ).toBe("#123456");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Reset highlights")!
      .click(),
  );
  expect(boundary.saved?.sidebarHighlightColors).toEqual(
    DEFAULT_CLIENT_SETTINGS.sidebarHighlightColors,
  );
  expect(container.querySelectorAll('button[aria-label="Blue"]')).toHaveLength(2);
  expect(choose).toHaveBeenCalledOnce();
});
