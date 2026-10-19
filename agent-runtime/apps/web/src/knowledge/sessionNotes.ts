import type {
  ObsidianVault,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@cinderdeck/contracts";
import { scopedThreadKey } from "@cinderdeck/client-runtime/environment";
import { collectToolFilePaths, classifyToolActivity } from "@cinderdeck/shared/toolActivity";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "../lib/storage";

export interface SessionNote {
  readonly vaultID: string;
  readonly vaultName: string;
  readonly path: string;
  readonly activity: "viewed" | "attached" | "edited";
}
export type NotesTarget = string | ScopedThreadRef;
export const notesTargetKey = (target: NotesTarget) =>
  typeof target === "string" ? `draft:${target}` : `session:${scopedThreadKey(target)}`;
export const sessionNoteKey = (note: Pick<SessionNote, "vaultID" | "path">) =>
  `${encodeURIComponent(note.vaultID)}:${encodeURIComponent(note.path)}`;
export const EMPTY_SESSION_NOTES: readonly SessionNote[] = [];
const priority = { viewed: 0, attached: 1, edited: 2 };

export function isSessionNote(value: unknown): value is SessionNote {
  if (!value || typeof value !== "object") return false;
  const n = value as SessionNote;
  return (
    typeof n.vaultID === "string" &&
    n.vaultID.length > 0 &&
    n.vaultID.length <= 200 &&
    typeof n.vaultName === "string" &&
    n.vaultName.length <= 200 &&
    typeof n.path === "string" &&
    n.path.length <= 4096 &&
    /\.md$/i.test(n.path) &&
    !n.path.includes("\\") &&
    !n.path.includes("\0") &&
    n.path.split("/").every((part) => part.length > 0 && !part.startsWith(".")) &&
    Object.hasOwn(priority, n.activity)
  );
}
export function mergeSessionNotes(
  current: readonly SessionNote[],
  incoming: readonly SessionNote[],
): readonly SessionNote[] {
  const merged = new Map(current.map((note) => [sessionNoteKey(note), note]));
  let changed = false;
  for (const note of incoming) {
    if (!isSessionNote(note)) continue;
    const key = sessionNoteKey(note),
      previous = merged.get(key);
    const activity =
      previous && priority[previous.activity] > priority[note.activity]
        ? previous.activity
        : note.activity;
    if (previous?.activity === activity && previous.vaultName === note.vaultName) continue;
    // Store identities only; Markdown and tool input never enter browser persistence.
    merged.set(key, {
      vaultID: note.vaultID,
      vaultName: note.vaultName,
      path: note.path,
      activity,
    });
    changed = true;
  }
  return changed ? [...merged.values()] : current;
}
function hydrate(value: unknown): { byTarget: Record<string, readonly SessionNote[]> } {
  const raw = value && typeof value === "object" && "byTarget" in value ? value.byTarget : null;
  if (!raw || typeof raw !== "object") return { byTarget: {} };
  return {
    byTarget: Object.fromEntries(
      Object.entries(raw).flatMap(([key, notes]) =>
        Array.isArray(notes) ? [[key, mergeSessionNotes([], notes)]] : [],
      ),
    ),
  };
}
interface SessionNotesState {
  byTarget: Record<string, readonly SessionNote[]>;
  remember: (target: NotesTarget, notes: readonly SessionNote[]) => void;
  copySession: (from: NotesTarget, to: NotesTarget) => void;
  removeSession: (target: NotesTarget) => void;
}
export const useSessionNotesStore = create<SessionNotesState>()(
  persist(
    (set, get) => ({
      byTarget: {},
      remember: (target, notes) =>
        set((state) => {
          const key = notesTargetKey(target),
            current = state.byTarget[key] ?? EMPTY_SESSION_NOTES;
          const next = mergeSessionNotes(current, notes);
          return next === current ? state : { byTarget: { ...state.byTarget, [key]: next } };
        }),
      copySession: (from, to) =>
        get().remember(to, get().byTarget[notesTargetKey(from)] ?? EMPTY_SESSION_NOTES),
      removeSession: (target) =>
        set((state) => {
          const { [notesTargetKey(target)]: _removed, ...byTarget } = state.byTarget;
          return { byTarget };
        }),
    }),
    {
      name: "cinderdeck:session-notes:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byTarget: state.byTarget }),
      migrate: hydrate,
      merge: (persisted, current) => ({ ...current, ...hydrate(persisted) }),
    },
  ),
);

function absolutePath(value: string, cwd: string | null): string | null {
  if (!value.startsWith("/") && !cwd?.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of (value.startsWith("/") ? value : `${cwd}/${value}`).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
/** Only structured file operations count; quoted paths in prose and shell output do not. */
export function notesFromActivity(
  items: readonly OrchestrationV2ProjectedTurnItem[],
  vaults: readonly ObsidianVault[],
  cwd: string | null,
): readonly SessionNote[] {
  const found: SessionNote[] = [];
  for (const { item } of items) {
    if (item.status !== "completed") continue;
    let paths: readonly string[] = [],
      activity: SessionNote["activity"] = "viewed";
    if (item.type === "file_change") {
      paths = item.changes?.map((change) => change.path) ?? [item.fileName];
      activity = "edited";
    } else if (item.type === "dynamic_tool") {
      const kind = classifyToolActivity({
        itemType: "dynamic_tool_call",
        data: { toolName: item.toolName ?? undefined, input: item.input },
      });
      if (kind !== "read" && kind !== "file_change") continue;
      paths = collectToolFilePaths({ input: item.input });
      activity = kind === "file_change" ? "edited" : "viewed";
    }
    found.push(...notesFromPaths(paths, vaults, cwd, activity));
  }
  return mergeSessionNotes([], found);
}

export function notesFromPaths(
  paths: readonly string[],
  vaults: readonly ObsidianVault[],
  cwd: string | null,
  activity: SessionNote["activity"] = "viewed",
): readonly SessionNote[] {
  const found: SessionNote[] = [];
  for (const path of paths) {
    const full = absolutePath(path, cwd);
    if (!full) continue;
    // Prefer the closest containing vault when connections overlap.
    const vault = vaults
      .filter((v) => full.startsWith(`${v.path.replace(/\/$/, "")}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!vault) continue;
    const note: SessionNote = {
      vaultID: vault.id,
      vaultName: vault.name,
      path: full.slice(vault.path.replace(/\/$/, "").length + 1),
      activity,
    };
    if (isSessionNote(note)) found.push(note);
  }
  return mergeSessionNotes([], found);
}
