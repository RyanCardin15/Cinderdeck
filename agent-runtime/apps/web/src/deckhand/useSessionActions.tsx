import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ThreadId, type EnvironmentId, type ContextMenuItem } from "@cinderdeck/contracts";
import type { ManagedSessionView } from "@cinderdeck/contracts/deckhand/rpc";
import { settlePromise, squashAtomCommandFailure } from "@cinderdeck/client-runtime/state/runtime";
import { threadRuntimeCanArchive } from "@cinderdeck/client-runtime/state/models";
import { useThreadActions } from "../hooks/useThreadActions";
import { useClientSettings } from "../hooks/useSettings";
import { useThreadSessionTerminal } from "../hooks/useThreadSessionTerminal";
import { readLocalApi } from "../localApi";
import { readThreadShell, readEnvironmentSupportsPinning } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { toastManager } from "../components/ui/toast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../components/ui/dialog";

type Action =
  | "open"
  | "rename"
  | "mark-unread"
  | "pin"
  | "unpin"
  | "copy-id"
  | "open-terminal"
  | "copy-resume-command"
  | "archive"
  | "unarchive"
  | "delete";

/** One controller per roster; lifecycle commands retain the normal thread cleanup and navigation. */
export function useSessionActions(environmentId: EnvironmentId) {
  const titleInputId = useId();
  const navigate = useNavigate();
  const actions = useThreadActions();
  const sessionTerminal = useThreadSessionTerminal();
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata, { reportFailure: false });
  const confirmArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  const confirmDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [rename, setRename] = useState<ManagedSessionView | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const lifetime = useRef(true);
  const busy = useRef(false);
  useEffect(() => {
    lifetime.current = true;
    return () => {
      lifetime.current = false;
    };
  }, []);
  const report = (error: unknown) =>
    toastManager.add({
      type: "error",
      title: "Could not update session",
      description: error instanceof Error ? error.message : "Please try again.",
    });
  const showMenu = async (
    session: ManagedSessionView,
    position: { x: number; y: number },
    enabled: boolean,
  ) => {
    const api = readLocalApi();
    if (!api || busy.current) return;
    const threadRef = { environmentId, threadId: ThreadId.make(session.binding.threadId) };
    const shell = readThreadShell(threadRef);
    const canArchive = enabled && !!shell && threadRuntimeCanArchive(shell.runtime);
    const canOpenTerminal =
      !!shell && shell.activeProviderThreadId !== null && sessionTerminal.canOpen(threadRef);
    const items: ContextMenuItem<Action>[] = [
      { id: "open", label: "Open session" },
      { id: "rename", label: "Rename session", icon: "pencil", disabled: !enabled },
      { id: "mark-unread", label: "Mark unread", icon: "mail", disabled: !enabled },
      ...(shell && readEnvironmentSupportsPinning(environmentId)
        ? [
            {
              id: shell.pinnedAt ? ("unpin" as const) : ("pin" as const),
              label: shell.pinnedAt ? "Unpin session" : "Pin session",
              icon: "pin",
              disabled: !enabled,
            },
          ]
        : []),
      ...(canOpenTerminal
        ? [
            {
              id: "open-terminal" as const,
              label: "Open in terminal",
              icon: "terminal",
              separatorBefore: true,
            },
          ]
        : []),
      {
        id: "copy-id",
        label: "Copy session ID",
        icon: "hash",
        separatorBefore: !canOpenTerminal,
      },
      ...(canOpenTerminal
        ? [{ id: "copy-resume-command" as const, label: "Copy resume command", icon: "terminal" }]
        : []),
      session.archived
        ? { id: "unarchive", label: "Restore session", icon: "archive", disabled: !enabled }
        : { id: "archive", label: "Archive session", icon: "archive", disabled: !canArchive },
      {
        id: "delete",
        label: "Delete session",
        icon: "trash",
        destructive: true,
        disabled: !enabled,
      },
    ];
    busy.current = true;
    try {
      const selected = await api.contextMenu.show(items, position);
      if (!lifetime.current || !selected || items.find((item) => item.id === selected)?.disabled)
        return;
      if (selected === "open") {
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
        return;
      }
      if (selected === "open-terminal") {
        await sessionTerminal.openInTerminal(threadRef);
        return;
      }
      if (selected === "copy-resume-command") {
        await sessionTerminal.copyResumeCommand(threadRef);
        return;
      }
      if (selected === "copy-id") {
        await navigator.clipboard.writeText(threadRef.threadId);
        return;
      }
      if (selected === "rename") {
        setTitle(session.title);
        setRename(session);
        return;
      }
      if (selected === "mark-unread") {
        actions.markThreadUnread(threadRef);
        return;
      }
      if ((selected === "archive" && confirmArchive) || (selected === "delete" && confirmDelete)) {
        const confirmed = await api.dialogs.confirm(
          selected === "delete"
            ? `Delete session "${session.title}"?\nThis permanently clears conversation history for this session.`
            : `Archive session "${session.title}"?`,
          selected === "delete" ? { variant: "destructive" } : undefined,
        );
        if (!confirmed || !lifetime.current) return;
      }
      const result = await (selected === "delete"
        ? actions.deleteThread(threadRef)
        : selected === "archive"
          ? actions.archiveThread(threadRef)
          : selected === "unarchive"
            ? actions.unarchiveThread(threadRef)
            : selected === "pin"
              ? actions.pinThread(threadRef)
              : actions.confirmAndUnpinThread(threadRef));
      if (result._tag === "Failure") report(squashAtomCommandFailure(result));
    } catch (error) {
      report(error);
    } finally {
      busy.current = false;
    }
  };
  const saveRename = async () => {
    const trimmed = title.trim();
    if (!rename || !trimmed || saving) return;
    if (trimmed === rename.title) {
      setRename(null);
      return;
    }
    setSaving(true);
    const result = await settlePromise(() =>
      updateMetadata({
        environmentId,
        input: { threadId: ThreadId.make(rename.binding.threadId), title: trimmed },
      }),
    );
    if (!lifetime.current) return;
    setSaving(false);
    if (result._tag === "Failure") report(squashAtomCommandFailure(result));
    else if (result.value._tag === "Failure") report(squashAtomCommandFailure(result.value));
    else setRename(null);
  };
  const renameDialog = (
    <Dialog
      open={rename !== null}
      onOpenChange={(open) => {
        if (!open && !saving) setRename(null);
      }}
    >
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveRename();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <label htmlFor={titleInputId}>Session name</label>
            <Input
              id={titleInputId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={saving}
              autoFocus
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setRename(null)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !title.trim()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
  return { showMenu, renameDialog };
}
