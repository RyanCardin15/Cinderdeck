import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImportedSkill,
  ObsidianVault,
  SkillImportAgent,
  SkillImportPreview,
} from "@cinderdeck/contracts";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
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
      window.dispatchEvent(new Event("cinderdeck:knowledge-changed"));
    } catch (cause) {
      if (alive.current) setError(knowledgeError(cause));
    } finally {
      running.current = false;
      if (alive.current) setPending(false);
    }
  }
  const scopeControl = (
    <SettingsRow
      title="Availability"
      description="Choose where connected vaults and imported skills are available."
      status={scope ? <span className="wrap-anywhere">Workspace folder: {scope}</span> : undefined}
      control={
        <div className="flex w-full flex-wrap gap-2 @min-[32rem]/settings-row:w-auto">
          <Select
            value={scope === null ? "personal" : "workspace"}
            disabled={pending}
            onValueChange={(value) => {
              if (value === null) return;
              if (value === "personal") setScope(null);
              else
                void run(async () => {
                  const folder = await window.desktopBridge?.pickFolder();
                  if (folder && alive.current) setScope(folder);
                });
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full @min-[32rem]/settings-row:w-56"
              aria-label="Connection and import scope"
            >
              <SelectValue>
                {scope === null ? "All chats on this Mac" : "Workspace folder"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="personal">All chats on this Mac</SelectItem>
              <SelectItem value="workspace">Workspace folder…</SelectItem>
            </SelectPopup>
          </Select>
          {scope && (
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
          )}
        </div>
      }
    />
  );
  if (!bridge) return null;
  return (
    <>
      <SettingsSection id="obsidian" title="Obsidian">
        {scopeControl}
        <SettingsRow
          title={<label htmlFor="obsidian-vault-name">Vault name</label>}
          description="Optional. Uses the folder name when left empty."
          control={
            <Input
              id="obsidian-vault-name"
              size="sm"
              className="w-full @min-[32rem]/settings-row:w-56"
              value={name}
              disabled={pending}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              placeholder="Uses the folder name"
            />
          }
        />
        <SettingsRow
          title="Connected vaults"
          description="Find notes, preview them, and attach snapshots to chat. Vault files stay in place and are read only."
          control={
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !vaults.length}
                onClick={() => setBrowse(true)}
              >
                Browse notes
              </Button>
              <Button
                size="sm"
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
            </>
          }
        />
        {vaults.map((vault) => (
          <SettingsRow
            key={vault.id}
            title={vault.name}
            status={<span className="wrap-anywhere">{vault.path}</span>}
            description={
              (vault.workspacePath
                ? `Workspace: ${vault.workspacePath}`
                : "Available to all chats on this Mac") + " · Read only"
            }
            control={
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
            }
          />
        ))}
      </SettingsSection>
      <SettingsSection id="custom-skills" title="Your skills">
        <SettingsRow
          title="Import a skill"
          description="Choose a folder containing SKILL.md, references, and optional scripts. Review the instructions before installing. Existing skills are preserved."
          status={
            scope
              ? `Install in workspace: ${scope}`
              : "Install as a personal skill on this Mac. Change Availability above to choose a workspace."
          }
          control={
            <Button
              size="sm"
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
          }
        />
        {skills.map((skill) => (
          <SettingsRow
            key={skill.id}
            title={skill.name}
            description={`Installed for ${skill.agent}`}
            status={<span className="wrap-anywhere">{skill.path}</span>}
            control={
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
            }
          />
        ))}
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
        <DialogPopup className="max-w-2xl" showCloseButton={!pending}>
          <DialogHeader>
            <DialogTitle>Import {preview?.name}</DialogTitle>
            <DialogDescription>
              These instructions become available to your agent. Scripts are copied without being
              run. Review all files from sources you trust.
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <DialogPanel>
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
              </DialogPanel>
              <DialogFooter>
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
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}
