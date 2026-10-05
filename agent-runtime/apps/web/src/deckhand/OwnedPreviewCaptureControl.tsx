import { PRIMARY_LOCAL_ENVIRONMENT_ID, type EnvironmentId } from "@cinderdeck/contracts";
import { parseScopedThreadKey } from "@cinderdeck/client-runtime/environment";
import { createEnvironmentRpcCommand } from "@cinderdeck/client-runtime/state/runtime";
import {
  OWNED_PREVIEW_METHODS,
  type OwnedPreviewStatus,
} from "@cinderdeck/contracts/deckhand/ownedPreviewRpc";
import { useEffect, useRef, useState } from "react";
import * as Cause from "effect/Cause";
import { CircleIcon, SquareIcon, RefreshCwIcon } from "lucide-react";
import { connectionAtomRuntime } from "../connection/runtime";
import { previewBridge } from "../components/preview/previewBridge";
import { useActivePreviewSessions } from "../previewStateStore";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { useAtomCommand } from "../state/use-atom-command";
import { randomUUID } from "../lib/utils";
import styles from "./verificationAttempt.module.css";
const intentCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:ownedPreview:intent",
  tag: OWNED_PREVIEW_METHODS.intent,
});
const getCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "deckhand:ownedPreview:get",
  tag: OWNED_PREVIEW_METHODS.get,
});
export function OwnedPreviewCaptureControl({
  environmentId,
  attemptOperationKey,
  enabled,
  onRecording,
}: {
  environmentId: EnvironmentId;
  attemptOperationKey: string;
  enabled: boolean;
  onRecording: (recordingID: string) => void;
}) {
  const previews = useActivePreviewSessions();
  const intent = useAtomCommand(intentCommand, { reportFailure: false });
  const inspect = useAtomCommand(getCommand, { reportFailure: false });
  const storageKey = `deckhand:owned-preview:${environmentId}:${attemptOperationKey}`;
  const key = useRef<string | null>(null);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState<OwnedPreviewStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    key.current = localStorage.getItem(storageKey);
    setStatus(null);
    setError(null);
    let live = true;
    if (key.current)
      void inspect({ environmentId, input: { captureKey: key.current } }).then((result) => {
        if (live && result._tag === "Success") {
          setStatus(result.value);
          if (result.value.recordingID && result.value.state === "ready")
            onRecording(result.value.recordingID);
        }
      });
    return () => {
      live = false;
    };
  }, [storageKey, environmentId, inspect, onRecording]);
  const tabs = Object.entries(previews).flatMap(([threadKey, state]) => {
    const ref = parseScopedThreadKey(threadKey);
    if (!ref || ref.environmentId !== environmentId) return [];
    return Object.values(state.sessions).flatMap((tab) =>
      state.desktopByTabId[tab.tabId]?.hasWebContents && tab.navStatus._tag !== "Idle"
        ? [{ id: previewRuntimeTabId(ref, state.serverEpoch, tab.tabId), label: tab.navStatus.url }]
        : [],
    );
  });
  const available =
    Boolean(previewBridge?.recording.owned) && environmentId === PRIMARY_LOCAL_ENVIRONMENT_ID;
  const run = async (action: "start" | "stop" | "refresh") => {
    if (busy || !available) return;
    setBusy(true);
    setError(null);
    try {
      let next: OwnedPreviewStatus;
      if (action === "start") {
        const captureKey = key.current ?? randomUUID();
        key.current = captureKey;
        localStorage.setItem(storageKey, captureKey);
        const result = await intent({ environmentId, input: { captureKey, attemptOperationKey } });
        if (result._tag === "Failure") throw Cause.squash(result.cause);
        if (!previewBridge?.recording.owned)
          throw new Error("Desktop preview capture is unavailable.");
        next = await previewBridge.recording.owned.start({ ...result.value, tabID: selected });
      } else if (action === "stop") {
        if (!key.current || !previewBridge?.recording.owned) return;
        next = await previewBridge.recording.owned.stop(key.current);
      } else {
        if (!key.current) return;
        const result = await inspect({ environmentId, input: { captureKey: key.current } });
        if (result._tag === "Failure") throw Cause.squash(result.cause);
        next = result.value;
      }
      setStatus(next);
      if (next.recordingID && next.state === "ready") onRecording(next.recordingID);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Capture unavailable. Recover the saved recording before starting another.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.ownedCapture}>
      <div>
        <strong>Record the owned browser preview</strong>
        <p>
          Cinderdeck captures its browser frames and binds the saved video to this declared build.
          Open the launched service in a connected conversation preview first. Starting reloads it
          to verify the actual loaded build. Leaving or reloading this page keeps the recording but
          makes its exact-preview proof incomplete.
        </p>
      </div>
      {available ? (
        <div className={styles.actions}>
          <label>
            Browser target
            <select
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={busy || status?.state === "capturing"}
            >
              <option value="">Choose an open preview</option>
              {tabs.map((tab) => (
                <option key={tab.id} value={tab.id}>
                  {tab.label}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={
              busy || !enabled || !selected || Boolean(status && status.state !== "prepared")
            }
            onClick={() => void run("start")}
          >
            <CircleIcon size={14} />
            Start owned preview
          </button>
          <button disabled={busy || status?.state !== "capturing"} onClick={() => void run("stop")}>
            <SquareIcon size={14} />
            Stop and save
          </button>
          <button disabled={busy || !key.current} onClick={() => void run("refresh")}>
            <RefreshCwIcon size={14} />
            Recover recording
          </button>
        </div>
      ) : (
        <p>
          Owned preview verification is available in the local Cinderdeck desktop app. Other capture
          targets retain their recorded source and build facts.
        </p>
      )}
      {status ? (
        <p role="status">
          {status.state}
          {status.detail ? ` · ${status.detail}` : ""}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
