import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { usePrimaryEnvironmentId } from "../state/environments";
import type { EnvironmentId, NativeToolRequest } from "@cinderdeck/contracts";
import {
  FolderPlusIcon,
  PencilLineIcon,
  WorkflowIcon,
  SettingsIcon,
  GitBranchIcon,
  SparklesIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { toastManager } from "../components/ui/toast";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import styles from "./nativeWorkspaceTools.module.css";
import { AGENT_ACCESS_SETTINGS_ID } from "./AgentAccessSettings";

/** These requests open native UI; its existing validation owns all changes. */
export function NativeWorkspaceTools({
  environmentId,
  workspaceID,
  sourceWorkspaceID,
  enabled,
  showSetup = true,
  header = false,
  terminal = false,
}: {
  environmentId: EnvironmentId;
  workspaceID?: string | undefined;
  sourceWorkspaceID?: string | undefined;
  enabled: boolean;
  showSetup?: boolean;
  header?: boolean;
  terminal?: boolean;
}) {
  const host = typeof window !== "undefined" && window.desktopBridge?.isNativeHost?.() === true;
  const primary = usePrimaryEnvironmentId();
  const local = environmentId === primary;
  const available = host && local && typeof window.desktopBridge?.openNativeTool === "function";
  const navigate = useNavigate();
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
        {workspaceID ? (
          <Tooltip>
            <TooltipTrigger
              type="button"
              render={<button disabled={disabled} />}
              disabled={disabled}
              onClick={() => void request({ surface: "workspace-branches", workspaceID })}
            >
              <GitBranchIcon size={15} aria-hidden /> Switch branch…
            </TooltipTrigger>
            <TooltipPopup>
              {local
                ? "Switch branches in the selected workspace or lane"
                : "Open branch tools in Cinderdeck on this workspace's Mac"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {sourceWorkspaceID ? (
          <Tooltip>
            <TooltipTrigger
              type="button"
              render={<button disabled={disabled} />}
              disabled={disabled}
              aria-label={
                workspaceID !== sourceWorkspaceID
                  ? "Source workspace settings"
                  : "Workspace settings"
              }
              onClick={() =>
                void request({ surface: "workspace-editor", workspaceID: sourceWorkspaceID })
              }
            >
              <SettingsIcon size={15} />
              {workspaceID !== sourceWorkspaceID
                ? "Source workspace settings"
                : "Workspace settings"}
            </TooltipTrigger>
            <TooltipPopup>
              {local
                ? workspaceID !== sourceWorkspaceID
                  ? "Source workspace settings"
                  : "Workspace settings"
                : "Open workspace settings in Cinderdeck on this workspace's Mac"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {sourceWorkspaceID && workspaceID === sourceWorkspaceID ? (
          <button
            type="button"
            className={styles.destructive}
            disabled={disabled}
            onClick={() =>
              void request({
                surface: "workspace-editor",
                workspaceID: sourceWorkspaceID,
                mode: "delete",
              })
            }
          >
            <Trash2Icon size={15} aria-hidden /> Delete workspace…
          </button>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            type="button"
            aria-label="Connect agents and CLI"
            onClick={() =>
              void navigate({ to: "/settings/integrations", hash: AGENT_ACCESS_SETTINGS_ID })
            }
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
