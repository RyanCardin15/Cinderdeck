import { useEffect, useState } from "react";
import type { ObsidianNote } from "@cinderdeck/contracts";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import { knowledgeError } from "./ObsidianNotes";
import { NoteContent } from "./NoteContent";
import type { SessionNote } from "./sessionNotes";
import styles from "./knowledge.module.css";

export function SessionNotePanel({
  reference,
  workspacePath,
  visible,
}: {
  reference: SessionNote;
  workspacePath: string | null;
  visible: boolean;
}) {
  const bridge = window.desktopBridge?.knowledge;
  const [note, setNote] = useState<ObsidianNote | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    setNote(null);
    setError("");
    setSource(false);
  }, [reference.vaultID, reference.path, workspacePath]);
  useEffect(() => {
    if (!visible) return;
    let active = true,
      pending = false;
    const read = async () => {
      if (pending) return;
      pending = true;
      setLoading(true);
      try {
        if (!bridge)
          throw new Error(
            "Local notes are unavailable. Open this session in Cinderdeck on the Mac where the vault is connected.",
          );
        const value = await bridge.readNote({
          vaultID: reference.vaultID,
          path: reference.path,
          workspacePath,
        });
        if (active) {
          setNote(value);
          setError("");
        }
      } catch (cause) {
        if (active) {
          setNote(null);
          setError(knowledgeError(cause));
        }
      } finally {
        pending = false;
        if (active) setLoading(false);
      }
    };
    void read();
    const timer = setInterval(() => {
      if (!document.hidden) void read();
    }, 3000);
    window.addEventListener("focus", read);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [bridge, reference.vaultID, reference.path, workspacePath, visible, refresh]);
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Obsidian note panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <Tooltip>
            <TooltipTrigger render={<h2 className="truncate text-sm font-medium" />}>
              {reference.path}
            </TooltipTrigger>
            <TooltipPopup variant="code">{reference.path}</TooltipPopup>
          </Tooltip>
          <p className="text-xs text-muted-foreground">
            {note?.vaultName ?? reference.vaultName} · Live note · Read only
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh note"
          disabled={loading}
          onClick={() => setRefresh((n) => n + 1)}
        >
          <RefreshCwIcon className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!note}
          onClick={() => {
            void bridge
              ?.openNote({ vaultID: reference.vaultID, path: reference.path, workspacePath })
              .catch((cause) => setError(knowledgeError(cause)));
          }}
        >
          <ExternalLinkIcon className="size-3.5" />
          Open in Obsidian
        </Button>
      </div>
      <div className="flex gap-1 border-b border-border px-4 py-2" aria-label="Note view">
        <Button
          size="sm"
          variant={source ? "ghost" : "secondary"}
          aria-pressed={!source}
          onClick={() => setSource(false)}
        >
          Preview
        </Button>
        <Button
          size="sm"
          variant={source ? "secondary" : "ghost"}
          aria-pressed={source}
          onClick={() => setSource(true)}
        >
          Source
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-5" aria-live="polite">
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {!note && !error && (
          <p role="status" className="text-sm text-muted-foreground">
            Loading note…
          </p>
        )}
        {note &&
          (source ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
              {note.content}
            </pre>
          ) : (
            <NoteContent content={note.content} />
          ))}
      </div>
    </section>
  );
}
