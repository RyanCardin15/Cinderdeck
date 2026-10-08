import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useBlocker } from "@tanstack/react-router";
import type { NativeSettingsCommand, NativeSettingsSnapshot } from "@cinderdeck/contracts";
import { Button } from "../components/ui/button";
import { SettingsSection, SettingsRow } from "../components/settings/settingsLayout";
import styles from "./NativeSettings.module.css";

interface Folder {
  id: string;
  path: string;
  lane: "worktree" | "shared";
  laneFrom: string;
}
interface Draft {
  name: string;
  folders: Folder[];
  files: string[];
  source: string;
  review: string;
}
const empty: Draft = { name: "", folders: [], files: [], source: "", review: "" };
const text = (snapshot: NativeSettingsSnapshot | null, key: string) =>
  String(snapshot?.status[key] ?? "");
function draftFrom(snapshot: NativeSettingsSnapshot): Draft {
  return {
    name: text(snapshot, "name"),
    folders: JSON.parse(text(snapshot, "folders") || "[]") as Folder[],
    files: JSON.parse(text(snapshot, "files") || "[]") as string[],
    source: text(snapshot, "source"),
    review: text(snapshot, "review"),
  };
}

/** The main settings shell hosts the inspector; native code owns disk writes. */
export function NativeWorkspaceSettings({
  workspace,
  deleting = false,
  configuration = false,
}: {
  workspace: string;
  deleting?: boolean;
  configuration?: boolean;
}) {
  const [snapshot, setSnapshot] = useState<NativeSettingsSnapshot | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [advanced, setAdvanced] = useState(configuration);
  const [confirmDelete, setConfirmDelete] = useState(deleting);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const live = useRef(true);
  const busy = useRef(false);
  const original = snapshot ? draftFrom(snapshot) : empty;
  const definitionDirty = advanced
    ? draft.source !== original.source
    : JSON.stringify([draft.name, draft.folders, draft.files]) !==
      JSON.stringify([original.name, original.folders, original.files]);
  const reviewDirty = draft.review !== original.review;
  const dirty = definitionDirty || reviewDirty;
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    withResolver: true,
    enableBeforeUnload: dirty,
  });
  const request = useCallback(
    async (
      action: NativeSettingsCommand["action"],
      payload: Record<string, unknown> = {},
      apply = true,
    ) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      setError("");
      setNotice("");
      try {
        if (!window.desktopBridge?.nativeSettings)
          throw new Error("Reopen the complete Cinderdeck app to edit this workspace.");
        const result = await window.desktopBridge.nativeSettings({
          category: "workspaces",
          action,
          payload: { workspace, ...payload },
        });
        if (!live.current) return;
        if (apply) {
          setSnapshot(result);
          setDraft(draftFrom(result));
        }
        if (action === "workspace-save") setNotice("Workspace saved.");
        if (action === "workspace-review-save")
          setNotice("Review instructions saved. New reviews will use them.");
        return result;
      } catch (cause) {
        if (live.current)
          setError(cause instanceof Error ? cause.message : "Could not update this workspace.");
      } finally {
        busy.current = false;
        if (live.current) setPending(false);
      }
    },
    [workspace],
  );
  useEffect(() => {
    live.current = true;
    void request("workspace-read");
    return () => {
      live.current = false;
    };
  }, [request]);
  const pick = async (folder: boolean) => {
    const result = await request(
      folder ? "workspace-pick-folder" : "workspace-pick-file",
      {},
      false,
    );
    const path = result?.status.picked;
    if (typeof path !== "string") return;
    setDraft((value) => {
      if (!folder) return { ...value, files: [...new Set([...value.files, path])] };
      if (value.folders.some((item) => item.path === path)) return value;
      const base =
        path
          .split("/")
          .at(-1)
          ?.replace(/[^a-zA-Z0-9_-]/g, "-") || "folder";
      let id = base;
      let suffix = 2;
      while (value.folders.some((item) => item.id === id)) id = `${base}-${suffix++}`;
      return {
        ...value,
        folders: [...value.folders, { id, path, lane: "worktree", laneFrom: "" }],
      };
    });
  };
  const changeFolder = (index: number, changes: Partial<Folder>) =>
    setDraft((value) => ({
      ...value,
      folders: value.folders.map((item, i) => (i === index ? { ...item, ...changes } : item)),
    }));
  if (snapshot?.status.removed)
    return (
      <div role="status" className={styles.panel}>
        <p>Workspace removed. Project folders and files are preserved.</p>
        <Link to="/settings/workspaces" search={{}} className="text-sm underline">
          Back to workspaces
        </Link>
      </div>
    );
  return (
    <div id="native-workspace" className={styles.panel}>
      <Link
        to="/settings/workspaces"
        search={{}}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        ← All workspaces
      </Link>
      <header className={styles.header}>
        <div>
          <h2>{text(snapshot, "name") || "Workspace settings"}</h2>
          <p>Folders, lane defaults, and review instructions for this workspace.</p>
        </div>
        <span className={styles.badge}>This Mac</span>
      </header>
      {error ? (
        <p role="alert" className={`${styles.feedback} ${styles.error}`}>
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className={styles.feedback}>
          {notice}
        </p>
      ) : null}
      {!snapshot ? (
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void request("workspace-read")}
        >
          {pending ? "Loading workspace…" : "Reload workspace"}
        </Button>
      ) : (
        <>
          {text(snapshot, "definitionError") ? (
            <p role="alert" className={styles.feedback}>
              {text(snapshot, "definitionError")}
            </p>
          ) : null}
          <SettingsSection title="Workspace">
            <SettingsRow
              title="Name"
              control={
                <input
                  className={styles.field}
                  aria-label="Workspace name"
                  value={draft.name}
                  disabled={pending || advanced || reviewDirty}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              }
            />
          </SettingsSection>
          <SettingsSection title="Folders & files">
            <div className="flex flex-col gap-4 p-4">
              <div className={styles.models}>
                {draft.folders.map((folder, index) => (
                  <div key={folder.id} className={styles.model}>
                    <p className="break-all text-xs font-mono">{folder.path}</p>
                    <label>
                      Lane checkout
                      <select
                        className={styles.field}
                        aria-label={`Lane checkout for ${folder.id}`}
                        value={folder.lane}
                        disabled={pending || advanced || reviewDirty}
                        onChange={(event) =>
                          changeFolder(index, { lane: event.target.value as Folder["lane"] })
                        }
                      >
                        <option value="worktree">Worktree</option>
                        <option value="shared">Reference</option>
                      </select>
                    </label>
                    {folder.lane === "worktree" ? (
                      <label>
                        Start from
                        <input
                          className={styles.field}
                          aria-label={`Starting revision for ${folder.id}`}
                          placeholder="Workspace default"
                          disabled={pending || advanced || reviewDirty}
                          value={folder.laneFrom}
                          onChange={(event) =>
                            changeFolder(index, { laneFrom: event.target.value })
                          }
                        />
                      </label>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={pending || advanced || reviewDirty}
                      onClick={() =>
                        setDraft({ ...draft, folders: draft.folders.filter((_, i) => i !== index) })
                      }
                    >
                      Remove folder
                    </Button>
                  </div>
                ))}
              </div>
              {draft.files.map((file) => (
                <div key={file} className={styles.orderRow}>
                  <span className="break-all font-mono text-xs">{file}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={pending || advanced || reviewDirty}
                    onClick={() =>
                      setDraft({ ...draft, files: draft.files.filter((item) => item !== file) })
                    }
                  >
                    Remove file
                  </Button>
                </div>
              ))}
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || advanced || reviewDirty}
                  onClick={() => void pick(true)}
                >
                  Add folder
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || advanced || reviewDirty}
                  onClick={() => void pick(false)}
                >
                  Add file
                </Button>
              </div>
            </div>
          </SettingsSection>
          <SettingsSection title="Code review">
            <div className="flex flex-col items-start gap-3 p-4">
              {text(snapshot, "reviewError") ? (
                <p className={styles.feedback}>{text(snapshot, "reviewError")}</p>
              ) : (
                <>
                  <textarea
                    className={`${styles.field} ${styles.editor}`}
                    rows={12}
                    aria-label="Code review instructions"
                    disabled={pending || definitionDirty}
                    value={draft.review}
                    maxLength={6000}
                    onChange={(event) => setDraft({ ...draft, review: event.target.value })}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !reviewDirty || definitionDirty}
                    onClick={() =>
                      void request("workspace-review-save", {
                        revision: text(snapshot, "revision"),
                        reviewRevision: text(snapshot, "reviewRevision"),
                        content: draft.review,
                      })
                    }
                  >
                    Save review instructions
                  </Button>
                </>
              )}
            </div>
          </SettingsSection>
          <details
            open={advanced}
            onToggle={(event) => {
              if (!definitionDirty) setAdvanced(event.currentTarget.open);
            }}
          >
            <summary className="cursor-pointer text-sm font-medium">
              Advanced workspace configuration
            </summary>
            <p className={styles.note}>
              Edit services, tasks, workflows, and lane preparation here. Stop services and active
              runs before saving.
            </p>
            {!advanced && definitionDirty ? (
              <p className={styles.note}>
                Save or discard your folder changes before editing configuration.
              </p>
            ) : (
              <textarea
                className={`${styles.field} ${styles.editor}`}
                aria-label="Workspace configuration"
                rows={18}
                value={draft.source}
                disabled={pending || reviewDirty}
                onChange={(event) => setDraft({ ...draft, source: event.target.value })}
              />
            )}
          </details>
          <div className={styles.actions}>
            <Button
              size="xs"
              variant="ghost"
              disabled={pending || dirty}
              onClick={() => setConfirmDelete(!confirmDelete)}
            >
              Remove workspace…
            </Button>
          </div>
          {confirmDelete ? (
            <div className={styles.feedback}>
              <p>
                Remove {text(snapshot, "name") || "this workspace"} from Cinderdeck? Project folders
                and files remain on disk. Services must be stopped and lanes removed first.
              </p>
              <div className={styles.actions}>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending || dirty}
                  onClick={() =>
                    void request("workspace-delete", { revision: text(snapshot, "revision") })
                  }
                >
                  Remove workspace
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          {dirty ? (
            <div className={styles.saveBar}>
              <span>Unsaved workspace changes</span>
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => setDraft(original)}
                >
                  Discard
                </Button>
                <Button
                  size="sm"
                  disabled={pending || reviewDirty || !definitionDirty}
                  onClick={() =>
                    void request("workspace-save", {
                      revision: text(snapshot, "revision"),
                      ...(advanced
                        ? { source: draft.source }
                        : { name: draft.name, folders: draft.folders, files: draft.files }),
                    })
                  }
                >
                  {pending ? "Saving…" : "Save workspace"}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="xs"
              variant="ghost"
              disabled={pending}
              onClick={() => void request("workspace-read")}
            >
              Reload workspace
            </Button>
          )}
        </>
      )}
      {blocker.status === "blocked" ? (
        <div role="alert" className={styles.feedback}>
          <p>You have unsaved workspace changes.</p>
          <div className={styles.actions}>
            <Button size="sm" onClick={() => blocker.reset()}>
              Keep editing
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setDraft(original);
                blocker.proceed();
              }}
            >
              Discard and leave
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
