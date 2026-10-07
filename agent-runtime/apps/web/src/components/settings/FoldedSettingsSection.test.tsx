// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const search = vi.hoisted(() => ({ targetId: null as string | null }));
vi.mock("./settingsLayout", () => ({
  useSettingsSearchTargetId: () => search.targetId,
  useSettingsSearchTarget: () => undefined,
}));

import { FoldedSettingsSection } from "./FoldedSettingsSection";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  search.targetId = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const renderTarget = async (targetId: string | null) => {
  search.targetId = targetId;
  await act(async () =>
    root.render(
      <FoldedSettingsSection id="workspace-ownership" title="Worktree management">
        <button>Choose a conversation</button>
      </FoldedSettingsSection>,
    ),
  );
};
const trigger = () =>
  container.querySelector<HTMLButtonElement>("[data-slot=collapsible-trigger]")!;

it("reopens a manually closed section on each settings-search jump", async () => {
  await renderTarget(null);
  expect(trigger().getAttribute("aria-expanded")).toBe("false");

  await renderTarget("workspace-ownership");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  await renderTarget(null); // The settings page clears its hash after handling the jump.
  await act(async () => trigger().click());
  expect(trigger().getAttribute("aria-expanded")).toBe("false");

  await renderTarget("workspace-ownership");
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
});

it("keeps the fold closed when search targets a different section", async () => {
  await renderTarget("agent-access");
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
});
