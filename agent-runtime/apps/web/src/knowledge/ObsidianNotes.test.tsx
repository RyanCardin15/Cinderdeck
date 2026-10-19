// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { DesktopBridge, ObsidianNote } from "@cinderdeck/contracts";
import { ObsidianNotes } from "./ObsidianNotes";
import { KnowledgeSettings } from "./KnowledgeSettings";
const note: ObsidianNote = {
  path: "Project/Decision.md",
  title: "Decision",
  excerpt: "Architecture",
  vaultName: "Work",
  modifiedAt: 1700000000000,
  content:
    "---\ntags: [design]\n---\n# Architecture\nKeep [[Links]].\n![remote](https://example.com/track.png)\n<script>alert(1)</script>",
};
const vault = { id: "vault-1", name: "Work", path: "/fixtures/vault", workspacePath: null };
const preview = {
  token: "reviewed",
  name: "my-skill",
  description: "My conventions",
  content: "---\nname: my-skill\ndescription: My conventions\n---\nUse these rules.",
  files: ["SKILL.md", "references/rules.md"],
  bytes: 120,
};
const bridge = {
  listVaults: vi.fn(),
  connectVault: vi.fn(),
  disconnectVault: vi.fn(),
  searchNotes: vi.fn(),
  readNote: vi.fn(),
  openNote: vi.fn(),
  previewSkill: vi.fn(),
  importSkill: vi.fn(),
  listImportedSkills: vi.fn(),
  removeImportedSkill: vi.fn(),
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  for (const fn of Object.values(bridge)) fn.mockReset();
  bridge.listVaults.mockResolvedValue([vault]);
  bridge.listImportedSkills.mockResolvedValue([]);
  bridge.searchNotes.mockResolvedValue({ notes: [note], limited: false });
  bridge.readNote.mockResolvedValue(note);
  bridge.openNote.mockResolvedValue(undefined);
  bridge.previewSkill.mockResolvedValue(preview);
  bridge.importSkill.mockResolvedValue({
    id: "skill-1",
    name: "my-skill",
    path: "/fixtures/project/.agents/skills/my-skill",
    agent: "codex",
    importedAt: "2026-10-19T00:00:00Z",
  });
  window.desktopBridge = {
    knowledge: bridge,
    pickFolder: vi.fn().mockResolvedValue("/fixtures/project"),
  } as unknown as DesktopBridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
  vi.unstubAllGlobals();
});
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("button")];
async function click(label: string) {
  const button = buttons().find((b) => b.textContent?.includes(label));
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function searchReady() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
}
async function fileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
it("searches, safely previews, opens, and attaches a snapshot through the chat callback", async () => {
  const attach = vi.fn().mockResolvedValue(undefined),
    close = vi.fn();
  await act(async () =>
    root.render(
      <ObsidianNotes
        open
        onOpenChange={close}
        workspacePath="/fixtures/project"
        onAttach={attach}
      />,
    ),
  );
  await searchReady();
  expect(bridge.searchNotes).toHaveBeenCalledWith({
    vaultID: vault.id,
    query: "",
    workspacePath: "/fixtures/project",
  });
  await click("Decision");
  expect(document.body.textContent).toContain("Architecture");
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
  await click("Open in Obsidian");
  expect(bridge.openNote).toHaveBeenCalledWith({
    vaultID: vault.id,
    path: note.path,
    workspacePath: "/fixtures/project",
  });
  await click("Attach note");
  expect(attach).toHaveBeenCalledOnce();
  const file = attach.mock.calls[0]![0] as File;
  expect(file.name).toBe("Decision.md");
  expect(file.type).toBe("text/markdown");
  const content = await fileText(file);
  expect(content).toContain("Obsidian vault: Work");
  expect(content).toContain(note.content);
  expect(close).toHaveBeenCalledWith(false);
});
it("discards a late preview after the conversation changes", async () => {
  let finish!: (note: ObsidianNote) => void;
  bridge.readNote.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const attach = vi.fn();
  await act(async () =>
    root.render(<ObsidianNotes key="old" open onOpenChange={() => {}} onAttach={attach} />),
  );
  await searchReady();
  await click("Decision");
  bridge.listVaults.mockResolvedValue([]);
  await act(async () =>
    root.render(<ObsidianNotes key="new" open onOpenChange={() => {}} onAttach={attach} />),
  );
  await act(async () => finish(note));
  expect(document.body.textContent).not.toContain("Keep [[Links]]");
  expect(attach).not.toHaveBeenCalled();
});
it("keeps the preview open and shows attachment failure", async () => {
  const close = vi.fn();
  await act(async () =>
    root.render(
      <ObsidianNotes
        open
        onOpenChange={close}
        onAttach={async () => {
          throw new Error("Attachment limit reached");
        }}
      />,
    ),
  );
  await searchReady();
  await click("Decision");
  await click("Attach note");
  expect(document.body.textContent).toContain("Attachment limit reached");
  expect(close).not.toHaveBeenCalled();
});
it("reviews custom skill instructions before installing and surfaces collisions", async () => {
  await act(async () => root.render(<KnowledgeSettings />));
  await click("Import skill folder");
  expect(document.body.textContent).toContain("Use these rules.");
  expect(bridge.importSkill).not.toHaveBeenCalled();
  bridge.importSkill.mockRejectedValueOnce(
    new Error("A skill with this name already exists. Your existing skill was kept."),
  );
  await click("Install skill");
  expect(document.body.textContent).toContain("already exists");
  expect(bridge.importSkill).toHaveBeenCalledWith({
    token: preview.token,
    agent: "codex",
    workspacePath: null,
  });
  await click("Install skill");
  expect(document.body.textContent).toContain("Imported my-skill for codex");
});
it("does not install when review is cancelled and disconnects only the chosen vault", async () => {
  await act(async () => root.render(<KnowledgeSettings />));
  await click("Import skill folder");
  await click("Cancel");
  expect(bridge.importSkill).not.toHaveBeenCalled();
  await click("Disconnect");
  expect(bridge.disconnectVault).toHaveBeenCalledWith(vault.id);
});
