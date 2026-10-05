import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppWindowIcon, MaximizeIcon, MinimizeIcon } from "lucide-react";
import type { EnvironmentId, ThreadId } from "@cinderdeck/contracts";
import type {
  DebugCommand,
  DebugSession,
  DebugSnapshot,
} from "@cinderdeck/contracts/deckhand/externalDebugRpc";
import { squashAtomCommandFailure } from "@cinderdeck/client-runtime/state/runtime";
import { useAtomCommand } from "../state/use-atom-command";
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
  const [snapshot, setSnapshot] = useState<DebugSnapshot | null>(null);
  const [live, setLive] = useState(true),
    [controls, setControls] = useState(false),
    [expanded, setExpanded] = useState(false),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  const cursor = useRef(0),
    imageSequence = useRef<number | undefined>(undefined),
    epoch = useRef(0),
    allowed = useRef(false),
    mounted = useRef(true),
    queue = useRef(Promise.resolve()),
    pending = useRef(0);
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
    <section className={styles.macPanel} data-embedded={compact} data-expanded={expanded && visible}>
      <div className={styles.panelHeader}>
        <strong>{label}</strong>
        <span data-state={state}>{state}</span>
        <button
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
          aria-expanded={expanded}
          onClick={() => setExpanded((previous) => !previous)}
        >
          {expanded ? <MinimizeIcon size={15} /> : <MaximizeIcon size={15} />}
        </button>
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
          Live view
        </label>
        <label>
          <input
            type="checkbox"
            checked={controls}
            disabled={state !== "connected" || !live}
            onChange={(event) => {
              setControls(event.target.checked);
              setError("");
            }}
          />
          Control window
        </label>
        {controls ? <button onClick={() => send({ action: "focus" })}>Open on Mac</button> : null}
      </div>
      <div className={styles.macCanvas}>
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
            }}
            onMouseUp={(event) => {
              if (!controls || ![0, 2].includes(event.button)) return;
              event.preventDefault();
              // Release the viewer's mouse before activation changes the native key window.
              const rect = event.currentTarget.getBoundingClientRect();
              send({
                action: "click",
                x: (event.clientX - rect.left) / rect.width,
                y: (event.clientY - rect.top) / rect.height,
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
              if (
                [
                  "Enter",
                  "Tab",
                  "Escape",
                  "Backspace",
                  "Delete",
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowDown",
                  "ArrowUp",
                  "Home",
                  "End",
                  "PageUp",
                  "PageDown",
                  "F6",
                  "F7",
                  "F8",
                ].includes(event.key) ||
                (event.metaKey && ["a", "c", "x", "z"].includes(event.key))
              ) {
                event.preventDefault();
                send({
                  action: "key",
                  key: event.key as NonNullable<DebugCommand["key"]>,
                  modifiers: modifiers(event),
                });
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
      <p className={styles.previewNote}>
        {session.target.app} · {session.target.title}
        <br />
        {controls
          ? "Click the live window, then type or paste. Controls activate this selected window on its Mac. Dragging is not supported."
          : "Viewing only. Control window activates it on the selected Mac for clicking, typing, pasting, and scrolling."}
      </p>
    </section>
  );
  // Stay in the app's window: macOS fullscreen creates a separate Space,
  // preventing timely focus of the external window for native controls.
  return expanded && visible ? createPortal(content, document.body) : content;
}
