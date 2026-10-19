import { useEffect, useMemo, useState } from "react";
import type { ObsidianVault, OrchestrationV2ProjectedTurnItem } from "@cinderdeck/contracts";
import {
  notesFromActivity,
  notesFromPaths,
  useSessionNotesStore,
  type NotesTarget,
} from "./sessionNotes";

/** Observe structured local file activity even while the details sidebar is closed. */
export function useSessionNotesTracking(
  target: NotesTarget,
  items: readonly OrchestrationV2ProjectedTurnItem[],
  cwd: string | null,
  local: boolean,
  openedFiles: readonly string[],
) {
  const bridge = typeof window !== "undefined" ? window.desktopBridge?.knowledge : undefined;
  const [vaults, setVaults] = useState<readonly ObsidianVault[]>([]);
  useEffect(() => {
    setVaults([]);
    if (!bridge || !local) return;
    let active = true;
    const refresh = () => {
      void bridge
        .listVaults(cwd)
        .then((rows) => {
          if (active) setVaults(rows);
        })
        .catch(() => {
          if (active) setVaults([]);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("cinderdeck:knowledge-changed", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("cinderdeck:knowledge-changed", refresh);
    };
  }, [bridge, cwd, local]);
  const notes = useMemo(
    () =>
      local
        ? [...notesFromActivity(items, vaults, cwd), ...notesFromPaths(openedFiles, vaults, cwd)]
        : [],
    [items, vaults, cwd, local, openedFiles],
  );
  useEffect(() => {
    if (notes.length) useSessionNotesStore.getState().remember(target, notes);
  }, [target, notes]);
}
