import { type CSSProperties, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AppWindowIcon,
  ChevronRightIcon,
  MaximizeIcon,
  MinimizeIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import type { EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import {
  DEBUG_KEYS,
  type DebugCommand,
  type DebugEvent,
  type DebugKey,
  type DebugSession,
  type DebugSnapshot,
} from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import { squashAtomCommandFailure } from "@cinderdeck/client-runtime/state/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { readDebugSession, runDebugCommand } from "./externalDebugState";
import styles from "./macWindowPanel.module.css";

const errorText = (failure: unknown) =>
  failure instanceof Error
    ? failure.message
    : typeof failure === "object" && failure !== null && "message" in failure
      ? String(failure.message)
      : "The Mac connection is unavailable. Find windows again to reconnect.";
const modifiers = (event: {
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
}): NonNullable<DebugCommand["modifiers"]> =>
  [
    event.metaKey && "meta",
    event.altKey && "alt",
    event.shiftKey && "shift",
    event.ctrlKey && "control",
  ].filter(Boolean) as NonNullable<DebugCommand["modifiers"]>;

const debugKeys = new Set<string>(DEBUG_KEYS);
// Named keys always go through as keys. Characters (and Space) do only with Command
// or Control, so ordinary typing, including Option characters, stays text. Plain
// Command-V stays a paste of the viewer's clipboard.
function shortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): DebugKey | undefined {
  if (event.key.length > 1) return debugKeys.has(event.key) ? (event.key as DebugKey) : undefined;
  if (event.key === " " && (event.shiftKey || event.ctrlKey || event.metaKey)) return "Space";
  if (!(event.metaKey || event.ctrlKey)) return undefined;
  const key = event.key.toLowerCase();
  if (key === "v" && event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey)
    return undefined;
  return debugKeys.has(key) ? (key as DebugKey) : undefined;
}
const point = (event: { clientX: number; clientY: number }, rect: DOMRect) => ({
  x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
  y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
});

// "fit" shows the whole window; "width" fills the panel width; numbers scale beyond it.
const zoomLevels = ["fit", "width", 1.5, 2, 3] as const;
type Zoom = (typeof zoomLevels)[number];
const zoomLabel = (zoom: Zoom) =>
  zoom === "fit" ? "Fit" : zoom === "width" ? "Width" : `${Math.round(zoom * 100)}%`;
export function MacWindowPanel({
  environmentId,
  session,
  label,
  threadId,
  visible = true,
  compact = false,
}: {
  environmentId: EnvironmentId;
  session: DebugSession;
  label: string;
  threadId?: ThreadId;
  visible?: boolean;
  compact?: boolean;
}) {
  const read = useAtomCommand(readDebugSession, { reportFailure: false });
  const run = useAtomCommand(runDebugCommand, { reportFailure: false });
  const [events, setEvents] = useState<readonly DebugEvent[]>([]);
  const [dropped, setDropped] = useState(0);
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [live, setLive] = useState(true),
    [controls, setControls] = useState(false),
    [expanded, setExpanded] = useState(false),
    [zoom, setZoom] = useState<Zoom>("fit"),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  const cursor = useRef(0),
    imageSequence = useRef<number | undefined>(undefined),
    epoch = useRef(0),
    allowed = useRef(false),
    mounted = useRef(true),
    queue = useRef(Promise.resolve()),
    pending = useRef(0),
    pressed = useRef<{ clientX: number; clientY: number } | null>(null);
  useEffect(() => {
    epoch.current += 1;
    allowed.current = controls && live && visible;
    if (!visible) {
      setControls(false);
      setExpanded(false);
    }
  }, [controls, live, visible]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      allowed.current = false;
    };
  }, []);
  useEffect(() => {
    let disposed = false,
      running = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (disposed || running || !visible || document.visibilityState !== "visible") return;
      running = true;
      let retry = false,
        disconnected = false;
      try {
        const result = await read({
          environmentId,
          input: {
            sessionId: session.sessionId,
            ...(threadId ? { threadId } : {}),
            after: cursor.current,
            screenshot: live,
            ...(imageSequence.current === undefined ? {} : { afterImage: imageSequence.current }),
          },
        });
        if (disposed) return;
        if (result._tag === "Failure") {
          setError(errorText(squashAtomCommandFailure(result)));
          imageSequence.current = undefined;
          allowed.current = false;
          epoch.current += 1;
          setSnapshot(null);
          setControls(false);
          retry = true;
          return;
        }
        setError("");
        cursor.current = result.value.nextSequence;
        if (result.value.events.length)
          setEvents((previous) => [...previous, ...result.value.events].slice(-200));
        if (result.value.dropped) setDropped((previous) => previous + result.value.dropped);
        imageSequence.current = result.value.imageSequence;
        setSnapshot((previous) => ({
          ...result.value,
          image:
            result.value.image ??
            (live && !result.value.imageUnavailable && result.value.session.state === "connected"
              ? (previous?.image ?? null)
              : null),
        }));
        if (result.value.session.state === "disconnected") {
          setControls(false);
          disconnected = true;
          return;
        }
      } catch (cause) {
        if (!disposed) {
          setError(errorText(cause));
          imageSequence.current = undefined;
          allowed.current = false;
          epoch.current += 1;
          setSnapshot(null);
          setControls(false);
          retry = true;
        }
      } finally {
        running = false;
        if (!disposed && visible && live && !disconnected && document.visibilityState === "visible")
          timer = setTimeout(
            () => {
              void poll();
            },
            retry ? 1200 : 400,
          );
      }
    }
    function visibility() {
      epoch.current += 1;
      if (timer) clearTimeout(timer);
      if (document.visibilityState === "visible") void poll();
    }
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [environmentId, session.sessionId, threadId, visible, live, read]);
  function send(input: Omit<DebugCommand, "sessionId">) {
    if (
      !allowed.current ||
      !mounted.current ||
      document.visibilityState !== "visible" ||
      pending.current >= 16
    )
      return;
    pending.current += 1;
    const generation = epoch.current;
    queue.current = queue.current
      .then(async () => {
        if (
          !mounted.current ||
          !allowed.current ||
          epoch.current !== generation ||
          document.visibilityState !== "visible"
        )
          return;
        const result = await run({
          environmentId,
          input: { ...input, sessionId: session.sessionId, ...(threadId ? { threadId } : {}) },
        });
        if (!mounted.current) return;
        if (result._tag === "Failure") {
          setError(errorText(squashAtomCommandFailure(result)));
          setControls(false);
        } else setError("");
      })
      .catch((cause) => {
        if (mounted.current) {
          setError(errorText(cause));
          setControls(false);
        }
      })
      .finally(() => {
        pending.current -= 1;
      });
  }
  const state = error ? "unavailable" : (snapshot?.session.state ?? session.state);
  const content = (
    <section
      className={styles.macPanel}
      data-embedded={compact}
      data-expanded={expanded && visible}
    >
      <div className={styles.panelHeader}>
        <span className={styles.connectionState} data-state={state} aria-hidden />
        <div className={styles.windowIdentity}>
          <strong>{session.target.title || label}</strong>
          <span>
            {label} · {state === "connected" ? (live ? "Live" : "Paused") : state}
          </span>
        </div>
        <div className={styles.macPanelToolbar}>
          <label>
            <input
              type="checkbox"
              checked={live}
              onChange={(event) => {
                setLive(event.target.checked);
                setControls(false);
                // Request a fresh frame when viewing resumes.
                imageSequence.current = undefined;
              }}
            />
            Live
          </label>
          <Tooltip>
            <TooltipTrigger render={<label />}>
              <input
                type="checkbox"
                checked={controls}
                disabled={state !== "connected" || !live}
                onChange={(event) => {
                  setControls(event.target.checked);
                  setError("");
                }}
              />
              Control
            </TooltipTrigger>
            <TooltipPopup>
              Click, type, paste, and scroll in the window. Input activates it on its Mac.
            </TooltipPopup>
          </Tooltip>
          {controls ? <button onClick={() => send({ action: "focus" })}>Open on Mac</button> : null}
        </div>
        <div className={styles.zoom} role="group" aria-label={`${label} zoom`}>
          <button
            aria-label={`Zoom out ${label}`}
            disabled={zoom === zoomLevels[0]}
            onClick={() =>
              setZoom((current) => zoomLevels[Math.max(0, zoomLevels.indexOf(current) - 1)]!)
            }
          >
            <ZoomOutIcon size={13} />
          </button>
          <button aria-label={`Reset zoom for ${label}`} onClick={() => setZoom("fit")}>
            {zoomLabel(zoom)}
          </button>
          <button
            aria-label={`Zoom in ${label}`}
            disabled={zoom === zoomLevels.at(-1)}
            onClick={() =>
              setZoom(
                (current) =>
                  zoomLevels[Math.min(zoomLevels.length - 1, zoomLevels.indexOf(current) + 1)]!,
              )
            }
          >
            <ZoomInIcon size={13} />
          </button>
        </div>
        <button
          className={styles.iconButton}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? <MinimizeIcon size={14} /> : <MaximizeIcon size={14} />}
        </button>
      </div>
      <div
        className={styles.macCanvas}
        data-zoom={snapshot?.image && live ? zoom : undefined}
        style={
          typeof zoom === "number"
            ? ({ "--zoom-width": `${zoom * 100}%` } as CSSProperties)
            : undefined
        }
      >
        {snapshot?.image && live ? (
          <img
            src={`data:image/jpeg;base64,${snapshot.image}`}
            alt={`${label}: ${session.target.title}`}
            tabIndex={controls ? 0 : -1}
            draggable={false}
            data-controlled={controls}
            onMouseDown={(event) => {
              if (!controls || ![0, 2].includes(event.button)) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              pressed.current =
                event.button === 0 ? { clientX: event.clientX, clientY: event.clientY } : null;
            }}
            onMouseUp={(event) => {
              if (!controls || ![0, 2].includes(event.button)) return;
              event.preventDefault();
              // Release the viewer's mouse before activation changes the native key window.
              const rect = event.currentTarget.getBoundingClientRect();
              const start = pressed.current;
              pressed.current = null;
              if (
                start &&
                event.button === 0 &&
                Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 4
              ) {
                // A drag selects ranges, moves panes and resizes columns on the Mac.
                const from = point(start, rect),
                  to = point(event, rect);
                send({
                  action: "drag",
                  x: from.x,
                  y: from.y,
                  toX: to.x,
                  toY: to.y,
                  modifiers: modifiers(event),
                });
                return;
              }
              send({
                action: "click",
                ...point(event, rect),
                button: event.button === 2 ? "right" : "left",
                clickCount: event.detail === 2 ? 2 : 1,
                modifiers: modifiers(event),
              });
            }}
            onContextMenu={(event) => {
              if (controls) event.preventDefault();
            }}
            onWheel={(event) => {
              if (!controls) return;
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              send({
                action: "scroll",
                x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
                y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
                deltaX: Math.max(-1200, Math.min(1200, Math.round(event.deltaX))),
                deltaY: Math.max(-1200, Math.min(1200, Math.round(event.deltaY))),
              });
            }}
            onKeyDown={(event) => {
              if (!controls) return;
              const key = shortcut(event);
              if (key) {
                event.preventDefault();
                send({ action: "key", key, modifiers: modifiers(event) });
              } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                send({ action: "type", text: event.key });
              }
            }}
            onPaste={(event) => {
              if (!controls) return;
              event.preventDefault();
              send({
                action: "type",
                text: event.clipboardData.getData("text/plain").slice(0, 4000),
              });
            }}
          />
        ) : (
          <div className={styles.macPlaceholder}>
            <AppWindowIcon size={32} />
            <p>
              {state !== "connected"
                ? "Window closed or unavailable"
                : !live
                  ? "Live view paused"
                  : snapshot?.imageUnavailable
                    ? "Waiting for a capturable window"
                    : "Connecting to the Mac window…"}
            </p>
          </div>
        )}
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {controls ? (
        <div className={styles.macTextEntry}>
          <input
            aria-label={`Text for ${label}`}
            value={text}
            maxLength={4000}
            disabled={!controls}
            placeholder={
              label === "Web Inspector"
                ? "JavaScript for the Inspector’s console…"
                : "Text for the selected field…"
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && text) {
                send({ action: "type", text });
                setText("");
              }
            }}
          />
          <button
            disabled={!controls || !text}
            onClick={() => {
              send({ action: "type", text });
              setText("");
            }}
          >
            Send text
          </button>
          <button disabled={!controls} onClick={() => send({ action: "key", key: "Enter" })}>
            Return
          </button>
        </div>
      ) : null}
      <details className={styles.actionHistory}>
        <summary>
          <ChevronRightIcon size={13} aria-hidden />
          <span>Action history</span>
          <span className={styles.eventCount}>{events.length}</span>
        </summary>
        <p>
          Shared with your agent. Verify accepted input against the live view. App console output is
          available in Web Inspector.
        </p>
        {dropped ? <p>{dropped} earlier events expired.</p> : null}
        <ol aria-label={`${label} action history`}>
          {events.map((event) => (
            <li key={event.sequence} data-level={event.level}>
              <time dateTime={event.at}>{event.at.slice(11, 19)} UTC</time>{" "}
              <span>
                {event.kind}: {event.text}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
  // Stay in the app's window: macOS fullscreen creates a separate Space,
  // preventing timely focus of the external window for native controls.
  return expanded && visible ? createPortal(content, document.body) : content;
}
