import { useState } from "react";
import type { ScopedThreadRef } from "@cinderdeck/contracts";
import { BookOpenIcon, PlusIcon } from "lucide-react";
import { ThreadDetailsSection } from "../components/chat/ThreadDetailsSection";
import { ThreadDetailsControl } from "../components/chat/ThreadDetailsControl";
import { useRightPanelStore } from "../rightPanelStore";
import { ObsidianNotes } from "./ObsidianNotes";
import {
  EMPTY_SESSION_NOTES,
  notesTargetKey,
  sessionNoteKey,
  useSessionNotesStore,
  type NotesTarget,
  type SessionNote,
} from "./sessionNotes";

export function SessionNotesSection({
  target,
  threadRef,
  workspacePath,
}: {
  target: NotesTarget;
  threadRef: ScopedThreadRef;
  workspacePath: string | null;
}) {
  const notes = useSessionNotesStore(
    (state) => state.byTarget[notesTargetKey(target)] ?? EMPTY_SESSION_NOTES,
  );
  const [browse, setBrowse] = useState(false);
  const [visibleCount, setVisibleCount] = useState(8);
  const remember = (note: SessionNote) => useSessionNotesStore.getState().remember(target, [note]);
  const open = (note: SessionNote) => {
    remember(note);
    useRightPanelStore.getState().openNote(threadRef, note);
  };
  if (typeof window === "undefined" || !window.desktopBridge?.knowledge) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-notes-heading"
      title="Notes"
      actions={
        <ThreadDetailsControl
          part="icon"
          aria-label="Browse session notes"
          title="Browse Obsidian notes"
          onClick={() => setBrowse(true)}
        >
          <PlusIcon className="size-3.5" />
        </ThreadDetailsControl>
      }
    >
      {notes.length === 0 ? (
        <p className="px-1.5 pb-1 text-2xs leading-relaxed text-muted-foreground">
          Notes you open, attach or edit in this session appear here.
        </p>
      ) : (
        <div className="max-h-72 overflow-auto" aria-label="Session notes">
          {notes.slice(0, visibleCount).map((note) => (
            <ThreadDetailsControl
              key={sessionNoteKey(note)}
              multiline
              title={`${note.vaultName} / ${note.path}`}
              onClick={() => open(note)}
            >
              <BookOpenIcon className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-left">
                <span className="block truncate text-xs">{note.path.split("/").at(-1)}</span>
                <span className="block truncate text-2xs text-muted-foreground">
                  {note.vaultName} · {note.path}
                </span>
              </span>
              <span className="text-2xs text-muted-foreground">
                {note.activity === "edited"
                  ? "Edited"
                  : note.activity === "attached"
                    ? "Attached"
                    : "Opened"}
              </span>
            </ThreadDetailsControl>
          ))}
          {notes.length > visibleCount && (
            <ThreadDetailsControl
              tone="muted"
              onClick={() => setVisibleCount((count) => count + 20)}
            >
              Show more notes ({notes.length - visibleCount})
            </ThreadDetailsControl>
          )}
        </div>
      )}
      {browse && (
        <ObsidianNotes
          open={browse}
          onOpenChange={setBrowse}
          workspacePath={workspacePath}
          onUseNote={remember}
          onOpenInPanel={open}
        />
      )}
    </ThreadDetailsSection>
  );
}
