// @effect-diagnostics globalDate:off -- Plain asynchronous storage uses wall time only for import expiry and bounded search.
// @effect-diagnostics nodeBuiltinImport:off -- Device-local file I/O is isolated from the renderer and tested with disposable roots.
// @effect-diagnostics cryptoRandomUUID:off -- Persistent connection and import identifiers.
import { skillMetadata } from "./skillMetadata.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type {
  ImportedSkill,
  ObsidianNote,
  ObsidianSearchResult,
  ObsidianVault,
  SkillImportAgent,
  SkillImportPreview,
} from "@cinderdeck/contracts";

const MAX_NOTE = 1024 * 1024;
const MAX_SKILL = 5 * MAX_NOTE;
const AGENTS = {
  codex: ".agents/skills",
  claude: ".claude/skills",
  cursor: ".cursor/skills",
  copilot: ".copilot/skills",
} as const;
interface State {
  version: 1;
  vaults: ObsidianVault[];
  skills: (ImportedSkill & { hashes: Record<string, string> })[];
}
interface Staged {
  preview: SkillImportPreview;
  files: Map<string, Buffer>;
  modes: Map<string, number>;
  expires: number;
}
const hash = (value: Buffer) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const contains = (root: string, file: string) =>
  file === root ||
  (!NodePath.isAbsolute(NodePath.relative(root, file)) &&
    !NodePath.relative(root, file).split(NodePath.sep).includes(".."));
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error(`Invalid ${label}.`);
  return value.trim();
}
function relative(value: string): string {
  text(value, "note path");
  if (
    NodePath.isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((p) => !p || p === "." || p === ".." || p.startsWith("."))
  )
    throw new Error("Choose a note inside the connected vault.");
  return value;
}
async function directory(value: string): Promise<string> {
  if (!NodePath.isAbsolute(text(value, "folder")))
    throw new Error("Choose an absolute folder path.");
  const real = await NodeFSP.realpath(value);
  if (!(await NodeFSP.stat(real)).isDirectory()) throw new Error("Choose a folder.");
  return real;
}
async function regularFile(
  root: string,
  rel: string,
  max: number,
): Promise<{ content: Buffer; modifiedAt: number; mode: number }> {
  const file = NodePath.join(root, relative(rel));
  let current = root;
  for (const part of rel.split("/")) {
    current = NodePath.join(current, part);
    if ((await NodeFSP.lstat(current)).isSymbolicLink())
      throw new Error("Symbolic links are excluded from connected folders.");
  }
  if (!contains(root, await NodeFSP.realpath(file)))
    throw new Error("The file is outside the connected folder.");
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max)
      throw new Error(`Files must be regular files smaller than ${Math.round(max / MAX_NOTE)} MB.`);
    // A bounded read also handles a file that grows between stat and read.
    const data = Buffer.alloc(Math.min(max + 1, stat.size + 1));
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const chunk = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > max) throw new Error("The file is too large.");
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || bytesRead !== stat.size)
      throw new Error("The file changed while it was being read. Try again.");
    return {
      content: data.subarray(0, bytesRead),
      modifiedAt: stat.mtimeMs,
      mode: stat.mode & 0o100 ? 0o700 : 0o600,
    };
  } finally {
    await handle.close();
  }
}

