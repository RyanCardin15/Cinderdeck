import { useRef, useState } from "react";
import { GitBranchIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { usePrimaryEnvironmentId } from "../state/environments";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../components/ui/tooltip";
import styles from "./WorkspaceSettingsButton.module.css";
import { toastManager } from "../components/ui/toast";

/** Always targets the explicit source workspace, including when shown on a lane. */
type WorkspaceButtonProps = {
  environmentId: string;
  workspaceID: string;
  label: string;
  enabled: boolean;
  compact?: boolean;
  showLabel?: boolean;
};
export function WorkspaceSettingsButton(props: WorkspaceButtonProps) {
  return <WorkspaceToolButton {...props} surface="workspace-editor" />;
}
export function WorkspaceBranchesButton(props: WorkspaceButtonProps) {
  return <WorkspaceToolButton {...props} surface="workspace-branches" />;
}
export function WorkspaceDeleteButton(props: WorkspaceButtonProps) {
  return <WorkspaceToolButton {...props} surface="workspace-editor" mode="delete" />;
}
function WorkspaceToolButton({
  environmentId,
  workspaceID,
  label,
  enabled,
  compact = false,
  showLabel = false,
  surface,
  mode,
}: WorkspaceButtonProps & { surface: "workspace-editor" | "workspace-branches"; mode?: "delete" }) {
  const primary = usePrimaryEnvironmentId();
  const available =
    environmentId === primary &&
    typeof window !== "undefined" &&
    window.desktopBridge?.isNativeHost?.() === true &&
    typeof window.desktopBridge.openNativeTool === "function";
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const open = async () => {
    if (!available || !enabled || busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      if (
        !(await window.desktopBridge!.openNativeTool!({
          surface,
          workspaceID,
          ...(mode ? { mode } : {}),
        }))
      )
        throw new Error("Workspace unavailable");
    } catch {
      toastManager.add({
        type: "error",
        title:
          surface === "workspace-editor"
            ? "Could not open workspace settings"
            : "Could not open branch picker",
        description: "Refresh the workspace connection and try again.",
      });
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const tooltip = !available
    ? "Open workspace tools in Cinderdeck on this workspace's Mac"
    : !enabled
      ? "Refresh the workspace connection to open workspace tools"
      : label;
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        render={
          <button
            className={`${compact ? styles.control : styles.button} ${mode === "delete" ? styles.destructive : ""}`}
            disabled={!available || !enabled || pending}
          />
        }
        aria-label={label}
        disabled={!available || !enabled || pending}
        onClick={() => void open()}
      >
        {mode === "delete" ? (
          <Trash2Icon size={15} aria-hidden />
        ) : surface === "workspace-editor" ? (
          <SettingsIcon size={15} aria-hidden />
        ) : (
          <GitBranchIcon size={15} aria-hidden />
        )}
        {showLabel
          ? mode === "delete"
            ? "Delete workspace…"
            : surface === "workspace-editor"
              ? "Workspace settings"
              : "Switch branch…"
          : null}
      </TooltipTrigger>
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
