import { useSessionNotesTracking } from "./useSessionNotesTracking";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import type { DesktopBridge, ObsidianNote } from "@cinderdeck/contracts";
import { scopeThreadRef } from "@cinderdeck/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import { SessionNotePanel } from "./SessionNotePanel";
import { SessionNotesSection } from "./SessionNotesSection";
import { useSessionNotesStore, type SessionNote } from "./sessionNotes";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
const reference: SessionNote = {
  vaultID: "v1",
  vaultName: "Work",
  path: "Project/Decision.md",
  activity: "attached",
};
const original: ObsidianNote = {
  ...reference,
  title: "Decision",
  excerpt: "",
  modifiedAt: 1700000000000,
  content:
    "---\ntags: [design]\n---\n# Original\nKeep [[links]].\n![remote](https://example.com/tracker.png)\n<script>alert(1)</script>",
};
const bridge = { readNote: vi.fn(), openNote: vi.fn(), listVaults: vi.fn() };
const thread = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("one"));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge.readNote.mockReset().mockResolvedValue(original);
  bridge.openNote.mockReset().mockResolvedValue(undefined);
  bridge.listVaults
    .mockReset()
    .mockResolvedValue([{ id: "v1", name: "Work", path: "/fixtures/vault", workspacePath: null }]);
  window.desktopBridge = { knowledge: bridge } as unknown as DesktopBridge;
  useSessionNotesStore.setState({ byTarget: {} });
  useRightPanelStore.setState({ byThreadKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === label || b.getAttribute("aria-label") === label,
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
it("opens a session note as a peer tab, deduplicating repeated clicks and preserving the list when tabs close", async () => {
  useSessionNotesStore.getState().remember(thread, [reference]);
  await act(async () =>
    root.render(
      <SessionNotesSection target={thread} threadRef={thread} workspacePath="/fixtures/project" />,
    ),
  );
  const row = container.querySelector<HTMLButtonElement>(
    `button[title="Work / Project/Decision.md"]`,
  )!;
  await act(async () => {
    row.click();
    row.click();
  });
  let state = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, thread);
  expect(state.isOpen).toBe(true);
  expect(state.surfaces).toHaveLength(1);
  expect(state.surfaces[0]).toMatchObject({ kind: "note", note: reference });
  await act(async () => useRightPanelStore.getState().closeAllSurfaces(thread));
  expect(container.textContent).toContain("Decision.md");
});
it("shows live safe Markdown, raw source, and the exact scoped Obsidian action", async () => {
  await act(async () =>
    root.render(
      <SessionNotePanel reference={reference} workspacePath="/fixtures/project" visible />,
    ),
  );
  expect(container.textContent).toContain("Original");
  expect(container.querySelector("img,script")).toBeNull();
  await click("Source");
  expect(container.textContent).toContain("tags: [design]");
  await click("Open in Obsidian");
  expect(bridge.openNote).toHaveBeenCalledWith({
    vaultID: "v1",
    path: reference.path,
    workspacePath: "/fixtures/project",
  });
  bridge.readNote.mockResolvedValue({ ...original, content: "# Updated externally" });
  await click("Refresh note");
  expect(container.textContent).toContain("Updated externally");
});
it("refreshes visible notes automatically and stops reading when the panel is hidden", async () => {
  vi.useFakeTimers();
  await act(async () =>
    root.render(<SessionNotePanel reference={reference} workspacePath={null} visible />),
  );
  bridge.readNote.mockResolvedValue({ ...original, content: "Updated while working" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(container.textContent).toContain("Updated while working");
  await act(async () =>
    root.render(<SessionNotePanel reference={reference} workspacePath={null} visible={false} />),
  );
  const calls = bridge.readNote.mock.calls.length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6000);
  });
  expect(bridge.readNote).toHaveBeenCalledTimes(calls);
});
it("discards a late note result after a tab switch and surfaces disconnected vault errors", async () => {
  let finish!: (note: ObsidianNote) => void;
  bridge.readNote.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () =>
    root.render(<SessionNotePanel reference={reference} workspacePath={null} visible />),
  );
  bridge.readNote.mockRejectedValue(new Error("The vault is disconnected."));
  await act(async () =>
    root.render(
      <SessionNotePanel
        reference={{ ...reference, path: "Other.md" }}
        workspacePath={null}
        visible
      />,
    ),
  );
  await act(async () => finish(original));
  expect(container.textContent).not.toContain("Original");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("disconnected");
});

const noItems: readonly import("@cinderdeck/contracts").OrchestrationV2ProjectedTurnItem[] = [];
const openedFiles = ["/fixtures/vault/Opened.md"];
function Tracking({ local, target }: { local: boolean; target: typeof thread }) {
  useSessionNotesTracking(target, noItems, "/fixtures/project", local, openedFiles);
  return null;
}
it("tracks a local workspace file while refusing to match remote paths against local vaults", async () => {
  const remote = scopeThreadRef(EnvironmentId.make("remote"), thread.threadId);
  await act(async () => root.render(<Tracking local={false} target={remote} />));
  expect(bridge.listVaults).not.toHaveBeenCalled();
  expect(Object.keys(useSessionNotesStore.getState().byTarget)).toHaveLength(0);
  await act(async () => root.render(<Tracking local target={thread} />));
  expect(bridge.listVaults).toHaveBeenCalledWith("/fixtures/project");
  expect(Object.values(useSessionNotesStore.getState().byTarget).flat()).toMatchObject([
    { path: "Opened.md", activity: "viewed" },
  ]);
  await act(async () => root.render(<Tracking local={false} target={remote} />));
  expect(Object.keys(useSessionNotesStore.getState().byTarget)).toHaveLength(1);
});
