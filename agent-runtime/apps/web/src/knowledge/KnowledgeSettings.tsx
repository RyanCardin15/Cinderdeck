import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImportedSkill,
  ObsidianVault,
  SkillImportAgent,
  SkillImportPreview,
} from "@cinderdeck/contracts";
import { SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../components/ui/dialog";
import { ObsidianNotes, knowledgeError } from "./ObsidianNotes";
import styles from "./knowledge.module.css";

export function KnowledgeSettings() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.knowledge;
  const [vaults, setVaults] = useState<readonly ObsidianVault[]>([]);
  const [skills, setSkills] = useState<readonly ImportedSkill[]>([]);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<string | null>(null);
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [agent, setAgent] = useState<SkillImportAgent>("codex");
  const [browse, setBrowse] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const alive = useRef(false);
  const running = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!bridge) return;
    const [rows, imports] = await Promise.all([bridge.listVaults(), bridge.listImportedSkills()]);
    if (alive.current) {
      setVaults(rows);
      setSkills(imports);
    }
  }, [bridge]);
  useEffect(() => {
    void refresh().catch((cause) => {
      if (alive.current) setError(knowledgeError(cause));
    });
  }, [refresh]);
  async function run(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await refresh();
    } catch (cause) {
      if (alive.current) setError(knowledgeError(cause));
    } finally {
      running.current = false;
      if (alive.current) setPending(false);
    }
  }
  const scopeControl = (
    <div className={styles.filters}>
      <label>
        Availability
        <select
          aria-label="Connection and import scope"
          value={scope === null ? "personal" : "workspace"}
          disabled={pending}
          onChange={(e) => {
            if (e.target.value === "personal") setScope(null);
            else
              void run(async () => {
                const folder = await window.desktopBridge?.pickFolder();
                if (folder && alive.current) setScope(folder);
              });
          }}
        >
          <option value="personal">All chats on this Mac / personal skills</option>
          <option value="workspace">Choose a workspace folder…</option>
        </select>
      </label>
      {scope && (
        <div className={styles.details}>
          <small>Workspace folder: {scope}</small>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              void run(async () => {
                const folder = await window.desktopBridge?.pickFolder();
                if (folder && alive.current) setScope(folder);
              })
            }
          >
            Change folder
          </Button>
        </div>
      )}
    </div>
  );
  if (!bridge) return null;
  return (
    <>
      <SettingsSection id="obsidian" title="Obsidian">
        <div className={styles.content}>
          <p className={styles.intro}>
            Connect vaults on this Mac to find notes, preview them, and attach snapshots to chat.
            Vault files stay in place and are read only.
          </p>
          {scopeControl}
          <div className={styles.filters}>
            <label>
              Vault name (optional)
              <input
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
                placeholder="Uses the folder name"
              />
            </label>
          </div>
          <div className={styles.actions}>
            <Button
              variant="outline"
              disabled={pending || !vaults.length}
              onClick={() => setBrowse(true)}
            >
              Browse notes
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  const vault = await bridge.connectVault({ name, workspacePath: scope });
                  if (vault && alive.current) {
                    setName("");
                    setMessage(`Connected ${vault.name}.`);
                  }
                })
              }
            >
              {pending ? "Working…" : "Connect vault…"}
            </Button>
          </div>
          {vaults.map((vault) => (
            <div className={styles.row} key={vault.id}>
              <div className={styles.details}>
                <strong>{vault.name}</strong>
                <small>{vault.path}</small>
                <small>
                  {vault.workspacePath
                    ? `Workspace: ${vault.workspacePath}`
                    : "Available to all chats on this Mac"}{" "}
                  · Read only
                </small>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                aria-label={`Disconnect ${vault.name}`}
                onClick={() =>
                  void run(async () => {
                    await bridge.disconnectVault(vault.id);
                    if (alive.current) setMessage(`Disconnected ${vault.name}. Notes were kept.`);
                  })
                }
              >
                Disconnect
              </Button>
            </div>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection id="custom-skills" title="Your skills">
        <div className={styles.content}>
          <p className={styles.intro}>
            Import a folder containing SKILL.md, references, and optional scripts. Review the
            instructions, then choose an agent. Existing skills are preserved. The availability
            setting above also selects personal or workspace installation.
          </p>
          <div className={styles.actions}>
            <Button
              variant="outline"
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  const value = await bridge.previewSkill();
                  if (alive.current) setPreview(value);
                })
              }
            >
              Import skill folder…
            </Button>
          </div>
          {skills.map((skill) => (
            <div className={styles.row} key={skill.id}>
              <div className={styles.details}>
                <strong>
                  {skill.name} · {skill.agent}
                </strong>
                <small>{skill.path}</small>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    await bridge.removeImportedSkill(skill.id);
                    if (alive.current)
                      setMessage(
                        "Removed from import history. The installed skill files were kept; remove them in Finder to uninstall.",
                      );
                  })
                }
              >
                Forget import
              </Button>
            </div>
          ))}
        </div>
      </SettingsSection>
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {message && (
        <p role="status" className={styles.intro}>
          {message}
        </p>
      )}
      <ObsidianNotes open={browse} onOpenChange={setBrowse} />
      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setPreview(null);
        }}
      >
        <DialogPopup className="max-w-2xl p-6" showCloseButton={!pending}>
          <DialogTitle>Import {preview?.name}</DialogTitle>
          <DialogDescription>
            These instructions become available to your agent. Scripts are copied without being run.
            Review all files from sources you trust.
          </DialogDescription>
          {preview && (
            <>
              <p className={styles.intro}>{preview.description}</p>
              <pre className={styles.source}>{preview.content}</pre>
              <details>
                <summary>
                  {preview.files.length} files · {Math.ceil(preview.bytes / 1024)} KB
                </summary>
                <ul>
                  {preview.files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </details>
              <div className={styles.filters}>
                <label>
                  Install for
                  <select
                    aria-label="Skill agent"
                    value={agent}
                    disabled={pending}
                    onChange={(e) => setAgent(e.target.value as SkillImportAgent)}
                  >
                    <option value="codex">Codex</option>
                    <option value="claude">Claude Code</option>
                    <option value="cursor">Cursor</option>
                    <option value="copilot">Copilot</option>
                  </select>
                </label>
              </div>
              <p className={styles.intro}>
                {scope ? `Workspace: ${scope}` : "Personal skill on this Mac"}. Restart or refresh
                the agent after importing.
              </p>
              {error && (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
              )}
              <div className={styles.actions}>
                <Button variant="outline" disabled={pending} onClick={() => setPreview(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      const skill = await bridge.importSkill({
                        token: preview.token,
                        agent,
                        workspacePath: scope,
                      });
                      if (alive.current) {
                        setPreview(null);
                        setMessage(
                          `Imported ${skill.name} for ${agent}. Refresh or restart your agent to load it.`,
                        );
                      }
                    })
                  }
                >
                  {pending ? "Importing…" : "Install skill"}
                </Button>
              </div>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
