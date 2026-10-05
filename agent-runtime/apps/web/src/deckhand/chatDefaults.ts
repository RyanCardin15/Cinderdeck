import type { EnvironmentId, ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { create } from "zustand";
import { persist } from "zustand/middleware";

type ChatModes = { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode };
type ChatPreferences = { rememberModes: boolean; interactionMode: ProviderInteractionMode };
const DEFAULT_PREFERENCES: ChatPreferences = { rememberModes: true, interactionMode: "default" };

// Viewer-local choices stay scoped to the machine that owns the chat. Model and
// reasoning memory already live in the composer store; pinned models stay in Settings.
export const useChatDefaultsStore = create<{
  preferences: Record<string, ChatPreferences>;
  lastModes: Record<string, Partial<ChatModes>>;
  repositories: Record<string, string>;
  setPreferences: (environmentId: EnvironmentId, patch: Partial<ChatPreferences>) => void;
  rememberModes: (environmentId: EnvironmentId, patch: Partial<ChatModes>) => void;
  rememberRepository: (scope: string, repositoryID: string) => void;
}>()(
  persist(
    (set) => ({
      preferences: {},
      lastModes: {},
      repositories: {},
      setPreferences: (environmentId, patch) =>
        set((state) => ({
          preferences: {
            ...state.preferences,
            [environmentId]: {
              ...DEFAULT_PREFERENCES,
              ...state.preferences[environmentId],
              ...patch,
            },
          },
        })),
      rememberModes: (environmentId, patch) =>
        set((state) => ({
          lastModes: {
            ...state.lastModes,
            [environmentId]: { ...state.lastModes[environmentId], ...patch },
          },
        })),
      rememberRepository: (scope, repositoryID) =>
        set((state) => ({
          repositories: { ...state.repositories, [scope]: repositoryID },
        })),
    }),
    { name: "deckhand:chat-defaults", version: 1 },
  ),
);

export function resolveChatModes(
  environmentId: EnvironmentId,
  defaultRuntimeMode: RuntimeMode,
  planModeEnabled: boolean,
): ChatModes {
  const state = useChatDefaultsStore.getState();
  const preferences = state.preferences[environmentId] ?? DEFAULT_PREFERENCES;
  const last = preferences.rememberModes ? state.lastModes[environmentId] : undefined;
  return {
    runtimeMode:
      last?.runtimeMode === "full-access" ||
      last?.runtimeMode === "approval-required" ||
      last?.runtimeMode === "auto" ||
      last?.runtimeMode === "auto-accept-edits"
        ? last.runtimeMode
        : defaultRuntimeMode,
    interactionMode:
      planModeEnabled && (last?.interactionMode ?? preferences.interactionMode) === "plan"
        ? "plan"
        : "default",
  };
}
