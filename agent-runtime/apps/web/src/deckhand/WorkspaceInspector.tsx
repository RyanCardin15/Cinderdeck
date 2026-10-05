import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useResizableWidth } from "../hooks/useResizableWidth";
import styles from "./workspace.module.css";

const MIN_WIDTH = 240;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 280;

export function WorkspaceInspector({ open, children }: { open: boolean; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [maxWidth, setMaxWidth] = useState(MAX_WIDTH);
  useLayoutEffect(() => {
    const shell = panelRef.current?.parentElement;
    if (!shell) return;
    const sidebar = shell.firstElementChild;
    const measure = () => {
      // Leave the overview enough room when the window or navigation rail changes size.
      const available = shell.clientWidth - (sidebar?.getBoundingClientRect().width ?? 0) - 400;
      setMaxWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available)));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(shell);
    if (sidebar) observer?.observe(sidebar);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);
  const { width, handlers, setWidth } = useResizableWidth({
    storageKey: "deckhand:workspace-inspector-width",
    defaultWidth: DEFAULT_WIDTH,
    minWidth: MIN_WIDTH,
    maxWidth,
    edge: "left",
  });

  return (
    <div
      ref={panelRef}
      className={styles["dh-inspector-panel"]}
      style={{ width }}
      hidden={!open}
      id="dh-selected-context"
    >
      <div
        className={styles["dh-inspector-resize"]}
        role="separator"
        aria-label="Resize selected context"
        aria-orientation="vertical"
        aria-controls="dh-selected-context"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        aria-valuetext={`${Math.round(width)} pixels`}
        tabIndex={0}
        aria-description="Drag or use arrow keys to resize. Shift uses larger steps; Home and End select the limits. Double-click to reset."
        {...handlers}
        onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 40 : 10;
          const next =
            event.key === "ArrowLeft"
              ? width + step
              : event.key === "ArrowRight"
                ? width - step
                : event.key === "Home"
                  ? MIN_WIDTH
                  : event.key === "End"
                    ? maxWidth
                    : null;
          if (next === null) return;
          event.preventDefault();
          setWidth(next);
        }}
      />
      <aside className={styles["dh-inspector"]} aria-label="Selected context">
        {children}
      </aside>
    </div>
  );
}
