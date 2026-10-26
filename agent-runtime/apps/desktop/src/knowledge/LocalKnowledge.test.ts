// @effect-diagnostics nodeBuiltinImport:off -- Disposable filesystem fixtures exercise actual vault and skill boundaries.
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { LocalKnowledge } from "./LocalKnowledge.ts";
let root: string, vault: string, workspace: string, home: string, store: LocalKnowledge;
beforeEach(async () => {
  root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cinderdeck-knowledge-")),
  );
  vault = NodePath.join(root, "Vault & notes");
  workspace = NodePath.join(root, "project");
  home = NodePath.join(root, "home");
  await Promise.all([
    NodeFSP.mkdir(NodePath.join(vault, ".obsidian"), { recursive: true }),
    NodeFSP.mkdir(workspace),
    NodeFSP.mkdir(home),
  ]);
  await NodeFSP.mkdir(NodePath.join(vault, "Projects"));
  await NodeFSP.writeFile(
    NodePath.join(vault, "Projects", "Design 1.md"),
    "---\ntags: [architecture]\n---\n# Architecture\nThe aurora decision links [[Research]].\n",
  );
  await NodeFSP.writeFile(NodePath.join(vault, "Research.md"), "# Research\nA separate note.");
  store = new LocalKnowledge(NodePath.join(root, "state"), home);
});
afterEach(async () => {
  await NodeFSP.rm(root, { recursive: true, force: true });
});
describe("Obsidian connections", () => {
  it("persists, searches content, reads exact Markdown, opens exact paths and disconnects without deleting notes", async () => {
    const connection = await store.connectVault(vault, "Work notes", null);
    store = new LocalKnowledge(NodePath.join(root, "state"), home);
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
    expect(uri.searchParams.get("path")).toBe(NodePath.join(vault, note.path));
    await store.disconnectVault(connection.id);
    await expect(store.readNote({ vaultID: connection.id, path: note.path })).rejects.toThrow(
      "disconnected",
    );
    expect(await NodeFSP.readFile(NodePath.join(vault, note.path), "utf8")).toBe(note.content);
  });
  it("percent-encodes literal plus signs, spaces, Unicode, and ampersands for Obsidian", async () => {
    const connection = await store.connectVault(vault, "Encoding", null);
    const filename = "A + B & résumé 2.md";
    await NodeFSP.writeFile(NodePath.join(vault, filename), "URI regression fixture");
    const uri = await store.noteURI({ vaultID: connection.id, path: filename });
    expect(uri).toBe(`obsidian://open?path=${encodeURIComponent(NodePath.join(vault, filename))}`);
    expect(decodeURIComponent(uri.split("?path=")[1]!)).toBe(NodePath.join(vault, filename));
  });
  it("enforces workspace scope on list, search, read and open", async () => {
    const connection = await store.connectVault(vault, "Scoped", workspace);
    expect(await store.listVaults(null)).toEqual([]);
    await NodeFSP.mkdir(NodePath.join(workspace, "child"));
    expect(await store.listVaults(NodePath.join(workspace, "child"))).toHaveLength(1);
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
    await NodeFSP.writeFile(NodePath.join(vault, "Literal # heading.md"), "Still readable");
    const input = { vaultID: connection.id, path: "Literal # heading.md" };
    expect((await store.readNote(input)).content).toBe("Still readable");
    await expect(store.noteURI(input)).rejects.toThrow("heading marker");
  });
  it("rejects non-vault folders, duplicates, traversal, hidden files and symlink escapes", async () => {
    await expect(store.connectVault(home, "", null)).rejects.toThrow("Obsidian vault");
    const connection = await store.connectVault(vault, "", null);
    await expect(store.connectVault(vault, "Again", null)).rejects.toThrow("already connected");
    await NodeFSP.writeFile(NodePath.join(home, "Secret.md"), "secret");
    await NodeFSP.symlink(NodePath.join(home, "Secret.md"), NodePath.join(vault, "Escape.md"));
    await NodeFSP.symlink(home, NodePath.join(vault, "outside"));
    await NodeFSP.writeFile(NodePath.join(vault, ".obsidian", "Secret.md"), "hidden secret");
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
    await NodeFSP.writeFile(NodePath.join(vault, "Big.md"), "x".repeat(1024 * 1024 + 1));
    await expect(store.readNote({ vaultID: connection.id, path: "Big.md" })).rejects.toThrow(
      "smaller",
    );
    await NodeFSP.writeFile(NodePath.join(vault, "Research.md"), "A new fresh conclusion");
    expect(
      (await store.searchNotes({ vaultID: connection.id, query: "fresh" })).notes,
    ).toHaveLength(1);
    await Promise.all(
      Array.from({ length: 110 }, (_, i) =>
        NodeFSP.writeFile(NodePath.join(vault, `Note${i}.md`), "limit"),
      ),
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
  const folder = NodePath.join(root, "my-skill");
  await NodeFSP.mkdir(NodePath.join(folder, "references"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(folder, "SKILL.md"),
    "---\nname: test-knowledge\ndescription: Preserve project conventions.\n---\n# Instructions\nRead references/rules.md.\n",
  );
  await NodeFSP.writeFile(
    NodePath.join(folder, "references", "rules.md"),
    "Respect [[wikilinks]].",
  );
  return folder;
}
describe("custom skills", () => {
  it("installs reviewed snapshots, persists inventory and preserves collisions", async () => {
    const folder = await skillFixture();
    const preview = await store.previewSkill(folder);
    expect(preview.files).toEqual(["SKILL.md", "references/rules.md"]);
    await NodeFSP.writeFile(
      NodePath.join(folder, "references", "rules.md"),
      "Changed after review",
    );
    const skill = await store.importSkill({
      token: preview.token,
      agent: "codex",
      workspacePath: null,
    });
    expect(skill.path).toBe(NodePath.join(home, ".agents/skills/test-knowledge"));
    expect(await NodeFSP.readFile(NodePath.join(skill.path, "references/rules.md"), "utf8")).toBe(
      "Respect [[wikilinks]].",
    );
    store = new LocalKnowledge(NodePath.join(root, "state"), home);
    expect(await store.listImportedSkills()).toEqual([skill]);
    const again = await store.previewSkill(folder);
    await expect(
      store.importSkill({ token: again.token, agent: "codex", workspacePath: null }),
    ).rejects.toThrow("already exists");
    await store.removeImportedSkill(skill.id);
    expect(await store.listImportedSkills()).toEqual([]);
    expect(await NodeFSP.readFile(NodePath.join(skill.path, "SKILL.md"), "utf8")).toContain(
      "Instructions",
    );
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
      expect(skill.path).toBe(NodePath.join(workspace, target, "skills/test-knowledge"));
    }
  });
  it("rejects missing metadata, unsafe names, symbolic links and redirected destinations", async () => {
    await expect(store.previewSkill(home)).rejects.toThrow("SKILL.md");
    const folder = await skillFixture();
    await NodeFSP.symlink(NodePath.join(home, "not-there"), NodePath.join(folder, "escape"));
    await expect(store.previewSkill(folder)).rejects.toThrow("symbolic links");
    await NodeFSP.unlink(NodePath.join(folder, "escape"));
    const preview = await store.previewSkill(folder);
    await NodeFSP.symlink(workspace, NodePath.join(home, ".agents"));
    await expect(
      store.importSkill({ token: preview.token, agent: "codex", workspacePath: null }),
    ).rejects.toThrow("symbolic link");
    await NodeFSP.writeFile(
      NodePath.join(folder, "SKILL.md"),
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
    await NodeFSP.writeFile(
      NodePath.join(folder, "SKILL.md"),
      "---\nname: multiline-skill\ndescription: >\n  Keep these\n  conventions.\n---\n# Rules\n",
    );
    expect((await store.previewSkill(folder)).description).toBe("Keep these conventions.");
    await NodeFSP.writeFile(
      NodePath.join(folder, "SKILL.md"),
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
