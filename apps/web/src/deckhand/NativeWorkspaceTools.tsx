import { useRef, useState } from "react";
import type { NativeToolRequest } from "@t3tools/contracts";
import { FolderPlusIcon, PencilLineIcon, WorkflowIcon } from "lucide-react";
import { toastManager } from "../components/ui/toast";
import styles from "./nativeWorkspaceTools.module.css";

/** These requests open native UI; its existing validation owns all changes. */
export function NativeWorkspaceTools({
  workspaceID,
  sourceWorkspaceID,
  enabled,
  showSetup = true,
}: {
  workspaceID?: string | undefined;
  sourceWorkspaceID?: string | undefined;
  enabled: boolean;
  showSetup?: boolean;
}) {
  const host = typeof window !== "undefined" && window.desktopBridge?.isNativeHost?.() === true;
  const available = host && typeof window.desktopBridge?.openNativeTool === "function";
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const request = async (input: NativeToolRequest) => {
    if (!available || !enabled || busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const accepted = await window.desktopBridge!.openNativeTool!(input);
      if (!accepted)
        toastManager.add({
          type: "error",
          title: "Could not open workspace tools",
          description: "The native Cinderdeck connection is unavailable.",
        });
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not open workspace tools",
        description: "The request could not reach Cinderdeck. Reconnect before trying again.",
      });
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  if (!host) return null;
  const disabled = !available || !enabled || pending;
  return (
    <div className={styles.tools} aria-label="Native workspace tools">
      {showSetup ? <button
        type="button"
        disabled={disabled}
        onClick={() => {
          void request({ surface: "workspace-setup" });
        }}
      >
        <FolderPlusIcon size={15} aria-hidden />
        Add workspace
      </button> : null}
      {sourceWorkspaceID ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            void request({ surface: "workspace-editor", workspaceID: sourceWorkspaceID });
          }}
        >
          <PencilLineIcon size={15} aria-hidden />
          {workspaceID && workspaceID !== sourceWorkspaceID
            ? "Edit source workspace"
            : "Edit workspace"}
        </button>
      ) : null}
      {workspaceID ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            void request({ surface: "execution-map", workspaceID });
          }}
        >
          <WorkflowIcon size={15} aria-hidden />
          Native execution map
        </button>
      ) : null}
      {!available || !enabled ? (
        <span className={styles.notice} role="status">
          Reconnect to manage workspaces.
        </span>
      ) : null}
    </div>
  );
}
