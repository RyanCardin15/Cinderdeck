// @effect-diagnostics nodeBuiltinImport:off -- Disposable filesystem fixtures exercise actual vault and skill boundaries.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { LocalKnowledge } from "./LocalKnowledge.ts";
let root: string, vault: string, workspace: string, home: string, store: LocalKnowledge;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cinderdeck-knowledge-")));
  vault = path.join(root, "Vault & notes");
  workspace = path.join(root, "project");
  home = path.join(root, "home");
  await Promise.all([
    fs.mkdir(path.join(vault, ".obsidian"), { recursive: true }),
    fs.mkdir(workspace),
    fs.mkdir(home),
  ]);
  await fs.mkdir(path.join(vault, "Projects"));
  await fs.writeFile(
    path.join(vault, "Projects", "Design 1.md"),
    "---\ntags: [architecture]\n---\n# Architecture\nThe aurora decision links [[Research]].\n",
  );
  await fs.writeFile(path.join(vault, "Research.md"), "# Research\nA separate note.");
  store = new LocalKnowledge(path.join(root, "state"), home);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
describe("Obsidian connections", () => {
  it("persists, searches content, reads exact Markdown, opens exact paths and disconnects without deleting notes", async () => {
    const connection = await store.connectVault(vault, "Work notes", null);
    store = new LocalKnowledge(path.join(root, "state"), home);
    expect(await store.listVaults()).toEqual([connection]);
    const result = await store.searchNotes({
      vaultID: connection.id,
      query: "aurora architecture",
    });
    expect(result.notes.map((n) => n.path)).toEqual(["Projects/Design 1.md"]);
    const note = await store.readNote({ vaultID: connection.id, path: result.notes[0]!.path });
    expect(note.content).toContain("[[Research]]");
    const uri = new URL(await store.noteURI({ vaultID: connection.id, path: note.path }));
    expect(uri.protocol).toBe("obsidian:");
    // Obsidian does percent decoding, not form decoding: '+' cannot represent a space.
    expect(uri.href).toContain("Design%201.md");
    expect(uri.href).not.toContain("+");
    expect(uri.searchParams.get("path")).toBe(path.join(vault, note.path));
    await store.disconnectVault(connection.id);
    await expect(store.readNote({ vaultID: connection.id, path: note.path })).rejects.toThrow(
      "disconnected",
    );
    expect(await fs.readFile(path.join(vault, note.path), "utf8")).toBe(note.content);
  });
  it("percent-encodes literal plus signs, spaces, Unicode, and ampersands for Obsidian", async () => {
    const connection = await store.connectVault(vault, "Encoding", null);
    const filename = "A + B & résumé 2.md";
    await fs.writeFile(path.join(vault, filename), "URI regression fixture");
    const uri = await store.noteURI({ vaultID: connection.id, path: filename });
    expect(uri).toBe(`obsidian://open?path=${encodeURIComponent(path.join(vault, filename))}`);
    expect(decodeURIComponent(uri.split("?path=")[1]!)).toBe(path.join(vault, filename));
  });
  it("enforces workspace scope on list, search, read and open", async () => {
    const connection = await store.connectVault(vault, "Scoped", workspace);
    expect(await store.listVaults(null)).toEqual([]);
    await fs.mkdir(path.join(workspace, "child"));
    expect(await store.listVaults(path.join(workspace, "child"))).toHaveLength(1);
    await expect(
      store.readNote({ vaultID: connection.id, path: "Research.md", workspacePath: home }),
    ).rejects.toThrow("unavailable");
    await expect(
      store.searchNotes({ vaultID: connection.id, query: "", workspacePath: null }),
    ).rejects.toThrow("unavailable");
    await expect(
      store.noteURI({ vaultID: connection.id, path: "Research.md", workspacePath: null }),
    ).rejects.toThrow("unavailable");
  });
  it("explains Obsidian's reserved heading separator while still allowing note reads", async () => {
    const connection = await store.connectVault(vault, "Reserved filename", null);
    await fs.writeFile(path.join(vault, "Literal # heading.md"), "Still readable");
    const input = { vaultID: connection.id, path: "Literal # heading.md" };
    expect((await store.readNote(input)).content).toBe("Still readable");
    await expect(store.noteURI(input)).rejects.toThrow("heading marker");
  });
  it("rejects non-vault folders, duplicates, traversal, hidden files and symlink escapes", async () => {
    await expect(store.connectVault(home, "", null)).rejects.toThrow("Obsidian vault");
    const connection = await store.connectVault(vault, "", null);
    await expect(store.connectVault(vault, "Again", null)).rejects.toThrow("already connected");
    await fs.writeFile(path.join(home, "Secret.md"), "secret");
    await fs.symlink(path.join(home, "Secret.md"), path.join(vault, "Escape.md"));
    await fs.symlink(home, path.join(vault, "outside"));
    await fs.writeFile(path.join(vault, ".obsidian", "Secret.md"), "hidden secret");
    for (const invalid of [
      "../home/Secret.md",
      "/tmp/Secret.md",
      "outside/Secret.md",
      "Escape.md",
      ".obsidian/Secret.md",
      "Projects/../Research.md",
      "Projects\\Design.md",
    ])
      await expect(store.readNote({ vaultID: connection.id, path: invalid })).rejects.toThrow();
    expect((await store.searchNotes({ vaultID: connection.id, query: "secret" })).notes).toEqual(
      [],
    );
  });
  it("bounds files and results, and notices external edits", async () => {
    const connection = await store.connectVault(vault, "", null);
    await fs.writeFile(path.join(vault, "Big.md"), "x".repeat(1024 * 1024 + 1));
    await expect(store.readNote({ vaultID: connection.id, path: "Big.md" })).rejects.toThrow(
      "smaller",
    );
    await fs.writeFile(path.join(vault, "Research.md"), "A new fresh conclusion");
    expect(
      (await store.searchNotes({ vaultID: connection.id, query: "fresh" })).notes,
    ).toHaveLength(1);
    await Promise.all(
      Array.from({ length: 110 }, (_, i) => fs.writeFile(path.join(vault, `Note${i}.md`), "limit")),
    );
    const result = await store.searchNotes({ vaultID: connection.id, query: "" });
    expect(result.limited).toBe(true);
    expect(result.notes).toHaveLength(100);
  });
  it("serializes concurrent changes", async () => {
    await Promise.all([
      store.connectVault(vault, "Global", null),
      store.connectVault(vault, "Project", workspace),
    ]);
    expect(await store.listVaults()).toHaveLength(2);
  });
});
async function skillFixture() {
  const folder = path.join(root, "my-skill");
  await fs.mkdir(path.join(folder, "references"), { recursive: true });
  await fs.writeFile(
    path.join(folder, "SKILL.md"),
    "---\nname: test-knowledge\ndescription: Preserve project conventions.\n---\n# Instructions\nRead references/rules.md.\n",
  );
  await fs.writeFile(path.join(folder, "references", "rules.md"), "Respect [[wikilinks]].");
  return folder;
}
describe("custom skills", () => {
  it("installs reviewed snapshots, persists inventory and preserves collisions", async () => {
    const folder = await skillFixture();
    const preview = await store.previewSkill(folder);
    expect(preview.files).toEqual(["SKILL.md", "references/rules.md"]);
    await fs.writeFile(path.join(folder, "references", "rules.md"), "Changed after review");
    const skill = await store.importSkill({
      token: preview.token,
      agent: "codex",
      workspacePath: null,
    });
    expect(skill.path).toBe(path.join(home, ".agents/skills/test-knowledge"));
    expect(await fs.readFile(path.join(skill.path, "references/rules.md"), "utf8")).toBe(
      "Respect [[wikilinks]].",
    );
    store = new LocalKnowledge(path.join(root, "state"), home);
    expect(await store.listImportedSkills()).toEqual([skill]);
    const again = await store.previewSkill(folder);
    await expect(
      store.importSkill({ token: again.token, agent: "codex", workspacePath: null }),
    ).rejects.toThrow("already exists");
    await store.removeImportedSkill(skill.id);
    expect(await store.listImportedSkills()).toEqual([]);
    expect(await fs.readFile(path.join(skill.path, "SKILL.md"), "utf8")).toContain("Instructions");
  });
  it("supports each provider and workspace installations", async () => {
    const folder = await skillFixture();
    for (const [agent, target] of [
      ["claude", ".claude"],
      ["cursor", ".cursor"],
      ["copilot", ".copilot"],
    ] as const) {
      const preview = await store.previewSkill(folder);
      const skill = await store.importSkill({
        token: preview.token,
        agent,
        workspacePath: workspace,
      });
      expect(skill.path).toBe(path.join(workspace, target, "skills/test-knowledge"));
    }
  });
  it("rejects missing metadata, unsafe names, symbolic links and redirected destinations", async () => {
    await expect(store.previewSkill(home)).rejects.toThrow("SKILL.md");
    const folder = await skillFixture();
    await fs.symlink(path.join(home, "not-there"), path.join(folder, "escape"));
    await expect(store.previewSkill(folder)).rejects.toThrow("symbolic links");
    await fs.unlink(path.join(folder, "escape"));
    const preview = await store.previewSkill(folder);
    await fs.symlink(workspace, path.join(home, ".agents"));
    await expect(
      store.importSkill({ token: preview.token, agent: "codex", workspacePath: null }),
    ).rejects.toThrow("symbolic link");
    await fs.writeFile(
      path.join(folder, "SKILL.md"),
      "---\nname: ../../escape\ndescription: Test\n---\n",
    );
    await expect(store.previewSkill(folder)).rejects.toThrow("lowercase");
  });
  it("allows only reviewed tokens, once", async () => {
    await expect(
      store.importSkill({ token: "unknown", agent: "codex", workspacePath: null }),
    ).rejects.toThrow("expired");
    const preview = await store.previewSkill(await skillFixture());
    await store.importSkill({ token: preview.token, agent: "codex", workspacePath: null });
    await expect(
      store.importSkill({ token: preview.token, agent: "claude", workspacePath: null }),
    ).rejects.toThrow("expired");
  });
  it("validates YAML metadata and supports multiline descriptions", async () => {
    const folder = await skillFixture();
    await fs.writeFile(
      path.join(folder, "SKILL.md"),
      "---\nname: multiline-skill\ndescription: >\n  Keep these\n  conventions.\n---\n# Rules\n",
    );
    expect((await store.previewSkill(folder)).description).toBe("Keep these conventions.");
    await fs.writeFile(
      path.join(folder, "SKILL.md"),
      "---\nname: valid-name\ndescription: [invalid, array]\n---\n",
    );
    await expect(store.previewSkill(folder)).rejects.toThrow("valid YAML");
  });
  it("rejects concurrent reuse of a reviewed snapshot", async () => {
    const preview = await store.previewSkill(await skillFixture());
    const result = await Promise.allSettled([
      store.importSkill({ token: preview.token, agent: "codex", workspacePath: null }),
      store.importSkill({ token: preview.token, agent: "claude", workspacePath: null }),
    ]);
    expect(result.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(await store.listImportedSkills()).toHaveLength(1);
  });
});
