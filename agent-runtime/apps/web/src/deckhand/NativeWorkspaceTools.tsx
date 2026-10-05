import { useRef, useState } from "react";
import type { NativeToolRequest } from "@t3tools/contracts";
import {
  FolderPlusIcon,
  PencilLineIcon,
  WorkflowIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import styles from "./nativeWorkspaceTools.module.css";

/** These requests open native UI; its existing validation owns all changes. */
export function NativeWorkspaceTools({
  workspaceID,
  sourceWorkspaceID,
  enabled,
  showSetup = true,
  header = false,
  terminal = false,
}: {
  workspaceID?: string | undefined;
  sourceWorkspaceID?: string | undefined;
  enabled: boolean;
  showSetup?: boolean;
  header?: boolean;
  terminal?: boolean;
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
  if (terminal)
    return workspaceID ? (
      <div className={styles.tools}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => void request({ surface: "workspace-terminal", workspaceID })}
        >
          <TerminalIcon size={14} />
          Terminal
        </button>
      </div>
    ) : null;
  if (header)
    return (
      <div className={`${styles.tools} ${styles.header}`} aria-label="Workspace settings">
        {sourceWorkspaceID ? (
          <Tooltip>
            <TooltipTrigger
              type="button"
              disabled={disabled}
              aria-label={
                workspaceID !== sourceWorkspaceID ? "Edit source workspace" : "Edit workspace"
              }
              onClick={() =>
                void request({ surface: "workspace-editor", workspaceID: sourceWorkspaceID })
              }
            >
              <SlidersHorizontalIcon size={15} />
            </TooltipTrigger>
            <TooltipPopup>Edit workspace</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            type="button"
            disabled={disabled}
            aria-label="Connect agents and CLI"
            onClick={() => void request({ surface: "agent-access" })}
          >
            <SparklesIcon size={15} />
          </TooltipTrigger>
          <TooltipPopup>Connect agents and CLI</TooltipPopup>
        </Tooltip>
      </div>
    );
  return (
    <div className={styles.tools} aria-label="Native workspace tools">
      {showSetup ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            void request({ surface: "workspace-setup" });
          }}
        >
          <FolderPlusIcon size={15} aria-hidden />
          Add workspace
        </button>
      ) : null}
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
