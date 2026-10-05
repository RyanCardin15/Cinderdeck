import { useRef, useState } from "react";
import type { NativeToolRequest } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CameraIcon,
  CheckCheckIcon,
  ClockIcon,
  FileImageIcon,
  FolderIcon,
  KeyboardIcon,
  LockKeyholeIcon,
  PencilLineIcon,
  ScanTextIcon,
  VideoIcon,
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
import styles from "./nativeToolsSettings.module.css";

function useNativeTools() {
  const host = typeof window !== "undefined" && window.desktopBridge?.isNativeHost?.() === true;
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

const preferences = [
  {
    mode: "capture",
    title: "Capture",
    description: "Screenshots, recording and capture defaults",
    Icon: CameraIcon,
  },
  {
    mode: "annotate",
    title: "Annotations",
    description: "Image editor and annotation defaults",
    Icon: FileImageIcon,
  },
  {
    mode: "permissions",
    title: "Permissions",
    description: "Screen recording and system access",
    Icon: LockKeyholeIcon,
  },
  {
    mode: "shortcuts",
    title: "Shortcuts",
    description: "Capture and desktop keyboard shortcuts",
    Icon: KeyboardIcon,
  },
  {
    mode: "history",
    title: "History & clipboard",
    description: "Saved captures and history preferences",
    Icon: ClockIcon,
  },
  {
    mode: "general",
    title: "Storage & updates",
    description: "Save location and automatic updates",
    Icon: FolderIcon,
  },
] as const;
const morePreferences = [
  { mode: "menuBar", title: "Menu bar" },
  { mode: "quickAccess", title: "Quick access" },
  { mode: "cloud", title: "Cloud sync" },
  { mode: "github", title: "GitHub" },
  { mode: "advanced", title: "Advanced" },
  { mode: "about", title: "About Cinderdeck" },
] as const;
export function NativeToolsSettings() {
  const tools = useNativeTools();
  if (!tools.host) return null;
  const disabled = !tools.available || tools.pending;
  return (
    <section className={styles.settings} aria-labelledby="native-tools-heading">
      <header>
        <div>
          <h2 id="native-tools-heading">Capture & desktop</h2>
          <p>Open Cinderdeck’s native preferences for capture, permissions and storage.</p>
        </div>
        <CameraIcon size={22} aria-hidden />
      </header>
      {!tools.available ? <p role="status">The native connection is unavailable.</p> : null}
      <div className={styles.categories}>
        {preferences.map(({ mode, title, description, Icon }) => (
          <button
            type="button"
            key={mode}
            disabled={disabled}
            onClick={() => {
              void tools.request({ surface: "preferences", mode });
            }}
          >
            <Icon size={19} aria-hidden />
            <span>
              <strong>{title}</strong>
              <small>{description}</small>
            </span>
            <ArrowUpRightIcon size={14} aria-hidden />
          </button>
        ))}
      </div>
      <div className={styles.updates}>
        <div>
          <strong>Application updates</strong>
          <p>Cinderdeck checks for updates in its native updater.</p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            void tools.request({ surface: "updates" });
          }}
        >
          <CheckCheckIcon size={16} aria-hidden />
          Check for updates
        </button>
      </div>
      <details className={styles.more}>
        <summary>More desktop preferences</summary>
        <div>
          {morePreferences.map(({ mode, title }) => (
            <button
              type="button"
              key={mode}
              disabled={disabled}
              onClick={() => {
                void tools.request({ surface: "preferences", mode });
              }}
            >
              {title}
              <ArrowUpRightIcon size={12} aria-hidden />
            </button>
          ))}
        </div>
      </details>
    </section>
  );
}

/** Installation belongs to the native owner; opening this panel writes no configuration. */
export function NativeAgentAccessSettings() {
  const tools = useNativeTools();
  return (
    <section
      id="cinderdeck-agent-access"
      className={styles.settings}
      aria-labelledby="agent-access-heading"
    >
      <header>
        <div>
          <h2 id="agent-access-heading">MCP & skills</h2>
          <p>
            Harness sessions receive authenticated MCP tools automatically. Connected workspace
            tools need an available Cinderdeck connection and a linked lane.
          </p>
        </div>
      </header>
      <p>
        Install Cinderdeck’s lane, recording and recording review skills for your provider. The
        installer shows missing and outdated skills and preserves copies you manage yourself.
      </p>
      <div className={styles.updates}>
        <div>
          <strong>Agent access{tools.host ? " on this Mac" : " on the execution computer"}</strong>
          <p>
            Set up skills for Codex, Claude Code or Cursor, and register the MCP server for external
            clients, including VS Code Copilot.
          </p>
        </div>
        {tools.host ? (
          <button
            type="button"
            disabled={!tools.available || tools.pending}
            onClick={() => void tools.request({ surface: "agent-access" })}
          >
            Set up MCP & skills
            <ArrowUpRightIcon size={14} aria-hidden />
          </button>
        ) : null}
      </div>
      {tools.host && !tools.available ? (
        <p role="status">
          The native connection is unavailable. Reopen Cinderdeck to access the installer.
        </p>
      ) : null}
      {!tools.host ? (
        <p>
          Open Agent access in Cinderdeck on the execution computer, or run{" "}
          <code>cinderdeck setup --all --skills</code> there. Check installed skills with{" "}
          <code>cinderdeck skills list</code>.
        </p>
      ) : null}
      <p>
        Installation uses the provider’s standard folders. If you configured a custom provider home,
        install the skills in that home. Use Restart agent session in the command palette after
        changing skills or MCP configuration.
      </p>
    </section>
  );
}
