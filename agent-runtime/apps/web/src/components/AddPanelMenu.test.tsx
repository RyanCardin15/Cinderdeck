// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AddPanelMenu, type AddPanelMenuProps } from "./RightPanelTabs";

vi.mock("../browser/browserDefaults", () => ({
  useBrowserDefaults: () => ({ profiles: [{ id: "work", name: "Work" }] }),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function props(): AddPanelMenuProps {
  return {
    onAddBrowser: vi.fn(),
    onAddBrowserInProfile: vi.fn(),
    onAddTerminal: vi.fn(),
    onAddDiff: vi.fn(),
    onAddFiles: vi.fn(),
    onAddPullRequest: vi.fn(),
    onAddPullRequests: vi.fn(),
    onAddDevice: vi.fn(),
    onAddExternalApp: vi.fn(),
    browserAvailable: true,
    terminalAvailable: true,
    diffAvailable: true,
    filesAvailable: true,
    pullRequestAvailable: true,
    pullRequestsAvailable: true,
    deviceAvailable: true,
  };
}
async function openMenu(input: AddPanelMenuProps) {
  await act(async () => root.render(<AddPanelMenu {...input} />));
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Add panel surface"]')!;
  await act(async () => trigger.click());
}
function item(label: string) {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) =>
    entry.textContent?.replace(/\s/g, "").startsWith(label.replace(/\s/g, "")),
  )!;
}

it.each([
  ["External app", "onAddExternalApp"],
  ["Terminal", "onAddTerminal"],
  ["Files", "onAddFiles"],
  ["Diff", "onAddDiff"],
  ["Device", "onAddDevice"],
] as const)("opens %s through the shared launcher", async (label, callback) => {
  const input = props();
  await openMenu(input);
  await act(async () => item(label).click());
  expect(input[callback]).toHaveBeenCalledOnce();
});

it("opens the default browser on a mouse click", async () => {
  const input = props();
  await openMenu(input);
  await act(async () => item("Browser").click());
  expect(input.onAddBrowser).toHaveBeenCalledOnce();
  expect(input.onAddBrowserInProfile).not.toHaveBeenCalled();
});

it("keeps unavailable Git actions disabled for both clicks and letter shortcuts", async () => {
  const input = { ...props(), diffAvailable: false };
  await openMenu(input);
  expect(item("Diff").getAttribute("aria-disabled")).toBe("true");
  await act(async () => {
    item("Diff").click();
    document
      .querySelector('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "d", bubbles: true }));
  });
  expect(input.onAddDiff).not.toHaveBeenCalled();
});
