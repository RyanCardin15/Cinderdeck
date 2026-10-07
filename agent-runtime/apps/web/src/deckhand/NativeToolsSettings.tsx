import { isNativeSettingsHost } from "./nativeSettingsPresentation";
import { Link } from "@tanstack/react-router";
import { NativeSettingsSection } from "./NativeSettings";
import { useRef, useState } from "react";
import type { NativeToolRequest } from "@cinderdeck/contracts";
import {
  CameraIcon,
  ClockIcon,
  PencilLineIcon,
  ScanTextIcon,
  VideoIcon,
  SettingsIcon,
} from "lucide-react";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { toastManager } from "../components/ui/toast";
import { Button } from "../components/ui/button";

function useNativeTools() {
  const host = isNativeSettingsHost();
  const available = host && typeof window.desktopBridge?.openNativeTool === "function";
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const request = async (input: NativeToolRequest) => {
    if (busy.current || !available) return;
    busy.current = true;
    setPending(true);
    try {
      // True means delivered to the native owner. Capture completion, permissions
      // and native failures are handled by its actual picker/alerts, not this UI.
      const accepted = await window.desktopBridge!.openNativeTool!(input);
      if (!accepted)
        toastManager.add({
          type: "error",
          title: "Could not open native tools",
          description: "The Cinderdeck native connection is unavailable.",
        });
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not open native tools",
        description:
          "The request could not reach Cinderdeck. Try again when the native connection is available.",
      });
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return { host, available, pending, request };
}

export function NativeToolsMenu({ className }: { className?: string | undefined }) {
  const tools = useNativeTools();
  if (!tools.host) return null;
  const disabled = !tools.available || tools.pending;
  return (
    <div className={className}>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" className="w-full justify-start" />}
          disabled={disabled}
        >
          <CameraIcon size={17} aria-hidden />
          Capture tools
        </MenuTrigger>
        <MenuPopup side="top" align="start" className="min-w-58">
          <MenuItem
            onClick={() => {
              void tools.request({ surface: "history" });
            }}
            disabled={disabled}
          >
            <ClockIcon aria-hidden />
            History & clipboard
          </MenuItem>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Capture</MenuGroupLabel>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                void tools.request({ surface: "capture", mode: "region" });
              }}
            >
              Area screenshot
            </MenuItem>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                void tools.request({ surface: "capture", mode: "window" });
              }}
            >
              Window screenshot
            </MenuItem>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                void tools.request({ surface: "capture", mode: "fullscreen" });
              }}
            >
              Full-screen screenshot
            </MenuItem>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                void tools.request({ surface: "capture", mode: "scrolling" });
              }}
            >
              Scrolling screenshot
            </MenuItem>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                void tools.request({ surface: "capture", mode: "ocr" });
              }}
            >
              <ScanTextIcon aria-hidden />
              Capture text (OCR)
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Record</MenuGroupLabel>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                void tools.request({ surface: "recording", mode: "screen" });
              }}
            >
              <VideoIcon aria-hidden />
              Record screen…
            </MenuItem>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                void tools.request({ surface: "recording", mode: "window" });
              }}
            >
              Record window…
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuItem
            disabled={disabled}
            onClick={() => {
              void tools.request({ surface: "annotate" });
            }}
          >
            <PencilLineIcon aria-hidden />
            Annotate image
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

export function NativeToolsSettings() {
  return <NativeSettingsSection category="general" title="Desktop defaults" />;
}
export function NativeGitHubSettingsButton({ iconOnly = false }: { iconOnly?: boolean }) {
  return (
    <Link to="/settings/source-control" hash="native-github" aria-label="GitHub account settings">
      <SettingsIcon size={14} />
      {iconOnly ? null : "Configure GitHub account"}
    </Link>
  );
}
export function NativeGitHubAccountSettings() {
  return <NativeSettingsSection category="github" title="GitHub account" />;
}
