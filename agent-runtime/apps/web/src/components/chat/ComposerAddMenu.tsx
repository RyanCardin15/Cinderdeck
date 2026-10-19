import { ObsidianNotes } from "../../knowledge/ObsidianNotes";
import { useEffect, useRef, useState } from "react";
import { AppWindowIcon, CameraIcon, ImagePlusIcon, BookOpenIcon, PlusIcon } from "lucide-react";
import type { RecentAppTarget, SnapShotSource } from "@cinderdeck/contracts";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { useComposerMenuProps } from "./composerEventScope";
import styles from "./composerAddMenu.module.css";

export function appContextError(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  return (
    cause.message.replace(
      /^Error invoking remote method 'cinderdeck:app-context': (?:Error: )?/,
      "",
    ) || fallback
  );
}

function AppIcon({ target }: { target: RecentAppTarget }) {
  return target.iconDataURL ? (
    <img className={styles.appIcon} src={target.iconDataURL} alt="" />
  ) : (
    <AppWindowIcon className={styles.appIcon} />
  );
}

/** Mounted per draft: asynchronous captures never land in a newly selected conversation. */
export function ComposerAddMenu({
  onChooseFiles,
  onAttach,
  onAttachFile,
  workspacePath,
}: {
  workspacePath?: string | null;
  onAttachFile?: (file: File) => Promise<void>;
  onChooseFiles: () => void;
  onAttach: (file: File, source: SnapShotSource) => Promise<void>;
}) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const native = bridge?.isNativeHost?.() === true ? bridge.appContext : undefined;
  const [notesOpen, setNotesOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<readonly RecentAppTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const mounted = useRef(true);
  const capturePending = useRef(false);
  const floating = useComposerMenuProps();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);

  async function refresh() {
    if (!native) return;
    const current = ++generation.current;
    setLoading(true);
    setTargets([]);
    setError("");
    try {
      const result = await native.list();
      if (mounted.current && current === generation.current) setTargets(result.targets);
    } catch (cause) {
      if (mounted.current && current === generation.current)
        setError(appContextError(cause, "App context is unavailable."));
    } finally {
      if (mounted.current && current === generation.current) setLoading(false);
    }
  }
  async function capture(target: RecentAppTarget) {
    if (!native || capturePending.current) return;
    capturePending.current = true;
    setCapturing(target.tabTitle || target.appName);
    setError("");
    // Retain the callback belonging to this exact draft before the native await.
    const attach = onAttach;
    try {
      const result = await native.capture(target.id);
      if (!mounted.current) return;
      const bytes = Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0));
      const base = `${result.source.appName} — ${result.source.windowTitle || "Window"}`;
      const name =
        Array.from(base, (char) => (char.charCodeAt(0) < 32 || "/\\:".includes(char) ? "-" : char))
          .join("")
          .slice(0, 200) + ".jpg";
      await attach(new File([bytes], name, { type: result.mimeType }), result.source);
    } catch (cause) {
      if (mounted.current) setError(appContextError(cause, "The window could not be attached."));
    } finally {
      capturePending.current = false;
      if (mounted.current) setCapturing(null);
    }
  }
  const recent = targets.find((target) => target.recent);
  return (
    <div className={styles.host}>
      <Menu
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) void refresh();
        }}
      >
        <MenuTrigger
          render={
            <button
              type="button"
              className={styles.trigger}
              aria-label="Add attachments"
              disabled={capturing !== null}
            />
          }
        >
          {capturing ? (
            <Spinner size="sm" />
          ) : (
            <PlusIcon className={open ? styles.plusOpen : styles.plus} />
          )}
        </MenuTrigger>
        <MenuPopup side="top" align="end" sideOffset={9} appearance="attachment" {...floating}>
          <MenuItem variant="attachment" onClick={onChooseFiles}>
            <ImagePlusIcon />
            <span>Add photos & files</span>
          </MenuItem>
          {bridge?.knowledge && onAttachFile && (
            <MenuItem
              variant="attachment"
              onClick={() => {
                setOpen(false);
                setNotesOpen(true);
              }}
            >
              <BookOpenIcon />
              <span>Add Obsidian note</span>
            </MenuItem>
          )}
          {native && (
            <>
              <MenuSeparator />
              {loading ? (
                <div className={styles.message} role="status">
                  <Spinner size="sm" /> Finding your recent app…
                </div>
              ) : recent ? (
                <MenuItem
                  variant="attachment"
                  data-recent="true"
                  onClick={() => void capture(recent)}
                  label={`Add ${recent.tabTitle || recent.appName}`}
                >
                  <AppIcon target={recent} />
                  <span className={styles.labels}>
                    <span>Add {recent.appName}</span>
                    <span className={styles.subtitle}>
                      {recent.tabTitle || recent.windowTitle || "Current window"}
                    </span>
                  </span>
                </MenuItem>
              ) : (
                <div className={styles.message}>Your recent app will appear here</div>
              )}
              <MenuSub>
                <MenuSubTrigger appearance="attachment" disabled={!targets.length}>
                  <CameraIcon />
                  <span>Take screenshot</span>
                </MenuSubTrigger>
                <MenuSubPopup appearance="attachment" {...floating}>
                  {targets.map((target) => (
                    <MenuItem
                      key={target.id}
                      variant="attachment"
                      label={`${target.appName} ${target.tabTitle || target.windowTitle}`}
                      onClick={() => void capture(target)}
                    >
                      <AppIcon target={target} />
                      <span className={styles.labels}>
                        <span>{target.appName}</span>
                        <span className={styles.subtitle}>
                          {target.tabTitle || target.windowTitle || "Window"}
                        </span>
                      </span>
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            </>
          )}
        </MenuPopup>
      </Menu>
      {notesOpen && (
        <ObsidianNotes
          open={notesOpen}
          onOpenChange={setNotesOpen}
          workspacePath={workspacePath ?? null}
          onAttach={onAttachFile}
        />
      )}
      {capturing && (
        <span role="status" className="sr-only">
          Attaching {capturing}…
        </span>
      )}
      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <button type="button" aria-label="Dismiss attachment error" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