/** One instance per desktop process; serialized mutations and atomic state replacement. */
export class LocalKnowledge {
  private searchGeneration = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private staged = new Map<string, Staged>();
  private readonly stateDir: string;
  private readonly homeDir: string;
  constructor(stateDir: string, homeDir: string) {
    this.stateDir = stateDir;
    this.homeDir = homeDir;
  }
  private get stateFile() {
    return NodePath.join(this.stateDir, "local-knowledge.json");
  }
  private async state(): Promise<State> {
    try {
      const raw = JSON.parse(await NodeFSP.readFile(this.stateFile, "utf8")) as State;
      if (raw.version !== 1 || !Array.isArray(raw.vaults) || !Array.isArray(raw.skills))
        throw new Error("Invalid knowledge settings.");
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, vaults: [], skills: [] };
      throw error;
    }
  }
  private mutate<T>(fn: (state: State) => Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const state = await this.state();
      const result = await fn(state);
      await NodeFSP.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.stateFile}.${NodeCrypto.randomUUID()}`;
      try {
        await NodeFSP.writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
        await NodeFSP.rename(temporary, this.stateFile);
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
      return result;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  async listVaults(workspacePath?: string | null | undefined): Promise<ObsidianVault[]> {
    await this.queue;
    const scope = workspacePath ? await directory(workspacePath) : null;
    return (await this.state()).vaults.filter(
      (v) =>
        workspacePath === undefined ||
        v.workspacePath === null ||
        (scope !== null && contains(v.workspacePath, scope)),
    );
  }
  async connectVault(
    folder: string,
    name: string,
    workspacePath: string | null,
  ): Promise<ObsidianVault> {
    const root = await directory(folder);
    const config = await NodeFSP.lstat(NodePath.join(root, ".obsidian")).catch(() => null);
    if (!config?.isDirectory() || config.isSymbolicLink())
      throw new Error("Choose an Obsidian vault folder containing .obsidian.");
    const scope = workspacePath === null ? null : await directory(workspacePath);
    return this.mutate(async (state) => {
      if (state.vaults.length >= 30)
        throw new Error("Disconnect a vault before adding another (maximum 30).");
      if (state.vaults.some((v) => v.path === root && v.workspacePath === scope))
        throw new Error("This vault is already connected in that scope.");
      const vault = {
        id: NodeCrypto.randomUUID(),
        name: name.trim() ? text(name, "vault name", 100) : NodePath.basename(root),
        path: root,
        workspacePath: scope,
      };
      state.vaults.push(vault);
      return vault;
    });
  }
  disconnectVault(id: string): Promise<void> {
    return this.mutate(async (state) => {
      state.vaults = state.vaults.filter((v) => v.id !== text(id, "vault ID"));
    });
  }
  private async vault(id: string, scope?: string | null): Promise<ObsidianVault> {
    const vault = (await this.listVaults(scope)).find((v) => v.id === id);
    if (!vault) throw new Error("This vault is disconnected or unavailable to this workspace.");
    if ((await directory(vault.path)) !== vault.path)
      throw new Error("The vault folder has moved. Reconnect it in Settings.");
    return vault;
  }
  async readNote(input: {
    vaultID: string;
    path: string;
    workspacePath?: string | null | undefined;
  }): Promise<ObsidianNote> {
    const vault = await this.vault(input.vaultID, input.workspacePath);
    if (!input.path.toLowerCase().endsWith(".md")) throw new Error("Choose a Markdown note.");
    const { content, modifiedAt } = await regularFile(vault.path, input.path, MAX_NOTE);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (body.includes("\0")) throw new Error("This note is not a text file.");
    return {
      path: input.path,
      title: NodePath.basename(input.path, NodePath.extname(input.path)),
      excerpt: body.slice(0, 220),
      content: body,
      modifiedAt,
      vaultName: vault.name,
    };
  }
  async searchNotes(input: {
    vaultID: string;
    query: string;
    workspacePath?: string | null | undefined;
  }): Promise<ObsidianSearchResult> {
    const vault = await this.vault(input.vaultID, input.workspacePath);
    if (typeof input.query !== "string" || input.query.length > 500)
      throw new Error("Search must be at most 500 characters.");
    const generation = ++this.searchGeneration;
    const terms = input.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const notes: ObsidianSearchResult["notes"][number][] = [];
    let scanned = 0,
      limited = false;
    const deadline = Date.now() + 5000;
    const folders = [""];
    while (folders.length && !limited) {
      const rel = folders.pop()!;
      const folder = NodePath.join(vault.path, rel);
      if (
        !contains(vault.path, await NodeFSP.realpath(folder)) ||
        (await NodeFSP.lstat(folder)).isSymbolicLink()
      )
        continue;
      const entries = await NodeFSP.readdir(folder, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (
          generation !== this.searchGeneration ||
          ++scanned > 30000 ||
          Date.now() > deadline ||
          notes.length >= 100
        ) {
          limited = true;
          break;
        }
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const target = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          folders.push(target);
          continue;
        }
        if (!entry.isFile() || !target.toLowerCase().endsWith(".md")) continue;
        try {
          const { content } = await regularFile(vault.path, target, MAX_NOTE);
          const body = new TextDecoder("utf-8", { fatal: true }).decode(content);
          if (body.includes("\0")) continue;
          const searchable = `${target}\n${body}`.toLocaleLowerCase();
          if (!terms.every((term) => searchable.includes(term))) continue;
          const offset = terms.length
            ? Math.max(0, body.toLocaleLowerCase().indexOf(terms[0]!) - 60)
            : 0;
          notes.push({
            path: target,
            title: NodePath.basename(target, NodePath.extname(target)),
            excerpt: body.slice(offset, offset + 220),
          });
        } catch {
          /* Unreadable, removed and oversized notes do not break other results. */
        }
      }
    }
    return { notes: notes.sort((a, b) => a.path.localeCompare(b.path)), limited };
  }
  async noteURI(input: {
    vaultID: string;
    path: string;
    workspacePath?: string | null | undefined;
  }): Promise<string> {
    await this.readNote(input);
    if (input.path.includes("#")) {
      throw new Error(
        "Obsidian treats # in note links as a heading marker. Open this note from Obsidian's file explorer; preview and chat attachments still work here.",
      );
    }
    const vault = await this.vault(input.vaultID, input.workspacePath);
    // Obsidian decodes URI values with percent decoding; form-style '+' spaces
    // are treated as literal plus signs and fail to resolve the intended note.
    return `obsidian://open?path=${encodeURIComponent(NodePath.join(vault.path, input.path))}`;
  }
  async previewSkill(folder: string): Promise<SkillImportPreview> {
    const root = await directory(folder);
    const files = new Map<string, Buffer>();
    const modes = new Map<string, number>();
    let bytes = 0,
      entries = 0;
    const deadline = Date.now() + 5000;
    const walk = async (rel: string) => {
      for (const entry of await NodeFSP.readdir(NodePath.join(root, rel), {
        withFileTypes: true,
      })) {
        if (++entries > 1000 || Date.now() > deadline)
          throw new Error("This skill folder is too large. Choose a single skill folder.");
        if (entry.name.startsWith(".")) continue;
        const target = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error("Skill imports cannot contain symbolic links.");
        if (entry.isDirectory()) {
          if (target.split("/").length > 10)
            throw new Error("Skill folders are nested too deeply.");
          await walk(target);
        } else if (entry.isFile()) {
          if (files.size >= 200) throw new Error("A skill can contain at most 200 files.");
          const result = await regularFile(
            root,
            target,
            target === "SKILL.md" ? MAX_NOTE : MAX_SKILL,
          );
          const file = result.content;
          modes.set(target, result.mode);
          bytes += file.length;
          if (bytes > MAX_SKILL) throw new Error("A skill must be smaller than 5 MB.");
          files.set(target, file);
        } else throw new Error("Skill imports must contain regular files.");
      }
    };
    await walk("");
    const entry = files.get("SKILL.md");
    if (!entry) throw new Error("Choose a skill folder containing SKILL.md.");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(entry);
    if (content.includes("\0")) throw new Error("SKILL.md must be a UTF-8 text file.");
    const { name, description } = skillMetadata(content);
    for (const [token, item] of this.staged)
      if (item.expires < Date.now()) this.staged.delete(token);
    if (this.staged.size >= 3) this.staged.delete(this.staged.keys().next().value!);
    const preview = {
      token: NodeCrypto.randomUUID(),
      name,
      description,
      content,
      files: [...files.keys()].sort(),
      bytes,
    };
    this.staged.set(preview.token, { preview, files, modes, expires: Date.now() + 15 * 60_000 });
    return preview;
  }
  async importSkill(input: {
    token: string;
    agent: SkillImportAgent;
    workspacePath: string | null;
  }): Promise<ImportedSkill> {
    const staged = this.staged.get(text(input.token, "import token"));
    if (!staged || staged.expires < Date.now())
      throw new Error("This preview expired. Choose the skill folder again.");
    if (!Object.hasOwn(AGENTS, input.agent)) throw new Error("Choose a supported agent.");
    const root =
      input.workspacePath === null
        ? await directory(this.homeDir)
        : await directory(input.workspacePath);
    return this.mutate(async (state) => {
      if (this.staged.get(input.token) !== staged || staged.expires < Date.now())
        throw new Error("This preview expired. Choose the skill folder again.");
      let parent = root;
      for (const part of AGENTS[input.agent].split("/")) {
        parent = NodePath.join(parent, part);
        await NodeFSP.mkdir(parent).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
        if (
          (await NodeFSP.lstat(parent)).isSymbolicLink() ||
          !(await NodeFSP.stat(parent)).isDirectory()
        )
          throw new Error("The skill destination must be a regular folder, not a symbolic link.");
      }
      const destination = NodePath.join(parent, staged.preview.name);
      try {
        await NodeFSP.mkdir(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("A skill with this name already exists. Your existing skill was kept.");
        throw error;
      }
      const hashes: Record<string, string> = {};
      try {
        // Publish the entrypoint last, so discovery never loads a partially copied skill.
        for (const [rel, data] of [...staged.files].sort(
          ([a], [b]) => Number(a === "SKILL.md") - Number(b === "SKILL.md"),
        )) {
          await NodeFSP.mkdir(NodePath.dirname(NodePath.join(destination, rel)), {
            recursive: true,
          });
          await NodeFSP.writeFile(NodePath.join(destination, rel), data, {
            flag: "wx",
            mode: staged.modes.get(rel) ?? 0o600,
          });
          hashes[rel] = hash(data);
        }
        const skill = {
          id: NodeCrypto.randomUUID(),
          name: staged.preview.name,
          agent: input.agent,
          path: destination,
          importedAt: new Date().toISOString(),
        };
        state.skills.push({ ...skill, hashes });
        this.staged.delete(input.token);
        return skill;
      } catch (error) {
        await NodeFSP.rm(destination, { recursive: true, force: true });
        throw error;
      }
    });
  }
  async listImportedSkills(): Promise<ImportedSkill[]> {
    await this.queue;
    return (await this.state()).skills.map(({ hashes: _, ...skill }) => skill);
  }
  removeImportedSkill(id: string): Promise<void> {
    return this.mutate(async (state) => {
      const skill = state.skills.find((s) => s.id === id);
      if (!skill) throw new Error("This skill is no longer registered.");
      // Unregister only. The person may have changed these files since import.
      state.skills = state.skills.filter((s) => s.id !== id);
    });
  }
}
