import { useMemo, useSyncExternalStore } from "react";
import {
  readSidebarPreferences,
  type WorkspaceSidebarPreferences,
} from "./workspaceSidebarPreferences";

const preferencesEvent = "cinderdeck-sidebar-preferences";
const stores = new Map<string, ReturnType<typeof createStore>>();

function createStore(key: string) {
  let preferences = readSidebarPreferences(key);
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const refresh = (event: Event) => {
    if (event instanceof StorageEvent && event.key !== null && event.key !== key) return;
    if (event instanceof CustomEvent && event.detail?.key && event.detail.key !== key) return;
    // Local updates already installed the shared snapshot before dispatching.
    if (event instanceof CustomEvent && event.detail?.key === key) return;
    preferences = readSidebarPreferences(key);
    notify();
  };
  const store = {
    snapshot: () => preferences,
    subscribe: (listener: () => void) => {
      if (!listeners.size) {
        stores.set(key, store);
        window.addEventListener("storage", refresh);
        window.addEventListener(preferencesEvent, refresh);
        // Close the gap between rendering and subscribing, including remounts.
        preferences = readSidebarPreferences(key);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          window.removeEventListener("storage", refresh);
          window.removeEventListener(preferencesEvent, refresh);
          if (stores.get(key) === store) stores.delete(key);
        }
      };
    },
    update: (change: (value: WorkspaceSidebarPreferences) => WorkspaceSidebarPreferences) => {
      const next = change(preferences);
      if (next === preferences) return;
      preferences = next;
      notify();
      try {
        localStorage.setItem(key, JSON.stringify(next));
        window.dispatchEvent(new CustomEvent(preferencesEvent, { detail: { key } }));
      } catch {
        /* All mounted consumers still share the update when storage is unavailable. */
      }
    },
  };
  return store;
}

export function useWorkspaceSidebarPreferences(key: string) {
  const store = useMemo(() => {
    const existing = stores.get(key);
    if (existing) return existing;
    const created = createStore(key);
    stores.set(key, created);
    return created;
  }, [key]);
  const preferences = useSyncExternalStore(store.subscribe, store.snapshot);
  return { preferences, update: store.update };
}
