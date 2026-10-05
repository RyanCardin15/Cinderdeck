import type { WorkspaceSearch } from "./workspaceNavigation";
import { Link } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type {
  PreviewImportBegin,
  PreviewImportReceipt,
  RecordingContext,
} from "@t3tools/contracts/deckhand/recordingsRpc";
import {
  PreviewImportBegin as BeginSchema,
  PreviewImportReceipt as ReceiptSchema,
} from "@t3tools/contracts/deckhand/recordingsRpc";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { CircleIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  readActiveBrowserRecordingTabIds,
  startBrowserRecording,
  stopBrowserRecordingForUpload,
} from "../browser/browserRecording";
import { previewRuntimeTabId } from "../browser/previewRuntimeTabId";
import { runtime } from "../lib/runtime";
import { useThreadPreviewState } from "../previewStateStore";
import { useAtomCommand } from "../state/use-atom-command";
import {
  beginPreviewImport,
  inspectPreviewImport,
  previewImportEvent,
  uploadPreviewChunk,
  finishPreviewImport,
} from "./recordingState";
import styles from "./previewCapture.module.css";

const pendingSchema = Schema.Struct({
  request: BeginSchema,
  receipt: Schema.NullOr(ReceiptSchema),
  runtimeTabId: Schema.String,
});
type Pending = typeof pendingSchema.Type;
function readPending(key: string): Pending | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return Schema.is(pendingSchema)(value) ? value : null;
  } catch {
    return null;
  }
}
export function PreviewCaptureControl({
  threadRef,
  sessionID,
  context,
  enabled,
  workspaceSearch,
}: {
  threadRef: ScopedThreadRef;
  sessionID: string;
  context: RecordingContext;
  enabled: boolean;
  workspaceSearch?: WorkspaceSearch;
}) {
  const preview = useThreadPreviewState(threadRef);
  const storageKey = `deckhand:preview-import:${threadRef.environmentId}:${sessionID}`;
  const [pending, setPending] = useState<Pending | null>(() => readPending(storageKey));
  const [busy, setBusy] = useState(false);
  const [includeLogs, setIncludeLogs] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const begin = useAtomCommand(beginPreviewImport, { reportFailure: false });
  const inspect = useAtomCommand(inspectPreviewImport, { reportFailure: false });
  const event = useAtomCommand(previewImportEvent, { reportFailure: false });
  const chunk = useAtomCommand(uploadPreviewChunk, { reportFailure: false });
  const finish = useAtomCommand(finishPreviewImport, { reportFailure: false });
  const save = (next: Pending) => {
    localStorage.setItem(storageKey, JSON.stringify(next));
    setPending(next);
  };
  useEffect(() => {
    if (!enabled || !pending) return;
    let cancelled = false;
    void inspect({
      environmentId: threadRef.environmentId,
      input: {
        installationID: pending.request.installationID,
        workspaceID: pending.request.workspaceID,
        generation: pending.request.generation,
        operationKey: pending.request.operationKey,
      },
    }).then((result) => {
      if (!cancelled && result._tag === "Success") {
        const next = { ...pending, receipt: result.value };
        localStorage.setItem(storageKey, JSON.stringify(next));
        setPending(next);
      }
    });
    return () => {
      cancelled = true;
    };
    // Reconcile once on context entry, including a lost begin/finish response.
  }, [storageKey, enabled, inspect, threadRef.environmentId]);
  const tabID = preview.activeTabId;
  const selected = tabID ? preview.sessions[tabID] : null;
  const targetURL = selected && selected.navStatus._tag !== "Idle" ? selected.navStatus.url : null;
  const available =
    enabled &&
    tabID !== null &&
    targetURL !== null &&
    Boolean(preview.desktopByTabId[tabID]?.hasWebContents);
  const control = (p: Pending) => {
    if (!p.receipt)
      throw new Error("Reconcile the original request before controlling this capture.");
    return {
      installationID: p.request.installationID,
      workspaceID: p.request.workspaceID,
      generation: p.request.generation,
      operationKey: p.request.operationKey,
      token: p.receipt.token,
    };
  };
  const requireReceipt = (result: Awaited<ReturnType<typeof begin>>): PreviewImportReceipt => {
    if (result._tag !== "Success")
      throw new Error(
        "Cinderdeck could not complete this step. Inspect or retry the original receipt.",
      );
    return result.value;
  };
  const upload = async (p: Pending, blob: Blob) => {
    if (blob.size === 0 || blob.size > 268435456)
      throw new Error(
        "Preview video must be between 1 byte and 256 MiB. The desktop recording remains saved.",
      );
    const mimeType = blob.type.startsWith("video/mp4")
      ? "video/mp4"
      : blob.type.startsWith("video/webm")
        ? "video/webm"
        : null;
    if (!mimeType)
      throw new Error(
        "This preview video format cannot be imported. The desktop recording remains saved.",
      );
    const current = requireReceipt(
      await inspect({
        environmentId: threadRef.environmentId,
        input: {
          installationID: p.request.installationID,
          workspaceID: p.request.workspaceID,
          generation: p.request.generation,
          operationKey: p.request.operationKey,
        },
      }),
    );
    let next = { ...p, receipt: current };
    if (current.state === "ready") {
      save(next);
      return current.recordingID;
    }
    if (current.state === "validating")
      throw new Error(
        "Cinderdeck is validating this source. Reconcile the receipt before retrying.",
      );
    for (let offset = current.receivedBytes; offset < blob.size; offset += 262144) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + 262144).arrayBuffer());
      let binary = "";
      for (const value of bytes) binary += String.fromCharCode(value);
      const receipt = requireReceipt(
        await chunk({
          environmentId: threadRef.environmentId,
          input: { ...control(next), offset, totalBytes: blob.size, mimeType, data: btoa(binary) },
        }),
      );
      next = { ...next, receipt };
      save(next);
      setProgress(Math.round((receipt.receivedBytes / blob.size) * 100));
    }
    const receipt = requireReceipt(
      await finish({ environmentId: threadRef.environmentId, input: control(next) }),
    );
    save({ ...next, receipt });
    if (receipt.state !== "ready")
      throw new Error(
        receipt.detail ??
          "Video import did not produce playable evidence. Its original source is preserved.",
      );
    blobRef.current = null;
    return receipt.recordingID;
  };
  const start = async () => {
    if (!available || !tabID || !targetURL) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    let p: Pending | null = null;
    try {
      if (
        pending &&
        !["ready", "failed", "interrupted"].includes(pending.receipt?.state ?? "prepared")
      ) {
        const receipt = requireReceipt(
          await begin({ environmentId: threadRef.environmentId, input: pending.request }),
        );
        save({ ...pending, receipt });
        throw new Error(
          "The previous capture is still open. Stop or cancel it before starting another.",
        );
      }
      const request: PreviewImportBegin = {
        ...context,
        operationKey: await runtime.runPromise(
          Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
        ),
        sessionID,
        tabID,
        targetURL,
        title: "Preview verification",
        clientMonotonicMs: performance.now(),
        capturedWorkspaceIDs: includeLogs ? [context.workspaceID] : [],
      };
      p = {
        request,
        receipt: null,
        runtimeTabId: previewRuntimeTabId(threadRef, preview.serverEpoch, tabID),
      };
      save(p);
      p = {
        ...p,
        receipt: requireReceipt(
          await begin({ environmentId: threadRef.environmentId, input: request }),
        ),
      };
      save(p);
      await startBrowserRecording(p.runtimeTabId, threadRef, tabID);
      const receipt = requireReceipt(
        await event({
          environmentId: threadRef.environmentId,
          input: { ...control(p), event: "first_frame", clientMonotonicMs: performance.now() },
        }),
      );
      save({ ...p, receipt });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview capture failed.");
      if (p?.receipt && !readActiveBrowserRecordingTabIds().has(p.runtimeTabId)) {
        const result = await event({
          environmentId: threadRef.environmentId,
          input: { ...control(p), event: "cancel", clientMonotonicMs: performance.now() },
        });
        if (result._tag === "Success") save({ ...p, receipt: result.value });
      }
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!pending?.receipt) return;
    setBusy(true);
    setError(null);
    try {
      let p = pending;
      if (p.receipt?.state === "capturing") {
        p = {
          ...p,
          receipt: requireReceipt(
            await event({
              environmentId: threadRef.environmentId,
              input: { ...control(p), event: "stop", clientMonotonicMs: performance.now() },
            }),
          ),
        };
        save(p);
      }
      if (blobRef.current) await upload(p, blobRef.current);
      else {
        const result = await stopBrowserRecordingForUpload(
          p.runtimeTabId,
          async (_artifact, blob) => {
            blobRef.current = blob;
            return upload(p, blob);
          },
        );
        if (!result)
          throw new Error(
            "The desktop capture is unavailable. Cancel this receipt; its saved source remains on the recording computer.",
          );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Preview upload failed.");
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!pending?.receipt) return;
    setBusy(true);
    setError(null);
    try {
      await stopBrowserRecordingForUpload(
        pending.runtimeTabId,
        async () => pending.receipt!.recordingID,
      );
      const receipt = requireReceipt(
        await event({
          environmentId: threadRef.environmentId,
          input: {
            ...control(pending),
            event: "cancel",
            clientMonotonicMs: Math.max(performance.now(), pending.request.clientMonotonicMs),
          },
        }),
      );
      save({ ...pending, receipt });
      blobRef.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cancel failed.");
    } finally {
      setBusy(false);
    }
  };
  const active =
    pending?.receipt &&
    ["prepared", "capturing", "uploading", "validating"].includes(pending.receipt.state);
  return (
    <details className={styles.control}>
      <summary>
        <CircleIcon size={14} aria-hidden />
        Preview capture{active ? <span className={styles.live}>Live</span> : null}
      </summary>
      <div className={styles.popover}>
        <h2>Record this preview</h2>
        {!active ? (
          <label className={styles.scope}>
            <input
              type="checkbox"
              checked={includeLogs}
              onChange={(event) => setIncludeLogs(event.target.checked)}
            />
            Include this lane’s logs
          </label>
        ) : null}
        <p>
          Capture the selected desktop preview with this lane’s logs. Video stays with its original
          session and computer.
        </p>
        <p className={styles.target}>
          {pending && active
            ? pending.request.targetURL
            : (targetURL ?? "Open a desktop preview to select a capture target.")}
        </p>
        {active ? (
          <>
            <p role="status">
              {pending.receipt!.state}
              {progress !== null ? ` · ${progress}% uploaded` : ""}
            </p>
            <button
              type="button"
              disabled={busy || !enabled || pending.receipt!.state === "validating"}
              onClick={() => void stop()}
            >
              <SquareIcon size={13} aria-hidden />
              {pending.receipt!.state === "capturing" ? "Stop and import" : "Retry import"}
            </button>
            <button
              type="button"
              disabled={busy || !enabled || pending.receipt!.state === "validating"}
              onClick={() => void cancel()}
            >
              Cancel capture
            </button>
          </>
        ) : (
          <button type="button" disabled={busy || !available} onClick={() => void start()}>
            Start recording
          </button>
        )}
        {pending?.receipt?.state === "ready" ? (
          <>
            <Link
              to={workspaceSearch ? "/workspaces" : "/recordings"}
              search={
                workspaceSearch
                  ? {
                      ...workspaceSearch,
                      tab: "recordings",
                      recording: pending.receipt.recordingID,
                    }
                  : {
                      environment: threadRef.environmentId,
                      workspace: pending.request.workspaceID,
                      recording: pending.receipt.recordingID,
                    }
              }
            >
              Review imported video
            </Link>
            <p>Clock alignment is estimated. Served-build revision is unknown.</p>
          </>
        ) : null}
        {pending?.receipt?.detail ? <p>{pending.receipt.detail}</p> : null}
        {pending ? (
          <button
            type="button"
            disabled={busy || !enabled}
            onClick={() => {
              setBusy(true);
              void inspect({
                environmentId: threadRef.environmentId,
                input: {
                  installationID: pending.request.installationID,
                  workspaceID: pending.request.workspaceID,
                  generation: pending.request.generation,
                  operationKey: pending.request.operationKey,
                },
              })
                .then((result) => {
                  if (result._tag === "Success") {
                    save({ ...pending, receipt: result.value });
                    setError(null);
                  } else setError("The original receipt is unavailable.");
                })
                .finally(() => setBusy(false));
            }}
          >
            Refresh receipt
          </button>
        ) : null}
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        {!pending?.receipt && pending ? (
          <button type="button" disabled={busy || !enabled} onClick={() => void start()}>
            Reconcile original request
          </button>
        ) : null}
      </div>
    </details>
  );
}
