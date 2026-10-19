import { useEffect, useRef, useState } from "react";
import type { ObsidianNote, ObsidianSearchResult, ObsidianVault } from "@cinderdeck/contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogPanel,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "../components/ui/dialog";
import { Button } from "../components/ui/button";
import styles from "./knowledge.module.css";

export function noteAttachment(note: ObsidianNote): File {
  // A snapshot uses the existing durable upload/claim pipeline; later vault edits do not alter the sent note.
  const header = `Obsidian vault: ${note.vaultName}\nNote: ${note.path}\nModified: ${new Date(note.modifiedAt).toISOString()}\n\n---\n\n`;
  return new File([header, note.content], note.path.split("/").at(-1) || "Note.md", {
    type: "text/markdown",
    lastModified: note.modifiedAt,
  });
}
export function knowledgeError(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
        .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
        .replace(/^KnowledgeError: /, "")
    : "The request could not be completed.";
}
export function ObsidianNotes({
  open,
  onOpenChange,
  workspacePath,
  onAttach,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath?: string | null | undefined;
  onAttach?: ((file: File) => Promise<void>) | undefined;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.knowledge;
  const [vaults, setVaults] = useState<readonly ObsidianVault[]>([]);
  const [vaultID, setVaultID] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ObsidianSearchResult>({ notes: [], limited: false });
  const [note, setNote] = useState<ObsidianNote | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const readGeneration = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readGeneration.current++;
    };
  }, []);
  useEffect(() => {
    if (!open || !bridge) return;
    let active = true;
    setError("");
    setNote(null);
    setVaults([]);
    setVaultID("");
    void bridge
      .listVaults(workspacePath)
      .then((rows) => {
        if (active) {
          setVaults(rows);
          setVaultID(rows[0]?.id ?? "");
        }
      })
      .catch((cause) => {
        if (active) setError(knowledgeError(cause));
      });
    return () => {
      active = false;
      readGeneration.current++;
    };
  }, [bridge, open, workspacePath]);
  useEffect(() => {
    if (!open || !bridge || !vaultID) {
      setResult({ notes: [], limited: false });
      return;
    }
    let active = true;
    setLoading(true);
    setResult({ notes: [], limited: false });
    setNote(null);
    readGeneration.current++;
    const timer = setTimeout(() => {
      void bridge
        .searchNotes({ vaultID, query, workspacePath })
        .then((value) => {
          if (active) {
            setResult(value);
            setError("");
          }
        })
        .catch((cause) => {
          if (active) setError(knowledgeError(cause));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [bridge, open, vaultID, query, workspacePath]);
  async function read(path: string) {
    if (!bridge) return;
    const current = ++readGeneration.current;
    setError("");
    setNote(null);
    try {
      const value = await bridge.readNote({ vaultID, path, workspacePath });
      if (mounted.current && current === readGeneration.current) setNote(value);
    } catch (cause) {
      if (mounted.current && current === readGeneration.current) setError(knowledgeError(cause));
    }
  }
  async function action(kind: "attach" | "open") {
    if (!note || !bridge || busy) return;
    setBusy(true);
    setError("");
    try {
      if (kind === "attach" && onAttach) {
        await onAttach(noteAttachment(note));
        if (mounted.current) onOpenChange(false);
      }
      if (kind === "open") await bridge.openNote({ vaultID, path: note.path, workspacePath });
    } catch (cause) {
      if (mounted.current) setError(knowledgeError(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Obsidian notes</DialogTitle>
          <DialogDescription>
            Browse connected vaults on this Mac. Attach a snapshot to share a note with your
            selected AI provider.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.filters}>
            <label>
              Vault
              <select
                aria-label="Obsidian vault"
                value={vaultID}
                onChange={(e) => setVaultID(e.target.value)}
                disabled={busy}
              >
                {vaults.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Search notes
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Title, path, or note text"
                maxLength={500}
              />
            </label>
          </div>
          {!vaults.length && !error && (
            <p className={styles.empty}>
              Connect a vault in Settings → Integrations → Obsidian to browse notes here.
            </p>
          )}
          <div className={styles.browser}>
            <div className={styles.results} aria-label="Note results" aria-busy={loading}>
              {loading && <p role="status">Searching…</p>}
              {!loading && vaultID && !result.notes.length && <p>No notes match your search.</p>}
              {result.notes.map((item) => (
                <button
                  type="button"
                  key={item.path}
                  aria-pressed={note?.path === item.path}
                  onClick={() => void read(item.path)}
                  disabled={busy}
                >
                  <strong>{item.title}</strong>
                  <small>{item.path}</small>
                  <span>{item.excerpt}</span>
                </button>
              ))}
              {result.limited && (
                <p role="status">Showing a limited set of results. Refine your search.</p>
              )}
            </div>
            <div className={styles.preview} aria-label="Note preview">
              {note ? (
                <>
                  <h3>{note.path}</h3>
                  <details>
                    <summary>Markdown source</summary>
                    <pre className={styles.source}>{note.content}</pre>
                  </details>
                  <div className={styles.markdown}>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      allowedElements={[
                        "p",
                        "h1",
                        "h2",
                        "h3",
                        "h4",
                        "h5",
                        "h6",
                        "ul",
                        "ol",
                        "li",
                        "blockquote",
                        "pre",
                        "code",
                        "em",
                        "strong",
                        "del",
                        "hr",
                        "br",
                        "table",
                        "thead",
                        "tbody",
                        "tr",
                        "th",
                        "td",
                      ]}
                      unwrapDisallowed
                    >
                      {note.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}
                    </ReactMarkdown>
                  </div>
                </>
              ) : (
                <p>Select a note to preview it.</p>
              )}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={!note || busy} onClick={() => void action("open")}>
            Open in Obsidian
          </Button>
          {onAttach && (
            <Button disabled={!note || busy} onClick={() => void action("attach")}>
              {busy ? "Working…" : "Attach note"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
