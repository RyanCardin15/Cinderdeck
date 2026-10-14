import { useEffect, useRef, useState } from "react";
import {
  readSidebarPreferences,
  type WorkspaceSidebarPreferences,
} from "./workspaceSidebarPreferences";

export function useWorkspaceSidebarPreferences(key: string) {
  const [preferences, setPreferences] = useState(() => readSidebarPreferences(key));
  const current = useRef(preferences);
  useEffect(() => {
    const refresh = () => {
      current.current = readSidebarPreferences(key);
      setPreferences(current.current);
    };
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener("cinderdeck-sidebar-preferences", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("cinderdeck-sidebar-preferences", refresh);
    };
  }, [key]);
  const update = (change: (value: WorkspaceSidebarPreferences) => WorkspaceSidebarPreferences) => {
    const next = change(current.current);
    current.current = next;
    setPreferences(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
      window.dispatchEvent(new Event("cinderdeck-sidebar-preferences"));
    } catch {
      /* Session state still works when storage is unavailable. */
    }
  };
  return { preferences, update };
}
